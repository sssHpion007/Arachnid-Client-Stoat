//! Расширения: темы, QuickCSS и плагины поверх веб-клиента.
//!
//! Устроено как у клиентских модов (Avia Client, Vencord): тема — файл CSS,
//! плагин — файл JavaScript, который выполняется на странице веб-клиента.
//! Всё лежит в каталоге данных, рядом с `config.toml`:
//!
//! ```text
//! themes/*.css     темы: выбирается одна, в «Внешнем виде» или в трее
//! plugins/*.js     плагины: в разделе «Плагины» или в трее
//! quickcss.css     свой CSS, действует всегда
//! extensions.json  выбранная тема, её настройки и включённые плагины
//! ```
//!
//! Тема может описать свои настройки (палитры, цвета, размеры) в заголовке
//! UserCSS (см. [`crate::usercss`]); пока тема выбрана, «Внешний вид»
//! показывает их вместо встроенных цветов Stoat.
//!
//! Новые плагины по умолчанию выключены: плагин получает те же права, что и
//! страница (в том числе сессию), поэтому включать его нужно осознанно.
//!
//! Стили применяются сразу и обновляются при сохранении файла. Плагин
//! выполняется после загрузки страницы; выгрузить уже выполненный код
//! нельзя, поэтому переключение плагина в трее перезагружает страницу, а
//! раздел «Плагины» предлагает перезагрузку.
//!
//! Плагины Avia Client добавляют свои пункты (настройки, переключатели)
//! через `window.AviaMenu`. Мост (`bridge.js`) даёт тот же объект; пункты
//! видны в разделе «Плагины» и в трее: «Расширения → Действия плагинов».

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, State, WebviewWindow};

use url::Url;

use crate::desktop::{self, TrayLabels};
use crate::instance::Instance;
use crate::{CmdResult, CommandError, usercss};

/// Каталог тем в каталоге данных.
pub const THEMES_DIR: &str = "themes";
/// Каталог плагинов в каталоге данных.
pub const PLUGINS_DIR: &str = "plugins";
/// Свой CSS, который действует всегда.
const QUICK_CSS: &str = "quickcss.css";
/// Выбранная тема, её настройки и включённые плагины.
const STATE_FILE: &str = "extensions.json";
/// Больше этого файл темы или плагина не читается: защита от случайно
/// положенного архива или видео.
const MAX_FILE_SIZE: u64 = 8 * 1024 * 1024;
/// Как часто проверять папки на изменения.
const WATCH_INTERVAL: Duration = Duration::from_secs(1);

/// Префиксы id пунктов меню трея.
const MENU_THEME: &str = "ext-theme:";
const MENU_THEME_DEFAULT: &str = "ext-theme-default";
const MENU_PLUGIN: &str = "ext-plugin:";
const MENU_OPEN_THEMES: &str = "ext-open-themes";
const MENU_OPEN_PLUGINS: &str = "ext-open-plugins";
const MENU_QUICK_CSS: &str = "ext-quickcss";
const MENU_ACTION: &str = "ext-action:";

/// Больше пунктов меню плагинов в трее не показывается.
const MAX_MENU_ENTRIES: usize = 64;

/// Заготовка `quickcss.css`, если его ещё нет.
const QUICK_CSS_TEMPLATE: &str = "/* QuickCSS: свой CSS для веб-клиента Stoat.\n   Действует всегда, поверх темы. Изменения применяются сразу. */\n";

/// Вид расширения.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `themes/*.css`
    Theme,
    /// `plugins/*.js`
    Plugin,
}

impl Kind {
    fn dir(self) -> &'static str {
        match self {
            Self::Theme => THEMES_DIR,
            Self::Plugin => PLUGINS_DIR,
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Theme => "css",
            Self::Plugin => "js",
        }
    }
}

/// Сохранённый выбор (`extensions.json`); ключи — имена файлов.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct Saved {
    /// Выбранная тема; `None` — стандартное оформление Stoat
    theme: Option<String>,
    /// Значения настроек тем: файл → имя настройки → значение
    theme_settings: BTreeMap<String, BTreeMap<String, String>>,
    /// Включённые плагины
    plugins: BTreeMap<String, bool>,
    /// До 0.14 темы включались флажками, по нескольку сразу: читается
    /// только для переноса
    #[serde(skip_serializing)]
    themes: BTreeMap<String, bool>,
}

impl Saved {
    /// Прочитать `extensions.json`; повреждённый файл не мешает запуску.
    fn load(path: &Path) -> Self {
        let mut saved: Self = match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|error| {
                tracing::warn!(%error, "extensions.json повреждён, все расширения выключены");
                Self::default()
            }),
            Err(_) => Self::default(),
        };
        // 0.13: первая включённая тема становится выбранной
        let legacy = std::mem::take(&mut saved.themes);
        if saved.theme.is_none() {
            saved.theme = legacy
                .into_iter()
                .find_map(|(name, enabled)| enabled.then_some(name));
        }
        saved
    }

    fn plugin_enabled(&self, name: &str) -> bool {
        self.plugins.get(name).copied().unwrap_or(false)
    }
}

/// Тема или плагин в папке.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Имя файла, например `catppuccin.css`
    pub name: String,
    /// Время изменения и размер: по ним видно, что файл сохранили
    stamp: Option<(SystemTime, u64)>,
}

/// Стиль для страницы: `bridge.js` держит по элементу `<style>` на каждый.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Style {
    /// `theme:<файл>` или `quickcss`
    pub id: String,
    /// Содержимое
    pub css: String,
}

/// Состояние папок на момент проверки: изменилось — пора обновить страницу
/// или меню трея.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Snapshot {
    themes: Vec<Entry>,
    plugins: Vec<Entry>,
    quick_css: Option<(SystemTime, u64)>,
}

/// Пункт меню плагина (`AviaMenu.register` / `submenuregister`): действие
/// или группа действий.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PluginMenuEntry {
    /// Id, под которым плагин зарегистрировал пункт
    id: String,
    /// Подпись
    name: String,
    /// Действия группы (`AviaMenu.submenu`); у действия — нет
    #[serde(default)]
    items: Option<Vec<PluginMenuAction>>,
}

/// Действие внутри группы.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PluginMenuAction {
    /// Id пункта
    id: String,
    /// Подпись
    name: String,
}

/// Тема для раздела «Внешний вид».
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInfo {
    /// Имя файла
    file: String,
    /// Название, автор, описание и настройки из заголовка
    #[serde(flatten)]
    meta: usercss::Meta,
    /// Действующие значения настроек
    values: BTreeMap<String, String>,
}

/// Плагин для раздела «Плагины».
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    /// Имя файла
    file: String,
    /// `@name`
    name: Option<String>,
    /// `@description`
    description: Option<String>,
    /// `@author`
    author: Option<String>,
    /// `@version`
    version: Option<String>,
    /// Включён
    enabled: bool,
    /// Выполняется на открытой странице
    running: bool,
}

/// Всё о темах и плагинах для настроек веб-клиента (`settings.js`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// Выбранная тема; `null` — стандартное оформление
    theme: Option<String>,
    /// Темы в папке
    themes: Vec<ThemeInfo>,
    /// Плагины в папке
    plugins: Vec<PluginInfo>,
    /// Включённые плагины отличаются от запущенных: нужна перезагрузка
    reload_needed: bool,
}

/// Что открыть в проводнике или редакторе.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenTarget {
    /// Папка тем
    Themes,
    /// Папка плагинов
    Plugins,
    /// `quickcss.css`
    QuickCss,
}

/// Расширения в каталоге данных.
pub struct Extensions {
    dir: PathBuf,
    /// Адрес веб-клиента: по нему раскрываются секции `@-moz-document`
    app_url: Url,
    saved: Mutex<Saved>,
    /// Пункты, которые плагины открытой страницы добавили в меню
    plugin_menu: Mutex<Vec<PluginMenuEntry>>,
    /// Плагины, выполненные на открытой странице
    running: Mutex<Vec<String>>,
}

impl Extensions {
    /// Прочитать `extensions.json` из каталога данных.
    pub fn new(dir: PathBuf, app_url: Url) -> Self {
        let saved = Saved::load(&dir.join(STATE_FILE));
        Self {
            dir,
            app_url,
            saved: Mutex::new(saved),
            plugin_menu: Mutex::new(Vec::new()),
            running: Mutex::new(Vec::new()),
        }
    }

    fn plugin_menu(&self) -> Vec<PluginMenuEntry> {
        self.plugin_menu
            .lock()
            .map(|menu| menu.clone())
            .unwrap_or_default()
    }

    /// Запомнить пункты меню плагинов; `true` — они изменились.
    fn set_plugin_menu(&self, mut entries: Vec<PluginMenuEntry>) -> bool {
        entries.truncate(MAX_MENU_ENTRIES);
        for entry in &mut entries {
            if let Some(items) = entry.items.as_mut() {
                items.truncate(MAX_MENU_ENTRIES);
            }
        }
        let Ok(mut menu) = self.plugin_menu.lock() else {
            return false;
        };
        if *menu == entries {
            return false;
        }
        *menu = entries;
        true
    }

    fn saved(&self) -> Saved {
        self.saved
            .lock()
            .map(|saved| saved.clone())
            .unwrap_or_default()
    }

    /// Изменить выбор и сохранить его.
    fn update(&self, change: impl FnOnce(&mut Saved)) {
        let Ok(mut saved) = self.saved.lock() else {
            return;
        };
        change(&mut saved);
        if let Err(error) = write_atomically(&self.dir.join(STATE_FILE), &*saved) {
            tracing::warn!(%error, "не удалось сохранить extensions.json");
        }
    }

    /// Темы или плагины в папке, по имени файла.
    pub fn list(&self, kind: Kind) -> Vec<Entry> {
        list_dir(&self.dir.join(kind.dir()), kind.extension())
    }

    fn exists(&self, kind: Kind, name: &str) -> bool {
        self.list(kind).iter().any(|entry| entry.name == name)
    }

    /// Выбранная тема, если её файл на месте.
    pub fn active_theme(&self) -> Option<String> {
        self.saved()
            .theme
            .filter(|name| self.exists(Kind::Theme, name))
    }

    /// Выбрать тему; `None` — стандартное оформление Stoat. Файла нет —
    /// ничего не меняется.
    pub fn set_theme(&self, name: Option<&str>) -> bool {
        if name.is_some_and(|name| !self.exists(Kind::Theme, name)) {
            return false;
        }
        tracing::info!(theme = name.unwrap_or("стандартная"), "выбрана тема");
        self.update(|saved| saved.theme = name.map(str::to_owned));
        true
    }

    /// Изменить настройку темы; `None` — вернуть значение по умолчанию.
    /// Неподходящее значение не сохраняется.
    fn set_theme_value(&self, file: &str, name: &str, value: Option<&str>) -> bool {
        let Some(css) = self.read(Kind::Theme, file) else {
            return false;
        };
        let meta = usercss::parse(&css);
        let Some(setting) = meta.settings.iter().find(|setting| setting.name == name) else {
            return false;
        };
        let value = match value {
            Some(value) => match setting.normalize(value) {
                Some(value) => Some(value),
                None => return false,
            },
            None => None,
        };
        self.update(|saved| {
            let values = saved.theme_settings.entry(file.to_owned()).or_default();
            match value {
                Some(value) => {
                    values.insert(name.to_owned(), value);
                }
                None => {
                    values.remove(name);
                }
            }
            if values.is_empty() {
                saved.theme_settings.remove(file);
            }
        });
        true
    }

    /// Сбросить все настройки темы.
    fn reset_theme(&self, file: &str) {
        self.update(|saved| {
            saved.theme_settings.remove(file);
        });
    }

    /// Включён ли плагин.
    pub fn plugin_enabled(&self, name: &str) -> bool {
        self.saved().plugin_enabled(name)
    }

    /// Включить или выключить плагин и запомнить это.
    pub fn set_plugin(&self, name: &str, value: bool) {
        self.update(|saved| {
            saved.plugins.insert(name.to_owned(), value);
        });
    }

    fn read(&self, kind: Kind, name: &str) -> Option<String> {
        read_limited(&self.dir.join(kind.dir()).join(name))
    }

    /// Стили для страницы: выбранная тема с её настройками, затем QuickCSS
    /// (он последний, чтобы перекрывать тему).
    pub fn styles(&self) -> Vec<Style> {
        let saved = self.saved();
        let mut styles = Vec::new();
        if let Some(name) = self.active_theme()
            && let Some(css) = self.read(Kind::Theme, &name)
        {
            let meta = usercss::parse(&css);
            let empty = BTreeMap::new();
            let values = saved.theme_settings.get(&name).unwrap_or(&empty);
            styles.push(Style {
                id: format!("theme:{name}"),
                css: usercss::render(&css, &meta, values, &self.app_url),
            });
        }
        if let Some(css) = read_limited(&self.dir.join(QUICK_CSS)) {
            styles.push(Style {
                id: "quickcss".into(),
                css,
            });
        }
        styles
    }

    /// Код включённых плагинов: `(имя файла, код)`.
    pub fn plugins(&self) -> Vec<(String, String)> {
        let saved = self.saved();
        self.list(Kind::Plugin)
            .into_iter()
            .filter(|entry| saved.plugin_enabled(&entry.name))
            .filter_map(|entry| {
                let code = self.read(Kind::Plugin, &entry.name)?;
                Some((entry.name, code))
            })
            .collect()
    }

    fn running(&self) -> Vec<String> {
        self.running
            .lock()
            .map(|running| running.clone())
            .unwrap_or_default()
    }

    fn set_running(&self, names: Vec<String>) {
        if let Ok(mut running) = self.running.lock() {
            *running = names;
        }
    }

    /// Темы и плагины для настроек веб-клиента.
    pub fn overview(&self) -> Overview {
        let saved = self.saved();
        let running = self.running();
        let empty = BTreeMap::new();
        let themes: Vec<ThemeInfo> = self
            .list(Kind::Theme)
            .into_iter()
            .map(|entry| {
                let meta = self
                    .read(Kind::Theme, &entry.name)
                    .map(|css| usercss::parse(&css))
                    .unwrap_or_default();
                let stored = saved.theme_settings.get(&entry.name).unwrap_or(&empty);
                let values = meta
                    .settings
                    .iter()
                    .map(|setting| {
                        let value =
                            setting.effective(stored.get(&setting.name).map(String::as_str));
                        (setting.name.clone(), value)
                    })
                    .collect();
                ThemeInfo {
                    file: entry.name,
                    meta,
                    values,
                }
            })
            .collect();
        let plugins: Vec<PluginInfo> = self
            .list(Kind::Plugin)
            .into_iter()
            .map(|entry| {
                let meta = self
                    .read(Kind::Plugin, &entry.name)
                    .map(|code| usercss::header(&code))
                    .unwrap_or_default();
                PluginInfo {
                    enabled: saved.plugin_enabled(&entry.name),
                    running: running.contains(&entry.name),
                    file: entry.name,
                    name: meta.name,
                    description: meta.description,
                    author: meta.author,
                    version: meta.version,
                }
            })
            .collect();
        let reload_needed = plugins
            .iter()
            .any(|plugin| plugin.enabled != plugin.running);
        let theme = saved
            .theme
            .filter(|name| themes.iter().any(|theme| &theme.file == name));
        Overview {
            theme,
            themes,
            plugins,
            reload_needed,
        }
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            themes: self.list(Kind::Theme),
            plugins: self.list(Kind::Plugin),
            quick_css: stamp(&self.dir.join(QUICK_CSS)),
        }
    }

    /// Текст `quickcss.css` для редактора в настройках; если файла ещё нет —
    /// заготовка (файл появится при первом сохранении).
    fn quick_css(&self) -> CmdResult<String> {
        let path = self.dir.join(QUICK_CSS);
        if !path.exists() {
            return Ok(QUICK_CSS_TEMPLATE.to_owned());
        }
        // пустой текст в редакторе стёр бы файл при сохранении: лучше ошибка
        let Some(css) = read_limited(&path) else {
            return Err(CommandError::new(
                "quickCss",
                "quickcss.css не читается или больше 8 МБ — откройте его в редакторе",
            ));
        };
        Ok(css)
    }

    /// Сохранить `quickcss.css` из редактора в настройках.
    fn set_quick_css(&self, css: &str) -> CmdResult<()> {
        if css.len() as u64 > MAX_FILE_SIZE {
            return Err(CommandError::new("quickCss", "QuickCSS больше 8 МБ"));
        }
        write_text_atomically(&self.dir.join(QUICK_CSS), css).map_err(|error| {
            tracing::warn!(%error, "не удалось сохранить quickcss.css");
            CommandError::new("quickCss", error.to_string())
        })
    }

    /// Путь к `quickcss.css`; при первом обращении создаётся заготовка.
    fn quick_css_path(&self) -> std::io::Result<PathBuf> {
        let path = self.dir.join(QUICK_CSS);
        if !path.exists() {
            std::fs::write(&path, QUICK_CSS_TEMPLATE)?;
        }
        Ok(path)
    }

    /// Открыть папку тем, плагинов или `quickcss.css`.
    fn open(&self, target: OpenTarget) {
        match target {
            OpenTarget::Themes => open_path(&self.dir.join(THEMES_DIR)),
            OpenTarget::Plugins => open_path(&self.dir.join(PLUGINS_DIR)),
            OpenTarget::QuickCss => match self.quick_css_path() {
                Ok(path) => open_path(&path),
                Err(error) => tracing::warn!(%error, "не удалось создать quickcss.css"),
            },
        }
    }
}

/// Файлы с нужным расширением в каталоге, по имени. Скрытые файлы
/// (`.name.css`) пропускаются: так редакторы хранят временные копии.
fn list_dir(dir: &Path, extension: &str) -> Vec<Entry> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<Entry> = read
        .filter_map(Result::ok)
        .filter(|item| item.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|item| {
            let path = item.path();
            let matches = path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case(extension));
            let name = item.file_name().into_string().ok()?;
            (matches && !name.starts_with('.')).then(|| Entry {
                stamp: stamp(&path),
                name,
            })
        })
        .collect();
    entries.sort_by_cached_key(|entry| entry.name.to_lowercase());
    entries
}

fn stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// Прочитать текстовый файл не больше [`MAX_FILE_SIZE`].
fn read_limited(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_SIZE {
        tracing::warn!(path = %path.display(), "файл расширения слишком большой, пропускаю");
        return None;
    }
    match std::fs::read_to_string(path) {
        // BOM перед CSS ломает первое правило
        Ok(text) => Some(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()),
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "файл расширения не читается");
            None
        }
    }
}

fn write_atomically(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    write_text_atomically(path, &text)
}

/// Записать файл через временный: при сбое старый текст остаётся целым.
fn write_text_atomically(path: &Path, text: &str) -> std::io::Result<()> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, path)
}

// ───────────────────────────────── страница ─────────────────────────────────

/// Выполнить на странице метод моста `window.__arachnidDesktop`.
pub(crate) fn call_page(app: &AppHandle, call: &str) {
    if let Some(window) = app.get_webview_window(desktop::MAIN_WINDOW) {
        let _ = window.eval(format!(
            "window.__arachnidDesktop && window.__arachnidDesktop.{call};"
        ));
    }
}

/// Передать странице текущие стили.
fn push_styles(app: &AppHandle) {
    let styles = app.state::<Arc<Extensions>>().styles();
    if let Ok(json) = serde_json::to_string(&styles) {
        call_page(app, &format!("setStyles({json})"));
    }
}

/// Сообщить настройкам веб-клиента, что темы или плагины изменились не с
/// их страницы (трей, сохранённый файл).
fn notify_page(app: &AppHandle) {
    call_page(app, "extensionsChanged()");
}

/// Выполнить включённые плагины после загрузки страницы веб-клиента.
///
/// Каждый плагин — отдельный скрипт в глобальной области страницы, как у
/// Avia Client: ошибка одного не мешает остальным. Метка на `window` не даёт
/// выполнить их дважды в одном документе.
pub fn on_page_load(window: WebviewWindow, payload: PageLoadPayload<'_>) {
    let app = window.app_handle();
    let extensions = app.state::<Arc<Extensions>>().inner().clone();
    tracing::info!(url = %payload.url(), event = ?payload.event(), "страница");
    if payload.event() == PageLoadEvent::Started {
        // код прошлой страницы выгружен вместе с ней
        extensions.set_running(Vec::new());
        return;
    }
    if !app.state::<Instance>().owns(payload.url()) {
        return;
    }
    let plugins = extensions.plugins();
    if plugins.is_empty() {
        return;
    }
    let target = window.clone();
    let first_time = "(() => { if (window.__arachnidPluginsLoaded) return false; \
                      Object.defineProperty(window, '__arachnidPluginsLoaded', { value: true }); \
                      return true; })()";
    let result = window.eval_with_callback(first_time, move |result| {
        if result.trim() != "true" {
            return;
        }
        let mut running = Vec::with_capacity(plugins.len());
        for (name, code) in &plugins {
            tracing::info!(plugin = %name, "запускаю плагин");
            match target.eval(plugin_script(name, code)) {
                Ok(()) => running.push(name.clone()),
                Err(error) => tracing::warn!(%error, plugin = %name, "плагин не запустился"),
            }
        }
        extensions.set_running(running);
        notify_page(target.app_handle());
    });
    if let Err(error) = result {
        tracing::warn!(%error, "плагины не запущены");
    }
}

/// Код плагина с подписью для консоли разработчика (`//# sourceURL`).
fn plugin_script(name: &str, code: &str) -> String {
    // имя попадает в комментарий: переводы строк из него убираются
    let label: String = name.chars().filter(|c| !c.is_control()).collect();
    format!("{code}\n//# sourceURL=arachnid-plugins/{label}\n")
}

/// Следить за папками: сохранённая тема применяется сразу, новые файлы
/// появляются в меню трея и в настройках.
pub fn start_watcher(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("extensions-watch".into())
        .spawn(move || {
            let extensions = app.state::<Arc<Extensions>>().inner().clone();
            let mut last = extensions.snapshot();
            loop {
                std::thread::sleep(WATCH_INTERVAL);
                let next = extensions.snapshot();
                if next == last {
                    continue;
                }
                if next.themes != last.themes || next.quick_css != last.quick_css {
                    push_styles(&app);
                }
                // редактор QuickCSS в настройках подхватит правку из другой программы
                if next.quick_css != last.quick_css {
                    call_page(&app, "quickCssChanged()");
                }
                if names(&next.themes) != names(&last.themes)
                    || names(&next.plugins) != names(&last.plugins)
                {
                    desktop::refresh_tray(&app);
                }
                // название и настройки темы могли измениться вместе с файлом
                if next.themes != last.themes || next.plugins != last.plugins {
                    notify_page(&app);
                }
                last = next;
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "слежение за темами и плагинами не запустилось");
    }
}

/// Имена файлов: по ним видно, что меню трея пора пересобрать.
fn names(entries: &[Entry]) -> Vec<&str> {
    entries.iter().map(|entry| entry.name.as_str()).collect()
}

// ─────────────────────────────────── трей ───────────────────────────────────

/// Подменю «Расширения» для меню трея.
pub fn tray_submenu(app: &AppHandle, labels: &TrayLabels) -> tauri::Result<Submenu<tauri::Wry>> {
    let extensions = app.state::<Arc<Extensions>>();
    let themes = themes_submenu(app, &extensions, labels)?;
    let plugins = plugins_submenu(app, &extensions, labels)?;
    let quick_css = MenuItem::with_id(app, MENU_QUICK_CSS, &labels.quick_css, true, None::<&str>)?;
    let submenu = Submenu::with_items(
        app,
        &labels.extensions,
        true,
        &[&themes, &plugins, &quick_css],
    )?;
    if let Some(actions) = plugin_actions_submenu(app, &extensions, labels)? {
        submenu.append(&PredefinedMenuItem::separator(app)?)?;
        submenu.append(&actions)?;
    }
    Ok(submenu)
}

/// «Действия плагинов»: пункты `AviaMenu` в порядке регистрации, сначала
/// отдельные действия, затем группы (как в меню Avia Client).
fn plugin_actions_submenu(
    app: &AppHandle,
    extensions: &Extensions,
    labels: &TrayLabels,
) -> tauri::Result<Option<Submenu<tauri::Wry>>> {
    let entries = extensions.plugin_menu();
    if entries.is_empty() {
        return Ok(None);
    }
    let action = |id: &str, name: &str| {
        MenuItem::with_id(
            app,
            format!("{MENU_ACTION}{id}"),
            menu_text(name),
            true,
            None::<&str>,
        )
    };
    let submenu = Submenu::new(app, &labels.plugin_actions, true)?;
    for entry in entries {
        match entry.items {
            // у Avia пустая группа тоже не показывается
            Some(items) if items.is_empty() => {}
            Some(items) => {
                let group = Submenu::new(app, menu_text(&entry.name), true)?;
                for item in items {
                    group.append(&action(&item.id, &item.name)?)?;
                }
                submenu.append(&group)?;
            }
            None => submenu.append(&action(&entry.id, &entry.name)?)?,
        }
    }
    Ok(Some(submenu))
}

/// «Темы»: стандартное оформление и по пункту на файл, отмечен выбранный.
fn themes_submenu(
    app: &AppHandle,
    extensions: &Extensions,
    labels: &TrayLabels,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let submenu = Submenu::new(app, &labels.themes, true)?;
    let active = extensions.active_theme();
    submenu.append(&CheckMenuItem::with_id(
        app,
        MENU_THEME_DEFAULT,
        &labels.default_theme,
        true,
        active.is_none(),
        None::<&str>,
    )?)?;
    let entries = extensions.list(Kind::Theme);
    if !entries.is_empty() {
        submenu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    for entry in entries {
        let checked = active.as_deref() == Some(entry.name.as_str());
        submenu.append(&CheckMenuItem::with_id(
            app,
            format!("{MENU_THEME}{}", entry.name),
            menu_text(&entry.name),
            true,
            checked,
            None::<&str>,
        )?)?;
    }
    submenu.append(&PredefinedMenuItem::separator(app)?)?;
    submenu.append(&MenuItem::with_id(
        app,
        MENU_OPEN_THEMES,
        &labels.open_folder,
        true,
        None::<&str>,
    )?)?;
    Ok(submenu)
}

/// «Плагины»: флажок на каждый файл и «Открыть папку».
fn plugins_submenu(
    app: &AppHandle,
    extensions: &Extensions,
    labels: &TrayLabels,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let submenu = Submenu::new(app, &labels.plugins, true)?;
    let entries = extensions.list(Kind::Plugin);
    if entries.is_empty() {
        submenu.append(&MenuItem::new(
            app,
            &labels.no_plugins,
            false,
            None::<&str>,
        )?)?;
    }
    for entry in entries {
        let item = CheckMenuItem::with_id(
            app,
            format!("{MENU_PLUGIN}{}", entry.name),
            menu_text(&entry.name),
            true,
            extensions.plugin_enabled(&entry.name),
            None::<&str>,
        )?;
        submenu.append(&item)?;
    }
    submenu.append(&PredefinedMenuItem::separator(app)?)?;
    submenu.append(&MenuItem::with_id(
        app,
        MENU_OPEN_PLUGINS,
        &labels.open_folder,
        true,
        None::<&str>,
    )?)?;
    Ok(submenu)
}

/// Текст пункта меню: `&` в имени файла иначе становится мнемоникой.
fn menu_text(name: &str) -> String {
    name.replace('&', "&&")
}

/// Применить выбор темы: стили на странице, меню трея, раздел настроек.
fn theme_changed(app: &AppHandle) {
    push_styles(app);
    desktop::refresh_tray(app);
}

/// Обработать пункт подменю «Расширения»; остальные пункты не трогаются.
pub fn on_menu(app: &AppHandle, id: &str) {
    let extensions = app.state::<Arc<Extensions>>();
    if id == MENU_THEME_DEFAULT {
        extensions.set_theme(None);
        theme_changed(app);
        notify_page(app);
    } else if let Some(name) = id.strip_prefix(MENU_THEME) {
        // повторный выбор той же темы возвращает стандартное оформление
        let same = extensions.active_theme().as_deref() == Some(name);
        extensions.set_theme((!same).then_some(name));
        theme_changed(app);
        notify_page(app);
    } else if let Some(name) = id.strip_prefix(MENU_PLUGIN) {
        let value = !extensions.plugin_enabled(name);
        extensions.set_plugin(name, value);
        tracing::info!(plugin = %name, enabled = value, "плагин переключён, перезагружаю страницу");
        desktop::refresh_tray(app);
        if let Some(window) = app.get_webview_window(desktop::MAIN_WINDOW) {
            let _ = window.reload();
        }
    } else if let Some(action) = id.strip_prefix(MENU_ACTION) {
        // действие обычно открывает окно настроек плагина на странице
        desktop::show_main_window(app);
        if let Ok(action) = serde_json::to_string(action) {
            call_page(app, &format!("runMenuItem({action})"));
        }
    } else if id == MENU_OPEN_THEMES {
        extensions.open(OpenTarget::Themes);
    } else if id == MENU_OPEN_PLUGINS {
        extensions.open(OpenTarget::Plugins);
    } else if id == MENU_QUICK_CSS {
        // редактор QuickCSS — окно поверх клиента (settings.js)
        desktop::show_main_window(app);
        call_page(app, "openQuickCss()");
    }
}

/// Открыть папку в проводнике или файл в программе по умолчанию.
fn open_path(path: &Path) {
    if path.extension().is_none() {
        let _ = std::fs::create_dir_all(path);
    }
    if let Err(error) = open::that_detached(path) {
        tracing::warn!(%error, path = %path.display(), "не удалось открыть");
    }
}

// ─────────────────────────────────── команды ───────────────────────────────────
//
// Команды моста (`bridge.js`) и раздела настроек (`settings.js`).

/// Стили при загрузке страницы (`bridge.js`): темы видны сразу, без вспышки.
#[tauri::command]
pub fn extensions_styles(extensions: State<'_, Arc<Extensions>>) -> Vec<Style> {
    extensions.styles()
}

/// Пункты `window.AviaMenu` страницы (`bridge.js`) — в меню трея.
#[tauri::command]
pub fn set_plugin_menu(
    entries: Vec<PluginMenuEntry>,
    app: AppHandle,
    extensions: State<'_, Arc<Extensions>>,
) {
    if extensions.set_plugin_menu(entries) {
        desktop::refresh_tray(&app);
    }
}

/// Темы и плагины для настроек веб-клиента.
#[tauri::command]
pub fn extensions_overview(extensions: State<'_, Arc<Extensions>>) -> Overview {
    extensions.overview()
}

/// Выбор в «Внешнем виде»: тема или `null` — стандартное оформление Stoat.
#[tauri::command]
pub fn extensions_set_theme(
    file: Option<String>,
    app: AppHandle,
    extensions: State<'_, Arc<Extensions>>,
) -> CmdResult<Overview> {
    if !extensions.set_theme(file.as_deref()) {
        return Err(CommandError::new("theme", "такой темы нет в папке themes"));
    }
    theme_changed(&app);
    Ok(extensions.overview())
}

/// Изменить настройку темы; `value: null` — значение по умолчанию.
#[tauri::command]
pub fn extensions_set_theme_value(
    file: String,
    name: String,
    value: Option<String>,
    app: AppHandle,
    extensions: State<'_, Arc<Extensions>>,
) -> CmdResult<Overview> {
    if !extensions.set_theme_value(&file, &name, value.as_deref()) {
        return Err(CommandError::new(
            "theme",
            "значение не подходит к настройке темы",
        ));
    }
    if extensions.active_theme().as_deref() == Some(file.as_str()) {
        push_styles(&app);
    }
    Ok(extensions.overview())
}

/// «Сбросить» в настройках темы.
#[tauri::command]
pub fn extensions_reset_theme(
    file: String,
    app: AppHandle,
    extensions: State<'_, Arc<Extensions>>,
) -> Overview {
    extensions.reset_theme(&file);
    if extensions.active_theme().as_deref() == Some(file.as_str()) {
        push_styles(&app);
    }
    extensions.overview()
}

/// Переключатель плагина в разделе «Плагины». Страница не
/// перезагружается сама: раздел предлагает перезагрузку, когда включённые
/// плагины отличаются от запущенных.
#[tauri::command]
pub fn extensions_set_plugin(
    file: String,
    enabled: bool,
    app: AppHandle,
    extensions: State<'_, Arc<Extensions>>,
) -> CmdResult<Overview> {
    if !extensions.exists(Kind::Plugin, &file) {
        return Err(CommandError::new(
            "plugin",
            "такого плагина нет в папке plugins",
        ));
    }
    extensions.set_plugin(&file, enabled);
    tracing::info!(plugin = %file, enabled, "плагин переключён в настройках");
    desktop::refresh_tray(&app);
    Ok(extensions.overview())
}

/// Кнопки «Папка тем», «Папка плагинов» и «Открыть в редакторе» (QuickCSS).
#[tauri::command]
pub fn extensions_open(target: OpenTarget, extensions: State<'_, Arc<Extensions>>) {
    extensions.open(target);
}

/// Текст QuickCSS для редактора в настройках.
#[tauri::command]
pub fn extensions_quick_css(extensions: State<'_, Arc<Extensions>>) -> CmdResult<String> {
    extensions.quick_css()
}

/// Сохранить QuickCSS из редактора и сразу применить на странице.
#[tauri::command]
pub fn extensions_set_quick_css(
    css: String,
    app: AppHandle,
    extensions: State<'_, Arc<Extensions>>,
) -> CmdResult<()> {
    extensions.set_quick_css(&css)?;
    push_styles(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("arachnid-ext-{name}-{nanos:x}"));
        std::fs::create_dir_all(dir.join(THEMES_DIR)).unwrap();
        std::fs::create_dir_all(dir.join(PLUGINS_DIR)).unwrap();
        dir
    }

    fn extensions(dir: &Path) -> Extensions {
        Extensions::new(
            dir.to_path_buf(),
            Url::parse("https://stoat.chat/app").unwrap(),
        )
    }

    #[test]
    fn new_files_are_disabled() {
        let dir = temp_dir("disabled");
        std::fs::write(dir.join(THEMES_DIR).join("dark.css"), "body{}").unwrap();
        std::fs::write(dir.join(PLUGINS_DIR).join("hello.js"), "1").unwrap();
        let extensions = extensions(&dir);
        assert_eq!(extensions.list(Kind::Theme).len(), 1);
        assert!(extensions.styles().is_empty());
        assert!(extensions.plugins().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_matching_files_are_listed() {
        let dir = temp_dir("list");
        let themes = dir.join(THEMES_DIR);
        for name in ["b.css", "A.CSS", "notes.txt", ".b.css.swp", ".hidden.css"] {
            std::fs::write(themes.join(name), "x").unwrap();
        }
        std::fs::create_dir_all(themes.join("folder.css")).unwrap();
        let names: Vec<String> = list_dir(&themes, "css")
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, ["A.CSS", "b.css"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn one_theme_comes_before_quick_css() {
        let dir = temp_dir("styles");
        std::fs::write(dir.join(THEMES_DIR).join("b.css"), "b{}").unwrap();
        std::fs::write(dir.join(THEMES_DIR).join("a.css"), "\u{feff}a{}").unwrap();
        std::fs::write(dir.join(QUICK_CSS), "q{}").unwrap();
        let extensions = extensions(&dir);
        assert!(extensions.set_theme(Some("b.css")));
        assert!(
            extensions.set_theme(Some("a.css")),
            "выбор заменяет прошлую тему"
        );
        assert!(!extensions.set_theme(Some("нет.css")));
        let styles = extensions.styles();
        let ids: Vec<&str> = styles.iter().map(|style| style.id.as_str()).collect();
        assert_eq!(ids, ["theme:a.css", "quickcss"]);
        assert_eq!(styles[0].css, "a{}", "BOM убран");

        assert!(extensions.set_theme(None));
        assert_eq!(
            extensions.styles().len(),
            1,
            "стандартное оформление — только QuickCSS"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_enabled_themes_become_one_choice() {
        let dir = temp_dir("legacy");
        std::fs::write(dir.join(THEMES_DIR).join("night.css"), "n{}").unwrap();
        std::fs::write(
            dir.join(STATE_FILE),
            r#"{"themes":{"day.css":false,"night.css":true},"plugins":{"x.js":true}}"#,
        )
        .unwrap();
        let extensions = extensions(&dir);
        assert_eq!(extensions.active_theme().as_deref(), Some("night.css"));
        assert!(extensions.plugin_enabled("x.js"));
        extensions.set_plugin("x.js", false);
        let saved = std::fs::read_to_string(dir.join(STATE_FILE)).unwrap();
        assert!(
            !saved.contains("\"themes\""),
            "старое поле больше не пишется"
        );
        assert!(saved.contains("\"theme\": \"night.css\""));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn theme_settings_are_saved_and_applied() {
        let dir = temp_dir("settings");
        let theme = "/* ==UserStyle==\n@name Ночь\n@var color accent \"Акцент\" #123456\n\
                     @var select palette \"Палитра\" [\"dark:Тёмная*\", \"oled:OLED\"]\n==/UserStyle== */\nbody{}";
        std::fs::write(dir.join(THEMES_DIR).join("night.css"), theme).unwrap();
        let extensions = extensions(&dir);
        extensions.set_theme(Some("night.css"));
        assert!(extensions.set_theme_value("night.css", "palette", Some("oled")));
        assert!(!extensions.set_theme_value("night.css", "palette", Some("розовая")));
        assert!(!extensions.set_theme_value("night.css", "нет", Some("1")));
        assert!(extensions.styles()[0].css.contains("--palette: oled;"));

        let overview = extensions.overview();
        assert_eq!(overview.theme.as_deref(), Some("night.css"));
        let info = &overview.themes[0];
        assert_eq!(info.meta.name.as_deref(), Some("Ночь"));
        assert_eq!(info.values["accent"], "#123456");
        assert_eq!(info.values["palette"], "oled");

        extensions.reset_theme("night.css");
        assert!(extensions.styles()[0].css.contains("--palette: dark;"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn overview_shows_when_reload_is_needed() {
        let dir = temp_dir("reload");
        std::fs::write(
            dir.join(PLUGINS_DIR).join("klipy.js"),
            "// @name Klipy\n// @author Ava\nrun()",
        )
        .unwrap();
        let extensions = extensions(&dir);
        assert!(!extensions.overview().reload_needed);
        extensions.set_plugin("klipy.js", true);
        let overview = extensions.overview();
        assert!(overview.reload_needed, "включён, но ещё не запущен");
        assert_eq!(overview.plugins[0].name.as_deref(), Some("Klipy"));
        extensions.set_running(vec!["klipy.js".into()]);
        assert!(!extensions.overview().reload_needed);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn choice_survives_restart() {
        let dir = temp_dir("state");
        std::fs::write(dir.join(PLUGINS_DIR).join("translate.js"), "go()").unwrap();
        extensions(&dir).set_plugin("translate.js", true);
        let plugins = extensions(&dir).plugins();
        assert_eq!(plugins, [("translate.js".to_owned(), "go()".to_owned())]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn removed_plugin_is_not_loaded() {
        let dir = temp_dir("removed");
        let extensions = extensions(&dir);
        extensions.set_plugin("gone.js", true);
        assert!(extensions.plugins().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn plugin_label_cannot_break_out_of_comment() {
        let script = plugin_script("evil\nalert(1).js", "run()");
        assert!(script.starts_with("run()\n"));
        assert!(script.ends_with("//# sourceURL=arachnid-plugins/evilalert(1).js\n"));
    }

    #[test]
    fn plugin_menu_keeps_shape_from_bridge() {
        // так bridge.js присылает пункты AviaMenu
        let entries: Vec<PluginMenuEntry> = serde_json::from_str(
            r#"[{"id":"klipy-api","name":"Set API Key"},
                {"id":"autocap","name":"Auto Capitalize","items":[{"id":"t","name":"Enabled"}]}]"#,
        )
        .unwrap();
        assert_eq!(entries[0].items, None);
        assert_eq!(entries[1].items.as_ref().map(Vec::len), Some(1));

        let extensions = extensions(&temp_dir("menu"));
        assert!(extensions.set_plugin_menu(entries.clone()));
        assert!(
            !extensions.set_plugin_menu(entries),
            "без изменений меню не пересобирается"
        );
        let many = (0..100)
            .map(|i| PluginMenuEntry {
                id: i.to_string(),
                name: i.to_string(),
                items: None,
            })
            .collect();
        assert!(extensions.set_plugin_menu(many));
        assert_eq!(extensions.plugin_menu().len(), MAX_MENU_ENTRIES);
        std::fs::remove_dir_all(&extensions.dir).ok();
    }

    #[test]
    fn ampersand_is_shown_as_is() {
        assert_eq!(menu_text("black&white.css"), "black&&white.css");
    }

    #[test]
    fn snapshot_notices_saved_file() {
        let dir = temp_dir("snapshot");
        let extensions = extensions(&dir);
        let before = extensions.snapshot();
        std::fs::write(dir.join(QUICK_CSS), "body { color: red }").unwrap();
        assert_ne!(extensions.snapshot(), before);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn quick_css_is_edited_in_place() {
        let dir = temp_dir("quickcss");
        let extensions = extensions(&dir);
        // файла ещё нет: редактор показывает заготовку, файл не создаётся
        assert_eq!(extensions.quick_css().unwrap(), QUICK_CSS_TEMPLATE);
        assert!(!dir.join(QUICK_CSS).exists());

        extensions.set_quick_css("body { color: red }").unwrap();
        assert_eq!(extensions.quick_css().unwrap(), "body { color: red }");
        let last = extensions.styles().pop().unwrap();
        assert_eq!(
            (last.id.as_str(), last.css.as_str()),
            ("quickcss", "body { color: red }")
        );
        assert!(!dir.join("quickcss.css.tmp").exists());

        let huge = "a".repeat(MAX_FILE_SIZE as usize + 1);
        assert!(extensions.set_quick_css(&huge).is_err());
        assert_eq!(extensions.quick_css().unwrap(), "body { color: red }");
        std::fs::remove_dir_all(&dir).ok();
    }
}
