fn main() {
    let target = std::env::var("TARGET").expect("Cargo TARGET");
    println!("cargo:rustc-env=LEGION_NATIVE_TARGET={target}");
    if target == "x86_64-pc-windows-msvc" {
        println!("cargo:rustc-link-arg=/STACK:4194304");
    }
    if target.ends_with("-linux-musl") {
        println!("cargo:rustc-link-arg=-static");
    }
    println!("cargo:rerun-if-changed=settings.json");
    println!("cargo:rerun-if-changed=wit/validator.wit");
}
