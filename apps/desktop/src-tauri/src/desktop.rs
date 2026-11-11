//! Раздел «ПК»: окно, трей, автозапуск, Discord RPC и уведомления.
//!
//! Повторяет Stoat for Desktop (`src/native/config.ts`, `window.ts`,
//! `tray.ts`, `autoLaunch.ts`, `discordRpc.ts`) и его раздел настроек
//! `Native.tsx`. Настройки лежат в `desktop.json` каталога данных: часть из
//! них (рамка окна, аппаратное ускорение) нужна до создания окна, когда
//! webview и его хранилище ещё недоступны.

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
use tauri::{AppHandle, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;

use crate::{CmdResult, CommandError};

/// Метка главного окна (как в `tauri.conf.json`).
pub const MAIN_WINDOW: &str = "main";

/// Аргумент, с которым систему просят запускать клиент при входе.
pub const HIDDEN_ARG: &str = "--hidden";

/// Файл настроек в каталоге данных.
const CONFIG_FILE: &str = "desktop.json";

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
    /// Своя строка заголовка вместо системной рамки
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
            custom_frame: true,
            minimise_to_tray: true,
            start_minimised_to_tray: false,
            spellchecker: true,
            hardware_acceleration: true,
            discord_rpc: true,
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

/// Изменение из раздела «ПК»: только присланные поля.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPatch {
    autostart: Option<bool>,
    custom_frame: Option<bool>,
    minimise_to_tray: Option<bool>,
    start_minimised_to_tray: Option<bool>,
    spellchecker: Option<bool>,
    hardware_acceleration: Option<bool>,
    discord_rpc: Option<bool>,
}

/// Подписи пунктов меню трея на языке интерфейса.
#[derive(Debug, Clone, Deserialize)]
pub struct TrayLabels {
    /// «Версия»
    pub version: String,
    /// «Показать приложение»
    pub show: String,
    /// «Скрыть приложение»
    pub hide: String,
    /// «Выйти из приложения»
    pub quit: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            version: "Версия".into(),
            show: "Показать приложение".into(),
            hide: "Скрыть приложение".into(),
            quit: "Выйти из приложения".into(),
        }
    }
}

/// Состояние «ПК», общее для команд и обработчиков окна.
pub struct Desktop {
    dir: PathBuf,
    config: Mutex<DesktopConfig>,
    /// Аппаратное ускорение, с которым запущен текущий процесс
    started_with_acceleration: bool,
    /// Выход через трей: закрытие окна больше не прячет его
    quitting: AtomicBool,
    discord: Mutex<Option<Sender<()>>>,
    tray: Mutex<Option<TrayIcon>>,
    labels: Mutex<TrayLabels>,
}

impl Desktop {
    /// Прочитать настройки из каталога данных.
    pub fn new(dir: PathBuf) -> Self {
        let config = DesktopConfig::load(&dir);
        Self {
            started_with_acceleration: config.hardware_acceleration,
            config: Mutex::new(config),
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

    fn update(&self, change: impl FnOnce(&mut DesktopConfig)) -> DesktopConfig {
        let Ok(mut config) = self.config.lock() else {
            return DesktopConfig::default();
        };
        change(&mut config);
        if let Err(error) = config.save(&self.dir) {
            tracing::warn!(%error, "не удалось сохранить desktop.json");
        }
        config.clone()
    }

    /// Запомнить положение окна (вызывается при перемещении и закрытии).
    fn remember_window(&self, window: &WebviewWindow) {
        let maximised = window.is_maximized().unwrap_or(false);
        let minimised = window.is_minimized().unwrap_or(false);
        let Ok(mut config) = self.config.lock() else {
            return;
        };
        config.window_state.is_maximised = maximised;
        // у свёрнутого и развёрнутого окна размеры не те, что надо вернуть
        if maximised || minimised {
            return;
        }
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
            config.window_state.x = position.x;
            config.window_state.y = position.y;
            config.window_state.width = size.width;
            config.window_state.height = size.height;
        }
    }

    fn persist(&self) {
        if let Ok(config) = self.config.lock()
            && let Err(error) = config.save(&self.dir)
        {
            tracing::warn!(%error, "не удалось сохранить desktop.json");
        }
    }
}

// ─────────────────────────────────── окно ───────────────────────────────────

/// Создать главное окно по настройкам «ПК».
///
/// В `tauri.conf.json` у окна `create: false`: рамку, аппаратное ускорение
/// и видимость при запуске нужно задать до появления окна.
pub fn create_main_window(app: &AppHandle, desktop: &Desktop) -> tauri::Result<WebviewWindow> {
    let config = desktop.config();
    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .cloned()
        .unwrap_or_default();

    let hidden = config.start_minimised_to_tray && std::env::args().any(|arg| arg == HIDDEN_ARG);

    let mut builder = tauri::WebviewWindowBuilder::from_config(app, &window_config)?
        .decorations(!config.custom_frame)
        .visible(false);

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
                refresh_tray(app);
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => desktop.remember_window(&webview),
        _ => {}
    }
}

/// Показать окно поверх остальных (трей, второй запуск).
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
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
            _ => {}
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
    Menu::with_items(app, &[&title, &version, &separator, &toggle, &quit])
}

/// Пересобрать меню трея: «Показать» и «Скрыть» зависят от окна.
fn refresh_tray(app: &AppHandle) {
    let desktop = app.state::<Arc<Desktop>>();
    let Ok(slot) = desktop.tray.lock() else {
        return;
    };
    if let Some(tray) = slot.as_ref() {
        match tray_menu(app) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(error) => tracing::warn!(%error, "меню трея не обновилось"),
        }
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

/// Настройки «ПК» для раздела настроек.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopView {
    #[serde(flatten)]
    config: DesktopConfig,
    /// Запуск вместе с системой
    autostart: bool,
    /// Аппаратное ускорение изменено и ждёт перезапуска
    restart_required: bool,
    /// Версия клиента
    version: &'static str,
}

fn view(app: &AppHandle, desktop: &Desktop) -> DesktopView {
    let config = desktop.config();
    DesktopView {
        restart_required: config.hardware_acceleration != desktop.started_with_acceleration,
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        config,
        version: env!("CARGO_PKG_VERSION"),
    }
}

/// Настройки «ПК».
#[tauri::command]
pub fn desktop_config(app: AppHandle, desktop: State<'_, Arc<Desktop>>) -> DesktopView {
    view(&app, &desktop)
}

/// Изменить настройки «ПК» и сразу применить то, что можно без перезапуска.
#[tauri::command]
pub fn set_desktop_config(
    patch: DesktopPatch,
    app: AppHandle,
    desktop: State<'_, Arc<Desktop>>,
) -> CmdResult<DesktopView> {
    if let Some(enabled) = patch.autostart {
        let manager = app.autolaunch();
        let result = if enabled {
            manager.enable()
        } else {
            manager.disable()
        };
        result.map_err(|error| CommandError::new("autostart", format!("автозапуск: {error}")))?;
    }

    let config = desktop.update(|config| {
        if let Some(value) = patch.custom_frame {
            config.custom_frame = value;
        }
        if let Some(value) = patch.minimise_to_tray {
            config.minimise_to_tray = value;
        }
        if let Some(value) = patch.start_minimised_to_tray {
            config.start_minimised_to_tray = value;
        }
        if let Some(value) = patch.spellchecker {
            config.spellchecker = value;
        }
        if let Some(value) = patch.hardware_acceleration {
            config.hardware_acceleration = value;
        }
        if let Some(value) = patch.discord_rpc {
            config.discord_rpc = value;
        }
    });

    if patch.custom_frame.is_some()
        && let Some(window) = app.get_webview_window(MAIN_WINDOW)
    {
        let _ = window.set_decorations(!config.custom_frame);
    }
    if patch.discord_rpc.is_some() {
        if config.discord_rpc {
            start_discord(&desktop);
        } else {
            stop_discord(&desktop);
        }
    }
    Ok(view(&app, &desktop))
}

/// Перевести меню трея на язык интерфейса.
#[tauri::command]
pub fn set_tray_labels(labels: TrayLabels, app: AppHandle, desktop: State<'_, Arc<Desktop>>) {
    if let Ok(mut current) = desktop.labels.lock() {
        *current = labels;
    }
    refresh_tray(&app);
}

/// Перезапустить клиент (после смены аппаратного ускорения).
#[tauri::command]
pub fn restart_app(app: AppHandle, desktop: State<'_, Arc<Desktop>>) {
    desktop.quitting.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        desktop.remember_window(&window);
    }
    desktop.persist();
    stop_discord(&desktop);
    app.restart();
}

/// Уведомление о сообщении («Включить уведомления на рабочем столе»).
#[tauri::command]
pub fn notify(title: String, body: String, app: AppHandle) -> CmdResult<()> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| CommandError::new("notification", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_stoat_for_desktop() {
        let config = DesktopConfig::default();
        assert!(config.custom_frame);
        assert!(config.minimise_to_tray);
        assert!(!config.start_minimised_to_tray);
        assert!(config.spellchecker);
        assert!(config.hardware_acceleration);
        assert!(config.discord_rpc);
    }

    #[test]
    fn missing_fields_take_defaults() {
        let config: DesktopConfig = serde_json::from_str(r#"{"discordRpc":false}"#).unwrap();
        assert!(!config.discord_rpc);
        assert!(config.custom_frame);
        assert_eq!(config.window_state, WindowState::default());
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
