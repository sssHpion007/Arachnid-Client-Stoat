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
];

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    tauri_build::try_build(attributes).expect("ошибка сборки Tauri");
}
