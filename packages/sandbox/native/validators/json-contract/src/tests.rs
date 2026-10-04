use super::*;

fn run(source: &str, predicate: Value) -> Value {
    let packet = json!({
        "abi":"legion-validator/v1", "projectCheckId":"business-check", "extensionCheckId":"json-contract",
        "acceptanceIds":[], "unitIds":[], "units":[],
        "configuration":{"assertions":[{"id":"business-rule","predicate":predicate}]},
        "files":[{"path":"data/product.json","kind":"file","mode":"100644","sha256":"0".repeat(64),"encoding":"utf8","content":source}],
    });
    serde_json::from_str(&validate_json_contract(&packet.to_string())).unwrap()
}

fn leaf(pointer: &str, op: &str, expected: Value) -> Value {
    json!({"file":"data/product.json","pointer":pointer,"op":op,"expected":expected})
}

#[test]
fn business_values_types_and_missing_fields_have_distinct_outcomes() {
    let p = leaf("/price", "eq", json!(10));
    assert_eq!(run(r#"{"price":10}"#, p.clone())["status"], "passed");
    assert_eq!(run(r#"{"price":11}"#, p.clone())["observations"][0]["status"], "failed");
    assert_eq!(run(r#"{"price":"10"}"#, p.clone())["observations"][0]["status"], "failed");
    assert_eq!(run(r#"{}"#, p)["observations"][0]["code"], "pointer-missing");
}

#[test]
fn errors_cannot_be_inverted_masked_or_short_circuited() {
    let ok = leaf("/ready", "eq", json!(true));
    let mismatch = leaf("/ready", "eq", json!(false));
    let absent = leaf("/absent", "eq", json!(0));
    for predicate in [
        json!({"op":"not","child":absent.clone()}),
        json!({"op":"any","children":[ok.clone(),absent.clone()]}),
        json!({"op":"any","children":[absent.clone(),ok]}),
        json!({"op":"all","children":[mismatch,absent.clone()]}),
        json!({"op":"not","child":{"op":"any","children":[absent]}}),
    ] {
        let result = run(r#"{"ready":true}"#, predicate);
        assert_eq!(result["status"], "failed");
        assert_eq!(result["observations"][0]["status"], "error");
        assert_eq!(result["observations"][0]["code"], "pointer-missing");
    }
}

#[test]
fn valid_group_boolean_semantics_are_preserved() {
    let yes = leaf("/ready", "eq", json!(true));
    let no = leaf("/ready", "eq", json!(false));
    for (predicate, status) in [
        (json!({"op":"all","children":[yes.clone(),no.clone()]}), "failed"),
        (json!({"op":"any","children":[yes.clone(),no.clone()]}), "passed"),
        (json!({"op":"not","child":no}), "passed"),
        (json!({"op":"not","child":yes}), "failed"),
    ] { assert_eq!(run(r#"{"ready":true}"#, predicate)["status"], status); }
}

#[test]
fn pointers_decode_escapes_and_reject_noncanonical_array_indices() {
    assert_eq!(run(r#"{"a/b":{"~key":[{"":7}]}}"#, leaf("/a~1b/~0key/0/", "eq", json!(7)))["status"], "passed");
    for pointer in ["/items/01", "/items/-", "/items/+0", "/items/999999999999999999999999"] {
        assert_eq!(run(r#"{"items":[7]}"#, leaf(pointer, "eq", json!(7)))["observations"][0]["code"], "pointer-missing");
    }
    assert_eq!(run("{}", leaf("/~2", "eq", json!(0)))["observations"][0]["code"], "configuration-invalid");
    assert_eq!(run(r#"{"":7}"#, leaf("/", "eq", json!(7)))["status"], "passed");
    assert_eq!(run("7", leaf("", "eq", json!(7)))["status"], "passed");
}

#[test]
fn equality_is_recursive_typed_and_order_sensitive_only_for_arrays() {
    assert_eq!(run(r#"{"x":{"a":1,"b":[true,null]}}"#, leaf("/x", "eq", json!({"b":[true,null],"a":1.0})))["status"], "passed");
    assert_eq!(run(r#"[1,2]"#, leaf("", "eq", json!([2,1])))["status"], "failed");
    assert_eq!(run(r#"{"x":1}"#, leaf("/x", "ne", json!("1")))["status"], "passed");
    assert_eq!(run(r#"{"x":false}"#, leaf("/x", "eq", json!(0)))["status"], "failed");
    assert_eq!(run("2", leaf("", "in", json!(["2",1,2.0])))["status"], "passed");
    assert_eq!(run("2", leaf("", "in", json!(["2",1])))["status"], "failed");
}

#[test]
fn numeric_comparisons_use_finite_binary64_and_require_numeric_operands() {
    for (op, expected, status) in [
        ("lt", 3, "passed"), ("le", 2, "passed"), ("gt", 1, "passed"), ("ge", 2, "passed"),
        ("lt", 2, "failed"), ("le", 1, "failed"), ("gt", 2, "failed"), ("ge", 3, "failed"),
    ] { assert_eq!(run("2", leaf("", op, json!(expected)))["status"], status); }
    assert_eq!(run(r#""2""#, leaf("", "lt", json!(3)))["observations"][0]["code"], "operand-type");
    assert_eq!(run("2", leaf("", "lt", json!("3")))["observations"][0]["code"], "configuration-invalid");
    assert_eq!(run("1.0", leaf("", "eq", json!(1)))["status"], "passed");
    assert_eq!(run("-0", leaf("", "eq", json!(0)))["status"], "passed");
    assert_eq!(run("9007199254740991", leaf("", "eq", json!(9007199254740991_u64)))["status"], "passed");
    assert_eq!(run("-9007199254740991", leaf("", "eq", json!(-9007199254740991_i64)))["status"], "passed");
}

#[test]
fn duplicate_keys_unicode_and_unsafe_numbers_are_errors_even_under_not() {
    for source in [r#"{"x":1,"x":2}"#, r#"{"x":"\ud800"}"#, "9007199254740992", "-9007199254740992", "1e999", "null trailing"] {
        let result = run(source, json!({"op":"not","child":leaf("", "eq", json!(null))}));
        assert_eq!(result["status"], "failed", "{source}");
        assert_eq!(result["observations"][0]["code"], "file-json-invalid", "{source}");
    }
    assert_eq!(run(r#"{"x":"\ud83d\ude00"}"#, leaf("/x", "eq", json!("😀")))["status"], "passed");
}

#[test]
fn configuration_cannot_smuggle_fields_or_undeclared_files() {
    let mut p = leaf("", "eq", json!(0));
    p["extra"] = json!(true);
    assert_eq!(run("0", p)["observations"][0]["code"], "configuration-invalid");
    let mut p = leaf("", "eq", json!(0));
    p["file"] = json!("data/secret.json");
    assert_eq!(run("0", p)["observations"][0]["code"], "file-undeclared");
    assert_eq!(run("0", leaf("", "in", json!(0)))["observations"][0]["code"], "configuration-invalid");
}

#[test]
fn missing_file_is_error_not_a_negated_pass() {
    let packet = json!({"abi":"legion-validator/v1","extensionCheckId":"json-contract","configuration":{"assertions":[{"id":"required","predicate":{"op":"not","child":leaf("", "eq", json!(null))}}]},"files":[{"kind":"missing","path":"data/product.json"}]});
    let result: Value = serde_json::from_str(&validate_json_contract(&packet.to_string())).unwrap();
    assert_eq!(result["status"], "failed");
    assert_eq!(result["observations"][0]["code"], "file-missing");
}

#[test]
fn numeric_operand_error_survives_an_otherwise_passing_any() {
    let result = run(r#"{"ready":true,"price":"10"}"#, json!({"op":"any","children":[
        leaf("/ready", "eq", json!(true)),
        leaf("/price", "gt", json!(0))
    ]}));
    assert_eq!(result["status"], "failed");
    assert_eq!(result["observations"][0]["status"], "error");
    assert_eq!(result["observations"][0]["code"], "operand-type");
}

#[test]
fn invalid_utf8_bytes_are_not_lossily_decoded() {
    let packet = json!({"abi":"legion-validator/v1","extensionCheckId":"json-contract","configuration":{"assertions":[{"id":"valid-json","predicate":leaf("", "eq", json!(null))}]},"files":[{"kind":"file","path":"data/product.json","encoding":"base64","content":"/w=="}]});
    let result: Value = serde_json::from_str(&validate_json_contract(&packet.to_string())).unwrap();
    assert_eq!(result["status"], "failed");
    assert_eq!(result["observations"][0]["code"], "file-json-invalid");
}

#[test]
fn duplicate_assertion_ids_are_not_merged_into_success() {
    let assertion = json!({"id":"same-rule","predicate":leaf("", "eq", json!(0))});
    let packet = json!({"abi":"legion-validator/v1","extensionCheckId":"json-contract","configuration":{"assertions":[assertion.clone(),assertion]},"files":[{"kind":"file","path":"data/product.json","encoding":"utf8","content":"0"}]});
    let result: Value = serde_json::from_str(&validate_json_contract(&packet.to_string())).unwrap();
    assert_eq!(result["status"], "failed");
    assert_eq!(result["observations"][0]["code"], "configuration-invalid");
}

#[test]
fn failure_recommendations_are_bounded_and_keep_authored_assertion_order() {
    let assertions: Vec<Value> = (0..33).map(|i| json!({"id":alloc::format!("rule-{i}"),"predicate":leaf("", "eq", json!(1))})).collect();
    let packet = json!({"abi":"legion-validator/v1","extensionCheckId":"json-contract","configuration":{"assertions":assertions},"files":[{"kind":"file","path":"data/product.json","encoding":"utf8","content":"0"}]});
    let result: Value = serde_json::from_str(&validate_json_contract(&packet.to_string())).unwrap();
    assert_eq!(result["status"], "failed");
    assert_eq!(result["observations"][32]["id"], "rule-32");
    assert_eq!(result["observations"][32]["status"], "failed");
    assert_eq!(result["recommendations"].as_array().unwrap().len(), 32);
    assert_eq!(result["recommendations"][0], json!({"title":"rule-0","priority":"P2","type":"bug","detail":"JSON contract assertion did not pass."}));
    assert_eq!(result["recommendations"][31]["title"], "rule-31");
    assert!(run("1", leaf("", "eq", json!(1))).get("recommendations").is_none());
}
