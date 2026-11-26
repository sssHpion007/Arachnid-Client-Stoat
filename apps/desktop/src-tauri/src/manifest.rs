//! Описания плагинов и тем-папок: `plugin.toml` и `theme.toml`.
//!
//! Плагин или тема могут быть одним файлом (`.js`, `.css` — формат Avia
//! Client, описание в комментарии в начале файла) или папкой со всем, что
//! нужно: кодом страницы, стилями, нативным модулем WebAssembly, картинками и
//! шрифтами. Папку описывает манифест TOML; имя папки — идентификатор
//! расширения (настройки, хранилище, адреса файлов). Подробно для авторов —
//! в `docs/extensions.md`.
//!
//! ```toml
//! name = "Translator"
//! version = "1.0.0"
//! author = "Ava"
//! description = "Translates messages"
//! icon = "icon.svg"
//!
//! [permissions]
//! network = ["api.example.com"]
//!
//! [[settings]]
//! name = "language"
//! label = "Target language"
//! type = "select"
//! default = "en"
//! options = [{ value = "en", label = "English" }, { value = "ru", label = "Русский" }]
//!
//! [strings]
//! translate = "Translate"
//! ```
//!
//! Переводы названия, описания, подписей настроек и строк `[strings]` —
//! `locales/<язык>.toml` рядом с манифестом:
//!
//! ```toml
//! name = "Переводчик"
//!
//! [settings.language]
//! label = "Язык перевода"
//!
//! [strings]
//! translate = "Перевести"
//! ```

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::usercss::{Kind as SettingKind, SelectOption, Setting};

/// Манифест плагина-папки.
pub const PLUGIN_MANIFEST: &str = "plugin.toml";
/// Манифест темы-папки.
pub const THEME_MANIFEST: &str = "theme.toml";
/// Папка переводов плагина: `locales/<язык>.toml`.
pub const LOCALES_DIR: &str = "locales";

/// Файлы плагина по умолчанию: берутся, если они есть, а в манифесте не
/// указаны другие.
const DEFAULT_MAIN: &str = "main.js";
const DEFAULT_STYLE: &str = "style.css";
const DEFAULT_NATIVE: &str = "native.wasm";
/// Стили темы по умолчанию.
const DEFAULT_THEME_CSS: &str = "theme.css";

/// Наибольшая длина идентификатора (имени папки).
const MAX_ID_LEN: usize = 64;
/// Сколько настроек и адресов сети можно объявить.
const MAX_SETTINGS: usize = 64;
const MAX_HOSTS: usize = 32;
/// Наибольшая длина строк манифеста (название, описание, подпись).
const MAX_TEXT: usize = 1024;
/// Сколько строк `[strings]` и переводов можно объявить.
const MAX_STRINGS: usize = 256;
const MAX_LOCALES: usize = 64;
/// Наибольший размер файла перевода.
const MAX_LOCALE_SIZE: u64 = 256 * 1024;
/// Значок плагина — картинка этих типов.
const ICON_TYPES: &[&str] = &["svg", "png", "webp", "gif", "jpg", "jpeg"];

/// Годится ли имя папки в идентификатор: латиница, цифры, `-`, `_`, `.`,
/// не с точки. Идентификатор попадает в адреса файлов и в имя папки
/// хранилища, поэтому другие символы не допускаются.
pub fn valid_id(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_ID_LEN
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// Путь внутри папки расширения: части через `/`, без `..`, `.`, пустых
/// частей, `\` и `:` (диск Windows, потоки NTFS). `None` — путь выходит за
/// папку или записан неоднозначно.
pub fn relative_path(path: &str) -> Option<PathBuf> {
    let mut result = PathBuf::new();
    for part in path.split('/') {
        let bad = part.is_empty()
            || part == "."
            || part == ".."
            || part.contains(['\\', ':', '\0'])
            || part.ends_with(['.', ' ']);
        if bad {
            return None;
        }
        result.push(part);
    }
    (!result.as_os_str().is_empty()).then_some(result)
}

/// Название, автор, версия и описание.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct About {
    pub name: Option<String>,
    pub version: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
}

/// Плагин-папка, прочитанный из `plugin.toml`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PluginManifest {
    pub about: About,
    /// Код страницы (путь внутри папки)
    pub main: Option<String>,
    /// Стили, которые действуют, пока плагин запущен
    pub style: Option<String>,
    /// Нативный модуль WebAssembly
    pub native: Option<String>,
    /// Значок в разделе «Плагины» (путь внутри папки)
    pub icon: Option<String>,
    /// Адреса, к которым плагин просит доступ в сеть (`[permissions] network`)
    pub network: Vec<String>,
    /// Настройки в разделе «Плагины»
    pub settings: Vec<Setting>,
    /// Строки для кода плагина (`[strings]`, `plugin.t`)
    pub strings: BTreeMap<String, String>,
    /// Переводы `locales/<язык>.toml` по кодам языков
    pub locales: BTreeMap<String, PluginLocale>,
}

/// Перевод плагина-папки: всё, что в нём не указано, берётся из манифеста.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PluginLocale {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Подписи настроек по их именам
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub settings: BTreeMap<String, SettingText>,
    /// Строки `[strings]`
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub strings: BTreeMap<String, String>,
}

/// Перевод подписи, пояснения и вариантов настройки.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SettingText {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// Подписи вариантов выбора по их значениям
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub options: BTreeMap<String, String>,
}

/// Тема-папка, прочитанная из `theme.toml`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ThemeManifest {
    pub about: About,
    /// Стили темы (путь внутри папки)
    pub main: String,
    /// Настройки: на странице — переменные CSS `--<имя>`
    pub settings: Vec<Setting>,
}

#[derive(Debug, Deserialize)]
struct RawPlugin {
    name: String,
    version: Option<String>,
    author: Option<String>,
    description: Option<String>,
    main: Option<String>,
    style: Option<String>,
    native: Option<String>,
    icon: Option<String>,
    #[serde(default)]
    permissions: RawPermissions,
    #[serde(default)]
    settings: Vec<RawSetting>,
    #[serde(default)]
    strings: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawLocale {
    name: Option<String>,
    description: Option<String>,
    #[serde(default)]
    settings: BTreeMap<String, RawSettingText>,
    #[serde(default)]
    strings: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSettingText {
    label: Option<String>,
    hint: Option<String>,
    #[serde(default)]
    options: BTreeMap<String, String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawPermissions {
    #[serde(default)]
    network: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RawTheme {
    name: String,
    version: Option<String>,
    author: Option<String>,
    description: Option<String>,
    main: Option<String>,
    #[serde(default)]
    settings: Vec<RawSetting>,
}

#[derive(Debug, Deserialize)]
struct RawSetting {
    name: String,
    label: Option<String>,
    hint: Option<String>,
    #[serde(rename = "type")]
    kind: RawKind,
    default: Option<toml::Value>,
    #[serde(default)]
    options: Vec<RawOption>,
    min: Option<f64>,
    max: Option<f64>,
    step: Option<f64>,
    unit: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RawKind {
    Text,
    Color,
    Checkbox,
    Select,
    Number,
    Range,
}

#[derive(Debug, Deserialize)]
struct RawOption {
    value: String,
    label: Option<String>,
}

/// Прочитать `plugin.toml` папки `dir`.
pub fn parse_plugin(dir: &Path, text: &str) -> Result<PluginManifest, String> {
    let raw: RawPlugin =
        toml::from_str(text).map_err(|error| toml_error(PLUGIN_MANIFEST, &error))?;
    let main = file_field(dir, "main", raw.main, DEFAULT_MAIN)?;
    let style = file_field(dir, "style", raw.style, DEFAULT_STYLE)?;
    let native = file_field(dir, "native", raw.native, DEFAULT_NATIVE)?;
    if main.is_none() && style.is_none() && native.is_none() {
        return Err(format!(
            "в папке нет ни {DEFAULT_MAIN}, ни {DEFAULT_STYLE}, ни {DEFAULT_NATIVE}"
        ));
    }
    let settings = settings(raw.settings)?;
    let strings = strings(raw.strings)?;
    let locales = locales(dir, &settings, &strings)?;
    Ok(PluginManifest {
        about: about(raw.name, raw.version, raw.author, raw.description)?,
        main,
        style,
        native,
        icon: icon(dir, raw.icon)?,
        network: hosts(raw.permissions.network)?,
        settings,
        strings,
        locales,
    })
}

/// Прочитать `theme.toml` папки `dir`.
pub fn parse_theme(dir: &Path, text: &str) -> Result<ThemeManifest, String> {
    let raw: RawTheme = toml::from_str(text).map_err(|error| toml_error(THEME_MANIFEST, &error))?;
    let Some(main) = file_field(dir, "main", raw.main, DEFAULT_THEME_CSS)? else {
        return Err(format!("в папке нет {DEFAULT_THEME_CSS}"));
    };
    Ok(ThemeManifest {
        about: about(raw.name, raw.version, raw.author, raw.description)?,
        main,
        settings: settings(raw.settings)?,
    })
}

fn toml_error(file: &str, error: &toml::de::Error) -> String {
    format!("{file}: {}", error.message())
}

fn about(
    name: String,
    version: Option<String>,
    author: Option<String>,
    description: Option<String>,
) -> Result<About, String> {
    let name = clean(Some(name));
    if name.is_none() {
        return Err("у плагина или темы пустое name".into());
    }
    Ok(About {
        name,
        version: clean(version),
        author: clean(author),
        description: clean(description),
    })
}

/// Строка манифеста без пробелов по краям и не длиннее [`MAX_TEXT`];
/// пустая — как не указанная.
fn clean(value: Option<String>) -> Option<String> {
    let value: String = value?.trim().chars().take(MAX_TEXT).collect();
    (!value.is_empty()).then_some(value)
}

/// Файл из манифеста: указанный должен быть на месте, а не указанный
/// берётся по имени по умолчанию, если он есть.
fn file_field(
    dir: &Path,
    field: &str,
    value: Option<String>,
    default: &str,
) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(dir.join(default).is_file().then(|| default.to_owned()));
    };
    let Some(path) = relative_path(&value) else {
        return Err(format!(
            "{field} = \"{value}\": путь должен вести внутрь папки"
        ));
    };
    if !dir.join(path).is_file() {
        return Err(format!("{field} = \"{value}\": такого файла нет"));
    }
    Ok(Some(value))
}

/// Значок: картинка внутри папки.
fn icon(dir: &Path, value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let extension = value
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    if !ICON_TYPES.contains(&extension.as_str()) {
        return Err(format!(
            "icon = \"{value}\": значок — SVG, PNG, WebP, GIF или JPEG"
        ));
    }
    file_field(dir, "icon", Some(value), "")
}

/// Годится ли строка в ключ `[strings]`: латиница, цифры, `-`, `_`, `.`.
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_ID_LEN
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// Строка для кода плагина: как есть, но не длиннее [`MAX_TEXT`].
fn limited(value: String) -> String {
    value.chars().take(MAX_TEXT).collect()
}

fn strings(raw: BTreeMap<String, String>) -> Result<BTreeMap<String, String>, String> {
    if raw.len() > MAX_STRINGS {
        return Err(format!("в strings больше {MAX_STRINGS} строк"));
    }
    raw.into_iter()
        .map(|(key, value)| {
            if !valid_key(&key) {
                return Err(format!("strings: ключ «{key}» — латиница, цифры, -_."));
            }
            Ok((key, limited(value)))
        })
        .collect()
}

/// Код языка в имени файла перевода: `en`, `pt-BR`, `zh-Hans`.
fn valid_language(code: &str) -> bool {
    let mut parts = code.split('-');
    let base = parts.next().unwrap_or_default();
    let base_valid = matches!(base.len(), 2 | 3) && base.bytes().all(|b| b.is_ascii_lowercase());
    base_valid && parts.all(valid_subtag)
}

/// Часть кода языка после `-`: регион или письменность.
fn valid_subtag(part: &str) -> bool {
    (2..=8).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// Текст файла не больше `limit` байт.
fn read_text(path: &Path, limit: u64) -> Option<String> {
    if !std::fs::metadata(path).is_ok_and(|meta| meta.len() <= limit) {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// Переводы из `locales/<язык>.toml`; папки нет — переводов нет.
fn locales(
    dir: &Path,
    settings: &[Setting],
    strings: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, PluginLocale>, String> {
    let Ok(entries) = std::fs::read_dir(dir.join(LOCALES_DIR)) else {
        return Ok(BTreeMap::new());
    };
    let mut result = BTreeMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("toml") {
            continue;
        }
        let Some(code) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let file = format!("{LOCALES_DIR}/{code}.toml");
        if !valid_language(code) {
            return Err(format!(
                "{file}: имя файла — код языка (en, pt-BR, zh-Hans)"
            ));
        }
        if result.len() >= MAX_LOCALES {
            return Err(format!("в {LOCALES_DIR} больше {MAX_LOCALES} переводов"));
        }
        let text = read_text(&path, MAX_LOCALE_SIZE)
            .ok_or_else(|| format!("{file} не читается или больше 256 КБ"))?;
        let locale = parse_locale(&text, settings, strings);
        let locale = locale.map_err(|error| format!("{file}: {error}"))?;
        result.insert(code.to_owned(), locale);
    }
    Ok(result)
}

/// Перевод: подписи только существующих настроек и вариантов, строки —
/// только объявленные в `[strings]` манифеста.
fn parse_locale(
    text: &str,
    settings: &[Setting],
    strings: &BTreeMap<String, String>,
) -> Result<PluginLocale, String> {
    let raw: RawLocale = toml::from_str(text).map_err(|error| error.message().to_owned())?;
    let mut locale = PluginLocale {
        name: clean(raw.name),
        description: clean(raw.description),
        ..PluginLocale::default()
    };
    for (name, raw) in raw.settings {
        let Some(setting) = settings.iter().find(|setting| setting.name == name) else {
            return Err(format!("настройки {name} нет в {PLUGIN_MANIFEST}"));
        };
        let mut options = BTreeMap::new();
        for (value, label) in raw.options {
            if !setting.options.iter().any(|option| option.name == value) {
                return Err(format!("у настройки {name} нет варианта {value}"));
            }
            if let Some(label) = clean(Some(label)) {
                options.insert(value, label);
            }
        }
        let text = SettingText {
            label: clean(raw.label),
            hint: clean(raw.hint),
            options,
        };
        locale.settings.insert(name, text);
    }
    for (key, value) in raw.strings {
        if !strings.contains_key(&key) {
            return Err(format!("строки {key} нет в [strings] {PLUGIN_MANIFEST}"));
        }
        locale.strings.insert(key, limited(value));
    }
    Ok(locale)
}

/// Адреса из `[permissions] network`: `example.com` — только этот адрес,
/// `*.example.com` — все адреса внутри example.com.
fn hosts(raw: Vec<String>) -> Result<Vec<String>, String> {
    if raw.len() > MAX_HOSTS {
        return Err(format!("в network больше {MAX_HOSTS} адресов"));
    }
    let mut result: Vec<String> = Vec::with_capacity(raw.len());
    for pattern in raw {
        let pattern = pattern.trim().to_ascii_lowercase();
        let host = pattern.strip_prefix("*.").unwrap_or(&pattern);
        let valid = !host.is_empty()
            && host.split('.').all(|label| {
                !label.is_empty()
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            });
        if !valid {
            return Err(format!(
                "network: «{pattern}» — не адрес (пример: api.example.com или *.example.com)"
            ));
        }
        if !result.contains(&pattern) {
            result.push(pattern);
        }
    }
    Ok(result)
}

/// Подходит ли адрес под разрешённые.
pub fn host_allowed(patterns: &[String], host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    patterns
        .iter()
        .any(|pattern| match pattern.strip_prefix("*.") {
            Some(domain) => host
                .strip_suffix(domain)
                .is_some_and(|rest| rest.len() > 1 && rest.ends_with('.')),
            None => *pattern == host,
        })
}

fn settings(raw: Vec<RawSetting>) -> Result<Vec<Setting>, String> {
    if raw.len() > MAX_SETTINGS {
        return Err(format!("больше {MAX_SETTINGS} настроек"));
    }
    let mut result: Vec<Setting> = Vec::with_capacity(raw.len());
    for raw in raw {
        let setting = setting(raw)?;
        if result.iter().any(|other| other.name == setting.name) {
            return Err(format!("настройка {} объявлена дважды", setting.name));
        }
        result.push(setting);
    }
    Ok(result)
}

fn setting(raw: RawSetting) -> Result<Setting, String> {
    let name = raw.name.trim().to_owned();
    let valid_name = !name.is_empty()
        && name.len() <= MAX_ID_LEN
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if !valid_name {
        return Err(format!("настройка «{name}»: имя — латиница, цифры, - и _"));
    }
    let kind = match raw.kind {
        RawKind::Text => SettingKind::Text,
        RawKind::Color => SettingKind::Color,
        RawKind::Checkbox => SettingKind::Checkbox,
        RawKind::Select => SettingKind::Select,
        RawKind::Number => SettingKind::Number,
        RawKind::Range => SettingKind::Range,
    };
    let options: Vec<SelectOption> = raw
        .options
        .into_iter()
        .map(|option| SelectOption {
            label: option.label.unwrap_or_else(|| option.value.clone()),
            name: option.value.clone(),
            value: option.value,
        })
        .collect();
    if kind == SettingKind::Select && options.is_empty() {
        return Err(format!("настройка {name}: у выбора нет options"));
    }
    if kind == SettingKind::Range && (raw.min.is_none() || raw.max.is_none()) {
        return Err(format!("настройка {name}: у ползунка нужны min и max"));
    }
    let default = match raw.default {
        Some(toml::Value::String(value)) => Some(value),
        Some(toml::Value::Boolean(value)) => Some(if value { "1" } else { "0" }.to_owned()),
        Some(toml::Value::Integer(value)) => Some(value.to_string()),
        Some(toml::Value::Float(value)) => Some(value.to_string()),
        Some(_) => {
            return Err(format!(
                "настройка {name}: default — строка, число или флаг"
            ));
        }
        None => None,
    };
    let mut setting = Setting {
        label: raw.label.unwrap_or_else(|| name.clone()),
        hint: clean(raw.hint),
        name,
        kind,
        default: String::new(),
        options,
        min: raw.min,
        max: raw.max,
        step: raw.step,
        unit: raw.unit,
    };
    let fallback = match kind {
        SettingKind::Text => Some(String::new()),
        SettingKind::Checkbox => Some("0".to_owned()),
        SettingKind::Select => setting.options.first().map(|option| option.name.clone()),
        SettingKind::Number | SettingKind::Range => Some(setting.min.unwrap_or(0.0).to_string()),
        SettingKind::Color => None,
    };
    let Some(default) = default.or(fallback) else {
        return Err(format!("настройка {}: нужен default", setting.name));
    };
    let Some(default) = setting.normalize(&default) else {
        return Err(format!(
            "настройка {}: значение по умолчанию «{default}» не подходит",
            setting.name
        ));
    };
    setting.default = default;
    Ok(setting)
}

/// Действующие значения настроек: сохранённые, если подходят, иначе по
/// умолчанию.
pub fn effective_values(
    settings: &[Setting],
    stored: Option<&BTreeMap<String, String>>,
) -> BTreeMap<String, String> {
    settings
        .iter()
        .map(|setting| {
            let value = stored.and_then(|stored| stored.get(&setting.name));
            let value = setting.effective(value.map(String::as_str));
            (setting.name.clone(), value)
        })
        .collect()
}

/// Значения настроек для кода плагина: флажок — `true`/`false`, число —
/// числом, остальное — строкой.
pub fn typed_values(settings: &[Setting], values: &BTreeMap<String, String>) -> Value {
    let map = settings
        .iter()
        .map(|setting| {
            let value = values.get(&setting.name).cloned().unwrap_or_default();
            let typed = match setting.kind {
                SettingKind::Checkbox => Value::Bool(value == "1"),
                SettingKind::Number | SettingKind::Range => value
                    .parse::<f64>()
                    .ok()
                    .and_then(serde_json::Number::from_f64)
                    .map_or(Value::Null, Value::Number),
                _ => Value::String(value),
            };
            (setting.name.clone(), typed)
        })
        .collect();
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("arachnid-manifest-{name}-{nanos:x}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ids_are_safe_for_urls_and_folders() {
        assert!(valid_id("translate"));
        assert!(valid_id("my_plugin-2.0"));
        for bad in ["", ".hidden", "with space", "кириллица", "a/b", "a:b"] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn paths_stay_inside_folder() {
        assert_eq!(
            relative_path("assets/icon.svg"),
            Some(PathBuf::from("assets").join("icon.svg"))
        );
        for bad in ["", "../x", "a/../b", "/abs", "a//b"] {
            assert_eq!(relative_path(bad), None, "{bad}");
        }
        for bad in ["a\\b", "c:x", "x.", "./a", "a/ "] {
            assert_eq!(relative_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn plugin_manifest_takes_default_files() {
        let dir = temp_dir("plugin");
        std::fs::write(dir.join("main.js"), "run()").unwrap();
        std::fs::write(dir.join("native.wasm"), "").unwrap();
        let text = "name = \"Переводчик\"\nversion = \"1.0\"\n\
                    [permissions]\nnetwork = [\"API.example.com\", \"*.deepl.com\"]\n\
                    [[settings]]\nname = \"lang\"\ntype = \"select\"\ndefault = \"en\"\n\
                    options = [{ value = \"ru\", label = \"Русский\" }, { value = \"en\" }]\n\
                    [[settings]]\nname = \"auto\"\ntype = \"checkbox\"\ndefault = true\n";
        let manifest = parse_plugin(&dir, text).unwrap();
        assert_eq!(manifest.about.name.as_deref(), Some("Переводчик"));
        assert_eq!(manifest.main.as_deref(), Some("main.js"));
        assert_eq!(manifest.style, None);
        assert_eq!(manifest.native.as_deref(), Some("native.wasm"));
        assert_eq!(manifest.network, ["api.example.com", "*.deepl.com"]);
        assert_eq!(manifest.settings[0].default, "en");
        assert_eq!(manifest.settings[0].options[1].label, "en");
        assert_eq!(manifest.settings[1].default, "1");

        let values = effective_values(&manifest.settings, None);
        let typed = typed_values(&manifest.settings, &values);
        assert_eq!(typed["lang"], "en");
        assert_eq!(typed["auto"], true);
        std::fs::remove_dir_all(&dir).ok();
    }

    const NO_NAME: &str = "version = \"1\"";
    const OUTSIDE: &str = "name = \"x\"\nmain = \"../evil.js\"";
    const MISSING: &str = "name = \"x\"\nstyle = \"none.css\"";
    const ANY_HOST: &str = "name = \"x\"\n[permissions]\nnetwork = [\"*\"]";
    const BAD_SETTING: &str = "name = \"x\"\n[[settings]]\nname = \"a b\"\ntype = \"text\"";
    const NO_COLOR: &str = "name = \"x\"\n[[settings]]\nname = \"c\"\ntype = \"color\"";
    const BAD_CHOICE: &str = "name = \"x\"\n[[settings]]\nname = \"s\"\ntype = \"select\"\n\
                              default = \"z\"\noptions = [{ value = \"a\" }]";

    #[test]
    fn plugin_manifest_errors_are_readable() {
        let dir = temp_dir("errors");
        std::fs::write(dir.join("main.js"), "").unwrap();
        let check = |text: &str, expected: &str| {
            let error = parse_plugin(&dir, text).unwrap_err();
            assert!(error.contains(expected), "{text}: {error}");
        };
        check(NO_NAME, "name");
        check(OUTSIDE, "внутрь папки");
        check(MISSING, "такого файла нет");
        check(ANY_HOST, "не адрес");
        check(BAD_SETTING, "имя");
        check(NO_COLOR, "нужен default");
        check(BAD_CHOICE, "не подходит");
        std::fs::remove_dir_all(&dir).ok();
    }

    const LOCALIZED: &str = "name = \"Translator\"\nicon = \"icon.svg\"\n\
                             [[settings]]\nname = \"lang\"\ntype = \"select\"\n\
                             hint = \"Where to translate\"\n\
                             options = [{ value = \"en\", label = \"English\" }]\n\
                             [strings]\ntranslate = \"Translate\"\n";
    const RU_LOCALE: &str = "name = \"Переводчик\"\n\
                             [settings.lang]\nlabel = \"Язык\"\noptions = { en = \"Английский\" }\n\
                             [strings]\ntranslate = \"Перевести\"\n";

    #[test]
    fn plugin_locales_translate_texts() {
        let dir = temp_dir("locales");
        std::fs::write(dir.join("main.js"), "").unwrap();
        std::fs::write(dir.join("icon.svg"), "<svg/>").unwrap();
        let locales = dir.join(LOCALES_DIR);
        std::fs::create_dir_all(&locales).unwrap();
        std::fs::write(locales.join("ru.toml"), RU_LOCALE).unwrap();
        let manifest = parse_plugin(&dir, LOCALIZED).unwrap();
        assert_eq!(manifest.icon.as_deref(), Some("icon.svg"));
        assert_eq!(
            manifest.settings[0].hint.as_deref(),
            Some("Where to translate")
        );
        assert_eq!(manifest.strings["translate"], "Translate");
        let ru = &manifest.locales["ru"];
        assert_eq!(ru.name.as_deref(), Some("Переводчик"));
        assert_eq!(ru.settings["lang"].label.as_deref(), Some("Язык"));
        assert_eq!(ru.settings["lang"].options["en"], "Английский");
        assert_eq!(ru.strings["translate"], "Перевести");

        let check = |file: &str, text: &str, expected: &str| {
            std::fs::write(locales.join(file), text).unwrap();
            let error = parse_plugin(&dir, LOCALIZED).unwrap_err();
            assert!(error.contains(expected), "{file}: {error}");
            std::fs::remove_file(locales.join(file)).unwrap();
        };
        check("de.toml", "[strings]\nunknown = \"x\"", "unknown");
        check("de.toml", "[settings.lang.options]\nfr = \"x\"", "fr");
        check("de.toml", "[settings.size]\nlabel = \"x\"", "size");
        check("de.toml", "title = \"x\"", "de.toml");
        check("Bad_Name.toml", "", "код языка");

        let icon = LOCALIZED.replace("icon.svg", "icon.txt");
        assert!(parse_plugin(&dir, &icon).unwrap_err().contains("значок"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Ключи строк перевода или манифеста
    fn keys(strings: &BTreeMap<String, String>) -> Vec<&String> {
        strings.keys().collect()
    }

    /// Плагины из папки plugins/ репозитория читаются, у них есть значок и
    /// полные переводы на все языки клиента.
    #[test]
    fn repository_plugins_are_translated() {
        let languages = crate::desktop::LOCALES.iter().map(|(code, _)| *code);
        let languages: Vec<&str> = languages.filter(|code| *code != "en").collect();
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        for entry in std::fs::read_dir(root.join("../../../plugins")).unwrap() {
            let dir = entry.unwrap().path();
            let name = dir.display().to_string();
            let text = std::fs::read_to_string(dir.join(PLUGIN_MANIFEST)).unwrap();
            let manifest = parse_plugin(&dir, &text);
            let manifest = manifest.unwrap_or_else(|error| panic!("{name}: {error}"));
            assert!(manifest.icon.is_some(), "{name}: нет значка");
            for code in &languages {
                let Some(locale) = manifest.locales.get(*code) else {
                    panic!("{name}: нет перевода {code}");
                };
                assert!(locale.name.is_some(), "{name} {code}: name");
                assert!(locale.description.is_some(), "{name} {code}");
                assert_eq!(keys(&locale.strings), keys(&manifest.strings), "{code}");
                for setting in &manifest.settings {
                    let text = locale.settings.get(&setting.name);
                    let label = text.and_then(|text| text.label.as_ref());
                    assert!(label.is_some(), "{name} {code}: {}", setting.name);
                }
            }
        }
    }

    #[test]
    fn language_codes_are_bcp47_like() {
        for good in ["en", "pt-BR", "zh-Hans", "ckb"] {
            assert!(valid_language(good), "{good}");
        }
        for bad in ["", "e", "EN", "en_US", "en-", "english", "en-x"] {
            assert!(!valid_language(bad), "{bad}");
        }
    }

    #[test]
    fn theme_manifest_needs_css() {
        let dir = temp_dir("theme");
        assert!(parse_theme(&dir, "name = \"Ночь\"").is_err());
        std::fs::write(dir.join("theme.css"), "body{}").unwrap();
        let theme = parse_theme(&dir, "name = \"Ночь\"\nauthor = \"Ava\"").unwrap();
        assert_eq!(theme.main, "theme.css");
        assert_eq!(theme.about.author.as_deref(), Some("Ava"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wildcard_hosts_match_only_subdomains() {
        let patterns = vec!["api.example.com".to_owned(), "*.deepl.com".to_owned()];
        assert!(host_allowed(&patterns, "api.example.com"));
        assert!(host_allowed(&patterns, "API.Example.com."));
        assert!(host_allowed(&patterns, "api-free.deepl.com"));
        assert!(host_allowed(&patterns, "a.b.deepl.com"));
        assert!(!host_allowed(&patterns, "deepl.com"));
        assert!(!host_allowed(&patterns, "evildeepl.com"));
        assert!(!host_allowed(&patterns, "example.com"));
    }
}
