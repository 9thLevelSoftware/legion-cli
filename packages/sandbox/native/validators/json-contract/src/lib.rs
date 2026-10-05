#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

use alloc::{collections::{BTreeMap, BTreeSet}, string::{String, ToString}, vec::Vec};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOCATOR: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! { core::arch::wasm32::unreachable() }

#[cfg(target_arch = "wasm32")]
wit_bindgen::generate!({ path: "../../wit", world: "validator" });

#[cfg(target_arch = "wasm32")]
struct JsonContract;

#[cfg(target_arch = "wasm32")]
impl Guest for JsonContract {
    fn validate(input: String) -> String { validate_json_contract(&input) }
}

#[cfg(target_arch = "wasm32")]
export!(JsonContract);

#[derive(Clone, Copy)]
enum Operation { Eq, Ne, Lt, Le, Gt, Ge, In }

enum Predicate<'a> {
    Leaf { file: &'a str, pointer: Vec<String>, operation: Operation, expected: &'a Value },
    All(Vec<Predicate<'a>>),
    Any(Vec<Predicate<'a>>),
    Not(alloc::boxed::Box<Predicate<'a>>),
}

struct Assertion<'a> { id: &'a str, predicate: Predicate<'a> }

type Files<'a> = BTreeMap<&'a str, Result<Value, &'static str>>;

fn identifier(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.as_bytes()[0].is_ascii_lowercase()
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn keys(value: &Value, fields: &[&str]) -> bool {
    value.as_object().is_some_and(|object| object.len() == fields.len() && fields.iter().all(|key| object.contains_key(*key)))
}

fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str, &'static str> {
    value.get(field).and_then(Value::as_str).ok_or("configuration-invalid")
}

fn pointer_segments(pointer: &str) -> Result<Vec<String>, &'static str> {
    if pointer.encode_utf16().count() > 4096 { return Err("configuration-invalid"); }
    if pointer.is_empty() { return Ok(Vec::new()); }
    let suffix = pointer.strip_prefix('/').ok_or("configuration-invalid")?;
    suffix.split('/').map(|segment| {
        let mut result = String::new();
        let mut characters = segment.chars();
        while let Some(character) = characters.next() {
            if character == '~' {
                result.push(match characters.next() {
                    Some('0') => '~', Some('1') => '/', _ => return Err("configuration-invalid"),
                });
            } else { result.push(character); }
        }
        Ok(result)
    }).collect()
}

fn predicate<'a>(value: &'a Value, declared: &Files<'_>, depth: usize) -> Result<Predicate<'a>, &'static str> {
    if depth > 16 { return Err("configuration-invalid"); }
    let op = string(value, "op")?;
    match op {
        "all" | "any" => {
            if !keys(value, &["op", "children"]) { return Err("configuration-invalid"); }
            let children = value["children"].as_array().ok_or("configuration-invalid")?;
            if children.is_empty() || children.len() > 256 { return Err("configuration-invalid"); }
            let children = children.iter().map(|child| predicate(child, declared, depth + 1)).collect::<Result<Vec<_>, _>>()?;
            Ok(if op == "all" { Predicate::All(children) } else { Predicate::Any(children) })
        }
        "not" => {
            if !keys(value, &["op", "child"]) { return Err("configuration-invalid"); }
            Ok(Predicate::Not(alloc::boxed::Box::new(predicate(&value["child"], declared, depth + 1)?)))
        }
        "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "in" => {
            if !keys(value, &["file", "pointer", "op", "expected"]) { return Err("configuration-invalid"); }
            let file = string(value, "file")?;
            if !declared.contains_key(file) { return Err("file-undeclared"); }
            let pointer = pointer_segments(string(value, "pointer")?)?;
            let expected = &value["expected"];
            let operation = match op {
                "eq" => Operation::Eq, "ne" => Operation::Ne, "lt" => Operation::Lt,
                "le" => Operation::Le, "gt" => Operation::Gt, "ge" => Operation::Ge,
                "in" => Operation::In, _ => unreachable!(),
            };
            if matches!(operation, Operation::In) && !expected.is_array() {
                return Err("configuration-invalid");
            }
            if matches!(operation, Operation::Lt | Operation::Le | Operation::Gt | Operation::Ge) && !expected.is_number() {
                return Err("configuration-invalid");
            }
            Ok(Predicate::Leaf { file, pointer, operation, expected })
        }
        _ => Err("configuration-invalid"),
    }
}

fn configuration<'a>(value: &'a Value, declared: &Files<'_>) -> Result<Vec<Assertion<'a>>, &'static str> {
    if !keys(value, &["assertions"]) { return Err("configuration-invalid"); }
    let assertions = value["assertions"].as_array().ok_or("configuration-invalid")?;
    if assertions.is_empty() || assertions.len() > 256 { return Err("configuration-invalid"); }
    let mut seen = BTreeSet::new();
    assertions.iter().map(|assertion| {
        if !keys(assertion, &["id", "predicate"]) { return Err("configuration-invalid"); }
        let id = string(assertion, "id")?;
        if !identifier(id) || !seen.insert(id) { return Err("configuration-invalid"); }
        Ok(Assertion { id, predicate: predicate(&assertion["predicate"], declared, 1)? })
    }).collect()
}

fn files(packet: &Value) -> Result<Files<'_>, &'static str> {
    let records = packet.get("files").and_then(Value::as_array).ok_or("input-invalid")?;
    if records.len() > 256 { return Err("input-invalid"); }
    let mut files = BTreeMap::new();
    for record in records {
        let path = record.get("path").and_then(Value::as_str).ok_or("input-invalid")?;
        if files.contains_key(path) { return Err("input-invalid"); }
        let parsed = match record.get("kind").and_then(Value::as_str) {
            Some("missing") => Err("file-missing"),
            Some("file") => {
                let content = record.get("content").and_then(Value::as_str).ok_or("input-invalid")?;
                match record.get("encoding").and_then(Value::as_str) {
                    Some("utf8") => legion_strict_json::parse(content, true, 32).map_err(|_| "file-json-invalid"),
                    Some("base64") => STANDARD.decode(content).map_err(|_| "file-json-invalid").and_then(|bytes| {
                        let text = core::str::from_utf8(&bytes).map_err(|_| "file-json-invalid")?;
                        legion_strict_json::parse(text, true, 32).map_err(|_| "file-json-invalid")
                    }),
                    _ => Err("input-invalid"),
                }
            }
            _ => return Err("input-invalid"),
        };
        files.insert(path, parsed);
    }
    Ok(files)
}

fn select<'a>(file: &'a Value, pointer: &[String]) -> Result<&'a Value, &'static str> {
    let mut value = file;
    for segment in pointer {
        value = match value {
            Value::Object(object) => object.get(segment).ok_or("pointer-missing")?,
            Value::Array(array) => {
                if segment.is_empty() || !segment.bytes().all(|b| b.is_ascii_digit()) || (segment.len() > 1 && segment.starts_with('0')) {
                    return Err("pointer-missing");
                }
                let index = segment.parse::<usize>().map_err(|_| "pointer-missing")?;
                array.get(index).ok_or("pointer-missing")?
            }
            _ => return Err("pointer-missing"),
        };
    }
    Ok(value)
}

fn equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(a, b)),
        (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().all(|(key, a)| b.get(key).is_some_and(|b| equal(a, b))),
        _ => false,
    }
}

fn evaluate(predicate: &Predicate<'_>, files: &Files<'_>) -> Result<bool, &'static str> {
    match predicate {
        Predicate::Leaf { file, pointer, operation, expected } => {
            let file = files.get(*file).ok_or("file-undeclared")?.as_ref().map_err(|code| *code)?;
            let actual = select(file, pointer)?;
            match operation {
                Operation::Eq => Ok(equal(actual, expected)),
                Operation::Ne => Ok(!equal(actual, expected)),
                Operation::In => Ok(expected.as_array().ok_or("configuration-invalid")?.iter().any(|candidate| equal(actual, candidate))),
                Operation::Lt | Operation::Le | Operation::Gt | Operation::Ge => {
                    let actual = actual.as_f64().ok_or("operand-type")?;
                    let expected = expected.as_f64().ok_or("configuration-invalid")?;
                    Ok(match operation {
                        Operation::Lt => actual < expected, Operation::Le => actual <= expected,
                        Operation::Gt => actual > expected, Operation::Ge => actual >= expected,
                        _ => unreachable!(),
                    })
                }
            }
        }
        Predicate::Not(child) => evaluate(child, files).map(|passed| !passed),
        Predicate::All(children) | Predicate::Any(children) => {
            let all = matches!(predicate, Predicate::All(_));
            let mut outcome = all;
            let mut first_error = None;
            for child in children {
                // Every leaf is evaluated even after a mismatch, success or error.
                match evaluate(child, files) {
                    Ok(passed) => if all { outcome &= passed; } else { outcome |= passed; },
                    Err(code) => if first_error.is_none() { first_error = Some(code); },
                }
            }
            match first_error { Some(code) => Err(code), None => Ok(outcome) }
        }
    }
}

fn failure(code: &str) -> String {
    json!({"schemaVersion":"legion-cli-validator-output/v1","checkId":"json-contract","status":"failed",
        "observations":[{"id":"configuration","status":"error","code":code}]}).to_string()
}

pub fn validate_json_contract(input: &str) -> String {
    if input.len() > 8 * 1024 * 1024 { return failure("input-invalid"); }
    let packet = match legion_strict_json::parse(input, true, 32) { Ok(packet) => packet, Err(_) => return failure("input-invalid") };
    if packet.get("abi").and_then(Value::as_str) != Some("legion-validator/v1") || packet.get("extensionCheckId").and_then(Value::as_str) != Some("json-contract") {
        return failure("input-invalid");
    }
    let files = match files(&packet) { Ok(files) => files, Err(code) => return failure(code) };
    let assertions = match configuration(&packet["configuration"], &files) { Ok(assertions) => assertions, Err(code) => return failure(code) };
    let mut observations = Vec::with_capacity(assertions.len());
    let mut recommendations = Vec::new();
    let mut passed = true;
    for assertion in assertions {
        let (status, code) = match evaluate(&assertion.predicate, &files) {
            Ok(true) => ("passed", "assertion-passed"),
            Ok(false) => ("failed", "assertion-mismatch"),
            Err(code) => ("error", code),
        };
        if status != "passed" {
            passed = false;
            if recommendations.len() < 32 {
                recommendations.push(json!({"title":assertion.id,"priority":"P2","type":"bug","detail":"JSON contract assertion did not pass."}));
            }
        }
        observations.push(json!({"id":assertion.id,"status":status,"code":code}));
    }
    let mut output = json!({"schemaVersion":"legion-cli-validator-output/v1","checkId":"json-contract","status":if passed {"passed"} else {"failed"},"observations":observations});
    if !recommendations.is_empty() { output["recommendations"] = Value::Array(recommendations); }
    output.to_string()
}

#[cfg(test)]
mod tests;
