mod guard;
mod output;
mod protocol;

use std::io::{Read, Write};
use protocol::{ABI, HEADER_BYTES, Input, LIMITS, Output, Request};
use sha2::{Digest, Sha256};
use wasmtime::{Config, Engine, Store, StoreLimitsBuilder, WasmFeatures, component::{Component, Linker}};

fn read_exact(reader: &mut impl Read, count: usize) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0; count];
    reader.read_exact(&mut bytes).map_err(|_| "Short or unreadable component request")?;
    Ok(bytes)
}

fn execute(guard: &guard::Guard) -> Result<(), String> {
    let mut arguments = std::env::args_os().skip(1);
    match (arguments.next(), arguments.next()) {
        (Some(argument), None) if argument == "--probe" => {
            let mut digest = Sha256::new();
            digest.update(b"legion-cli-component-settings/v1\0");
            digest.update(include_str!("../settings.json").trim_end().as_bytes());
            let probe = serde_json::json!({
                "abi": ABI, "version": env!("CARGO_PKG_VERSION"),
                "target": env!("LEGION_NATIVE_TARGET"), "settingsDigest": format!("{:x}", digest.finalize()),
                "guard": guard.kind(), "guardVerified": true,
            });
            std::io::stdout().lock().write_all(serde_json::to_string(&probe).map_err(|_| "Cannot encode runtime probe")?.as_bytes()).map_err(|_| "Cannot write runtime probe")?;
            return Ok(());
        }
        (None, None) => {}
        _ => return Err("Only --probe or the framed stdin protocol is supported".into()),
    }
    let mut stdin = std::io::stdin().lock();
    let mut prefix = [0; 4];
    stdin.read_exact(&mut prefix).map_err(|_| "Missing BE4 component request header")?;
    let header_length = u32::from_be_bytes(prefix) as usize;
    if !(1..=HEADER_BYTES).contains(&header_length) { return Err("Component request header exceeds 16 KiB".into()); }
    let request: Request = protocol::decode(&read_exact(&mut stdin, header_length)?)?;
    request.validate()?;
    let component_bytes = read_exact(&mut stdin, request.component_bytes)?;
    let input_bytes = read_exact(&mut stdin, request.input_bytes)?;
    let mut extra = [0];
    if stdin.read(&mut extra).map_err(|_| "Cannot check request EOF")? != 0 { return Err("Trailing component request bytes".into()); }
    if protocol::hash(&component_bytes) != request.module_sha256 || protocol::hash(&input_bytes) != request.input_sha256 {
        return Err("Component or input SHA-256 mismatch".into());
    }
    let check_id = {
        let input: Input = protocol::decode(&input_bytes)?;
        input.validate()?;
        input.extension_check_id
    };
    let input_string = String::from_utf8(input_bytes).map_err(|_| "Invalid component input UTF-8")?;
    let mut config = Config::new();
    config.consume_fuel(true)
        .max_wasm_stack(LIMITS.wasm_stack_bytes)
        .wasm_component_model(true)
        .wasm_features(WasmFeatures::THREADS, false)
        .shared_memory(false)
        .cranelift_nan_canonicalization(true)
        .relaxed_simd_deterministic(true)
        .memory_reservation(LIMITS.memory_bytes as u64)
        .memory_guard_size(65536)
        .memory_reservation_for_growth(0);
    let engine = Engine::new(&config).map_err(|_| "Wasmtime engine prerequisite failed")?;
    let component = Component::new(&engine, &component_bytes).map_err(|_| "Raw component validation or compilation failed under verified process boundary; native/AOT bytes are forbidden")?;
    drop(component_bytes);
    let component_type = component.component_type();
    let mut exports = component_type.exports(&engine);
    if exports.len() != 1 || !exports.next().is_some_and(|(name, _)| name == "validate") {
        return Err("Component world must export only validate".into());
    }
    let limits = StoreLimitsBuilder::new()
        .memory_size(LIMITS.memory_bytes).memories(LIMITS.memories)
        .instances(LIMITS.instances).tables(LIMITS.tables)
        .table_elements(LIMITS.table_elements).trap_on_grow_failure(true).build();
    let mut store = Store::new(&engine, limits);
    store.limiter(|state| state);
    store.set_fuel(LIMITS.fuel).map_err(|_| "Cannot establish guest fuel limit")?;
    let linker = Linker::new(&engine);
    let instance = linker.instantiate(&mut store, &component).map_err(|_| "Component imports, initialization trap or resource limit; no host imports are available")?;
    let validate = instance.get_typed_func::<(String,), (output::ValidatorString,)>(&mut store, "validate").map_err(|_| "Component validate export must have string-to-string ABI")?;
    // Wasmtime 49 invokes canonical post-return automatically as part of call.
    let (output::ValidatorString(output),) = validate.call(&mut store, (input_string,)).map_err(|_| "Validator trapped, returned an invalid/oversized string or exceeded a guest resource bound")?;
    let parsed: Output = protocol::decode(output.as_bytes())?;
    parsed.validate(&check_id)?;
    std::io::stdout().lock().write_all(output.as_bytes()).map_err(|_| "Cannot write validator result")?;
    Ok(())
}

fn main() {
    let result = guard::Guard::establish().and_then(|guard| execute(&guard));
    if let Err(error) = result {
        let diagnostic: String = error.chars().filter(|c| !c.is_control()).take(2048).collect();
        let _ = writeln!(std::io::stderr().lock(), "legion-wasi-host: {diagnostic}");
        std::process::exit(1);
    }
}
