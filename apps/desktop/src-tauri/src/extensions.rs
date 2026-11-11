//! Расширения: темы, QuickCSS и плагины поверх веб-клиента.
//!
//! Устроено как у клиентских модов (Avia Client, Vencord): тема — файл CSS,
//! плагин — файл JavaScript, который выполняется на странице веб-клиента.
//! Всё лежит в каталоге данных, рядом с `config.toml`:
//!
//! ```text
//! themes/*.css     темы, включаются по одной в меню трея
//! plugins/*.js     плагины, включаются по одному в меню трея
//! quickcss.css     свой CSS, действует всегда
//! extensions.json  какие темы и плагины включены
//! ```
//!
//! Новые файлы по умолчанию выключены: плагин получает те же права, что и
//! страница (в том числе сессию), поэтому включать его нужно осознанно.
//!
//! Стили применяются сразу и обновляются при сохранении файла. Плагин
//! выполняется после загрузки страницы; включение и выключение плагина
//! перезагружает страницу — выгрузить уже выполненный код нельзя.
//!
//! Плагины Avia Client добавляют свои пункты (настройки, переключатели)
//! через `window.AviaMenu`. Мост (`bridge.js`) даёт тот же объект и передаёт
//! пункты сюда; они появляются в трее: «Расширения → Действия плагинов».

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::desktop::{self, TrayLabels};
use crate::instance::Instance;

/// Каталог тем в каталоге данных.
pub const THEMES_DIR: &str = "themes";
/// Каталог плагинов в каталоге данных.
pub const PLUGINS_DIR: &str = "plugins";
/// Свой CSS, который действует всегда.
const QUICK_CSS: &str = "quickcss.css";
/// Какие темы и плагины включены.
const STATE_FILE: &str = "extensions.json";
/// Больше этого файл темы или плагина не читается: защита от случайно
/// положенного архива или видео.
const MAX_FILE_SIZE: u64 = 8 * 1024 * 1024;
/// Как часто проверять папки на изменения.
const WATCH_INTERVAL: Duration = Duration::from_secs(1);

/// Префиксы id пунктов меню трея.
const MENU_THEME: &str = "ext-theme:";
const MENU_PLUGIN: &str = "ext-plugin:";
const MENU_OPEN_THEMES: &str = "ext-open-themes";
const MENU_OPEN_PLUGINS: &str = "ext-open-plugins";
const MENU_QUICK_CSS: &str = "ext-quickcss";
const MENU_ACTION: &str = "ext-action:";

/// Больше пунктов меню плагинов в трее не показывается.
const MAX_MENU_ENTRIES: usize = 64;

/// Заготовка `quickcss.css`, если его ещё нет.
const QUICK_CSS_TEMPLATE: &str = "/* QuickCSS: свой CSS для веб-клиента Stoat.\n   Действует всегда и обновляется сразу после сохранения файла. */\n";

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

/// Включённые темы и плагины (`extensions.json`); ключ — имя файла.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct Enabled {
    themes: BTreeMap<String, bool>,
    plugins: BTreeMap<String, bool>,
}

impl Enabled {
    fn map(&self, kind: Kind) -> &BTreeMap<String, bool> {
        match kind {
            Kind::Theme => &self.themes,
            Kind::Plugin => &self.plugins,
        }
    }

    fn map_mut(&mut self, kind: Kind) -> &mut BTreeMap<String, bool> {
        match kind {
            Kind::Theme => &mut self.themes,
            Kind::Plugin => &mut self.plugins,
        }
    }

    fn is_enabled(&self, kind: Kind, name: &str) -> bool {
        self.map(kind).get(name).copied().unwrap_or(false)
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

/// Расширения в каталоге данных.
pub struct Extensions {
    dir: PathBuf,
    enabled: Mutex<Enabled>,
    /// Пункты, которые плагины открытой страницы добавили в меню
    plugin_menu: Mutex<Vec<PluginMenuEntry>>,
}

impl Extensions {
    /// Прочитать `extensions.json`; повреждённый файл не мешает запуску.
    pub fn new(dir: PathBuf) -> Self {
        let enabled = match std::fs::read_to_string(dir.join(STATE_FILE)) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|error| {
                tracing::warn!(%error, "extensions.json повреждён, все расширения выключены");
                Enabled::default()
            }),
            Err(_) => Enabled::default(),
        };
        Self {
            dir,
            enabled: Mutex::new(enabled),
            plugin_menu: Mutex::new(Vec::new()),
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

    fn enabled(&self) -> Enabled {
        self.enabled
            .lock()
            .map(|enabled| enabled.clone())
            .unwrap_or_default()
    }

    /// Темы или плагины в папке, по имени файла.
    pub fn list(&self, kind: Kind) -> Vec<Entry> {
        list_dir(&self.dir.join(kind.dir()), kind.extension())
    }

    /// Включено ли расширение.
    pub fn is_enabled(&self, kind: Kind, name: &str) -> bool {
        self.enabled().is_enabled(kind, name)
    }

    /// Включить или выключить расширение и запомнить это.
    pub fn set_enabled(&self, kind: Kind, name: &str, value: bool) {
        let Ok(mut enabled) = self.enabled.lock() else {
            return;
        };
        enabled.map_mut(kind).insert(name.to_owned(), value);
        if let Err(error) = write_atomically(&self.dir.join(STATE_FILE), &*enabled) {
            tracing::warn!(%error, "не удалось сохранить extensions.json");
        }
    }

    /// Стили для страницы: включённые темы по имени файла, затем QuickCSS
    /// (он последний, чтобы перекрывать темы).
    pub fn styles(&self) -> Vec<Style> {
        let enabled = self.enabled();
        let mut styles: Vec<Style> = self
            .list(Kind::Theme)
            .into_iter()
            .filter(|entry| enabled.is_enabled(Kind::Theme, &entry.name))
            .filter_map(|entry| {
                let css = read_limited(&self.dir.join(THEMES_DIR).join(&entry.name))?;
                Some(Style {
                    id: format!("theme:{}", entry.name),
                    css,
                })
            })
            .collect();
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
        let enabled = self.enabled();
        self.list(Kind::Plugin)
            .into_iter()
            .filter(|entry| enabled.is_enabled(Kind::Plugin, &entry.name))
            .filter_map(|entry| {
                let code = read_limited(&self.dir.join(PLUGINS_DIR).join(&entry.name))?;
                Some((entry.name, code))
            })
            .collect()
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            themes: self.list(Kind::Theme),
            plugins: self.list(Kind::Plugin),
            quick_css: stamp(&self.dir.join(QUICK_CSS)),
        }
    }

    /// Путь к `quickcss.css`; при первом обращении создаётся заготовка.
    fn quick_css_path(&self) -> std::io::Result<PathBuf> {
        let path = self.dir.join(QUICK_CSS);
        if !path.exists() {
            std::fs::write(&path, QUICK_CSS_TEMPLATE)?;
        }
        Ok(path)
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
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, path)
}

// ───────────────────────────────── страница ─────────────────────────────────

/// Передать странице текущие стили.
fn push_styles(app: &AppHandle) {
    let Some(window) = app.get_webview_window(desktop::MAIN_WINDOW) else {
        return;
    };
    let styles = app.state::<Arc<Extensions>>().styles();
    let Ok(json) = serde_json::to_string(&styles) else {
        return;
    };
    let _ = window.eval(format!(
        "window.__arachnidDesktop && window.__arachnidDesktop.setStyles({json});"
    ));
}

/// Выполнить включённые плагины после загрузки страницы веб-клиента.
///
/// Каждый плагин — отдельный скрипт в глобальной области страницы, как у
/// Avia Client: ошибка одного не мешает остальным. Метка на `window` не даёт
/// выполнить их дважды в одном документе.
pub fn on_page_load(window: WebviewWindow, payload: PageLoadPayload<'_>) {
    if payload.event() != PageLoadEvent::Finished {
        return;
    }
    let app = window.app_handle();
    if !app.state::<Instance>().owns(payload.url()) {
        return;
    }
    let plugins = app.state::<Arc<Extensions>>().plugins();
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
        for (name, code) in &plugins {
            tracing::info!(plugin = %name, "запускаю плагин");
            if let Err(error) = target.eval(plugin_script(name, code)) {
                tracing::warn!(%error, plugin = %name, "плагин не запустился");
            }
        }
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
/// появляются в меню трея.
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
                if names(&next.themes) != names(&last.themes)
                    || names(&next.plugins) != names(&last.plugins)
                {
                    desktop::refresh_tray(&app);
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
    let themes = kind_submenu(app, &extensions, Kind::Theme, labels)?;
    let plugins = kind_submenu(app, &extensions, Kind::Plugin, labels)?;
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

/// «Темы» или «Плагины»: флажок на каждый файл и «Открыть папку».
fn kind_submenu(
    app: &AppHandle,
    extensions: &Extensions,
    kind: Kind,
    labels: &TrayLabels,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let (prefix, open_id, title, empty) = match kind {
        Kind::Theme => (
            MENU_THEME,
            MENU_OPEN_THEMES,
            &labels.themes,
            &labels.no_themes,
        ),
        Kind::Plugin => (
            MENU_PLUGIN,
            MENU_OPEN_PLUGINS,
            &labels.plugins,
            &labels.no_plugins,
        ),
    };
    let submenu = Submenu::new(app, title, true)?;
    let entries = extensions.list(kind);
    if entries.is_empty() {
        submenu.append(&MenuItem::new(app, empty, false, None::<&str>)?)?;
    }
    for entry in entries {
        let item = CheckMenuItem::with_id(
            app,
            format!("{prefix}{}", entry.name),
            menu_text(&entry.name),
            true,
            extensions.is_enabled(kind, &entry.name),
            None::<&str>,
        )?;
        submenu.append(&item)?;
    }
    submenu.append(&PredefinedMenuItem::separator(app)?)?;
    submenu.append(&MenuItem::with_id(
        app,
        open_id,
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

/// Обработать пункт подменю «Расширения»; остальные пункты не трогаются.
pub fn on_menu(app: &AppHandle, id: &str) {
    let extensions = app.state::<Arc<Extensions>>();
    if let Some(name) = id.strip_prefix(MENU_THEME) {
        let value = !extensions.is_enabled(Kind::Theme, name);
        extensions.set_enabled(Kind::Theme, name, value);
        push_styles(app);
        desktop::refresh_tray(app);
    } else if let Some(name) = id.strip_prefix(MENU_PLUGIN) {
        let value = !extensions.is_enabled(Kind::Plugin, name);
        extensions.set_enabled(Kind::Plugin, name, value);
        tracing::info!(plugin = %name, enabled = value, "плагин переключён, перезагружаю страницу");
        desktop::refresh_tray(app);
        if let Some(window) = app.get_webview_window(desktop::MAIN_WINDOW) {
            let _ = window.reload();
        }
    } else if let Some(action) = id.strip_prefix(MENU_ACTION) {
        // действие обычно открывает окно настроек плагина на странице
        desktop::show_main_window(app);
        if let (Some(window), Ok(action)) = (
            app.get_webview_window(desktop::MAIN_WINDOW),
            serde_json::to_string(action),
        ) {
            let _ = window.eval(format!(
                "window.__arachnidDesktop && window.__arachnidDesktop.runMenuItem({action});"
            ));
        }
    } else if id == MENU_OPEN_THEMES {
        open_path(&extensions.dir.join(THEMES_DIR));
    } else if id == MENU_OPEN_PLUGINS {
        open_path(&extensions.dir.join(PLUGINS_DIR));
    } else if id == MENU_QUICK_CSS {
        match extensions.quick_css_path() {
            Ok(path) => open_path(&path),
            Err(error) => tracing::warn!(%error, "не удалось создать quickcss.css"),
        }
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

    #[test]
    fn new_files_are_disabled() {
        let dir = temp_dir("disabled");
        std::fs::write(dir.join(THEMES_DIR).join("dark.css"), "body{}").unwrap();
        std::fs::write(dir.join(PLUGINS_DIR).join("hello.js"), "1").unwrap();
        let extensions = Extensions::new(dir.clone());
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
    fn enabled_themes_come_before_quick_css() {
        let dir = temp_dir("styles");
        std::fs::write(dir.join(THEMES_DIR).join("b.css"), "b{}").unwrap();
        std::fs::write(dir.join(THEMES_DIR).join("a.css"), "\u{feff}a{}").unwrap();
        std::fs::write(dir.join(THEMES_DIR).join("off.css"), "off{}").unwrap();
        std::fs::write(dir.join(QUICK_CSS), "q{}").unwrap();
        let extensions = Extensions::new(dir.clone());
        extensions.set_enabled(Kind::Theme, "b.css", true);
        extensions.set_enabled(Kind::Theme, "a.css", true);
        let styles = extensions.styles();
        let ids: Vec<&str> = styles.iter().map(|style| style.id.as_str()).collect();
        assert_eq!(ids, ["theme:a.css", "theme:b.css", "quickcss"]);
        assert_eq!(styles[0].css, "a{}", "BOM убран");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn choice_survives_restart() {
        let dir = temp_dir("state");
        std::fs::write(dir.join(PLUGINS_DIR).join("translate.js"), "go()").unwrap();
        Extensions::new(dir.clone()).set_enabled(Kind::Plugin, "translate.js", true);
        let plugins = Extensions::new(dir.clone()).plugins();
        assert_eq!(plugins, [("translate.js".to_owned(), "go()".to_owned())]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn removed_plugin_is_not_loaded() {
        let dir = temp_dir("removed");
        let extensions = Extensions::new(dir.clone());
        extensions.set_enabled(Kind::Plugin, "gone.js", true);
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

        let extensions = Extensions::new(temp_dir("menu"));
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
        let extensions = Extensions::new(dir.clone());
        let before = extensions.snapshot();
        std::fs::write(dir.join(QUICK_CSS), "body { color: red }").unwrap();
        assert_ne!(extensions.snapshot(), before);
        std::fs::remove_dir_all(&dir).ok();
    }
}
