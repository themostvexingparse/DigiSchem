use base64::Engine;

/// Write a file atomically: into a temporary file next to it, flushed to disk, then renamed over
/// the target — a crash or full disk mid-save never leaves a truncated project behind.
fn write_atomic(path: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let target = std::path::Path::new(path);
    let dir = target.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(std::path::Path::new("."));
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, target)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Failed to write {path}: {e}"));
    }
    Ok(())
}

/// Write UTF-8 text (project files, SVG) to an absolute path chosen via the native dialog.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    write_atomic(&path, contents.as_bytes())
}

/// Write binary data (PNG) passed as base64.
#[tauri::command]
fn write_binary_file(path: String, base64_data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| format!("Invalid base64: {e}"))?;
    write_atomic(&path, &bytes)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            write_text_file,
            write_binary_file,
            read_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
