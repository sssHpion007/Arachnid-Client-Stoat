/// Команды моста веб-клиента (`src/bridge.js`, `src/settings.js`).
///
/// Веб-клиент открыт с удалённого адреса, а такой странице Tauri разрешает
/// только команды, на которые выдано право. Права `allow-<команда>` Tauri
/// создаёт по этому списку; выдаются они при запуске в `lib.rs`.
const COMMANDS: &[&str] = &[
    "native_minimise",
    "native_maximise",
    "native_close",
    "desktop_config_set",
    "desktop_autostart_get",
    "desktop_autostart_set",
    "set_tray_labels",
    "extensions_styles",
    "set_plugin_menu",
    "extensions_overview",
    "extensions_set_theme",
    "extensions_set_theme_value",
    "extensions_reset_theme",
    "extensions_set_plugin",
    "extensions_open",
    "extensions_quick_css",
    "extensions_set_quick_css",
    "extensions_set_plugin_value",
    "extensions_reset_plugin",
    "extensions_remove_plugin",
    "extensions_catalog",
    "extensions_install_plugin",
    "plugin_storage_get",
    "plugin_storage_set",
    "plugin_native_call",
    "plugin_fetch",
    "emoji_packs",
    "emoji_pack_download",
    "emoji_pack_cancel",
    "emoji_pack_delete",
    "favorite_gifs_list",
    "favorite_gifs_add",
    "favorite_gifs_describe",
    "favorite_gifs_remove",
    "favorite_gifs_move",
    "favorite_gifs_sent",
    "favorite_gifs_set_preview",
    "favorite_gifs_resolve",
    "favorite_gifs_download",
    "favorite_gifs_previews",
    "favorite_gifs_clear_previews",
    "image_save",
    "hotkeys_overview",
    "hotkeys_activate",
    "hotkeys_set",
    "hotkeys_record",
    "media_transcode",
    "media_report",
    "scroll_report",
];

/// Встроить ffmpeg для перекодирования видео (`src/transcode.rs`): путь к
/// exe, собранному `ffmpeg/build.sh`, в переменной `ARACHNID_FFMPEG`. Без неё
/// клиент собирается без перекодирования.
fn ffmpeg() {
    println!("cargo:rustc-check-cfg=cfg(arachnid_ffmpeg)");
    println!("cargo:rerun-if-env-changed=ARACHNID_FFMPEG");
    let Some(path) = std::env::var_os("ARACHNID_FFMPEG").filter(|path| !path.is_empty()) else {
        return;
    };
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let path = std::path::absolute(&path)
        .ok()
        .filter(|path| path.is_file())
        .unwrap_or_else(|| panic!("ARACHNID_FFMPEG: нет файла {}", path.to_string_lossy()));
    println!("cargo:rerun-if-changed={}", path.display());
    println!("cargo:rustc-env=ARACHNID_FFMPEG_PATH={}", path.display());
    println!("cargo:rustc-cfg=arachnid_ffmpeg");
}

fn main() {
    ffmpeg();
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    tauri_build::try_build(attributes).expect("ошибка сборки Tauri");
}
