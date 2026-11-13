//! Arachnid Client: настольная оболочка для официального веб-клиента Stoat.
//!
//! Интерфейс — Stoat for Web без изменений, открытый с адреса инстанса
//! (по умолчанию https://stoat.chat/app), как это делает официальный Stoat
//! for Desktop. Оболочка отвечает за то, чего нет у браузера: окно со своей
//! рамкой, трей, автозапуск, Discord RPC, раздел настроек «ПК»,
//! портативный каталог данных (см. [`desktop`] и [`instance`]), экономия
//! памяти в фоне (см. [`memory`]), а также темы с собственными настройками,
//! QuickCSS и плагины в формате Avia Client (см. [`extensions`] и
//! [`usercss`]). В настройки веб-клиента добавлены раздел «Плагины» и выбор
//! темы в «Внешнем виде» (`settings.js`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::Manager;
use tauri::ipc::CapabilityBuilder;

mod desktop;
mod emoji_packs;
mod emoji_raster;
mod extensions;
mod favorite_gifs;
#[cfg(windows)]
mod http;
mod icon;
mod instance;
mod manifest;
mod media;
mod memory;
mod plugin_host;
mod system_emoji;
mod usercss;

/// Проблема, которую нужно сообщить странице.
#[derive(Debug, Serialize)]
pub struct CommandError {
    /// Тип ошибки
    pub kind: String,
    /// Текст для человека
    pub message: String,
}

impl CommandError {
    fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
        }
    }
}

impl From<tauri::Error> for CommandError {
    fn from(error: tauri::Error) -> Self {
        Self::new("window", error.to_string())
    }
}

type CmdResult<T> = Result<T, CommandError>;

/// Команды моста, доступные веб-клиенту. Тот же список — в `build.rs`
/// (по нему Tauri создаёт права `allow-…`).
const BRIDGE_PERMISSIONS: &[&str] = &[
    "allow-native-minimise",
    "allow-native-maximise",
    "allow-native-close",
    "allow-desktop-config-set",
    "allow-desktop-autostart-get",
    "allow-desktop-autostart-set",
    "allow-set-tray-labels",
    "allow-extensions-styles",
    "allow-set-plugin-menu",
    "allow-extensions-overview",
    "allow-extensions-set-theme",
    "allow-extensions-set-theme-value",
    "allow-extensions-reset-theme",
    "allow-extensions-set-plugin",
    "allow-extensions-open",
    "allow-extensions-quick-css",
    "allow-extensions-set-quick-css",
    "allow-extensions-set-plugin-value",
    "allow-extensions-reset-plugin",
    "allow-plugin-storage-get",
    "allow-plugin-storage-set",
    "allow-plugin-native-call",
    "allow-plugin-fetch",
    "allow-emoji-packs",
    "allow-emoji-pack-download",
    "allow-emoji-pack-cancel",
    "allow-emoji-pack-delete",
    "allow-favorite-gifs-list",
    "allow-favorite-gifs-add",
    "allow-favorite-gifs-describe",
    "allow-favorite-gifs-remove",
    "allow-favorite-gifs-move",
    "allow-favorite-gifs-sent",
    "allow-favorite-gifs-set-preview",
    "allow-favorite-gifs-resolve",
    "allow-favorite-gifs-download",
    // перетаскивание за рамку for-web вне Windows (см. bridge.js)
    "core:window:allow-start-dragging",
];

// ─────────────────────────────── каталог данных ─────────────────────────────

/// Каталог для журналов: рядом с exe (portable) либо `%LOCALAPPDATA%\Arachnid-Client\logs`.
fn log_directory() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("ARACHNID_CLIENT_DIR") {
        return Some(PathBuf::from(dir).join("logs"));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
        && parent.join(instance::CONFIG_FILE).exists()
    {
        return Some(parent.join("logs"));
    }
    std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("HOME"))
        .map(|base| PathBuf::from(base).join("Arachnid-Client").join("logs"))
}

/// Определить каталог данных: портативный режим важнее системного.
///
/// Порядок:
/// 1. переменная `ARACHNID_CLIENT_DIR` (её выставляет запуск из бутстрапа);
/// 2. рядом с исполняемым файлом, если там лежит `config.toml` (portable);
/// 3. системный каталог данных приложения.
fn resolve_data_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("ARACHNID_CLIENT_DIR") {
        let path = PathBuf::from(dir);
        if ensure_layout(&path).is_ok() {
            return path;
        }
    }

    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
        && parent.join(instance::CONFIG_FILE).exists()
        && ensure_layout(parent).is_ok()
    {
        return parent.to_path_buf();
    }

    let fallback = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = ensure_layout(&fallback);
    fallback
}

/// Идентификатор приложения до переименования Tauri-Stoat → Arachnid Client.
const LEGACY_IDENTIFIER: &str = "com.tauristoat.client";

/// Перенести данные со старого идентификатора на новый.
///
/// По идентификатору называется каталог данных приложения (в нём
/// `desktop.json` с настройками «ПК»). Переносим до создания окна.
fn migrate_legacy_identifier(identifier: &str) {
    let Some(base) = directories::BaseDirs::new() else {
        return;
    };
    let mut roots = vec![
        base.data_dir().to_path_buf(),
        base.data_local_dir().to_path_buf(),
    ];
    roots.dedup();
    for root in roots {
        let place = root.display();
        match move_dir_if_absent(&root.join(LEGACY_IDENTIFIER), &root.join(identifier)) {
            Ok(true) => tracing::info!(%place, "данные перенесены на новый идентификатор"),
            Ok(false) => {}
            Err(error) => tracing::warn!(%error, %place, "не удалось перенести старые данные"),
        }
    }
}

/// Переименовать `from` в `to`, если `from` есть, а `to` ещё нет.
fn move_dir_if_absent(from: &Path, to: &Path) -> std::io::Result<bool> {
    if !from.is_dir() || to.exists() {
        return Ok(false);
    }
    std::fs::rename(from, to)?;
    Ok(true)
}

/// Создать каталог данных, журналов, тем и плагинов, если их нет (первый
/// запуск без бутстрапа).
///
/// Профиль webview (`webview/`) WebView2 создаёт сам.
fn ensure_layout(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir.join("logs"))?;
    std::fs::create_dir_all(dir.join(extensions::THEMES_DIR))?;
    std::fs::create_dir_all(dir.join(extensions::PLUGINS_DIR))
}

// ─────────────────────────────────── вход ───────────────────────────────────

/// Запуск приложения.
pub fn run() {
    let log_dir = log_directory();
    let file_writer = log_dir.as_ref().and_then(|dir| {
        std::fs::create_dir_all(dir).ok()?;
        std::fs::File::create(dir.join("arachnid-client.log")).ok()
    });

    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "arachnid_client=debug,arachnid_client_lib=debug".into());

    // в Windows-релизе нет консоли, поэтому журнал обязательно пишем в файл
    match file_writer {
        Some(file) => {
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_ansi(false)
                .with_writer(std::sync::Mutex::new(file))
                .init();
        }
        None => {
            tracing_subscriber::fmt().with_env_filter(filter).init();
        }
    }

    // паника в GUI-процессе иначе исчезает бесследно
    std::panic::set_hook(Box::new(|info| {
        tracing::error!(%info, "паника");
        if let Some(dir) = log_directory() {
            let _ = std::fs::create_dir_all(&dir);
            let path = dir.join("panic.log");
            let _ = std::fs::write(path, format!("{info}\n"));
        }
    }));

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        log_dir = ?log_dir,
        "запуск Arachnid Client"
    );

    let context = tauri::generate_context!();
    migrate_legacy_identifier(&context.config().identifier);

    tauri::Builder::default()
        // первым: второй экземпляр должен выйти до того, как что-то создаст
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            desktop::show_main_window(app);
        }))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg(desktop::HIDDEN_ARG)
                .build(),
        )
        .on_window_event(desktop::on_window_event)
        // файлы из папок тем и плагинов: картинки, шрифты, стили
        .register_asynchronous_uri_scheme_protocol(
            extensions::ASSET_SCHEME,
            extensions::asset_protocol,
        )
        .setup(|app| {
            let data_dir = resolve_data_dir(app.handle());
            tracing::info!(dir = %data_dir.display(), "каталог данных");

            let instance = instance::Instance::load(&data_dir);
            tracing::info!(url = %instance.app_url, "веб-клиент");

            // страница открыта с удалённого адреса: команды моста доступны
            // только ему и только в главном окне
            let mut capability = CapabilityBuilder::new("web-client")
                .remote(instance.capability_pattern())
                .local(false)
                .window(desktop::MAIN_WINDOW);
            for permission in BRIDGE_PERMISSIONS {
                capability = capability.permission(*permission);
            }
            app.add_capability(capability)?;
            app.manage(instance.clone());
            app.manage(Arc::new(extensions::Extensions::new(
                data_dir.clone(),
                instance.app_url.clone(),
            )));
            // до создания окна: его события сразу приходят сюда
            app.manage(Arc::new(memory::MemorySaver::new(memory::Settings::load(
                &data_dir,
            ))));
            memory::MemorySaver::start(app.handle());
            // до создания окна: оно отдаёт картинки эмодзи из этих наборов
            let emoji_dir = data_dir.join(emoji_packs::DIR);
            app.manage(Arc::new(emoji_packs::EmojiPacks::new(emoji_dir)));
            // избранные GIF «Quality of Life»: список и превью
            let gifs_dir = data_dir.join(favorite_gifs::DIR);
            app.manage(Arc::new(favorite_gifs::FavoriteGifs::new(gifs_dir)));

            // окно создаётся здесь, а не по tauri.conf.json: адрес, рамка,
            // аппаратное ускорение и запуск в трее берутся из настроек
            let desktop = Arc::new(desktop::Desktop::new(data_dir));
            app.manage(desktop.clone());
            desktop::create_main_window(app.handle(), &desktop, &instance)?;
            if let Err(error) = desktop::create_tray(app.handle()) {
                tracing::warn!(%error, "значок в трее не создан");
            }
            if desktop.config().discord_rpc {
                desktop::start_discord(&desktop);
            }
            extensions::start_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop::native_minimise,
            desktop::native_maximise,
            desktop::native_close,
            desktop::desktop_config_set,
            desktop::desktop_autostart_get,
            desktop::desktop_autostart_set,
            desktop::set_tray_labels,
            extensions::extensions_styles,
            extensions::set_plugin_menu,
            extensions::extensions_overview,
            extensions::extensions_set_theme,
            extensions::extensions_set_theme_value,
            extensions::extensions_reset_theme,
            extensions::extensions_set_plugin,
            extensions::extensions_open,
            extensions::extensions_quick_css,
            extensions::extensions_set_quick_css,
            extensions::extensions_set_plugin_value,
            extensions::extensions_reset_plugin,
            extensions::plugin_storage_get,
            extensions::plugin_storage_set,
            extensions::plugin_native_call,
            extensions::plugin_fetch,
            emoji_packs::emoji_packs,
            emoji_packs::emoji_pack_download,
            emoji_packs::emoji_pack_cancel,
            emoji_packs::emoji_pack_delete,
            favorite_gifs::favorite_gifs_list,
            favorite_gifs::favorite_gifs_add,
            favorite_gifs::favorite_gifs_describe,
            favorite_gifs::favorite_gifs_remove,
            favorite_gifs::favorite_gifs_move,
            favorite_gifs::favorite_gifs_sent,
            favorite_gifs::favorite_gifs_set_preview,
            favorite_gifs::favorite_gifs_resolve,
            favorite_gifs::favorite_gifs_download,
        ])
        .run(context)
        .expect("ошибка запуска Tauri-приложения");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Уникальное имя временного каталога для теста.
    fn temp_dir(name: &str) -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("arachnid-client-{name}-{nanos:x}"))
    }

    #[test]
    fn legacy_dir_moves_only_once() {
        let root = temp_dir("migrate");
        let old = root.join(LEGACY_IDENTIFIER);
        let new = root.join("com.arachnid.client");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("marker"), "1").unwrap();

        assert!(move_dir_if_absent(&old, &new).unwrap());
        assert!(new.join("marker").is_file());
        assert!(!old.exists());

        // новый каталог уже есть — старый (если вдруг появился) не трогаем
        std::fs::create_dir_all(&old).unwrap();
        assert!(!move_dir_if_absent(&old, &new).unwrap());
        assert!(old.is_dir());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn portable_layout_is_created() {
        let dir = temp_dir("layout");
        ensure_layout(&dir).unwrap();
        assert!(dir.join("logs").is_dir());
        assert!(dir.join("themes").is_dir());
        assert!(dir.join("plugins").is_dir());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bridge_permissions_match_build_script() {
        // build.rs перечисляет команды, lib.rs — права на них
        let build = include_str!("../build.rs");
        for permission in BRIDGE_PERMISSIONS {
            let Some(command) = permission.strip_prefix("allow-") else {
                continue;
            };
            let command = command.replace('-', "_");
            assert!(
                build.contains(&format!("\"{command}\"")),
                "команды {command} нет в build.rs"
            );
        }
    }
}
