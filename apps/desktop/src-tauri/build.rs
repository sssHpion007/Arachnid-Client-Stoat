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
];

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    tauri_build::try_build(attributes).expect("ошибка сборки Tauri");
}
