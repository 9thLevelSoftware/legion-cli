use std::{error::Error, fmt::Write as _, fs, path::Path};
use wasm_encoder::{CodeSection, Component, Function, FunctionSection, Instruction, Module, ModuleSection, TypeSection, ValType};
use wasmparser::{Validator, WasmFeatures};

const PASS: &str = r#"{"schemaVersion":"legion-cli-validator-output/v1","checkId":"json-contract","status":"passed","observations":[]}"#;

fn escaped(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 3);
    for byte in bytes { write!(&mut text, "\\{byte:02x}").unwrap(); }
    text
}

fn source(output: &str, output_length: usize, memory: &str, extras: &str, validate: &str, imports: &str, instances: &str) -> String {
    let mut descriptor = Vec::with_capacity(8);
    descriptor.extend_from_slice(&16u32.to_le_bytes());
    descriptor.extend_from_slice(&(output_length as u32).to_le_bytes());
    format!(r#"(component
      {imports}
      (core module $guest
        (memory (export "memory") {memory})
        {extras}
        (data (i32.const 0) "{}")
        (data (i32.const 16) "{}")
        (func (export "realloc") (param i32 i32 i32 i32) (result i32) i32.const 16384)
        (func (export "validate") (param i32 i32) (result i32) {validate}))
      (core instance $guest-instance (instantiate $guest))
      {instances}
      (func (export "validate") (param "input" string) (result string)
        (canon lift (core func $guest-instance "validate")
          (memory $guest-instance "memory") (realloc (func $guest-instance "realloc")))))"#,
        escaped(&descriptor), escaped(output.as_bytes()))
}

fn encoded_output(output: &[u8], length: u32, encoding: &str) -> String {
    let mut descriptor = Vec::with_capacity(8);
    descriptor.extend_from_slice(&16u32.to_le_bytes());
    descriptor.extend_from_slice(&length.to_le_bytes());
    let input_pointer = (output.len() + 4096 + 7) & !7;
    let pages = (input_pointer + 65536).div_ceil(65536);
    format!(r#"(component
      (core module $guest
        (memory (export "memory") {pages})
        (data (i32.const 0) "{}")
        (data (i32.const 16) "{}")
        (func (export "realloc") (param i32 i32 i32 i32) (result i32) i32.const {input_pointer})
        (func (export "validate") (param i32 i32) (result i32) i32.const 0)
        (func (export "post-return") (param i32) i32.const 16 i32.const 120 i32.store8))
      (core instance $guest-instance (instantiate $guest))
      (func (export "validate") (param "input" string) (result string)
        (canon lift (core func $guest-instance "validate") string-encoding={encoding}
          (memory $guest-instance "memory") (realloc (func $guest-instance "realloc"))
          (post-return (func $guest-instance "post-return")))))"#,
        escaped(&descriptor), escaped(output))
}

fn fixture(directory: &Path, name: &str, source: String, manifest: &mut Vec<serde_json::Value>, expected: &str) -> Result<(), Box<dyn Error>> {
    let bytes = wat::parse_str(&source)?;
    Validator::new_with_features(WasmFeatures::all()).validate_all(&bytes)?;
    fs::write(directory.join(format!("{name}.wasm")), &bytes)?;
    manifest.push(serde_json::json!({"name":name,"bytes":bytes.len(),"expected":expected}));
    Ok(())
}

fn compilation_pressure(mut component: Vec<u8>) -> Vec<u8> {
    let mut module = Module::new();
    let mut types = TypeSection::new();
    types.ty().function([ValType::I32], [ValType::I32]);
    module.section(&types);
    let mut functions = FunctionSection::new();
    for _ in 0..2 { functions.function(0); }
    module.section(&functions);
    let mut code = CodeSection::new();
    // Preserve two million SSA arithmetic updates across two bodies below the
    // Wasm validator's 7,654,321-byte per-function body ceiling.
    for _ in 0..2 {
        let mut function = Function::new([]);
        for _ in 0..1_000_000 {
            function.instruction(&Instruction::LocalGet(0));
            function.instruction(&Instruction::I32Const(1));
            function.instruction(&Instruction::I32Add);
            function.instruction(&Instruction::LocalSet(0));
        }
        function.instruction(&Instruction::LocalGet(0));
        function.instruction(&Instruction::End);
        code.function(&function);
    }
    module.section(&code);
    let mut extra = Component::new();
    extra.section(&ModuleSection(&module));
    component.extend_from_slice(&extra.finish()[8..]);
    component
}

fn generate() -> Result<(), Box<dyn Error>> {
    let directory = std::env::args_os().nth(1).ok_or("Usage: legion-component-fixtures <new-output-directory>")?;
    let directory = Path::new(&directory);
    fs::create_dir(directory)?;
    let mut manifest = Vec::new();
    let standard = |output: &str| source(output, output.len(), "1", "", "i32.const 0", "", "");
    fixture(directory, "control-pass", standard(PASS), &mut manifest, "passed")?;
    for (name, imports) in [
        ("filesystem", r#"(import "wasi:filesystem/types@0.2.0" (instance (export "read" (func (param "input" string) (result string)))))"#),
        ("network", r#"(import "wasi:sockets/tcp@0.2.0" (instance (export "connect" (func (param "input" string) (result string)))))"#),
        ("clock", r#"(import "wasi:clocks/wall-clock@0.2.0" (instance (export "now" (func (result u64)))))"#),
        ("random", r#"(import "wasi:random/random@0.2.0" (instance (export "get-random-u64" (func (result u64)))))"#),
        ("environment", r#"(import "wasi:cli/environment@0.2.0" (instance (export "get-environment" (func (result (list (tuple string string)))))))"#),
        ("process", r#"(import "wasi:cli/exit@0.2.0" (instance (export "exit" (func (param "code" u32)))))"#),
    ] {
        fixture(directory, &format!("import-{name}"), source(PASS, PASS.len(), "1", "", "i32.const 0", imports, ""), &mut manifest, "unavailable")?;
    }
    fixture(directory, "infinite-loop", source(PASS, PASS.len(), "1", "", "(loop $forever (br $forever)) unreachable", "", ""), &mut manifest, "unavailable")?;
    fixture(directory, "excess-memory", source(PASS, PASS.len(), "1025", "", "i32.const 0", "", ""), &mut manifest, "unavailable")?;
    fixture(directory, "excess-memories", source(PASS, PASS.len(), "1", "(memory 1) (memory 1) (memory 1) (memory 1)", "i32.const 0", "", ""), &mut manifest, "unavailable")?;
    fixture(directory, "excess-table", source(PASS, PASS.len(), "1", "(table 100001 funcref)", "i32.const 0", "", ""), &mut manifest, "unavailable")?;
    fixture(directory, "excess-tables", source(PASS, PASS.len(), "1", &"(table 1 funcref) ".repeat(17), "i32.const 0", "", ""), &mut manifest, "unavailable")?;
    fixture(directory, "shared-memory", source(PASS, PASS.len(), "1", "(memory 1 1 shared)", "i32.const 0", "", ""), &mut manifest, "unavailable")?;
    fixture(directory, "excess-instances", source(PASS, PASS.len(), "1", "", "i32.const 0", "", &"(core instance (instantiate $guest)) ".repeat(32)), &mut manifest, "unavailable")?;
    for (name, output) in [
        ("malformed-output", "not JSON"),
        ("wrong-check-id", r#"{"schemaVersion":"legion-cli-validator-output/v1","checkId":"other-check","status":"passed","observations":[]}"#),
        ("unknown-output-field", r#"{"schemaVersion":"legion-cli-validator-output/v1","checkId":"json-contract","status":"passed","observations":[],"authority":true}"#),
        ("duplicate-output-key", r#"{"schemaVersion":"legion-cli-validator-output/v1","checkId":"json-contract","status":"failed","status":"passed","observations":[]}"#),
        ("passed-with-error", r#"{"schemaVersion":"legion-cli-validator-output/v1","checkId":"json-contract","status":"passed","observations":[{"id":"rule","status":"error","code":"bad"}]}"#),
        ("null-optional-field", r#"{"schemaVersion":"legion-cli-validator-output/v1","checkId":"json-contract","status":"passed","observations":[],"recommendations":null}"#),
    ] { fixture(directory, name, standard(output), &mut manifest, "unavailable")?; }
    fixture(directory, "output-expansion", source("", 32 * 1024 * 1024, "513", "", "i32.const 0", "", ""), &mut manifest, "unavailable")?;
    fixture(directory, "utf8-post-return", encoded_output(PASS.as_bytes(), PASS.len() as u32, "utf8"), &mut manifest, "passed")?;
    let utf16: Vec<u8> = PASS.encode_utf16().flat_map(u16::to_le_bytes).collect();
    fixture(directory, "utf16-post-return", encoded_output(&utf16, (utf16.len() / 2) as u32, "utf16"), &mut manifest, "passed")?;
    fixture(directory, "compact-latin1-post-return", encoded_output(PASS.as_bytes(), PASS.len() as u32, "latin1+utf16"), &mut manifest, "passed")?;
    fixture(directory, "compact-utf16-post-return", encoded_output(&utf16, (utf16.len() / 2) as u32 | (1 << 31), "latin1+utf16"), &mut manifest, "passed")?;
    let unicode = r#"{"schemaVersion":"legion-cli-validator-output/v1","checkId":"json-contract","status":"passed","observations":[{"id":"unicode","status":"passed","code":"ok","detail":"漢😀"}]}"#;
    let unicode_utf16: Vec<u8> = unicode.encode_utf16().flat_map(u16::to_le_bytes).collect();
    fixture(directory, "utf16-unicode-post-return", encoded_output(&unicode_utf16, (unicode_utf16.len() / 2) as u32, "utf16"), &mut manifest, "passed")?;
    fixture(directory, "compact-utf16-unicode-post-return", encoded_output(&unicode_utf16, (unicode_utf16.len() / 2) as u32 | (1 << 31), "latin1+utf16"), &mut manifest, "passed")?;
    let latin1 = r#"{"schemaVersion":"legion-cli-validator-output/v1","checkId":"json-contract","status":"passed","observations":[{"id":"unicode","status":"passed","code":"ok","detail":"café"}]}"#;
    let latin1_bytes: Vec<u8> = latin1.chars().map(|character| u8::try_from(u32::from(character)).expect("Latin-1 fixture")).collect();
    fixture(directory, "compact-latin1-unicode-post-return", encoded_output(&latin1_bytes, latin1_bytes.len() as u32, "latin1+utf16"), &mut manifest, "passed")?;
    let at_cap = format!("{}{PASS}", " ".repeat(1024 * 1024 - PASS.len()));
    let utf16_at_cap: Vec<u8> = at_cap.encode_utf16().flat_map(u16::to_le_bytes).collect();
    fixture(directory, "utf16-storage-above-utf8-cap", encoded_output(&utf16_at_cap, (utf16_at_cap.len() / 2) as u32, "utf16"), &mut manifest, "passed")?;
    let utf16_expansion: Vec<u8> = core::iter::repeat_n(0x0800u16, 400_000).flat_map(u16::to_le_bytes).collect();
    fixture(directory, "utf16-decoding-expansion", encoded_output(&utf16_expansion, 400_000, "utf16"), &mut manifest, "unavailable")?;
    fixture(directory, "compact-utf16-decoding-expansion", encoded_output(&utf16_expansion, 400_000 | (1 << 31), "latin1+utf16"), &mut manifest, "unavailable")?;
    fixture(directory, "compact-latin1-decoding-expansion", encoded_output(&vec![0x80; 600_000], 600_000, "latin1+utf16"), &mut manifest, "unavailable")?;
    fixture(directory, "utf16-invalid-surrogate", encoded_output(&[0x00, 0xd8], 1, "utf16"), &mut manifest, "unavailable")?;
    fixture(directory, "compact-utf16-invalid-surrogate", encoded_output(&[0x00, 0xd8], 1 | (1 << 31), "latin1+utf16"), &mut manifest, "unavailable")?;
    fixture(directory, "abi-mismatch", "(component (core module $m (func (export \"v\") (param i32) (result i32) local.get 0)) (core instance $i (instantiate $m)) (func (export \"validate\") (param \"input\" u32) (result u32) (canon lift (core func $i \"v\"))))".into(), &mut manifest, "unavailable")?;
    let pressure = compilation_pressure(wat::parse_str(standard(PASS))?);
    if pressure.len() > 16 * 1024 * 1024 { return Err("Compilation pressure fixture exceeds admitted component size".into()); }
    Validator::new_with_features(WasmFeatures::all()).validate_all(&pressure)?;
    fs::write(directory.join("compilation-pressure.wasm"), &pressure)?;
    manifest.push(serde_json::json!({"name":"compilation-pressure","bytes":pressure.len(),"expected":"unavailable","scope":"native-compilation-pressure; report observed exit/guard/deadline, do not infer which bound fired"}));
    fs::write(directory.join("manifest.json"), serde_json::to_vec_pretty(&manifest)?)?;
    Ok(())
}

fn main() {
    if let Err(error) = generate() {
        eprintln!("legion-component-fixtures: {error}");
        std::process::exit(1);
    }
}
