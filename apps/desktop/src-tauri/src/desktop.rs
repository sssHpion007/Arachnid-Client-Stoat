//! Нативный слой: окно, трей, автозапуск, Discord RPC и мост к веб-клиенту.
//!
//! Повторяет Stoat for Desktop (`src/native/config.ts`, `window.ts`,
//! `tray.ts`, `autoLaunch.ts`, `discordRpc.ts`, `src/world/*.ts`).
//! Интерфейс — официальный веб-клиент Stoat (for-web), который открывается
//! в окне как есть; его раздел настроек «ПК» работает через
//! `window.native` и `window.desktopConfig` (см. `bridge.js`).
//!
//! Настройки лежат в `desktop.json` каталога данных: часть из них (рамка
//! окна, аппаратное ускорение) нужна до создания окна, когда webview и его
//! хранилище ещё недоступны.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use discord_rich_presence::activity::{Activity, Assets, Button};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;

use crate::emoji_packs::{self, EmojiPacks};
use crate::instance::Instance;
use crate::memory::MemorySaver;
use crate::{CmdResult, CommandError, extensions, icon, media};

/// Метка главного окна (как в `tauri.conf.json`).
pub const MAIN_WINDOW: &str = "main";

/// Аргумент, с которым систему просят запускать клиент при входе.
pub const HIDDEN_ARG: &str = "--hidden";

/// Файл настроек в каталоге данных.
const CONFIG_FILE: &str = "desktop.json";

/// Профиль webview (вход, кэш, настройки веб-клиента) в каталоге данных:
/// portable-папку можно перенести вместе с сессией.
const WEBVIEW_DIR: &str = "webview";

/// Мост `window.native` / `window.desktopConfig` для веб-клиента.
const BRIDGE_SCRIPT: &str = include_str!("bridge.js");

/// Раздел «Плагины», выбор темы в «Внешнем виде» и подпись Arachnid Client в
/// настройках веб-клиента; выполняется после моста.
const SETTINGS_SCRIPT: &str = include_str!("settings.js");

/// Значения Arachnid Client для настроек веб-клиента (набор эмодзи Twemoji),
/// записываются до того, как for-web их прочитает.
const DEFAULTS_SCRIPT: &str = include_str!("defaults.js");

/// Разделы и «Часто используемые» в окне выбора эмодзи, как в Discord.
const EMOJI_SCRIPT: &str = include_str!("emoji.js");

/// Приложение Discord, от имени которого показывается статус (`discordRpc.ts`).
const DISCORD_CLIENT_ID: &str = "872068124005007420";

/// Как часто пробовать подключиться к Discord, если он не запущен.
const DISCORD_RETRY: Duration = Duration::from_secs(10);

/// Аргументы WebView2, которые Tauri ставит сам: при своих аргументах их
/// нужно передать явно, иначе включатся встроенные меню Edge.
#[cfg(windows)]
const WEBVIEW2_DEFAULT_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// Положение и размер окна (`windowState`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowState {
    /// Левый край, физические пиксели
    pub x: i32,
    /// Верхний край
    pub y: i32,
    /// Ширина (0 — по умолчанию)
    pub width: u32,
    /// Высота
    pub height: u32,
    /// Окно развёрнуто
    pub is_maximised: bool,
}

/// Настройки раздела «ПК» (`DesktopConfig` в Stoat for Desktop).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopConfig {
    /// Первый запуск (сбрасывается после него, как в Stoat for Desktop)
    pub first_launch: bool,
    /// Своя строка заголовка вместо системной рамки (после перезапуска)
    pub custom_frame: bool,
    /// Закрытие окна прячет его в трей
    pub minimise_to_tray: bool,
    /// При автозапуске сразу прятаться в трей
    pub start_minimised_to_tray: bool,
    /// Проверка орфографии в полях ввода
    pub spellchecker: bool,
    /// Аппаратное ускорение webview (действует после перезапуска)
    pub hardware_acceleration: bool,
    /// Статус «Chatting with others» в Discord
    pub discord_rpc: bool,
    /// Последнее положение окна
    pub window_state: WindowState,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            first_launch: true,
            custom_frame: true,
            minimise_to_tray: true,
            start_minimised_to_tray: false,
            spellchecker: true,
            hardware_acceleration: true,
            // как и автозапуск: статус в Discord включает сам пользователь
            discord_rpc: false,
            window_state: WindowState::default(),
        }
    }
}

impl DesktopConfig {
    /// Прочитать из каталога данных; повреждённый файл не мешает запуску.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(CONFIG_FILE);
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|error| {
                tracing::warn!(%error, "desktop.json повреждён, беру настройки по умолчанию");
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    /// Записать через временный файл, чтобы сбой не оставил половину JSON.
    fn save(&self, dir: &Path) -> std::io::Result<()> {
        let path = dir.join(CONFIG_FILE);
        let temp = dir.join(format!("{CONFIG_FILE}.tmp"));
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(&temp, text)?;
        std::fs::rename(&temp, &path)
    }
}

/// Изменение из раздела «ПК» (`desktopConfig.set`): только присланные поля.
///
/// Положение окна страница не меняет — его ведёт оболочка.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPatch {
    first_launch: Option<bool>,
    custom_frame: Option<bool>,
    minimise_to_tray: Option<bool>,
    start_minimised_to_tray: Option<bool>,
    spellchecker: Option<bool>,
    hardware_acceleration: Option<bool>,
    discord_rpc: Option<bool>,
}

impl DesktopPatch {
    fn apply(&self, config: &mut DesktopConfig) {
        let fields = [
            (self.first_launch, &mut config.first_launch),
            (self.custom_frame, &mut config.custom_frame),
            (self.minimise_to_tray, &mut config.minimise_to_tray),
            (
                self.start_minimised_to_tray,
                &mut config.start_minimised_to_tray,
            ),
            (self.spellchecker, &mut config.spellchecker),
            (
                self.hardware_acceleration,
                &mut config.hardware_acceleration,
            ),
            (self.discord_rpc, &mut config.discord_rpc),
        ];
        for (value, field) in fields {
            if let Some(value) = value {
                *field = value;
            }
        }
    }
}

/// Подписи пунктов меню трея на языке системы.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayLabels {
    /// «Версия»
    pub version: String,
    /// «Показать приложение»
    pub show: String,
    /// «Скрыть приложение»
    pub hide: String,
    /// «Выйти из приложения»
    pub quit: String,
    /// «Расширения»
    pub extensions: String,
    /// «Темы»
    pub themes: String,
    /// «Плагины»
    pub plugins: String,
    /// «Stoat (по умолчанию)»: стандартное оформление вместо темы
    pub default_theme: String,
    /// «Плагинов нет»
    pub no_plugins: String,
    /// «Открыть папку»
    pub open_folder: String,
    /// «Изменить QuickCSS»
    pub quick_css: String,
    /// «Действия плагинов» (пункты `AviaMenu`)
    pub plugin_actions: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            version: "Версия".into(),
            show: "Показать приложение".into(),
            hide: "Скрыть приложение".into(),
            quit: "Выйти из приложения".into(),
            extensions: "Расширения".into(),
            themes: "Темы".into(),
            plugins: "Плагины".into(),
            default_theme: "Stoat (по умолчанию)".into(),
            no_plugins: "Плагинов нет".into(),
            open_folder: "Открыть папку".into(),
            quick_css: "Изменить QuickCSS".into(),
            plugin_actions: "Действия плагинов".into(),
        }
    }
}

/// Состояние нативного слоя, общее для команд и обработчиков окна.
pub struct Desktop {
    dir: PathBuf,
    config: Mutex<DesktopConfig>,
    /// Выход через трей: закрытие окна больше не прячет его
    quitting: AtomicBool,
    discord: Mutex<Option<Sender<()>>>,
    tray: Mutex<Option<TrayIcon>>,
    labels: Mutex<TrayLabels>,
}

impl Desktop {
    /// Прочитать настройки из каталога данных.
    pub fn new(dir: PathBuf) -> Self {
        Self {
            config: Mutex::new(DesktopConfig::load(&dir)),
            dir,
            quitting: AtomicBool::new(false),
            discord: Mutex::new(None),
            tray: Mutex::new(None),
            labels: Mutex::new(TrayLabels::default()),
        }
    }

    /// Копия текущих настроек.
    pub fn config(&self) -> DesktopConfig {
        self.config
            .lock()
            .map(|config| config.clone())
            .unwrap_or_default()
    }

    /// Изменить и сохранить настройки.
    pub fn update(&self, change: impl FnOnce(&mut DesktopConfig)) -> DesktopConfig {
        let Ok(mut config) = self.config.lock() else {
            return DesktopConfig::default();
        };
        change(&mut config);
        if let Err(error) = config.save(&self.dir) {
            tracing::warn!(%error, "не удалось сохранить desktop.json");
        }
        config.clone()
    }

    /// Запомнить положение окна (при перемещении, изменении размера и закрытии).
    ///
    /// Возвращает `true`, если окно развернули или вернули из развёрнутого.
    fn remember_window(&self, window: &WebviewWindow) -> bool {
        let maximised = window.is_maximized().unwrap_or(false);
        let minimised = window.is_minimized().unwrap_or(false);
        let Ok(mut config) = self.config.lock() else {
            return false;
        };
        let changed = config.window_state.is_maximised != maximised;
        config.window_state.is_maximised = maximised;
        // у свёрнутого и развёрнутого окна размеры не те, что надо вернуть
        if maximised || minimised {
            return changed;
        }
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
            config.window_state.x = position.x;
            config.window_state.y = position.y;
            config.window_state.width = size.width;
            config.window_state.height = size.height;
        }
        changed
    }

    fn persist(&self) {
        if let Ok(config) = self.config.lock()
            && let Err(error) = config.save(&self.dir)
        {
            tracing::warn!(%error, "не удалось сохранить desktop.json");
        }
    }
}

// ─────────────────────────────────── мост ───────────────────────────────────

/// Версии для раздела настроек веб-клиента (`window.native.versions`).
#[derive(Debug, Serialize)]
struct Versions {
    /// Версия Arachnid Client
    desktop: &'static str,
    /// Версия Tauri
    tauri: &'static str,
    /// Версия движка webview (WebView2, WebKitGTK, WKWebView)
    webview: String,
    /// Система и архитектура
    os: String,
    /// `std::env::consts::OS`: мост по нему решает, как перетаскивать окно
    platform: &'static str,
}

impl Versions {
    fn current() -> Self {
        Self {
            desktop: env!("CARGO_PKG_VERSION"),
            tauri: tauri::VERSION,
            webview: tauri::webview_version().unwrap_or_else(|_| "?".into()),
            os: format!("{} {}", os_name(), std::env::consts::ARCH),
            platform: std::env::consts::OS,
        }
    }
}

fn os_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        other => other,
    }
}

/// Скрипт моста с подставленными настройками, версиями и адресом клиента.
fn bridge_script(config: &DesktopConfig, instance: &Instance) -> String {
    BRIDGE_SCRIPT
        .replace("__ARACHNID_ORIGIN__", &js_literal(&instance.origin()))
        .replace("__ARACHNID_CONFIG__", &js_literal(config))
        .replace("__ARACHNID_VERSIONS__", &js_literal(&Versions::current()))
}

/// Значение для подстановки в скрипт: JSON — корректный литерал JavaScript.
fn js_literal<T: Serialize + ?Sized>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

/// Сообщить странице новые настройки (например, окно развернули из системы).
fn push_config(window: &WebviewWindow, config: &DesktopConfig) {
    let json = js_literal(config);
    let _ = window.eval(format!(
        "window.__arachnidDesktop && window.__arachnidDesktop.update({json});"
    ));
}

/// Открыть ссылку в системном браузере или почтовой программе.
fn open_external(url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return;
    }
    if let Err(error) = open::that_detached(url.as_str()) {
        tracing::warn!(%error, "не удалось открыть ссылку");
    }
}

// ─────────────────────────────────── окно ───────────────────────────────────

/// Создать главное окно по настройкам «ПК».
///
/// В `tauri.conf.json` у окна `create: false`: адрес веб-клиента берётся из
/// `config.toml`, а рамка, аппаратное ускорение и видимость при запуске —
/// из настроек «ПК», и всё это нужно задать до появления окна.
pub fn create_main_window(
    app: &AppHandle,
    desktop: &Desktop,
    instance: &Instance,
) -> tauri::Result<WebviewWindow> {
    let config = desktop.config();
    let mut window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .cloned()
        .unwrap_or_default();
    window_config.url = WebviewUrl::External(instance.app_url.clone());

    let hidden = config.start_minimised_to_tray && std::env::args().any(|arg| arg == HIDDEN_ARG);
    let guard = instance.clone();

    let mut builder = tauri::WebviewWindowBuilder::from_config(app, &window_config)?
        .decorations(!config.custom_frame)
        .visible(false)
        .data_directory(desktop.dir.join(WEBVIEW_DIR))
        .initialization_script(bridge_script(&config, instance))
        .initialization_script(SETTINGS_SCRIPT)
        .initialization_script(DEFAULTS_SCRIPT)
        .initialization_script(EMOJI_SCRIPT)
        // как `will-navigate` в Stoat for Desktop: окно не уходит с клиента
        .on_navigation(move |url| {
            let allowed = guard.owns(url);
            if !allowed {
                tracing::info!(%url, "переход с клиента заблокирован");
            }
            allowed
        })
        // как `setWindowOpenHandler`: ссылки открываются в системе
        .on_new_window(|url, _features| {
            open_external(&url);
            NewWindowResponse::Deny
        })
        // включённые плагины — после загрузки страницы клиента
        .on_page_load(extensions::on_page_load);

    #[cfg(windows)]
    if !config.hardware_acceleration {
        builder =
            builder.additional_browser_args(&format!("{WEBVIEW2_DEFAULT_ARGS} --disable-gpu"));
    }

    let state = &config.window_state;
    if state.width >= 300 && state.height >= 300 {
        builder = builder
            .center()
            .inner_size(f64::from(state.width), f64::from(state.height));
    }

    let window = builder.build()?;
    icon::apply_window(&window);
    media::allow_for_client(&window, instance);
    emoji_packs::serve(&window, Arc::clone(&app.state::<Arc<EmojiPacks>>()));

    // положение — в физических пикселях, как и сохранено
    if state.width >= 300 && state.height >= 300 && on_screen(&window, state) {
        let _ = window.set_size(tauri::PhysicalSize::new(state.width, state.height));
        let _ = window.set_position(tauri::PhysicalPosition::new(state.x, state.y));
    }
    if state.is_maximised && !hidden {
        let _ = window.maximize();
    }
    if !hidden {
        let _ = window.show();
        MemorySaver::foreground(app);
    }

    // как в Stoat for Desktop: признак первого запуска сбрасывается сразу
    if config.first_launch {
        desktop.update(|config| config.first_launch = false);
    }
    Ok(window)
}

/// Попадает ли сохранённое окно на один из мониторов: монитор могли отключить.
fn on_screen(window: &WebviewWindow, state: &WindowState) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    monitors.iter().any(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        let right = position.x + size.width as i32;
        let bottom = position.y + size.height as i32;
        // хватит того, что заголовок окна виден
        state.x + 64 > position.x
            && state.x < right - 64
            && state.y >= position.y - 8
            && state.y < bottom - 32
    })
}

/// События окна: закрытие в трей и запоминание положения.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    let app = window.app_handle();
    let desktop = app.state::<Arc<Desktop>>();
    let Some(webview) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            desktop.remember_window(&webview);
            desktop.persist();
            if desktop.config().minimise_to_tray && !desktop.quitting.load(Ordering::SeqCst) {
                api.prevent_close();
                let _ = webview.hide();
                app.state::<Arc<MemorySaver>>().backgrounded();
                refresh_tray(app);
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let maximised_changed = desktop.remember_window(&webview);
            // строка заголовка for-web показывает «Развернуть» или «Восстановить»
            if maximised_changed {
                push_config(&webview, &desktop.config());
            }
            if matches!(event, WindowEvent::Resized(_)) {
                // сворачивание и возврат из свёрнутого приходят как Resized
                if webview.is_minimized().unwrap_or(false) {
                    app.state::<Arc<MemorySaver>>().backgrounded();
                } else if webview.is_visible().unwrap_or(false) {
                    MemorySaver::foreground(app);
                }
            }
        }
        // на мониторе с другим масштабом нужны кадры значка другого размера
        WindowEvent::ScaleFactorChanged { .. } => icon::apply_window(&webview),
        WindowEvent::Focused(true) => MemorySaver::foreground(app),
        WindowEvent::Focused(false) => app.state::<Arc<MemorySaver>>().unfocused(),
        _ => {}
    }
}

/// Показать окно поверх остальных (трей, второй запуск).
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        MemorySaver::foreground(app);
    }
    refresh_tray(app);
}

/// Выйти по-настоящему, даже если закрытие прячет окно в трей.
fn quit(app: &AppHandle) {
    let desktop = app.state::<Arc<Desktop>>();
    desktop.quitting.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        desktop.remember_window(&window);
    }
    desktop.persist();
    stop_discord(&desktop);
    app.exit(0);
}

// ─────────────────────────────────── трей ───────────────────────────────────

/// Значок в трее (`tray.ts`): щелчок прячет и показывает окно.
pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app)?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Arachnid Client")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => toggle_window(app),
            "quit" => quit(app),
            id => extensions::on_menu(app, id),
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    icon::apply_tray(&tray);
    if let Ok(mut slot) = app.state::<Arc<Desktop>>().tray.lock() {
        *slot = Some(tray);
    }
    Ok(())
}

fn toggle_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        app.state::<Arc<MemorySaver>>().backgrounded();
        refresh_tray(app);
    } else {
        show_main_window(app);
    }
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let desktop = app.state::<Arc<Desktop>>();
    let labels = desktop
        .labels
        .lock()
        .map(|labels| labels.clone())
        .unwrap_or_default();
    let visible = app
        .get_webview_window(MAIN_WINDOW)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(true);

    let title = MenuItem::with_id(app, "title", "Arachnid Client", false, None::<&str>)?;
    let version_item = MenuItem::with_id(
        app,
        "version_number",
        env!("CARGO_PKG_VERSION"),
        false,
        None::<&str>,
    )?;
    let version = Submenu::with_items(app, &labels.version, true, &[&version_item])?;
    let separator = PredefinedMenuItem::separator(app)?;
    let toggle = MenuItem::with_id(
        app,
        "toggle",
        if visible { &labels.hide } else { &labels.show },
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", &labels.quit, true, None::<&str>)?;
    let extensions_menu = extensions::tray_submenu(app, &labels)?;
    let second_separator = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[
            &title,
            &version,
            &separator,
            &extensions_menu,
            &second_separator,
            &toggle,
            &quit,
        ],
    )
}

/// Пересобрать меню трея: «Показать» и «Скрыть» зависят от окна, список
/// тем и плагинов — от папок.
///
/// Вызывается и из потока слежения за папками. Пункты меню создаются в
/// главном потоке, поэтому блокировка не держится, пока меню собирается:
/// иначе главный поток, ждущий её же (щелчок по трею), и этот поток ждали
/// бы друг друга.
pub fn refresh_tray(app: &AppHandle) {
    let desktop = app.state::<Arc<Desktop>>();
    let tray = desktop.tray.lock().ok().and_then(|slot| slot.clone());
    let Some(tray) = tray else {
        return;
    };
    match tray_menu(app) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(error) => tracing::warn!(%error, "меню трея не обновилось"),
    }
}

// ─────────────────────────────── Discord RPC ───────────────────────────────

/// Запустить показ статуса в Discord, если он включён.
pub fn start_discord(desktop: &Desktop) {
    let Ok(mut slot) = desktop.discord.lock() else {
        return;
    };
    if slot.is_some() {
        return;
    }
    let (stop, stopped) = mpsc::channel::<()>();
    let spawned = std::thread::Builder::new()
        .name("discord-rpc".into())
        .spawn(move || discord_loop(stopped));
    match spawned {
        Ok(_) => *slot = Some(stop),
        Err(error) => tracing::warn!(%error, "поток Discord RPC не запустился"),
    }
}

/// Убрать статус и закрыть соединение с Discord.
fn stop_discord(desktop: &Desktop) {
    if let Ok(mut slot) = desktop.discord.lock()
        && let Some(stop) = slot.take()
    {
        let _ = stop.send(());
    }
}

/// Статус как у Stoat for Desktop.
fn activity() -> Activity<'static> {
    Activity::new()
        .state("stoat.chat")
        .details("Chatting with others")
        .assets(Assets::new().large_image("qr").large_text("Join Stoat!"))
        .buttons(vec![Button::new("Join Stoat", "https://stoat.chat/")])
}

/// Держать статус, пока Discord запущен; переподключаться раз в 10 секунд.
fn discord_loop(stopped: mpsc::Receiver<()>) {
    let mut client = DiscordIpcClient::new(DISCORD_CLIENT_ID);
    let mut connected = false;
    loop {
        if !connected {
            connected = client.connect().is_ok();
            if connected {
                tracing::info!("Discord RPC подключён");
            }
        }
        // статус обновляется и как проверка связи: Discord мог закрыться
        if connected && client.set_activity(activity()).is_err() {
            tracing::info!("Discord RPC отключился");
            let _ = client.close();
            connected = false;
        }
        match stopped.recv_timeout(DISCORD_RETRY) {
            Err(RecvTimeoutError::Timeout) => continue,
            Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    if connected {
        let _ = client.clear_activity();
        let _ = client.close();
    }
}

// ─────────────────────────────────── команды ───────────────────────────────────
//
// Команды моста (`bridge.js`). Веб-клиент открыт с адреса из `config.toml`,
// поэтому доступ к ним выдаётся этому адресу при запуске (см. `lib.rs`).

/// `window.native.minimise()`
#[tauri::command]
pub fn native_minimise(window: WebviewWindow) -> CmdResult<()> {
    window.minimize().map_err(CommandError::from)
}

/// `window.native.maximise()`: развернуть или вернуть размер.
#[tauri::command]
pub fn native_maximise(window: WebviewWindow) -> CmdResult<()> {
    if window.is_maximized()? {
        window.unmaximize()?;
    } else {
        window.maximize()?;
    }
    Ok(())
}

/// `window.native.close()`: закрытие проходит через [`on_window_event`],
/// поэтому «Сворачивать в трей» соблюдается.
#[tauri::command]
pub fn native_close(window: WebviewWindow) -> CmdResult<()> {
    window.close().map_err(CommandError::from)
}

/// `window.desktopConfig.set(patch)`: сохранить и применить то, что можно
/// без перезапуска. Рамка окна и аппаратное ускорение — после перезапуска,
/// как в Stoat for Desktop.
#[tauri::command]
pub fn desktop_config_set(patch: DesktopPatch, desktop: State<'_, Arc<Desktop>>) {
    let config = desktop.update(|config| patch.apply(config));
    if patch.discord_rpc.is_some() {
        if config.discord_rpc {
            start_discord(&desktop);
        } else {
            stop_discord(&desktop);
        }
    }
}

/// `window.desktopConfig.getAutostart()`
#[tauri::command]
pub fn desktop_autostart_get(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// `window.desktopConfig.setAutostart(value)`: возвращает то, что получилось.
#[tauri::command]
pub fn desktop_autostart_set(value: bool, app: AppHandle) -> CmdResult<bool> {
    let manager = app.autolaunch();
    let result = if value {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|error| CommandError::new("autostart", format!("автозапуск: {error}")))?;
    Ok(manager.is_enabled().unwrap_or(value))
}

/// Перевести меню трея на язык системы.
#[tauri::command]
pub fn set_tray_labels(labels: TrayLabels, app: AppHandle, desktop: State<'_, Arc<Desktop>>) {
    if let Ok(mut current) = desktop.labels.lock() {
        *current = labels;
    }
    refresh_tray(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Как в Stoat for Desktop, кроме Discord RPC: он выключен до явного
    /// включения пользователем.
    #[test]
    fn defaults_of_first_launch() {
        let config = DesktopConfig::default();
        assert!(config.first_launch);
        assert!(config.custom_frame);
        assert!(config.minimise_to_tray);
        assert!(!config.start_minimised_to_tray);
        assert!(config.spellchecker);
        assert!(config.hardware_acceleration);
        assert!(!config.discord_rpc);
    }

    #[test]
    fn missing_fields_take_defaults() {
        let config: DesktopConfig = serde_json::from_str(r#"{"discordRpc":true}"#).unwrap();
        assert!(config.discord_rpc);
        assert!(config.custom_frame);
        assert_eq!(config.window_state, WindowState::default());
    }

    #[test]
    fn config_uses_names_of_web_client() {
        let value = serde_json::to_value(DesktopConfig::default()).unwrap();
        for key in [
            "firstLaunch",
            "customFrame",
            "minimiseToTray",
            "startMinimisedToTray",
            "spellchecker",
            "hardwareAcceleration",
            "discordRpc",
        ] {
            assert!(value[key].is_boolean(), "нет поля {key}");
        }
        assert_eq!(value["windowState"]["isMaximised"], false);
    }

    #[test]
    fn patch_changes_only_sent_fields() {
        // так `desktopConfig.set` присылает изменение из раздела «ПК»
        let patch: DesktopPatch =
            serde_json::from_str(r#"{"spellchecker":false,"windowState":{"x":5}}"#).unwrap();
        let mut config = DesktopConfig::default();
        patch.apply(&mut config);
        assert!(!config.spellchecker);
        assert_eq!(
            config,
            DesktopConfig {
                spellchecker: false,
                ..DesktopConfig::default()
            }
        );
    }

    #[test]
    fn bridge_gets_every_placeholder() {
        let instance = Instance::default();
        let script = bridge_script(&DesktopConfig::default(), &instance);
        assert!(!script.contains("__ARACHNID_"), "осталась метка в мосте");
        assert!(script.contains(r#"const appOrigin = "https://stoat.chat";"#));
        assert!(script.contains(r#""customFrame":true"#));
        assert!(script.contains(env!("CARGO_PKG_VERSION")));
        // в остальных скриптах подставлять нечего: они берут всё у моста
        for script in [SETTINGS_SCRIPT, DEFAULTS_SCRIPT, EMOJI_SCRIPT] {
            assert!(!script.contains("__ARACHNID_"));
        }
    }

    #[test]
    fn config_survives_round_trip() {
        let dir = std::env::temp_dir().join(format!("arachnid-desktop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = DesktopConfig {
            minimise_to_tray: false,
            window_state: WindowState {
                width: 1024,
                ..WindowState::default()
            },
            ..DesktopConfig::default()
        };
        config.save(&dir).unwrap();
        assert_eq!(DesktopConfig::load(&dir), config);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn broken_file_falls_back_to_defaults() {
        let dir =
            std::env::temp_dir().join(format!("arachnid-desktop-broken-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(CONFIG_FILE), "{ не json").unwrap();
        assert_eq!(DesktopConfig::load(&dir), DesktopConfig::default());
        std::fs::remove_dir_all(&dir).ok();
    }
}
