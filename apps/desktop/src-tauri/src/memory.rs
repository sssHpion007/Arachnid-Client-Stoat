//! Экономия памяти, пока окно в фоне (Windows, WebView2).
//!
//! WebView2 сам умеет отдавать память системе, если приложение сообщает,
//! что его не видно: `ICoreWebView2_19::MemoryUsageTargetLevel = Low`.
//! Движок сбрасывает кэши и вытесняет неиспользуемое в файл подкачки;
//! страница при этом продолжает работать (сообщения, уведомления, звонок),
//! не перезагружается и не приостанавливается.
//!
//! Когда переходить в экономный режим:
//!
//! * окно свёрнуто или спрятано в трей — через 20 секунд, чтобы быстрое
//!   «свернуть и тут же вернуть» не трогало память;
//! * по желанию — окно 2 минуты без фокуса (`unfocused = true`).
//!
//! Как только окно показали (или оно получило фокус), обычный режим
//! возвращается сразу. Окно, которое ещё ни разу не показывали (запуск в
//! трее), не трогается: страница в нём только загружается.
//!
//! Настройка — раздел `[memory]` файла `config.toml`:
//!
//! ```toml
//! [memory]
//! background = true   # экономить память, пока окно свёрнуто или в трее
//! unfocused = false   # ещё и когда окно 2 минуты без фокуса
//! ```
//!
//! WebView2 Runtime старше 1.0.1722.45 этого не умеет: тогда режим просто
//! не меняется (запись в журнале одна).

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::webview::PlatformWebview;
use tauri::{AppHandle, Manager};

use crate::desktop::MAIN_WINDOW;
use crate::instance::CONFIG_FILE;

/// Через сколько после сворачивания или скрытия в трей экономить память.
const BACKGROUND_DELAY: Duration = Duration::from_secs(20);
/// Через сколько без фокуса экономить память (`unfocused = true`).
const UNFOCUSED_DELAY: Duration = Duration::from_secs(120);

/// Раздел `[memory]` файла `config.toml`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Экономить память, пока окно свёрнуто или спрятано в трей
    pub background: bool,
    /// Экономить память, когда окно 2 минуты без фокуса
    pub unfocused: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            background: true,
            unfocused: false,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ConfigFile {
    memory: Settings,
}

impl Settings {
    /// Прочитать `config.toml`; без файла или с ошибкой — по умолчанию
    /// (ошибку в файле журналирует [`crate::instance::Instance::load`]).
    pub fn load(dir: &Path) -> Self {
        std::fs::read_to_string(dir.join(CONFIG_FILE))
            .map(|text| Self::parse(&text))
            .unwrap_or_default()
    }

    fn parse(text: &str) -> Self {
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        toml::from_str::<ConfigFile>(text)
            .map(|file| file.memory)
            .unwrap_or_default()
    }
}

/// Задание потоку-таймеру.
enum Command {
    /// Перейти в экономный режим через `delay`, если окно за это время не
    /// вернётся (`generation` не изменится)
    Schedule { delay: Duration, generation: u64 },
    /// Окно вернулось: ждать нечего
    Cancel,
}

/// Режим памяти главного окна.
pub struct MemorySaver {
    settings: Settings,
    /// Растёт каждый раз, когда окно возвращается: отложенный переход,
    /// назначенный раньше, устаревает
    generation: AtomicU64,
    /// Сейчас включён экономный режим
    low: AtomicBool,
    /// Окно хоть раз показывали
    shown: AtomicBool,
    /// Таймер назначен
    pending: AtomicBool,
    /// WebView2 не умеет менять режим (старый Runtime)
    unsupported: AtomicBool,
    timer: Mutex<Option<Sender<Command>>>,
}

impl MemorySaver {
    /// Режим по настройкам `config.toml`.
    pub fn new(settings: Settings) -> Self {
        Self {
            settings,
            generation: AtomicU64::new(0),
            low: AtomicBool::new(false),
            shown: AtomicBool::new(false),
            pending: AtomicBool::new(false),
            unsupported: AtomicBool::new(false),
            timer: Mutex::new(None),
        }
    }

    /// Работает ли экономия вообще: только WebView2 и только если её не
    /// выключили.
    fn active(&self) -> bool {
        cfg!(windows)
            && (self.settings.background || self.settings.unfocused)
            && !self.unsupported.load(Ordering::SeqCst)
    }

    /// Запустить поток-таймер.
    pub fn start(app: &AppHandle) {
        let saver = app.state::<Arc<MemorySaver>>().inner().clone();
        tracing::info!(
            background = saver.settings.background,
            unfocused = saver.settings.unfocused,
            supported = cfg!(windows),
            "экономия памяти в фоне"
        );
        if !saver.active() {
            return;
        }
        let (sender, receiver) = mpsc::channel();
        let handle = app.clone();
        let spawned = std::thread::Builder::new()
            .name("memory-saver".into())
            .spawn(move || timer_loop(&handle, &receiver));
        match spawned {
            Ok(_) => {
                if let Ok(mut timer) = saver.timer.lock() {
                    *timer = Some(sender);
                }
            }
            Err(error) => tracing::warn!(%error, "поток экономии памяти не запустился"),
        }
    }

    fn send(&self, command: Command) {
        if let Ok(timer) = self.timer.lock()
            && let Some(sender) = timer.as_ref()
        {
            let _ = sender.send(command);
        }
    }

    fn schedule(&self, delay: Duration) {
        if !self.active() || !self.shown.load(Ordering::SeqCst) {
            return;
        }
        self.pending.store(true, Ordering::SeqCst);
        let generation = self.generation.load(Ordering::SeqCst);
        self.send(Command::Schedule { delay, generation });
    }

    /// Окно свёрнуто или спрятано в трей.
    pub fn backgrounded(&self) {
        if self.settings.background {
            self.schedule(BACKGROUND_DELAY);
        }
    }

    /// Окно потеряло фокус.
    pub fn unfocused(&self) {
        if self.settings.unfocused {
            self.schedule(UNFOCUSED_DELAY);
        }
    }

    /// Окно показали, развернули или оно получило фокус: обычный режим
    /// сразу.
    pub fn foreground(app: &AppHandle) {
        let saver = app.state::<Arc<MemorySaver>>().inner().clone();
        saver.shown.store(true, Ordering::SeqCst);
        saver.generation.fetch_add(1, Ordering::SeqCst);
        if saver.pending.swap(false, Ordering::SeqCst) {
            saver.send(Command::Cancel);
        }
        if !saver.low.load(Ordering::SeqCst) {
            return;
        }
        let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
            return;
        };
        let target = saver.clone();
        let result = window.with_webview(move |webview| {
            if target.low.swap(false, Ordering::SeqCst) && target.apply(&webview, false) {
                tracing::info!("окно на экране: обычный режим памяти WebView2");
            }
        });
        if let Err(error) = result {
            tracing::warn!(%error, "режим памяти не изменён");
        }
    }

    /// Таймер сработал: экономный режим, если окно так и не вернулось.
    fn enter_low(app: &AppHandle, generation: u64) {
        let saver = app.state::<Arc<MemorySaver>>().inner().clone();
        let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
            return;
        };
        let target = saver.clone();
        let result = window.with_webview(move |webview| {
            // выполняется в главном потоке, после событий окна: если окно
            // успело вернуться, поколение уже другое
            if target.generation.load(Ordering::SeqCst) != generation
                || target.low.load(Ordering::SeqCst)
            {
                return;
            }
            target.pending.store(false, Ordering::SeqCst);
            if target.apply(&webview, true) {
                target.low.store(true, Ordering::SeqCst);
                tracing::info!("окно в фоне: экономный режим памяти WebView2");
            }
        });
        if let Err(error) = result {
            tracing::warn!(%error, "режим памяти не изменён");
        }
    }

    /// Сообщить WebView2 режим; `false` — не получилось.
    fn apply(&self, webview: &PlatformWebview, low: bool) -> bool {
        match set_target_level(webview, low) {
            Ok(()) => true,
            Err(LevelError::Unsupported) => {
                if !self.unsupported.swap(true, Ordering::SeqCst) {
                    tracing::info!(
                        "WebView2 Runtime не умеет MemoryUsageTargetLevel (нужен 1.0.1722.45+), экономия памяти выключена"
                    );
                }
                false
            }
            Err(LevelError::Failed(error)) => {
                tracing::warn!(%error, "WebView2 не принял режим памяти");
                false
            }
        }
    }
}

/// Поток-таймер: ждёт назначенный срок; новое задание заменяет старое, но
/// не откладывает уже назначенный более ранний переход того же поколения
/// (свернули окно, а потом оно ещё и потеряло фокус).
fn timer_loop(app: &AppHandle, receiver: &mpsc::Receiver<Command>) {
    let mut pending: Option<(Instant, u64)> = None;
    loop {
        let message = match pending {
            Some((deadline, _)) => {
                receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            }
            None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match message {
            Ok(Command::Schedule { delay, generation }) => {
                let deadline = Instant::now() + delay;
                pending = Some(match pending {
                    Some((earlier, same)) if same == generation && earlier <= deadline => {
                        (earlier, same)
                    }
                    _ => (deadline, generation),
                });
            }
            Ok(Command::Cancel) => pending = None,
            Err(RecvTimeoutError::Timeout) => {
                if let Some((_, generation)) = pending.take() {
                    MemorySaver::enter_low(app, generation);
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Почему режим не изменился.
#[cfg_attr(not(windows), allow(dead_code))]
enum LevelError {
    /// Нет `ICoreWebView2_19` (старый Runtime) или это не WebView2
    Unsupported,
    /// WebView2 вернул ошибку
    Failed(String),
}

/// `ICoreWebView2_19::put_MemoryUsageTargetLevel`.
#[cfg(windows)]
fn set_target_level(webview: &PlatformWebview, low: bool) -> Result<(), LevelError> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        ICoreWebView2_19,
    };
    use windows_core::Interface;

    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    // SAFETY: вызовы COM в главном потоке (with_webview), контроллер жив,
    // пока существует окно
    unsafe {
        let core = webview
            .controller()
            .CoreWebView2()
            .map_err(|error| LevelError::Failed(error.to_string()))?;
        let core = core
            .cast::<ICoreWebView2_19>()
            .map_err(|_| LevelError::Unsupported)?;
        core.SetMemoryUsageTargetLevel(level)
            .map_err(|error| LevelError::Failed(error.to_string()))
    }
}

/// WebKitGTK и WKWebView такого режима не дают.
#[cfg(not(windows))]
fn set_target_level(_webview: &PlatformWebview, _low: bool) -> Result<(), LevelError> {
    Err(LevelError::Unsupported)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_saving_is_on_by_default() {
        assert_eq!(
            Settings::parse("[instance]\napp_url = \"https://stoat.chat/app\"\n"),
            Settings {
                background: true,
                unfocused: false
            }
        );
    }

    #[test]
    fn settings_are_read_from_config() {
        let settings = Settings::parse("\u{feff}[memory]\nbackground = false\nunfocused = true\n");
        assert!(!settings.background);
        assert!(settings.unfocused);
        // ошибка в файле не мешает запуску
        assert_eq!(Settings::parse("[memory\n"), Settings::default());
    }
}
