fn main() {
    // The app icon is compiled into the exe by tauri-build: re-run when any icon changes,
    // otherwise cargo reuses the old embedded icon resource.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
