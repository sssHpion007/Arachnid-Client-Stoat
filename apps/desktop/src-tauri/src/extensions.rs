//! Расширения: темы, QuickCSS и плагины поверх веб-клиента.
//!
//! Устроено как у клиентских модов (Avia Client, Vencord, BetterDiscord):
//! тема — CSS, плагин — JavaScript, который выполняется на странице
//! веб-клиента. Всё лежит в каталоге данных, рядом с `config.toml`:
//!
//! ```text
//! themes/*.css             темы одним файлом (UserCSS)
//! themes/<id>/theme.toml   тема-папка: стили, картинки, шрифты
//! plugins/*.js             плагины одним файлом (формат Avia Client)
//! plugins/<id>/plugin.toml плагин-папка: код страницы, стили, модуль
//!                          WebAssembly, файлы; настройки и разрешения
//! plugin-data/<id>/        хранилище плагинов-папок
//! quickcss.css             свой CSS, действует всегда
//! extensions.json          выбранная тема, настройки, включённые плагины
//!                          и подтверждённые разрешения
//! ```
//!
//! Описание папок — [`crate::manifest`], нативные модули, хранилище и сеть
//! плагинов — [`crate::plugin_host`]. Файлы из папок страница получает по
//! адресам `http://arachnid.localhost/<plugins|themes>/<id>/<путь>` (в Linux
//! и macOS — `arachnid://localhost/…`); относительные `url()` в стилях папок
//! ведут туда же. По той же схеме отдаются превью избранных GIF
//! (`/favorite-gifs/<id>.webp`, [`crate::favorite_gifs`]). Ядро клиента
//! (мост, настройки, наборы эмодзи) не выключается; встроенные плагины
//! (`builtin:*`) — выключаются, как и остальные.
//!
//! Тема может описать свои настройки (палитры, цвета, размеры) в заголовке
//! UserCSS (см. [`crate::usercss`]); пока тема выбрана, «Внешний вид»
//! показывает их вместо встроенных цветов Stoat.
//!
//! Новые плагины по умолчанию выключены: плагин получает те же права, что и
//! страница (в том числе сессию), поэтому включать его нужно осознанно.
//! Плагин-папка, которому нужна сеть в обход ограничений страницы, называет
//! адреса в `plugin.toml`; при включении их подтверждает пользователь.
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
use serde_json::{Value, json};
use tauri::menu::{CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, State, WebviewWindow};

use url::Url;

use crate::desktop::{self, TrayLabels};
use crate::favorite_gifs::{self, FavoriteGifs};
use crate::instance::Instance;
use crate::manifest::{self, PluginManifest};
use crate::plugin_host::{self, FetchRequest, FetchResponse, NativeHost, Storage};
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

/// Схема адресов файлов из папок тем и плагинов.
pub const ASSET_SCHEME: &str = "arachnid";
/// Начало адресов файлов: так WebView2 (Windows) и WebKit (Linux, macOS)
/// показывают свою схему странице.
#[cfg(windows)]
pub(crate) const ASSET_BASE: &str = "http://arachnid.localhost/";
#[cfg(not(windows))]
pub(crate) const ASSET_BASE: &str = "arachnid://localhost/";
/// Больше этого файл из папки не отдаётся.
const MAX_ASSET_SIZE: u64 = 64 * 1024 * 1024;
/// Сколько файлов папки проверять на изменения и как глубоко.
const MAX_WATCHED_FILES: usize = 256;
const MAX_WATCH_DEPTH: usize = 4;

/// Версия API плагинов (`plugin` в коде плагина-папки, `plugin.toml`).
pub const API_VERSION: u32 = 1;
/// Начало ключей встроенных плагинов: в именах файлов и папок `:` не бывает.
const BUILTIN_PREFIX: &str = "builtin:";

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

    /// Манифест папки.
    fn manifest(self) -> &'static str {
        match self {
            Self::Theme => manifest::THEME_MANIFEST,
            Self::Plugin => manifest::PLUGIN_MANIFEST,
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
    /// Значения настроек плагинов-папок: плагин → имя настройки → значение
    plugin_settings: BTreeMap<String, BTreeMap<String, String>>,
    /// Подтверждённые адреса сети: плагин → адреса из `[permissions] network`
    granted: BTreeMap<String, Vec<String>>,
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

    /// Включён ли плагин; новые выключены, встроенные — включены.
    fn plugin_enabled(&self, name: &str) -> bool {
        self.plugins
            .get(name)
            .copied()
            .unwrap_or_else(|| builtin(name).is_some_and(|builtin| builtin.enabled_by_default))
    }

    /// Адреса сети, которые плагин просит и пользователь подтвердил.
    fn network(&self, id: &str, manifest: &PluginManifest) -> Vec<String> {
        let granted = self.granted.get(id);
        manifest
            .network
            .iter()
            .filter(|host| granted.is_some_and(|granted| granted.contains(host)))
            .cloned()
            .collect()
    }

    /// Действующие значения настроек плагина-папки.
    fn plugin_values(&self, id: &str, manifest: &PluginManifest) -> BTreeMap<String, String> {
        manifest::effective_values(&manifest.settings, self.plugin_settings.get(id))
    }

    /// Все ли адреса, которые просит плагин, подтверждены.
    fn granted(&self, id: &str, manifest: &PluginManifest) -> bool {
        self.network(id, manifest).len() == manifest.network.len()
    }
}

// ─────────────────────────────── встроенные ───────────────────────────────

/// Плагин, встроенный в клиент.
struct Builtin {
    /// Ключ в `extensions.json`
    id: &'static str,
    name: &'static str,
    description: &'static str,
    /// Включён, пока его не выключили
    enabled_by_default: bool,
    /// Код для страницы
    code: fn() -> String,
}

/// Встроенные плагины: улучшения, которые не обязательны для работы
/// клиента и поэтому выключаются, в отличие от ядра.
const BUILTINS: &[Builtin] = &[Builtin {
    id: "builtin:qol",
    name: "Quality of Life",
    description: "Разделы в окне эмодзи, избранные GIF, крупные реакции, значки ролей целиком",
    enabled_by_default: true,
    code: desktop::qol_script,
}];

fn builtin(id: &str) -> Option<&'static Builtin> {
    if !id.starts_with(BUILTIN_PREFIX) {
        return None;
    }
    BUILTINS.iter().find(|builtin| builtin.id == id)
}

/// Тема или плагин в папке.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Имя файла, например `catppuccin.css`, или имя папки
    pub name: String,
    /// Папка с манифестом, а не один файл
    pub folder: bool,
    /// Время изменения и размер (у папки — самого нового файла и всех
    /// файлов): по ним видно, что файл сохранили
    stamp: Option<(SystemTime, u64)>,
}

/// Тема, прочитанная с диска.
struct ThemeSource {
    /// Описание и настройки: из заголовка UserCSS или из `theme.toml`
    meta: usercss::Meta,
    /// Текст стилей; `None` — не читается
    css: Option<String>,
    /// Адрес файла стилей темы-папки: от него считаются относительные `url()`
    base: Option<Url>,
    /// Почему тема-папка не читается
    error: Option<String>,
}

/// Плагин, прочитанный с диска.
struct PluginSource {
    id: String,
    about: manifest::About,
    origin: Origin,
}

impl PluginSource {
    /// Название для меню и журнала: у файла — имя файла, как раньше.
    fn label(&self) -> &str {
        match &self.origin {
            Origin::Builtin(builtin) => builtin.name,
            _ => &self.id,
        }
    }

    /// Можно ли включить плагин без окна разрешений: он читается, и все
    /// адреса сети, которые он просит, уже подтверждены.
    fn ready(&self, saved: &Saved) -> bool {
        match &self.origin {
            Origin::Broken(_) => false,
            Origin::Folder(manifest) => saved.granted(&self.id, manifest),
            Origin::Builtin(_) | Origin::File => true,
        }
    }
}

/// Откуда плагин.
enum Origin {
    Builtin(&'static Builtin),
    /// `plugins/*.js`
    File,
    /// `plugins/<id>/plugin.toml`
    Folder(Box<PluginManifest>),
    /// Папка с ошибкой в `plugin.toml`
    Broken(String),
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
    /// Имя файла или папки
    file: String,
    /// Тема-папка
    folder: bool,
    /// Почему тема-папка не читается
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
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
    /// Имя файла, папки или `builtin:<имя>`
    file: String,
    /// `@name` / `name`
    name: Option<String>,
    /// `@description` / `description`
    description: Option<String>,
    /// `@author` / `author`
    author: Option<String>,
    /// `@version` / `version`
    version: Option<String>,
    /// Включён
    enabled: bool,
    /// Выполняется на открытой странице
    running: bool,
    /// Встроен в клиент
    builtin: bool,
    /// Плагин-папка
    folder: bool,
    /// Есть нативный модуль
    native: bool,
    /// Адреса, к которым плагин просит доступ в сеть
    network: Vec<String>,
    /// Все эти адреса подтверждены
    granted: bool,
    /// Настройки из `plugin.toml`
    settings: Vec<usercss::Setting>,
    /// Их действующие значения
    values: BTreeMap<String, String>,
    /// Почему плагин-папка не читается
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
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
    /// Версия клиента (ядра)
    version: &'static str,
    /// Версия API плагинов
    api_version: u32,
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
    /// Нативные модули и хранилище плагинов-папок
    host: NativeHost,
}

impl Extensions {
    /// Прочитать `extensions.json` из каталога данных.
    pub fn new(dir: PathBuf, app_url: Url) -> Self {
        let saved = Saved::load(&dir.join(STATE_FILE));
        let storage = Arc::new(Storage::new(dir.join(plugin_host::DATA_DIR)));
        Self {
            dir,
            app_url,
            saved: Mutex::new(saved),
            plugin_menu: Mutex::new(Vec::new()),
            running: Mutex::new(Vec::new()),
            host: NativeHost::new(storage),
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

    /// Темы или плагины в папке: файлы и папки с манифестом, по имени.
    pub fn list(&self, kind: Kind) -> Vec<Entry> {
        let dir = self.dir.join(kind.dir());
        let mut entries = list_dir(&dir, kind.extension());
        for folder in list_folders(&dir, kind.manifest()) {
            // ключ в extensions.json — имя: папка `x.css` рядом с файлом `x.css` спутала бы их
            if entries
                .iter()
                .any(|entry| entry.name.eq_ignore_ascii_case(&folder.name))
            {
                tracing::warn!(name = %folder.name, "папка совпадает по имени с файлом, пропускаю");
                continue;
            }
            entries.push(folder);
        }
        entries.sort_by_cached_key(|entry| entry.name.to_lowercase());
        entries
    }

    fn entry(&self, kind: Kind, name: &str) -> Option<Entry> {
        self.list(kind).into_iter().find(|entry| entry.name == name)
    }

    fn exists(&self, kind: Kind, name: &str) -> bool {
        self.entry(kind, name).is_some()
    }

    /// Папка темы или плагина.
    fn folder(&self, kind: Kind, name: &str) -> PathBuf {
        self.dir.join(kind.dir()).join(name)
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

    /// Прочитать тему: файл UserCSS или папку с `theme.toml`.
    fn load_theme(&self, entry: &Entry) -> ThemeSource {
        let path = self.folder(Kind::Theme, &entry.name);
        if !entry.folder {
            let css = read_limited(&path);
            let meta = css.as_deref().map(usercss::parse).unwrap_or_default();
            return ThemeSource {
                meta,
                css,
                base: None,
                error: None,
            };
        }
        let parsed = read_limited(&path.join(manifest::THEME_MANIFEST))
            .ok_or_else(|| format!("{} не читается", manifest::THEME_MANIFEST))
            .and_then(|text| manifest::parse_theme(&path, &text));
        match parsed {
            Ok(theme) => {
                let css = manifest::relative_path(&theme.main)
                    .and_then(|file| read_limited(&path.join(file)));
                let meta = usercss::Meta {
                    name: theme.about.name,
                    description: theme.about.description,
                    author: theme.about.author,
                    version: theme.about.version,
                    preprocessor: "default".into(),
                    supported: true,
                    settings: theme.settings,
                };
                ThemeSource {
                    meta,
                    css,
                    base: asset_url(Kind::Theme, &entry.name, &theme.main),
                    error: None,
                }
            }
            Err(error) => {
                tracing::warn!(theme = %entry.name, %error, "тема-папка не читается");
                ThemeSource {
                    meta: usercss::Meta {
                        name: Some(entry.name.clone()),
                        ..usercss::Meta::default()
                    },
                    css: None,
                    base: None,
                    error: Some(error),
                }
            }
        }
    }

    /// Изменить настройку темы; `None` — вернуть значение по умолчанию.
    /// Неподходящее значение не сохраняется.
    fn set_theme_value(&self, file: &str, name: &str, value: Option<&str>) -> bool {
        let Some(entry) = self.entry(Kind::Theme, file) else {
            return false;
        };
        let theme = self.load_theme(&entry);
        let Some(value) = checked_value(&theme.meta.settings, name, value) else {
            return false;
        };
        self.update(|saved| store_value(&mut saved.theme_settings, file, name, value));
        true
    }

    /// Сбросить все настройки темы.
    fn reset_theme(&self, file: &str) {
        self.update(|saved| {
            saved.theme_settings.remove(file);
        });
    }

    /// Включить или выключить плагин и запомнить это. Модуль выключенного
    /// плагина выгружается.
    pub fn set_plugin(&self, name: &str, value: bool) {
        self.update(|saved| {
            saved.plugins.insert(name.to_owned(), value);
        });
        if !value {
            self.host.unload(name);
        }
    }

    /// Запомнить, что пользователь разрешил плагину эти адреса.
    fn grant(&self, name: &str, hosts: &[String]) {
        tracing::info!(plugin = name, ?hosts, "разрешения плагина подтверждены");
        self.update(|saved| {
            saved.granted.insert(name.to_owned(), hosts.to_vec());
        });
    }

    /// Прочитать плагин: встроенный, файл или папку.
    fn plugin(&self, name: &str) -> Option<PluginSource> {
        if let Some(builtin) = builtin(name) {
            return Some(PluginSource {
                id: builtin.id.to_owned(),
                about: manifest::About {
                    name: Some(builtin.name.to_owned()),
                    version: Some(env!("CARGO_PKG_VERSION").to_owned()),
                    author: Some("Arachnid Client".to_owned()),
                    description: Some(builtin.description.to_owned()),
                },
                origin: Origin::Builtin(builtin),
            });
        }
        let entry = self.entry(Kind::Plugin, name)?;
        Some(self.load_plugin(entry))
    }

    fn load_plugin(&self, entry: Entry) -> PluginSource {
        let path = self.folder(Kind::Plugin, &entry.name);
        if !entry.folder {
            let meta = read_limited(&path)
                .map(|code| usercss::header(&code))
                .unwrap_or_default();
            return PluginSource {
                id: entry.name,
                about: manifest::About {
                    name: meta.name,
                    version: meta.version,
                    author: meta.author,
                    description: meta.description,
                },
                origin: Origin::File,
            };
        }
        let parsed = read_limited(&path.join(manifest::PLUGIN_MANIFEST))
            .ok_or_else(|| format!("{} не читается", manifest::PLUGIN_MANIFEST))
            .and_then(|text| manifest::parse_plugin(&path, &text));
        match parsed {
            Ok(manifest) => PluginSource {
                id: entry.name,
                about: manifest.about.clone(),
                origin: Origin::Folder(Box::new(manifest)),
            },
            Err(error) => {
                tracing::warn!(plugin = %entry.name, %error, "плагин-папка не читается");
                PluginSource {
                    about: manifest::About {
                        name: Some(entry.name.clone()),
                        ..manifest::About::default()
                    },
                    id: entry.name,
                    origin: Origin::Broken(error),
                }
            }
        }
    }

    /// Все плагины: сначала встроенные, затем из папки.
    fn all_plugins(&self) -> Vec<PluginSource> {
        let builtins = BUILTINS
            .iter()
            .filter_map(|builtin| self.plugin(builtin.id));
        let user = self
            .list(Kind::Plugin)
            .into_iter()
            .map(|entry| self.load_plugin(entry));
        builtins.chain(user).collect()
    }

    /// Включённый плагин-папка с его разрешёнными адресами — для команд
    /// хранилища, модуля и сети.
    fn active_folder(&self, name: &str) -> CmdResult<(Box<PluginManifest>, Vec<String>)> {
        let saved = self.saved();
        let plugin = self.plugin(name).filter(|_| saved.plugin_enabled(name));
        let Some(PluginSource {
            origin: Origin::Folder(manifest),
            ..
        }) = plugin
        else {
            return Err(CommandError::new(
                "plugin",
                format!("плагин-папка «{name}» не найден или выключен"),
            ));
        };
        let network = saved.network(name, &manifest);
        Ok((manifest, network))
    }

    /// Изменить настройку плагина-папки; `None` — значение по умолчанию.
    fn set_plugin_value(&self, file: &str, name: &str, value: Option<&str>) -> bool {
        let Some(PluginSource {
            origin: Origin::Folder(manifest),
            ..
        }) = self.plugin(file)
        else {
            return false;
        };
        let Some(value) = checked_value(&manifest.settings, name, value) else {
            return false;
        };
        self.update(|saved| store_value(&mut saved.plugin_settings, file, name, value));
        true
    }

    /// Сбросить все настройки плагина.
    fn reset_plugin(&self, file: &str) {
        self.update(|saved| {
            saved.plugin_settings.remove(file);
        });
    }

    /// Действующие значения настроек плагина-папки для его кода.
    fn plugin_values(&self, name: &str) -> Option<Value> {
        let Some(PluginSource {
            origin: Origin::Folder(manifest),
            ..
        }) = self.plugin(name)
        else {
            return None;
        };
        let values = self.saved().plugin_values(name, &manifest);
        Some(manifest::typed_values(&manifest.settings, &values))
    }

    fn read(&self, kind: Kind, name: &str) -> Option<String> {
        read_limited(&self.dir.join(kind.dir()).join(name))
    }

    /// Стили для страницы: выбранная тема с её настройками, стили
    /// запущенных плагинов-папок, затем QuickCSS (он последний, чтобы
    /// перекрывать остальное).
    pub fn styles(&self) -> Vec<Style> {
        let saved = self.saved();
        let mut styles = Vec::new();
        if let Some(name) = self.active_theme()
            && let Some(entry) = self.entry(Kind::Theme, &name)
        {
            let theme = self.load_theme(&entry);
            if let Some(css) = theme.css {
                let css = match &theme.base {
                    Some(base) => rebase_urls(&css, base),
                    None => css,
                };
                let empty = BTreeMap::new();
                let values = saved.theme_settings.get(&name).unwrap_or(&empty);
                styles.push(Style {
                    id: format!("theme:{name}"),
                    css: usercss::render(&css, &theme.meta, values, &self.app_url),
                });
            }
        }
        let running = self.running();
        for plugin in self.all_plugins() {
            if !running.contains(&plugin.id) {
                continue;
            }
            if let Origin::Folder(manifest) = &plugin.origin
                && let Some(css) = self.plugin_style(&plugin.id, manifest, &saved)
            {
                styles.push(Style {
                    id: format!("plugin:{}", plugin.id),
                    css,
                });
            }
        }
        if let Some(css) = read_limited(&self.dir.join(QUICK_CSS)) {
            styles.push(Style {
                id: "quickcss".into(),
                css,
            });
        }
        styles
    }

    /// Стили плагина-папки: настройки — переменными CSS, `url()` — в его папку.
    fn plugin_style(&self, id: &str, manifest: &PluginManifest, saved: &Saved) -> Option<String> {
        let style = manifest.style.as_deref()?;
        let path = self
            .folder(Kind::Plugin, id)
            .join(manifest::relative_path(style)?);
        let css = read_limited(&path)?;
        let css = match asset_url(Kind::Plugin, id, style) {
            Some(base) => rebase_urls(&css, &base),
            None => css,
        };
        if manifest.settings.is_empty() {
            return Some(css);
        }
        let values = saved.plugin_values(id, manifest);
        Some(usercss::css_variables(&manifest.settings, &values) + &css)
    }

    /// Код включённых плагинов для страницы: `(ключ, скрипт)`.
    pub fn plugins(&self) -> Vec<(String, String)> {
        let saved = self.saved();
        self.all_plugins()
            .into_iter()
            .filter(|plugin| saved.plugin_enabled(&plugin.id))
            .filter_map(|plugin| {
                let script = self.script(&plugin, &saved)?;
                Some((plugin.id, script))
            })
            .collect()
    }

    /// Скрипт плагина для страницы.
    fn script(&self, plugin: &PluginSource, saved: &Saved) -> Option<String> {
        match &plugin.origin {
            Origin::Builtin(builtin) => Some(plugin_script(&plugin.id, &(builtin.code)())),
            Origin::File => {
                let code = self.read(Kind::Plugin, &plugin.id)?;
                Some(plugin_script(&plugin.id, &code))
            }
            Origin::Folder(manifest) => {
                let code = match manifest.main.as_deref() {
                    Some(main) => read_limited(
                        &self
                            .folder(Kind::Plugin, &plugin.id)
                            .join(manifest::relative_path(main)?),
                    )?,
                    None => String::new(),
                };
                let values = saved.plugin_values(&plugin.id, manifest);
                let info = json!({
                    "id": plugin.id,
                    "name": plugin.about.name,
                    "version": plugin.about.version,
                    "author": plugin.about.author,
                    "description": plugin.about.description,
                    "apiVersion": API_VERSION,
                    "settings": manifest::typed_values(&manifest.settings, &values),
                    "assetBase": format!("{ASSET_BASE}{PLUGINS_DIR}/{}/", plugin.id),
                    "native": manifest.native.is_some(),
                    "network": saved.network(&plugin.id, manifest),
                });
                let main = manifest
                    .main
                    .as_deref()
                    .unwrap_or(manifest::PLUGIN_MANIFEST);
                Some(folder_plugin_script(&plugin.id, main, &code, &info))
            }
            Origin::Broken(_) => None,
        }
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
                let theme = self.load_theme(&entry);
                let stored = saved.theme_settings.get(&entry.name).unwrap_or(&empty);
                let values = manifest::effective_values(&theme.meta.settings, Some(stored));
                ThemeInfo {
                    file: entry.name,
                    folder: entry.folder,
                    error: theme.error,
                    meta: theme.meta,
                    values,
                }
            })
            .collect();
        let plugins: Vec<PluginInfo> = self
            .all_plugins()
            .into_iter()
            .map(|plugin| {
                let (manifest, error) = match plugin.origin {
                    Origin::Folder(manifest) => (Some(manifest), None),
                    Origin::Broken(error) => (None, Some(error)),
                    Origin::Builtin(_) | Origin::File => (None, None),
                };
                let values = manifest
                    .as_ref()
                    .map(|manifest| saved.plugin_values(&plugin.id, manifest))
                    .unwrap_or_default();
                PluginInfo {
                    enabled: saved.plugin_enabled(&plugin.id),
                    running: running.contains(&plugin.id),
                    builtin: builtin(&plugin.id).is_some(),
                    folder: manifest.is_some() || error.is_some(),
                    native: manifest
                        .as_ref()
                        .is_some_and(|manifest| manifest.native.is_some()),
                    granted: manifest
                        .as_ref()
                        .is_none_or(|manifest| saved.granted(&plugin.id, manifest)),
                    network: manifest
                        .as_ref()
                        .map(|manifest| manifest.network.clone())
                        .unwrap_or_default(),
                    settings: manifest
                        .map(|manifest| manifest.settings)
                        .unwrap_or_default(),
                    values,
                    error,
                    file: plugin.id,
                    name: plugin.about.name,
                    description: plugin.about.description,
                    author: plugin.about.author,
                    version: plugin.about.version,
                }
            })
            .collect();
        let reload_needed = plugins
            .iter()
            .any(|plugin| plugin.enabled != plugin.running && plugin.error.is_none());
        let theme = saved
            .theme
            .filter(|name| themes.iter().any(|theme| &theme.file == name));
        Overview {
            theme,
            themes,
            plugins,
            reload_needed,
            version: env!("CARGO_PKG_VERSION"),
            api_version: API_VERSION,
        }
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            themes: self.list(Kind::Theme),
            plugins: self.list(Kind::Plugin),
            quick_css: stamp(&self.dir.join(QUICK_CSS)),
        }
    }

    /// Файл из папки темы или плагина по пути адреса
    /// (`/plugins/<id>/<путь>`); `None` — такого файла нет или путь ведёт
    /// за пределы папки.
    fn asset_path(&self, path: &str) -> Option<PathBuf> {
        let path = percent_decode(path.strip_prefix('/').unwrap_or(path))?;
        let (dir, rest) = path.split_once('/')?;
        let kind = match dir {
            THEMES_DIR => Kind::Theme,
            PLUGINS_DIR => Kind::Plugin,
            _ => return None,
        };
        let (id, file) = rest.split_once('/')?;
        if !manifest::valid_id(id) {
            return None;
        }
        let folder = self.folder(kind, id);
        if !folder.join(kind.manifest()).is_file() {
            return None;
        }
        let file = folder.join(manifest::relative_path(file)?);
        // ссылки внутри папки не должны вести наружу
        let real = file.canonicalize().ok()?;
        let root = folder.canonicalize().ok()?;
        (real.starts_with(&root) && real.is_file()).then_some(real)
    }

    /// Ответ на запрос файла из папки.
    pub fn asset(&self, path: &str) -> tauri::http::Response<Vec<u8>> {
        let Some(file) = self.asset_path(path) else {
            return asset_response(404, "text/plain", b"not found".to_vec());
        };
        let fits = std::fs::metadata(&file).is_ok_and(|meta| meta.len() <= MAX_ASSET_SIZE);
        if !fits {
            return asset_response(413, "text/plain", b"too large".to_vec());
        }
        match std::fs::read(&file) {
            Ok(body) => asset_response(200, mime_type(&file), body),
            Err(error) => {
                tracing::warn!(%error, path = %file.display(), "файл расширения не читается");
                asset_response(500, "text/plain", b"unreadable".to_vec())
            }
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
                folder: false,
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

/// Папки с манифестом в каталоге; имя папки — идентификатор.
fn list_folders(dir: &Path, manifest_file: &str) -> Vec<Entry> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    read.filter_map(Result::ok)
        .filter(|item| item.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|item| {
            let name = item.file_name().into_string().ok()?;
            let path = item.path();
            let valid = manifest::valid_id(&name) && path.join(manifest_file).is_file();
            valid.then(|| Entry {
                stamp: folder_stamp(&path),
                folder: true,
                name,
            })
        })
        .collect()
}

/// Отметка папки: время самого нового файла и общий размер вместе с числом
/// файлов — меняется, когда файл сохранили, добавили или удалили.
fn folder_stamp(dir: &Path) -> Option<(SystemTime, u64)> {
    let mut newest: Option<SystemTime> = None;
    let mut total = 0u64;
    let mut count = 0u64;
    let mut pending = vec![(dir.to_path_buf(), 0usize)];
    while let Some((path, depth)) = pending.pop() {
        let Ok(read) = std::fs::read_dir(&path) else {
            continue;
        };
        for item in read.filter_map(Result::ok) {
            if count as usize >= MAX_WATCHED_FILES {
                break;
            }
            if item.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(meta) = item.metadata() else {
                continue;
            };
            if meta.is_dir() {
                if depth < MAX_WATCH_DEPTH {
                    pending.push((item.path(), depth + 1));
                }
                continue;
            }
            count += 1;
            total = total.wrapping_add(meta.len());
            if let Ok(modified) = meta.modified() {
                newest = newest.max(Some(modified));
            }
        }
    }
    Some((newest?, total.wrapping_add(count << 40)))
}

/// Проверить значение настройки: `Some(None)` — вернуть значение по
/// умолчанию, `None` — такой настройки нет или значение не подходит.
fn checked_value(
    settings: &[usercss::Setting],
    name: &str,
    value: Option<&str>,
) -> Option<Option<String>> {
    let setting = settings.iter().find(|setting| setting.name == name)?;
    match value {
        Some(value) => setting.normalize(value).map(Some),
        None => Some(None),
    }
}

/// Записать значение настройки: тема или плагин → имя → значение.
fn store_value(
    map: &mut BTreeMap<String, BTreeMap<String, String>>,
    owner: &str,
    name: &str,
    value: Option<String>,
) {
    let values = map.entry(owner.to_owned()).or_default();
    match value {
        Some(value) => {
            values.insert(name.to_owned(), value);
        }
        None => {
            values.remove(name);
        }
    }
    if values.is_empty() {
        map.remove(owner);
    }
}

// ─────────────────────────────── файлы папок ───────────────────────────────

/// Адрес файла из папки темы или плагина.
fn asset_url(kind: Kind, id: &str, file: &str) -> Option<Url> {
    let folder = Url::parse(ASSET_BASE)
        .ok()?
        .join(&format!("{}/{id}/", kind.dir()))
        .ok()?;
    folder.join(file).ok()
}

/// Относительные адреса в `url()` стилей из папки — от адреса файла
/// стилей, как у подключённого файла: иначе `<style>` на странице искал бы
/// их на сервере веб-клиента. Адреса со схемой, `/…` и `#…` не меняются.
fn rebase_urls(css: &str, base: &Url) -> String {
    let bytes = css.as_bytes();
    let mut out = String::with_capacity(css.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = css[i + 2..]
                    .find("*/")
                    .map_or(bytes.len(), |end| i + 2 + end + 2);
            }
            quote @ (b'"' | b'\'') => i = skip_string(bytes, i + 1, quote),
            b'u' | b'U' if starts_url(bytes, i) => {
                let Some((value, end)) = url_argument(css, i + 4) else {
                    i += 4;
                    continue;
                };
                if let Some(url) = rebased(value, base) {
                    out.push_str(&css[copied..i]);
                    out.push_str(&format!("url(\"{url}\")"));
                    copied = end;
                }
                i = end;
            }
            _ => i += 1,
        }
    }
    out.push_str(&css[copied..]);
    out
}

/// `url(` с позиции `i`, не продолжение другого имени.
fn starts_url(bytes: &[u8], i: usize) -> bool {
    let name = |byte: u8| byte.is_ascii_alphanumeric() || b"-_".contains(&byte) || byte >= 0x80;
    bytes.len() >= i + 4
        && bytes[i..i + 4].eq_ignore_ascii_case(b"url(")
        && (i == 0 || !name(bytes[i - 1]))
}

/// Конец строки CSS, начатой кавычкой `quote` перед `i`.
fn skip_string(bytes: &[u8], mut i: usize, quote: u8) -> usize {
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            // незакрытая строка кончается вместе со строкой файла
            b'\n' => return i + 1,
            byte if byte == quote => return i + 1,
            _ => i += 1,
        }
    }
    bytes.len()
}

/// Адрес внутри `url(…)` с позиции `start` и позиция после `)`. Адреса с
/// экранированием не трогаются.
fn url_argument(css: &str, start: usize) -> Option<(&str, usize)> {
    let rest = &css[start..];
    let trimmed = rest.trim_start();
    let offset = start + rest.len() - trimmed.len();
    match *trimmed.as_bytes().first()? {
        quote @ (b'"' | b'\'') => {
            let close = trimmed[1..].find(char::from(quote))? + 1;
            let value = &trimmed[1..close];
            if value.contains(['\\', '\n']) {
                return None;
            }
            let after = trimmed[close + 1..].trim_start();
            after
                .starts_with(')')
                .then(|| (value, css.len() - after.len() + 1))
        }
        _ => {
            let close = trimmed.find(')')?;
            let value = trimmed[..close].trim_end();
            let plain = !value.contains(|c: char| c.is_whitespace() || "\"'(\\".contains(c));
            plain.then_some((value, offset + close + 1))
        }
    }
}

fn rebased(value: &str, base: &Url) -> Option<Url> {
    if value.is_empty() || value.starts_with(['/', '#']) || Url::parse(value).is_ok() {
        return None;
    }
    base.join(value).ok()
}

/// Раскодировать `%XX` в пути адреса.
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let hex = bytes.get(i + 1..i + 3)?;
        if !hex.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        let digits = std::str::from_utf8(hex).ok()?;
        out.push(u8::from_str_radix(digits, 16).ok()?);
        i += 3;
    }
    String::from_utf8(out).ok()
}

/// Тип файла для ответа. HTML отдаётся текстом: адреса файлов — не место
/// для страниц со скриптами.
fn mime_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" => "audio/ogg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "txt" | "md" | "html" | "htm" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn asset_response(status: u16, mime: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        // шрифты и fetch страницы веб-клиента — запросы с другого origin
        .header("Access-Control-Allow-Origin", "*")
        // файл могли сохранить: страница проверяет, не изменился ли он
        .header("Cache-Control", "no-cache")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap_or_default()
}

/// Файлы из папок тем и плагинов (схема [`ASSET_SCHEME`]).
pub fn asset_protocol(
    context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    let path = request.uri().path().to_owned();
    // чтение с диска — не в главном потоке
    tauri::async_runtime::spawn_blocking(move || {
        let response = match path.strip_prefix(favorite_gifs::ASSET_PREFIX) {
            Some(file) => favorite_gif_preview(&app, file),
            None => match app.try_state::<Arc<Extensions>>() {
                Some(extensions) => extensions.asset(&path),
                None => asset_response(503, "text/plain", Vec::new()),
            },
        };
        responder.respond(response);
    });
}

/// Превью избранной GIF (`favorite_gifs.rs`).
fn favorite_gif_preview(app: &AppHandle, file: &str) -> tauri::http::Response<Vec<u8>> {
    let preview = app
        .try_state::<Arc<FavoriteGifs>>()
        .and_then(|gifs| gifs.preview(file));
    match preview {
        Some(body) => asset_response(200, "image/webp", body),
        None => asset_response(404, "text/plain", b"not found".to_vec()),
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
        for (name, script) in &plugins {
            tracing::info!(plugin = %name, "запускаю плагин");
            match target.eval(script) {
                Ok(()) => running.push(name.clone()),
                Err(error) => tracing::warn!(%error, plugin = %name, "плагин не запустился"),
            }
        }
        extensions.set_running(running);
        // стили плагинов-папок действуют, пока плагин запущен
        push_styles(target.app_handle());
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

/// Код плагина-папки: тело функции с объектом `plugin` (API плагинов,
/// `bridge.js`). Функция асинхронная — в коде можно сразу писать `await`;
/// её переменные не попадают в глобальную область страницы.
fn folder_plugin_script(id: &str, main: &str, code: &str, info: &Value) -> String {
    let label: String = main.chars().filter(|c| !c.is_control()).collect();
    format!(
        "(async function (plugin) {{\n{code}\n}}).call(window, window.__arachnidDesktop.plugin({info}))\n\
         .catch((error) => console.error(\"[{id}]\", error));\n\
         //# sourceURL=arachnid-plugins/{id}/{label}\n"
    )
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
                // стили плагинов-папок тоже обновляются при сохранении
                if next.themes != last.themes
                    || next.plugins != last.plugins
                    || next.quick_css != last.quick_css
                {
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

/// «Плагины»: флажок на каждый плагин (сначала встроенные) и «Открыть
/// папку». Плагин, которому нужно разрешение на сеть, включается только в
/// настройках — там окно разрешений; здесь его флажок недоступен.
fn plugins_submenu(
    app: &AppHandle,
    extensions: &Extensions,
    labels: &TrayLabels,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let submenu = Submenu::new(app, &labels.plugins, true)?;
    let saved = extensions.saved();
    let (builtins, user): (Vec<_>, Vec<_>) = extensions
        .all_plugins()
        .into_iter()
        .partition(|plugin| matches!(plugin.origin, Origin::Builtin(_)));
    let item = |plugin: &PluginSource| {
        let enabled = saved.plugin_enabled(&plugin.id);
        CheckMenuItem::with_id(
            app,
            format!("{MENU_PLUGIN}{}", plugin.id),
            menu_text(plugin.label()),
            enabled || plugin.ready(&saved),
            enabled,
            None::<&str>,
        )
    };
    for plugin in &builtins {
        submenu.append(&item(plugin)?)?;
    }
    if !builtins.is_empty() {
        submenu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    if user.is_empty() {
        submenu.append(&MenuItem::new(
            app,
            &labels.no_plugins,
            false,
            None::<&str>,
        )?)?;
    }
    for plugin in &user {
        submenu.append(&item(plugin)?)?;
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
        let saved = extensions.saved();
        let value = !saved.plugin_enabled(name);
        // включить можно только готовый плагин (см. plugins_submenu)
        if value
            && !extensions
                .plugin(name)
                .is_some_and(|plugin| plugin.ready(&saved))
        {
            desktop::refresh_tray(app);
            return;
        }
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
///
/// Плагин-папку, которая просит доступ в сеть, можно включить только с
/// `grant: true` — после того как пользователь согласился в окне раздела.
/// Тот же вызов подтверждает новые адреса уже включённого плагина.
#[tauri::command]
pub fn extensions_set_plugin(
    file: String,
    enabled: bool,
    grant: Option<bool>,
    app: AppHandle,
    extensions: State<'_, Arc<Extensions>>,
) -> CmdResult<Overview> {
    let Some(plugin) = extensions.plugin(&file) else {
        return Err(CommandError::new(
            "plugin",
            "такого плагина нет в папке plugins",
        ));
    };
    if enabled && !plugin.ready(&extensions.saved()) {
        match &plugin.origin {
            Origin::Folder(manifest) if grant == Some(true) => {
                extensions.grant(&file, &manifest.network);
            }
            Origin::Folder(_) => {
                return Err(CommandError::new(
                    "permissions",
                    "плагину нужно разрешение на доступ в сеть",
                ));
            }
            Origin::Broken(error) => return Err(CommandError::new("plugin", error.clone())),
            Origin::Builtin(_) | Origin::File => {}
        }
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

/// Настройка плагина-папки изменилась: стили плагина (переменные CSS) и
/// подписчики `plugin.onSettingsChange` на странице.
fn plugin_settings_changed(app: &AppHandle, extensions: &Extensions, file: &str) {
    if extensions.running().iter().any(|name| name == file) {
        push_styles(app);
    }
    if let Some(values) = extensions.plugin_values(file) {
        let id = serde_json::to_string(file).unwrap_or_default();
        call_page(app, &format!("pluginSettingsChanged({id}, {values})"));
    }
}

/// Изменить настройку плагина-папки; `value: null` — значение по умолчанию.
#[tauri::command]
pub fn extensions_set_plugin_value(
    file: String,
    name: String,
    value: Option<String>,
    app: AppHandle,
    extensions: State<'_, Arc<Extensions>>,
) -> CmdResult<Overview> {
    if !extensions.set_plugin_value(&file, &name, value.as_deref()) {
        return Err(CommandError::new(
            "plugin",
            "значение не подходит к настройке плагина",
        ));
    }
    plugin_settings_changed(&app, &extensions, &file);
    Ok(extensions.overview())
}

/// «Сбросить» в настройках плагина-папки.
#[tauri::command]
pub fn extensions_reset_plugin(
    file: String,
    app: AppHandle,
    extensions: State<'_, Arc<Extensions>>,
) -> Overview {
    extensions.reset_plugin(&file);
    plugin_settings_changed(&app, &extensions, &file);
    extensions.overview()
}

/// `plugin.storage.get`: значение ключа или `null`.
#[tauri::command(async)]
pub fn plugin_storage_get(
    plugin: String,
    key: String,
    extensions: State<'_, Arc<Extensions>>,
) -> CmdResult<Option<Value>> {
    extensions.active_folder(&plugin)?;
    extensions
        .host
        .storage()
        .get(&plugin, &key)
        .map_err(|error| CommandError::new("storage", error))
}

/// `plugin.storage.set` / `delete`: `value: null` удаляет ключ.
#[tauri::command(async)]
pub fn plugin_storage_set(
    plugin: String,
    key: String,
    value: Option<Value>,
    extensions: State<'_, Arc<Extensions>>,
) -> CmdResult<()> {
    extensions.active_folder(&plugin)?;
    extensions
        .host
        .storage()
        .set(&plugin, &key, value)
        .map_err(|error| CommandError::new("storage", error))
}

/// `plugin.native.call`: функция нативного модуля плагина. Модуль может
/// работать секунды — вызов идёт в фоновом потоке.
#[tauri::command]
pub async fn plugin_native_call(
    plugin: String,
    function: String,
    input: Value,
    extensions: State<'_, Arc<Extensions>>,
) -> CmdResult<Value> {
    let (manifest, network) = extensions.active_folder(&plugin)?;
    let native = manifest
        .native
        .as_deref()
        .and_then(manifest::relative_path)
        .ok_or_else(|| CommandError::new("native", "у плагина нет нативного модуля"))?;
    let path = extensions.folder(Kind::Plugin, &plugin).join(native);
    let extensions = Arc::clone(extensions.inner());
    let call = move || {
        extensions
            .host
            .call(&plugin, &path, &network, &function, &input)
    };
    tauri::async_runtime::spawn_blocking(call)
        .await?
        .map_err(|error| CommandError::new("native", error))
}

/// `plugin.fetch`: запрос к адресу, который плагин назвал в `plugin.toml`
/// и пользователь подтвердил, — без ограничений CORS страницы.
#[tauri::command]
pub async fn plugin_fetch(
    plugin: String,
    request: FetchRequest,
    extensions: State<'_, Arc<Extensions>>,
) -> CmdResult<FetchResponse> {
    let (_, network) = extensions.active_folder(&plugin)?;
    let fetch = move || plugin_host::fetch(&request, &network);
    tauri::async_runtime::spawn_blocking(fetch)
        .await?
        .map_err(|error| CommandError::new("network", error))
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
        assert!(user_plugins(&extensions).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Плагины из папки plugins, без встроенных.
    fn user_plugins(extensions: &Extensions) -> Vec<(String, String)> {
        extensions
            .plugins()
            .into_iter()
            .filter(|(id, _)| !id.starts_with(BUILTIN_PREFIX))
            .collect()
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
        assert!(extensions.saved().plugin_enabled("x.js"));
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
        assert!(
            extensions.overview().reload_needed,
            "встроенный ещё не запущен"
        );
        extensions.set_running(vec!["builtin:qol".into()]);
        assert!(!extensions.overview().reload_needed);
        extensions.set_plugin("klipy.js", true);
        let overview = extensions.overview();
        assert!(overview.reload_needed, "включён, но ещё не запущен");
        let klipy = overview
            .plugins
            .iter()
            .find(|plugin| plugin.file == "klipy.js");
        assert_eq!(
            klipy.and_then(|plugin| plugin.name.as_deref()),
            Some("Klipy")
        );
        extensions.set_running(vec!["builtin:qol".into(), "klipy.js".into()]);
        assert!(!extensions.overview().reload_needed);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn choice_survives_restart() {
        let dir = temp_dir("state");
        std::fs::write(dir.join(PLUGINS_DIR).join("translate.js"), "go()").unwrap();
        extensions(&dir).set_plugin("translate.js", true);
        let plugins = user_plugins(&extensions(&dir));
        let script = plugin_script("translate.js", "go()");
        assert_eq!(plugins, [("translate.js".to_owned(), script)]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn removed_plugin_is_not_loaded() {
        let dir = temp_dir("removed");
        let extensions = extensions(&dir);
        extensions.set_plugin("gone.js", true);
        assert!(user_plugins(&extensions).is_empty());
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

    #[test]
    fn builtin_plugin_is_on_until_switched_off() {
        let dir = temp_dir("builtin");
        let extensions = extensions(&dir);
        assert!(extensions.saved().plugin_enabled("builtin:qol"));
        let plugins = extensions.plugins();
        assert_eq!(plugins.len(), 1);
        assert!(plugins[0].1.contains("__arachnidDesktop"), "это emoji.js");
        let overview = extensions.overview();
        assert!(overview.plugins[0].builtin);
        assert_eq!(overview.api_version, API_VERSION);

        extensions.set_plugin("builtin:qol", false);
        assert!(extensions.plugins().is_empty());
        assert!(!extensions.saved().plugin_enabled("builtin:nothing"));
        std::fs::remove_dir_all(&dir).ok();
    }

    const TRANSLATE_MANIFEST: &str = "name = \"Переводчик\"\nversion = \"1.0\"\n\
        [permissions]\nnetwork = [\"api.example.com\"]\n\
        [[settings]]\nname = \"lang\"\ntype = \"select\"\ndefault = \"en\"\n\
        options = [{ value = \"en\" }, { value = \"ru\" }]\n";

    fn translate_plugin(dir: &Path) -> PathBuf {
        let folder = dir.join(PLUGINS_DIR).join("translate");
        std::fs::create_dir_all(folder.join("img")).unwrap();
        std::fs::write(folder.join("plugin.toml"), TRANSLATE_MANIFEST).unwrap();
        std::fs::write(folder.join("main.js"), "plugin.storage.get('x');").unwrap();
        std::fs::write(
            folder.join("style.css"),
            "a { background: url(img/flag.png) }",
        )
        .unwrap();
        std::fs::write(folder.join("img").join("flag.png"), "png").unwrap();
        folder
    }

    #[test]
    fn folder_plugin_gets_api_settings_and_style() {
        let dir = temp_dir("folder-plugin");
        translate_plugin(&dir);
        let extensions = extensions(&dir);
        let entry = extensions.entry(Kind::Plugin, "translate").unwrap();
        assert!(entry.folder);
        assert!(extensions.active_folder("translate").is_err(), "выключен");

        extensions.set_plugin("translate", true);
        let plugins = user_plugins(&extensions);
        let script = &plugins[0].1;
        assert!(script.starts_with("(async function (plugin) {\nplugin.storage.get('x');\n}"));
        assert!(script.contains(r#""assetBase":"#));
        assert!(script.contains("/plugins/translate/"));
        assert!(script.contains(r#""settings":{"lang":"en"}"#));
        assert!(
            script.contains(r#""network":[]"#),
            "адрес ещё не подтверждён"
        );
        assert!(script.ends_with("//# sourceURL=arachnid-plugins/translate/main.js\n"));

        let info = extensions
            .overview()
            .plugins
            .into_iter()
            .find(|plugin| plugin.folder)
            .unwrap();
        assert_eq!(info.name.as_deref(), Some("Переводчик"));
        assert_eq!(info.network, ["api.example.com"]);
        assert!(!info.granted);
        assert_eq!(info.values["lang"], "en");

        extensions.grant("translate", &["api.example.com".to_owned()]);
        let (_, network) = extensions.active_folder("translate").unwrap();
        assert_eq!(network, ["api.example.com"]);

        assert!(extensions.set_plugin_value("translate", "lang", Some("ru")));
        assert!(!extensions.set_plugin_value("translate", "lang", Some("de")));
        assert_eq!(extensions.plugin_values("translate").unwrap()["lang"], "ru");

        // стиль действует, пока плагин запущен
        assert!(extensions.styles().is_empty());
        extensions.set_running(vec!["translate".into()]);
        let styles = extensions.styles();
        assert_eq!(styles[0].id, "plugin:translate");
        assert!(styles[0].css.contains("--lang: ru;"));
        assert!(styles[0].css.contains("/plugins/translate/img/flag.png\")"));

        extensions.reset_plugin("translate");
        assert_eq!(extensions.plugin_values("translate").unwrap()["lang"], "en");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn broken_folder_is_shown_but_not_run() {
        let dir = temp_dir("broken");
        let folder = dir.join(PLUGINS_DIR).join("broken");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("plugin.toml"), "name = ").unwrap();
        // без манифеста папка не плагин
        std::fs::create_dir_all(dir.join(PLUGINS_DIR).join("just-a-folder")).unwrap();
        let extensions = extensions(&dir);
        extensions.set_plugin("broken", true);
        assert!(user_plugins(&extensions).is_empty());
        let overview = extensions.overview();
        let names: Vec<&str> = overview
            .plugins
            .iter()
            .map(|plugin| plugin.file.as_str())
            .collect();
        assert_eq!(names, ["builtin:qol", "broken"]);
        assert!(
            overview.plugins[1]
                .error
                .as_deref()
                .unwrap()
                .contains("plugin.toml")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn folder_theme_has_assets_and_settings() {
        let dir = temp_dir("folder-theme");
        let folder = dir.join(THEMES_DIR).join("night");
        std::fs::create_dir_all(&folder).unwrap();
        let manifest = "name = \"Ночь\"\n[[settings]]\nname = \"accent\"\ntype = \"color\"\n\
                        default = \"#123456\"\n";
        std::fs::write(folder.join("theme.toml"), manifest).unwrap();
        let css = "body { background: url('bg.png'), url(data:image/png;base64,AA) }";
        std::fs::write(folder.join("theme.css"), css).unwrap();
        let extensions = extensions(&dir);
        assert!(extensions.set_theme(Some("night")));
        let styles = extensions.styles();
        assert_eq!(styles[0].id, "theme:night");
        assert!(styles[0].css.contains("--accent: #123456;"));
        assert!(styles[0].css.contains("/themes/night/bg.png\")"));
        assert!(styles[0].css.contains("url(data:image/png;base64,AA)"));

        assert!(extensions.set_theme_value("night", "accent", Some("#ff0000")));
        assert!(extensions.styles()[0].css.contains("--accent: #ff0000;"));
        let overview = extensions.overview();
        assert!(overview.themes[0].folder);
        assert_eq!(overview.themes[0].meta.name.as_deref(), Some("Ночь"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn assets_stay_inside_their_folder() {
        let dir = temp_dir("assets");
        let folder = translate_plugin(&dir);
        std::fs::write(folder.join("img").join("two words.png"), "png").unwrap();
        std::fs::write(dir.join("secret.txt"), "secret").unwrap();
        let extensions = extensions(&dir);
        assert!(
            extensions
                .asset_path("/plugins/translate/img/flag.png")
                .is_some()
        );
        assert!(
            extensions
                .asset_path("/plugins/translate/img/two%20words.png")
                .is_some()
        );
        for bad in [
            "/plugins/translate/../../secret.txt",
            "/plugins/translate/%2E%2E/%2E%2E/secret.txt",
            "/plugins/translate/img/none.png",
            "/plugins/translate/img",
            "/plugins/missing/main.js",
            "/other/translate/main.js",
            "/plugins/translate/%zz",
        ] {
            assert!(extensions.asset_path(bad).is_none(), "{bad}");
        }
        let response = extensions.asset("/plugins/translate/img/flag.png");
        assert_eq!(response.status(), 200);
        assert_eq!(response.body(), b"png");
        assert_eq!(response.headers()["content-type"], "image/png");
        assert_eq!(extensions.asset("/plugins/translate/x.png").status(), 404);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_relative_urls_are_rebased() {
        let base = Url::parse("http://arachnid.localhost/themes/night/css/theme.css").unwrap();
        let css = "a { b: url(img/x.png); c: URL( \"../y.svg\" ); d: url(/root.png); \
                   e: url(#mask); f: url(https://e.com/z.png); g: myurl(q.png); }\n\
                   /* url(comment.png) */ h { content: \"url(string.png)\" }";
        let out = rebase_urls(css, &base);
        assert!(out.contains(r#"b: url("http://arachnid.localhost/themes/night/css/img/x.png")"#));
        assert!(out.contains(r#"c: url("http://arachnid.localhost/themes/night/y.svg")"#));
        assert!(out.contains("d: url(/root.png)"));
        assert!(out.contains("e: url(#mask)"));
        assert!(out.contains("f: url(https://e.com/z.png)"));
        assert!(out.contains("g: myurl(q.png)"));
        assert!(out.contains("/* url(comment.png) */"));
        assert!(out.contains("\"url(string.png)\""));
        // незакрытое не ломает остаток
        assert_eq!(rebase_urls("a { b: url(x.png", &base), "a { b: url(x.png");
    }

    #[test]
    fn folder_change_is_noticed() {
        let dir = temp_dir("folder-stamp");
        let folder = translate_plugin(&dir);
        let before = folder_stamp(&folder);
        std::fs::write(folder.join("img").join("new.png"), "png").unwrap();
        assert_ne!(folder_stamp(&folder), before);
        std::fs::remove_dir_all(&dir).ok();
    }
}
