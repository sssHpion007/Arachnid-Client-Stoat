//! Горячие клавиши «Quality of Life» (настройка `hotkeys`): микрофон, звук,
//! камера, демонстрация экрана, выход из звонка и окно клиента — сочетанием
//! клавиш или кнопкой мыши (средней, боковыми), даже когда клиент свёрнут или
//! спрятан в трей.
//!
//! * Нажатия ловят низкоуровневые хуки Windows (`WH_KEYBOARD_LL`,
//!   `WH_MOUSE_LL`) в своём потоке: так же, как Discord, — без
//!   `RegisterHotKey`, который не знает кнопок мыши и отнимает сочетание у
//!   всех программ. Хуки стоят, только пока настройка включена и что-то
//!   назначено (хук мыши — только если назначена кнопка мыши), и сами ничего
//!   не запоминают: на каждое нажатие — сравнение с назначенными сочетаниями.
//! * Сочетание, нажатое в окне клиента, до страницы не доходит: F11, F5 или
//!   боковая кнопка мыши делают только своё действие. В других программах
//!   нажатие проходит дальше, как у Discord.
//! * Пока настройка включена, WebView2 не выполняет свои сочетания браузера
//!   (F5, F11, Ctrl+R, Ctrl+P, Ctrl+F, масштаб, F12):
//!   `ICoreWebView2AcceleratorKeyPressedEventArgs2::IsBrowserAcceleratorKeyEnabled`.
//!   Переход назад и вперёд боковыми кнопками мыши отменяет страница
//!   (`hotkeys.js`).
//! * Действия звонка выполняет страница (`hotkeys.js`): нажимает кнопки
//!   for-web в карточке звонка. Показать или спрятать окно — здесь.
//! * Назначения хранятся в `hotkeys.json` каталога данных. Сочетание
//!   записывается в разделе «Горячие клавиши» (`settings.js`): следующее
//!   нажатие ловит тот же хук, поэтому записать можно и F11, и кнопку мыши.
//!
//! Включает всё это страница: код «Quality of Life» сообщает настройку
//! командой `hotkeys_activate`, а новая страница (перезагрузка) выключает,
//! пока плагин не запустится снова.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};

use serde::{Deserialize, Serialize};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::{CmdResult, CommandError, desktop, extensions};

/// Назначения в каталоге данных.
pub const FILE: &str = "hotkeys.json";

/// Действия по порядку раздела настроек. Подписи — в `settings.js`.
pub const ACTIONS: &[&str] = &[
    "toggle_mute",
    "toggle_deafen",
    "disconnect",
    "toggle_camera",
    "toggle_screenshare",
    "toggle_window",
];

/// Показать или спрятать окно: выполняется здесь, остальные — на странице.
const WINDOW_ACTION: &str = "toggle_window";

/// Esc без модификаторов отменяет запись сочетания.
const VK_ESCAPE: u8 = 0x1B;

/// Неназначенная клавиша (как у AutoHotkey): её нажатие после проглоченного
/// сочетания с Alt или Win не даёт системе открыть меню окна или «Пуск»,
/// когда Alt или Win отпустят.
const MASK_KEY: u8 = 0xE8;

// ─────────────────────────────── сочетания ───────────────────────────────

/// Кнопка мыши, которую можно назначить. Левая и правая нужны для щелчков.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Button {
    Middle,
    /// «Назад» (XBUTTON1)
    X1,
    /// «Вперёд» (XBUTTON2)
    X2,
}

impl Button {
    fn name(self) -> &'static str {
        match self {
            Self::Middle => "middle",
            Self::X1 => "x1",
            Self::X2 => "x2",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        match name {
            "middle" => Some(Self::Middle),
            "x1" => Some(Self::X1),
            "x2" => Some(Self::X2),
            _ => None,
        }
    }
}

/// Главная клавиша сочетания: виртуальный код клавиши Windows или кнопка мыши.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Trigger {
    Key(u8),
    Mouse(Button),
}

/// Модификатор (Ctrl, Shift, Alt, Win — и левый, и правый).
fn is_modifier(vk: u8) -> bool {
    matches!(vk, 0x10..=0x12 | 0x5B | 0x5C | 0xA0..=0xA5)
}

/// Может ли клавиша быть главной в сочетании: не модификатор, не кнопка мыши
/// (коды 1–6) и не служебный код.
fn is_trigger_key(vk: u8) -> bool {
    !is_modifier(vk) && !matches!(vk, 0x00..=0x07 | MASK_KEY | 0xFF)
}

/// Зажатые модификаторы; левый и правый не различаются.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Modifiers {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub win: bool,
}

/// Назначенное сочетание.
///
/// В файле и на странице — строкой: модификаторы и главная клавиша через
/// «+», например `ctrl+shift+key:120` (Ctrl+Shift+F9) или `mouse:x1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Combo {
    pub modifiers: Modifiers,
    pub trigger: Trigger,
}

impl Combo {
    pub fn parse(code: &str) -> Option<Self> {
        let mut modifiers = Modifiers::default();
        let mut trigger = None;
        for part in code.split('+') {
            // главная клавиша — последней
            if trigger.is_some() {
                return None;
            }
            let flag = match part {
                "ctrl" => &mut modifiers.ctrl,
                "shift" => &mut modifiers.shift,
                "alt" => &mut modifiers.alt,
                "win" => &mut modifiers.win,
                _ => {
                    trigger = Some(parse_trigger(part)?);
                    continue;
                }
            };
            if *flag {
                return None;
            }
            *flag = true;
        }
        Some(Self {
            modifiers,
            trigger: trigger?,
        })
    }

    pub fn code(&self) -> String {
        let Modifiers {
            ctrl,
            shift,
            alt,
            win,
        } = self.modifiers;
        let held = [ctrl, shift, alt, win];
        let mut parts: Vec<String> = ["ctrl", "shift", "alt", "win"]
            .into_iter()
            .zip(held)
            .filter(|(_, held)| *held)
            .map(|(name, _)| name.to_owned())
            .collect();
        parts.push(match self.trigger {
            Trigger::Key(vk) => format!("key:{vk}"),
            Trigger::Mouse(button) => format!("mouse:{}", button.name()),
        });
        parts.join("+")
    }
}

fn parse_trigger(part: &str) -> Option<Trigger> {
    if let Some(vk) = part.strip_prefix("key:") {
        let vk: u8 = vk.parse().ok()?;
        return is_trigger_key(vk).then_some(Trigger::Key(vk));
    }
    Button::parse(part.strip_prefix("mouse:")?).map(Trigger::Mouse)
}

// ─────────────────────────────── нажатия ───────────────────────────────

/// Что хук сообщает клиенту.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Нажато назначенное сочетание
    Pressed(String),
    /// Записано сочетание; `None` — запись отменили (Esc)
    Recorded(Option<Combo>),
}

/// Что ловить: назначенные сочетания (пока настройка включена) и запись.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Config {
    pub combos: Vec<(Combo, String)>,
    pub recording: bool,
}

impl Config {
    /// Нужен хук клавиатуры
    pub fn keyboard(&self) -> bool {
        self.recording
            || self
                .combos
                .iter()
                .any(|(combo, _)| matches!(combo.trigger, Trigger::Key(_)))
    }

    /// Нужен хук мыши: он видит каждое движение указателя, поэтому ставится,
    /// только если назначена кнопка мыши
    pub fn mouse(&self) -> bool {
        self.recording
            || self
                .combos
                .iter()
                .any(|(combo, _)| matches!(combo.trigger, Trigger::Mouse(_)))
    }
}

/// Решение по одному нажатию или отпусканию.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Verdict {
    /// Не передавать дальше (ни странице, ни другим программам)
    pub swallow: bool,
    pub event: Option<Event>,
}

/// Сравнение нажатий с сочетаниями. Хук только передаёт сюда нажатия и
/// отпускания — без Windows, поэтому логика проверяется тестами.
#[derive(Debug, Default)]
pub struct Matcher {
    config: Config,
    /// Зажатые сейчас: повтор клавиши (автоповтор) — не новое нажатие
    held: HashSet<Trigger>,
    /// Проглоченные нажатия: их автоповтор и отпускание тоже проглатываются
    swallowed: HashSet<Trigger>,
}

impl Matcher {
    pub fn configure(&mut self, config: Config) {
        self.config = config;
    }

    /// Хуки сняты: о зажатых клавишах больше ничего не известно.
    pub fn reset(&mut self) {
        self.held.clear();
        self.swallowed.clear();
    }

    /// Может ли нажатие что-то значить: модификаторы и служебные коды хук
    /// пропускает сразу.
    pub fn relevant(trigger: Trigger) -> bool {
        match trigger {
            Trigger::Key(vk) => is_trigger_key(vk),
            Trigger::Mouse(_) => true,
        }
    }

    /// `own` — нажатие пришло в окно клиента (клавиатура — окно на переднем
    /// плане, мышь — окно под указателем).
    pub fn input(
        &mut self,
        trigger: Trigger,
        down: bool,
        modifiers: Modifiers,
        own: bool,
    ) -> Verdict {
        if !Self::relevant(trigger) {
            return Verdict::default();
        }
        if !down {
            self.held.remove(&trigger);
            return Verdict {
                swallow: self.swallowed.remove(&trigger),
                event: None,
            };
        }
        if !self.held.insert(trigger) {
            // автоповтор зажатой клавиши
            return Verdict {
                swallow: self.swallowed.contains(&trigger),
                event: None,
            };
        }
        self.swallowed.remove(&trigger);

        if self.config.recording {
            // запись — одно нажатие; клиент пришлёт новые настройки
            self.config.recording = false;
            self.swallowed.insert(trigger);
            let cancel = trigger == Trigger::Key(VK_ESCAPE) && modifiers == Modifiers::default();
            let combo = (!cancel).then_some(Combo { modifiers, trigger });
            return Verdict {
                swallow: true,
                event: Some(Event::Recorded(combo)),
            };
        }

        let Some((_, action)) = self
            .config
            .combos
            .iter()
            .find(|(combo, _)| combo.trigger == trigger && combo.modifiers == modifiers)
        else {
            return Verdict::default();
        };
        if own {
            self.swallowed.insert(trigger);
        }
        Verdict {
            swallow: own,
            event: Some(Event::Pressed(action.clone())),
        }
    }
}

// ─────────────────────────────── состояние ───────────────────────────────

/// `hotkeys.json`
#[derive(Debug, Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    bindings: BTreeMap<String, String>,
}

/// Назначения, запись и включённость; хук получает их через [`Config`].
pub struct Hotkeys {
    path: PathBuf,
    bindings: Mutex<BTreeMap<String, Combo>>,
    /// Настройка `hotkeys` включена у запущенной «Quality of Life»
    active: AtomicBool,
    /// Для какого действия записывается сочетание
    recording: Mutex<Option<String>>,
    /// `None` — без хуков (тесты)
    hook: Option<platform::Hook>,
}

impl Hotkeys {
    fn new(dir: &Path, hook: Option<platform::Hook>) -> Self {
        let path = dir.join(FILE);
        let saved: Saved = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        // неизвестные действия и испорченные сочетания пропускаются
        let bindings = saved
            .bindings
            .iter()
            .filter(|(action, _)| ACTIONS.contains(&action.as_str()))
            .filter_map(|(action, code)| Some((action.clone(), Combo::parse(code)?)))
            .collect();
        Self {
            path,
            bindings: Mutex::new(bindings),
            active: AtomicBool::new(false),
            recording: Mutex::new(None),
            hook,
        }
    }

    /// Действие → сочетание строкой.
    pub fn bindings(&self) -> BTreeMap<String, String> {
        self.bindings
            .lock()
            .map(|bindings| {
                bindings
                    .iter()
                    .map(|(action, combo)| (action.clone(), combo.code()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Назначить сочетание (`None` — убрать). Сочетание, уже назначенное
    /// другому действию, переходит к этому.
    pub fn set(&self, action: &str, combo: Option<Combo>) -> bool {
        if !ACTIONS.contains(&action) {
            return false;
        }
        let saved = {
            let Ok(mut bindings) = self.bindings.lock() else {
                return false;
            };
            match combo {
                Some(combo) => {
                    bindings.retain(|_, bound| *bound != combo);
                    bindings.insert(action.to_owned(), combo);
                }
                None => {
                    bindings.remove(action);
                }
            }
            Saved {
                bindings: bindings
                    .iter()
                    .map(|(action, combo)| (action.clone(), combo.code()))
                    .collect(),
            }
        };
        if let Err(error) = extensions::write_atomically(&self.path, &saved) {
            tracing::warn!(%error, "горячие клавиши не сохранены");
        }
        self.sync();
        true
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    /// Настройка включена или выключена (страница, перезагрузка). Выключение
    /// отменяет и запись.
    pub fn set_active(&self, active: bool) {
        let changed = self.active.swap(active, Ordering::SeqCst) != active;
        let stopped_recording = !active
            && self
                .recording
                .lock()
                .map(|mut recording| recording.take().is_some())
                .unwrap_or(false);
        if changed || stopped_recording {
            tracing::info!(active, "горячие клавиши");
            self.sync();
        }
    }

    /// Записать сочетание для действия (`None` — отменить запись). Только
    /// пока настройка включена.
    pub fn record(&self, action: Option<&str>) -> bool {
        if let Some(action) = action
            && (!ACTIONS.contains(&action) || !self.is_active())
        {
            return false;
        }
        if let Ok(mut recording) = self.recording.lock() {
            *recording = action.map(str::to_owned);
        }
        self.sync();
        true
    }

    pub fn recording(&self) -> Option<String> {
        self.recording
            .lock()
            .map(|recording| recording.clone())
            .unwrap_or_default()
    }

    /// Хук поймал нажатие для записи.
    fn recorded(&self, combo: Option<Combo>) {
        let action = self
            .recording
            .lock()
            .map(|mut recording| recording.take())
            .unwrap_or_default();
        match (action, combo) {
            (Some(action), Some(combo)) => {
                tracing::info!(action, combo = combo.code(), "сочетание записано");
                self.set(&action, Some(combo));
            }
            _ => self.sync(),
        }
    }

    fn config(&self) -> Config {
        let recording = self.recording().is_some();
        let combos = if self.is_active() {
            self.bindings
                .lock()
                .map(|bindings| {
                    bindings
                        .iter()
                        .map(|(action, combo)| (*combo, action.clone()))
                        .collect()
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        Config { combos, recording }
    }

    fn sync(&self) {
        if let Some(hook) = &self.hook {
            hook.configure(self.config());
        }
    }

    fn overview(&self) -> Overview {
        Overview {
            active: self.is_active(),
            recording: self.recording(),
            bindings: self.bindings(),
            actions: ACTIONS,
        }
    }
}

/// Создать состояние и поток, который выполняет нажатые действия.
pub fn start(app: &AppHandle, dir: &Path) -> Arc<Hotkeys> {
    let (sender, receiver) = mpsc::channel();
    let hotkeys = Arc::new(Hotkeys::new(dir, Some(platform::Hook::new(sender))));
    let target = Arc::clone(&hotkeys);
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("hotkeys-events".into())
        .spawn(move || {
            for event in receiver {
                handle(&app, &target, event);
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "поток горячих клавиш не запущен");
    }
    hotkeys
}

/// Выполнить нажатое действие. Не в потоке хука: окно и страница отвечают
/// через главный поток, а хук должен вернуть ответ сразу.
fn handle(app: &AppHandle, hotkeys: &Hotkeys, event: Event) {
    match event {
        Event::Pressed(action) => {
            tracing::debug!(action, "горячая клавиша");
            if action == WINDOW_ACTION {
                desktop::toggle_from_hotkey(app);
            } else {
                let action = serde_json::to_string(&action).unwrap_or_default();
                extensions::call_page(app, &format!("hotkey({action})"));
            }
        }
        Event::Recorded(combo) => {
            hotkeys.recorded(combo);
            extensions::call_page(app, "hotkeysChanged()");
        }
    }
}

/// Новая страница: настройку снова сообщит запущенная «Quality of Life».
pub fn on_page_load(window: &WebviewWindow, payload: &PageLoadPayload<'_>) {
    if payload.event() == PageLoadEvent::Started {
        window.state::<Arc<Hotkeys>>().set_active(false);
    }
}

/// WebView2 не выполняет сочетания браузера, пока настройка включена.
pub fn guard_browser_keys(window: &WebviewWindow, hotkeys: Arc<Hotkeys>) {
    platform::guard_browser_keys(window, hotkeys);
}

// ─────────────────────────────── команды ───────────────────────────────

/// Состояние для раздела «Горячие клавиши».
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    active: bool,
    recording: Option<String>,
    bindings: BTreeMap<String, String>,
    actions: &'static [&'static str],
}

#[tauri::command]
pub fn hotkeys_overview(hotkeys: State<'_, Arc<Hotkeys>>) -> Overview {
    hotkeys.overview()
}

/// Код «Quality of Life»: настройка `hotkeys` включена или выключена.
#[tauri::command]
pub fn hotkeys_activate(active: bool, hotkeys: State<'_, Arc<Hotkeys>>) -> Overview {
    hotkeys.set_active(active);
    hotkeys.overview()
}

/// Назначить сочетание строкой (`null` — убрать).
#[tauri::command]
pub fn hotkeys_set(
    action: String,
    code: Option<String>,
    hotkeys: State<'_, Arc<Hotkeys>>,
) -> CmdResult<Overview> {
    let combo = code.as_deref().map(parse_code).transpose()?;
    if !hotkeys.set(&action, combo) {
        return Err(unknown_action());
    }
    Ok(hotkeys.overview())
}

fn unknown_action() -> CommandError {
    CommandError::translated(
        "hotkeys",
        "hotkeyUnknown",
        Vec::new(),
        "такого действия нет",
    )
}

fn parse_code(code: &str) -> CmdResult<Combo> {
    Combo::parse(code).ok_or_else(|| {
        CommandError::translated(
            "hotkeys",
            "hotkeyInvalid",
            Vec::new(),
            "такое сочетание не назначить",
        )
    })
}

/// Записать следующее нажатие для действия (`null` — отменить запись).
#[tauri::command]
pub fn hotkeys_record(
    action: Option<String>,
    hotkeys: State<'_, Arc<Hotkeys>>,
) -> CmdResult<Overview> {
    if !hotkeys.record(action.as_deref()) {
        return Err(CommandError::translated(
            "hotkeys",
            "hotkeysOff",
            Vec::new(),
            "горячие клавиши выключены или такого действия нет",
        ));
    }
    Ok(hotkeys.overview())
}

// ─────────────────────────────── Windows ───────────────────────────────

#[cfg(windows)]
mod platform {
    use std::cell::RefCell;
    use std::sync::{Arc, Mutex, OnceLock, mpsc};

    use tauri::WebviewWindow;
    use tauri::webview::PlatformWebview;
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32 as wv;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT,
        KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GA_ROOT, GetAncestor, GetForegroundWindow, GetMessageW,
        GetWindowThreadProcessId, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT,
        PM_NOREMOVE, PeekMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
        WH_KEYBOARD_LL, WH_MOUSE_LL, WINDOWS_HOOK_ID, WM_APP, WM_KEYDOWN, WM_KEYUP, WM_MBUTTONDOWN,
        WM_MBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_USER, WM_XBUTTONDOWN, WM_XBUTTONUP,
        WindowFromPoint, XBUTTON1, XBUTTON2,
    };
    use windows_core::{Interface, PCWSTR};

    use super::{Button, Config, Event, Hotkeys, MASK_KEY, Matcher, Modifiers, Trigger};

    /// Новые настройки в [`PENDING`]
    const WM_RECONFIGURE: u32 = WM_APP + 1;
    /// Нажать [`MASK_KEY`]
    const WM_MASK: u32 = WM_APP + 2;

    type HookProc = unsafe extern "system" fn(i32, WPARAM, LPARAM) -> LRESULT;

    const KEYBOARD: (WINDOWS_HOOK_ID, HookProc) = (WH_KEYBOARD_LL, keyboard_proc);
    const MOUSE: (WINDOWS_HOOK_ID, HookProc) = (WH_MOUSE_LL, mouse_proc);

    /// Последние настройки для потока хука.
    static PENDING: Mutex<Option<Config>> = Mutex::new(None);

    /// Состояние потока хука: процедуры хука вызываются в нём же.
    struct Local {
        matcher: Matcher,
        events: mpsc::Sender<Event>,
        thread: u32,
        keyboard: Option<HHOOK>,
        mouse: Option<HHOOK>,
    }

    thread_local! {
        static LOCAL: RefCell<Option<Local>> = const { RefCell::new(None) };
    }

    /// Поток с хуками; запускается при первой надобности.
    pub struct Hook {
        events: mpsc::Sender<Event>,
        thread: OnceLock<Option<u32>>,
    }

    impl Hook {
        pub fn new(events: mpsc::Sender<Event>) -> Self {
            Self {
                events,
                thread: OnceLock::new(),
            }
        }

        pub fn configure(&self, config: Config) {
            let idle = !config.keyboard() && !config.mouse();
            if idle && self.thread.get().is_none() {
                return;
            }
            if let Ok(mut pending) = PENDING.lock() {
                *pending = Some(config);
            }
            let Some(thread) = *self.thread.get_or_init(|| spawn(self.events.clone())) else {
                return;
            };
            if let Err(error) = post(thread, WM_RECONFIGURE) {
                tracing::warn!(%error, "горячие клавиши: поток хука не ответил");
            }
        }
    }

    /// Сообщение потоку хука.
    fn post(thread: u32, message: u32) -> windows_core::Result<()> {
        // SAFETY: у потока хука есть очередь сообщений: она создана до того,
        // как он сообщил свой номер
        unsafe { PostThreadMessageW(thread, message, WPARAM(0), LPARAM(0)) }
    }

    fn spawn(events: mpsc::Sender<Event>) -> Option<u32> {
        let (ready, started) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("hotkeys".into())
            .spawn(move || run(events, &ready));
        if let Err(error) = spawned {
            tracing::warn!(%error, "поток хука горячих клавиш не запущен");
            return None;
        }
        started.recv().ok()
    }

    /// Очередь сообщений потока: в ней Windows вызывает процедуры хука.
    fn run(events: mpsc::Sender<Event>, ready: &mpsc::Sender<u32>) {
        let mut message = MSG::default();
        // SAFETY: PeekMessage создаёт очередь сообщений потока
        let thread = unsafe {
            let _ = PeekMessageW(&mut message, None, WM_USER, WM_USER, PM_NOREMOVE);
            GetCurrentThreadId()
        };
        LOCAL.with(|local| {
            *local.borrow_mut() = Some(Local {
                matcher: Matcher::default(),
                events,
                thread,
                keyboard: None,
                mouse: None,
            });
        });
        let _ = ready.send(thread);
        loop {
            // SAFETY: message — свой буфер; окон у потока нет, приходят
            // только сообщения потока
            let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
            if result.0 <= 0 {
                break;
            }
            match message.message {
                WM_RECONFIGURE => reconfigure(),
                WM_MASK => send_mask(),
                _ => {}
            }
        }
    }

    fn reconfigure() {
        let Some(config) = PENDING.lock().ok().and_then(|mut pending| pending.take()) else {
            return;
        };
        LOCAL.with(|local| {
            let mut local = local.borrow_mut();
            let Some(local) = local.as_mut() else {
                return;
            };
            let (keyboard, mouse) = (config.keyboard(), config.mouse());
            local.matcher.configure(config);
            let keyboard_removed = set_hook(&mut local.keyboard, keyboard, KEYBOARD);
            let mouse_removed = set_hook(&mut local.mouse, mouse, MOUSE);
            if keyboard_removed || mouse_removed {
                local.matcher.reset();
            }
        });
    }

    /// Модуль exe: в нём процедуры хука.
    fn module() -> Option<HINSTANCE> {
        // SAFETY: модуль exe живёт всё время работы процесса
        let module = unsafe { GetModuleHandleW(PCWSTR::null()) };
        module.ok().map(|module| HINSTANCE(module.0))
    }

    /// Поставить или снять хук; `true` — хук снят.
    fn set_hook(
        slot: &mut Option<HHOOK>,
        wanted: bool,
        (id, procedure): (WINDOWS_HOOK_ID, HookProc),
    ) -> bool {
        match (slot.is_some(), wanted) {
            (false, true) => {
                // SAFETY: процедура — функция модуля exe
                match unsafe { SetWindowsHookExW(id, Some(procedure), module(), 0) } {
                    Ok(hook) => *slot = Some(hook),
                    Err(error) => tracing::warn!(%error, "хук горячих клавиш не поставлен"),
                }
                false
            }
            (true, false) => {
                if let Some(hook) = slot.take() {
                    // SAFETY: хук поставлен этим потоком
                    let _ = unsafe { UnhookWindowsHookEx(hook) };
                }
                true
            }
            _ => false,
        }
    }

    /// Решение по нажатию; `true` — проглотить.
    fn decide(trigger: Trigger, down: bool, own: impl FnOnce() -> bool) -> bool {
        if !Matcher::relevant(trigger) {
            return false;
        }
        LOCAL.with(|local| {
            let Ok(mut local) = local.try_borrow_mut() else {
                return false;
            };
            let Some(local) = local.as_mut() else {
                return false;
            };
            let modifiers = modifiers();
            let verdict = local.matcher.input(trigger, down, modifiers, own());
            if let Some(event) = verdict.event {
                let _ = local.events.send(event);
            }
            if verdict.swallow && down && (modifiers.alt || modifiers.win) {
                let _ = post(local.thread, WM_MASK);
            }
            verdict.swallow
        })
    }

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            // SAFETY: при HC_ACTION lparam указывает на KBDLLHOOKSTRUCT
            let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            let message = wparam.0 as u32;
            let down = matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN);
            let up = matches!(message, WM_KEYUP | WM_SYSKEYUP);
            if (down || up)
                && let Ok(vk) = u8::try_from(info.vkCode)
                && decide(Trigger::Key(vk), down, foreground_is_own)
            {
                return LRESULT(1);
            }
        }
        // SAFETY: дальше по цепочке хуков — то, что пришло
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            // SAFETY: при HC_ACTION lparam указывает на MSLLHOOKSTRUCT
            let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            let point = info.pt;
            if let Some((button, down)) = mouse_button(wparam.0 as u32, info.mouseData)
                && decide(Trigger::Mouse(button), down, || under_cursor_is_own(point))
            {
                return LRESULT(1);
            }
        }
        // SAFETY: дальше по цепочке хуков — то, что пришло
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    /// Нажатая или отпущенная кнопка мыши; движения указателя и колёсико —
    /// `None`.
    fn mouse_button(message: u32, data: u32) -> Option<(Button, bool)> {
        let extra = || match (data >> 16) as u16 {
            XBUTTON1 => Some(Button::X1),
            XBUTTON2 => Some(Button::X2),
            _ => None,
        };
        match message {
            WM_MBUTTONDOWN => Some((Button::Middle, true)),
            WM_MBUTTONUP => Some((Button::Middle, false)),
            WM_XBUTTONDOWN => Some((extra()?, true)),
            WM_XBUTTONUP => Some((extra()?, false)),
            _ => None,
        }
    }

    fn modifiers() -> Modifiers {
        // SAFETY: без условий; старший бит — клавиша зажата
        let held = |key: VIRTUAL_KEY| unsafe { GetAsyncKeyState(i32::from(key.0)) } < 0;
        Modifiers {
            ctrl: held(VK_CONTROL),
            shift: held(VK_SHIFT),
            alt: held(VK_MENU),
            win: held(VK_LWIN) || held(VK_RWIN),
        }
    }

    /// Окно верхнего уровня принадлежит клиенту. Содержимое WebView2 —
    /// дочернее окно процесса msedgewebview2, поэтому сравнивается корень.
    fn owned(window: HWND) -> bool {
        if window.is_invalid() {
            return false;
        }
        let mut process = 0u32;
        // SAFETY: окно могло закрыться — тогда номер останется 0
        unsafe { GetWindowThreadProcessId(window, Some(&raw mut process)) };
        process == std::process::id()
    }

    fn foreground_is_own() -> bool {
        // SAFETY: без условий
        owned(unsafe { GetForegroundWindow() })
    }

    fn under_cursor_is_own(point: POINT) -> bool {
        // SAFETY: без условий; для пустого окна GetAncestor вернёт пустое
        owned(unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) })
    }

    /// Нажать и отпустить неназначенную клавишу.
    fn send_mask() {
        let key = |flags: KEYBD_EVENT_FLAGS| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(u16::from(MASK_KEY)),
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
        // SAFETY: массив INPUT и его размер
        unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
    }

    /// `AcceleratorKeyPressed` контроллера WebView2: пока настройка включена,
    /// сочетания браузера не выполняются, остальные клавиши (ввод, Ctrl+C)
    /// работают как обычно.
    pub fn guard_browser_keys(window: &WebviewWindow, hotkeys: Arc<Hotkeys>) {
        let result = window.with_webview(move |webview| {
            if let Err(error) = setup(&webview, hotkeys) {
                tracing::warn!(%error, "сочетания браузера не отключить");
            }
        });
        if let Err(error) = result {
            tracing::warn!(%error, "webview недоступен, сочетания браузера не отключить");
        }
    }

    fn setup(webview: &PlatformWebview, hotkeys: Arc<Hotkeys>) -> windows_core::Result<()> {
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args
                && hotkeys.is_active()
            {
                let args: wv::ICoreWebView2AcceleratorKeyPressedEventArgs2 = args.cast()?;
                // SAFETY: аргументы события действительны во время обработчика
                unsafe { args.SetIsBrowserAcceleratorKeyEnabled(false) }?;
            }
            Ok(())
        }));
        let controller = webview.controller();
        let mut token = 0i64;
        // SAFETY: with_webview вызывает нас в главном потоке, контроллер жив,
        // пока существует окно; обработчик живёт, пока его держит WebView2
        unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) }
    }
}

/// Хуки клавиатуры и мыши здесь — только для Windows.
#[cfg(not(windows))]
mod platform {
    use std::sync::{Arc, mpsc};

    use tauri::WebviewWindow;

    use super::{Config, Event, Hotkeys};

    pub struct Hook;

    impl Hook {
        pub fn new(_events: mpsc::Sender<Event>) -> Self {
            Self
        }

        pub fn configure(&self, _config: Config) {}
    }

    pub fn guard_browser_keys(_window: &WebviewWindow, _hotkeys: Arc<Hotkeys>) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    const CTRL_SHIFT: Modifiers = Modifiers {
        ctrl: true,
        shift: true,
        alt: false,
        win: false,
    };
    const NONE: Modifiers = Modifiers {
        ctrl: false,
        shift: false,
        alt: false,
        win: false,
    };
    const F9: Trigger = Trigger::Key(0x78);
    const ESC: Trigger = Trigger::Key(VK_ESCAPE);
    const X1: Trigger = Trigger::Mouse(Button::X1);

    fn temp_dir(name: &str) -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("arachnid-hotkeys-{name}-{nanos:x}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn matcher(combos: &[(&str, &str)], recording: bool) -> Matcher {
        let mut matcher = Matcher::default();
        matcher.configure(Config {
            combos: combos
                .iter()
                .map(|(code, action)| (Combo::parse(code).unwrap(), (*action).to_owned()))
                .collect(),
            recording,
        });
        matcher
    }

    #[test]
    fn combos_round_trip() {
        for code in [
            "ctrl+shift+key:120",
            "mouse:x1",
            "alt+win+mouse:middle",
            "key:122",
        ] {
            assert_eq!(Combo::parse(code).unwrap().code(), code);
        }
        // порядок модификаторов в файле не важен, в ответе — один
        assert_eq!(
            Combo::parse("shift+ctrl+key:120").unwrap().code(),
            "ctrl+shift+key:120"
        );
        assert_eq!(
            Combo::parse("mouse:x2").unwrap().trigger,
            Trigger::Mouse(Button::X2)
        );
    }

    #[test]
    fn broken_combos_are_rejected() {
        for code in [
            "",
            "ctrl",
            "ctrl+ctrl+key:120",
            "key:120+ctrl",
            "key:17",
            "key:1",
            "key:300",
            "mouse:left",
            "ctrl+",
            "key:120+key:121",
        ] {
            assert_eq!(Combo::parse(code), None, "{code}");
        }
    }

    #[test]
    fn pressed_combo_fires_once_and_is_swallowed_in_own_window() {
        let mut matcher = matcher(&[("ctrl+shift+key:120", "toggle_mute")], false);
        let pressed = matcher.input(F9, true, CTRL_SHIFT, true);
        assert_eq!(
            pressed,
            Verdict {
                swallow: true,
                event: Some(Event::Pressed("toggle_mute".into()))
            }
        );
        // автоповтор и отпускание тоже не доходят до страницы
        assert_eq!(
            matcher.input(F9, true, CTRL_SHIFT, true),
            Verdict {
                swallow: true,
                event: None
            }
        );
        assert!(matcher.input(F9, false, CTRL_SHIFT, true).swallow);
        // без модификаторов — просто F9
        assert_eq!(
            matcher.input(F9, true, Modifiers::default(), true),
            Verdict::default()
        );
        assert!(!matcher.input(F9, false, NONE, true).swallow);
    }

    #[test]
    fn other_programs_get_the_press_too() {
        let mut matcher = matcher(&[("mouse:x1", "toggle_deafen")], false);
        assert_eq!(
            matcher.input(X1, true, Modifiers::default(), false),
            Verdict {
                swallow: false,
                event: Some(Event::Pressed("toggle_deafen".into()))
            }
        );
        assert!(!matcher.input(X1, false, NONE, false).swallow);
    }

    #[test]
    fn modifiers_alone_are_never_triggers() {
        let mut matcher = matcher(&[("ctrl+key:120", "toggle_mute")], true);
        assert_eq!(
            matcher.input(Trigger::Key(0xA2), true, CTRL_SHIFT, true),
            Verdict::default()
        );
        // запись ждёт главную клавишу
        assert!(matcher.config.recording);
    }

    #[test]
    fn recording_takes_one_press_and_escape_cancels() {
        let mut recording = matcher(&[("key:120", "toggle_mute")], true);
        // назначенное сочетание во время записи не срабатывает, а записывается
        assert_eq!(
            recording.input(Trigger::Key(0x78), true, Modifiers::default(), false),
            Verdict {
                swallow: true,
                event: Some(Event::Recorded(Combo::parse("key:120")))
            }
        );
        assert!(recording.input(F9, false, NONE, false).swallow);
        assert_eq!(
            recording.input(Trigger::Key(0x78), true, Modifiers::default(), false),
            Verdict {
                swallow: false,
                event: Some(Event::Pressed("toggle_mute".into()))
            }
        );

        let mut cancelled = matcher(&[], true);
        assert_eq!(
            cancelled.input(ESC, true, Modifiers::default(), true),
            Verdict {
                swallow: true,
                event: Some(Event::Recorded(None))
            }
        );
        // Shift+Esc — обычное сочетание
        let mut shifted = matcher(&[], true);
        let shift = Modifiers {
            shift: true,
            ..Modifiers::default()
        };
        assert_eq!(
            shifted.input(ESC, true, shift, true).event,
            Some(Event::Recorded(Combo::parse("shift+key:27")))
        );
    }

    #[test]
    fn missed_release_does_not_eat_the_next_press() {
        let mut matcher = matcher(&[("mouse:x1", "toggle_mute")], false);
        assert!(matcher.input(X1, true, Modifiers::default(), true).swallow);
        // хук сняли, отпускание не пришло
        matcher.reset();
        assert_eq!(
            matcher.input(X1, true, Modifiers::default(), false).event,
            Some(Event::Pressed("toggle_mute".into()))
        );
    }

    #[test]
    fn hooks_are_needed_only_for_bound_kinds() {
        let keys = matcher(&[("key:120", "toggle_mute")], false).config;
        assert!(keys.keyboard() && !keys.mouse());
        let mouse = matcher(&[("mouse:x2", "toggle_mute")], false).config;
        assert!(!mouse.keyboard() && mouse.mouse());
        let recording = Config {
            combos: Vec::new(),
            recording: true,
        };
        assert!(recording.keyboard() && recording.mouse());
        assert!(!Config::default().keyboard() && !Config::default().mouse());
    }

    #[test]
    fn bindings_are_saved_and_move_between_actions() {
        let dir = temp_dir("bindings");
        let hotkeys = Hotkeys::new(&dir, None);
        assert!(hotkeys.set("toggle_mute", Combo::parse("mouse:x1")));
        assert!(hotkeys.set("toggle_deafen", Combo::parse("ctrl+key:77")));
        assert!(!hotkeys.set("format_disk", Combo::parse("key:120")));
        // то же сочетание у другого действия — переходит к нему
        assert!(hotkeys.set("disconnect", Combo::parse("mouse:x1")));
        let expected: BTreeMap<String, String> = [
            ("disconnect".to_owned(), "mouse:x1".to_owned()),
            ("toggle_deafen".to_owned(), "ctrl+key:77".to_owned()),
        ]
        .into();
        assert_eq!(hotkeys.bindings(), expected);

        // файл читается заново; чужое и испорченное пропускается
        let reloaded = Hotkeys::new(&dir, None);
        assert_eq!(reloaded.bindings(), expected);
        std::fs::write(
            dir.join(FILE),
            r#"{"bindings":{"toggle_mute":"key:17","x":"key:120","toggle_window":"win+key:122"}}"#,
        )
        .unwrap();
        let filtered = Hotkeys::new(&dir, None);
        assert_eq!(
            filtered.bindings(),
            [("toggle_window".to_owned(), "win+key:122".to_owned())].into()
        );
        assert!(filtered.set("toggle_window", None));
        assert!(Hotkeys::new(&dir, None).bindings().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn combos_work_only_while_active_and_recording_needs_it() {
        let dir = temp_dir("active");
        let hotkeys = Hotkeys::new(&dir, None);
        hotkeys.set("toggle_mute", Combo::parse("key:120"));
        assert_eq!(hotkeys.config(), Config::default());
        assert!(!hotkeys.record(Some("toggle_mute")));

        hotkeys.set_active(true);
        assert_eq!(hotkeys.config().combos.len(), 1);
        assert!(!hotkeys.record(Some("unknown")));
        assert!(hotkeys.record(Some("toggle_deafen")));
        assert!(hotkeys.config().recording);
        hotkeys.recorded(Combo::parse("mouse:x2"));
        assert_eq!(hotkeys.recording(), None);
        assert_eq!(hotkeys.bindings()["toggle_deafen"], "mouse:x2");

        // перезагрузка страницы выключает и отменяет запись
        assert!(hotkeys.record(Some("disconnect")));
        hotkeys.set_active(false);
        assert_eq!(hotkeys.recording(), None);
        assert_eq!(hotkeys.config(), Config::default());
        std::fs::remove_dir_all(&dir).ok();
    }
}
