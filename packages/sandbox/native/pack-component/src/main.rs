use std::{error::Error, fs};
use wasmparser::{Parser, Payload, Validator, WasmFeatures};
use wit_component::ComponentEncoder;

fn pack() -> Result<(), Box<dyn Error>> {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    if arguments.len() != 2 { return Err("Usage: legion-pack-component <raw-module.wasm> <component.wasm>".into()); }
    let module = fs::read(&arguments[0])?;
    // Embedded wit-bindgen metadata is sufficient; no WASI or other adapter.
    let component = ComponentEncoder::default().module(&module)?.validate(true).encode()?;
    Validator::new_with_features(WasmFeatures::default()).validate_all(&component)?;
    for payload in Parser::new(0).parse_all(&component) {
        if let Payload::ComponentImportSection(imports) = payload? {
            if imports.count() != 0 { return Err("Packaged validator has unresolved host imports".into()); }
        }
    }
    fs::write(&arguments[1], component)?;
    Ok(())
}

fn main() {
    if let Err(error) = pack() {
        eprintln!("legion-pack-component: {error}");
        std::process::exit(1);
    }
}
