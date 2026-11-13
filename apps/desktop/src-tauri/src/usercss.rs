//! Описание темы и её собственные настройки в формате UserCSS.
//!
//! UserCSS — формат пользовательских стилей Stylus
//! (<https://github.com/openstyles/stylus/wiki/Writing-UserCSS>): в начале
//! файла комментарий `==UserStyle==` с названием, автором и настройками.
//!
//! ```css
//! /* ==UserStyle==
//! @name        Catppuccin
//! @author      catppuccin
//! @version     1.2.0
//! @var select  flavor "Палитра" ["latte:Latte", "mocha:Mocha*"]
//! @var color   accent "Акцент"  #cba6f7
//! @var range   radius "Скругление" [12, 0, 24, 1, "px"]
//! ==/UserStyle== */
//! ```
//!
//! Настройки показываются в «Внешнем виде» вместо встроенных цветов Stoat,
//! когда тема выбрана. Значения подставляются как в Stylus:
//!
//! * препроцессор `default` (по умолчанию) — переменные CSS `--имя` в `:root`;
//! * `@preprocessor uso` — замена `/*[[имя]]*/` в тексте темы, так удобно
//!   держать палитры: у каждого варианта `dropdown` свой кусок CSS.
//!
//! Препроцессоры `less` и `stylus` требуют компилятора, их настройки не
//! применяются (тема подключается как есть). Секции `@-moz-document` (их
//! Chromium не понимает) раскрываются, если подходят к адресу веб-клиента.
//!
//! Темы без `==UserStyle==` тоже работают: название, автор и описание
//! берутся из первого комментария с `@name` (как у тем BetterDiscord), а
//! своих настроек у такой темы нет.

use std::collections::BTreeMap;

use serde::Serialize;
use url::Url;

/// Больше настроек у одной темы не читается.
const MAX_SETTINGS: usize = 128;
/// Длиннее значение текстовой настройки не сохраняется.
const MAX_TEXT_VALUE: usize = 1024;

/// Описание темы из её заголовка.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    /// `@name`
    pub name: Option<String>,
    /// `@description`
    pub description: Option<String>,
    /// `@author`
    pub author: Option<String>,
    /// `@version`
    pub version: Option<String>,
    /// `@preprocessor`: `default`, `uso` или неподдерживаемый
    pub preprocessor: String,
    /// Настройки применяются (препроцессор поддерживается)
    pub supported: bool,
    /// `@var` и `@advanced`
    pub settings: Vec<Setting>,
}

/// Вид настройки.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Строка
    Text,
    /// Цвет
    Color,
    /// Флажок: `1` или `0`
    Checkbox,
    /// Выбор из вариантов (`select`, `dropdown`, `image`)
    Select,
    /// Число
    Number,
    /// Ползунок
    Range,
}

/// Настройка темы.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    /// Имя переменной
    pub name: String,
    /// Подпись
    pub label: String,
    /// Вид
    pub kind: Kind,
    /// Значение по умолчанию (у выбора — имя варианта)
    pub default: String,
    /// Варианты выбора
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<SelectOption>,
    /// Наименьшее значение числа
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    /// Наибольшее значение числа
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// Шаг
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,
    /// Единица (`px`, `%`), дописывается к числу
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

/// Вариант выбора.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SelectOption {
    /// Имя, под которым вариант сохраняется
    pub name: String,
    /// Подпись
    pub label: String,
    /// Что подставляется в CSS: значение или кусок CSS
    #[serde(skip)]
    pub value: String,
}

impl Setting {
    /// Проверить значение из интерфейса и привести к сохраняемому виду;
    /// `None` — значение не подходит.
    pub fn normalize(&self, input: &str) -> Option<String> {
        let input = input.trim();
        match self.kind {
            Kind::Text | Kind::Color => {
                // значение попадает в CSS: скобки блоков сломали бы тему
                let clean: String = input
                    .chars()
                    .filter(|c| !c.is_control() && *c != '{' && *c != '}')
                    .take(MAX_TEXT_VALUE)
                    .collect();
                (self.kind == Kind::Text || !clean.is_empty()).then_some(clean)
            }
            Kind::Checkbox => match input {
                "1" | "true" => Some("1".into()),
                "0" | "false" => Some("0".into()),
                _ => None,
            },
            Kind::Select => self
                .options
                .iter()
                .any(|option| option.name == input)
                .then(|| input.to_owned()),
            Kind::Number | Kind::Range => {
                let mut value: f64 = input.parse().ok().filter(|v: &f64| v.is_finite())?;
                if let Some(min) = self.min {
                    value = value.max(min);
                }
                if let Some(max) = self.max {
                    value = value.min(max);
                }
                Some(format_number(value))
            }
        }
    }

    /// Действующее значение: сохранённое, если оно подходит, иначе по
    /// умолчанию.
    pub fn effective(&self, stored: Option<&str>) -> String {
        stored
            .and_then(|value| self.normalize(value))
            .unwrap_or_else(|| self.default.clone())
    }

    /// Что подставить в CSS.
    fn css_value(&self, stored: Option<&str>) -> String {
        let value = self.effective(stored);
        match self.kind {
            Kind::Select => self
                .options
                .iter()
                .find(|option| option.name == value)
                .map(|option| option.value.clone())
                .unwrap_or_default(),
            Kind::Number | Kind::Range => match &self.unit {
                Some(unit) => format!("{value}{unit}"),
                None => value,
            },
            _ => value,
        }
    }
}

/// Число без лишнего `.0`: `12`, `0.5`.
fn format_number(value: f64) -> String {
    format!("{value}")
}

// ───────────────────────────────── заголовок ─────────────────────────────────

/// Прочитать описание темы из её текста.
pub fn parse(css: &str) -> Meta {
    let mut meta = Meta {
        preprocessor: "default".into(),
        supported: true,
        ..Meta::default()
    };
    if let Some(block) = user_style_block(css) {
        parse_block(block, &mut meta);
    } else {
        read_comment_header(css, &mut meta);
    }
    meta
}

/// Описание плагина: `@name`, `@description`, `@author`, `@version` в
/// первом комментарии (`/** … */` или строки `// …`, как у UserScript).
pub fn header(code: &str) -> Meta {
    let mut meta = Meta::default();
    read_comment_header(code, &mut meta);
    meta
}

/// Поля из первого комментария файла (BetterDiscord, UserScript).
fn read_comment_header(text: &str, meta: &mut Meta) {
    let Some(comment) = leading_comment(text) else {
        return;
    };
    for line in comment.lines() {
        let line = line
            .trim_start()
            .trim_start_matches('/')
            .trim_start_matches('*')
            .trim();
        if let Some((key, value)) = header_line(line) {
            set_field(meta, key, value);
        }
    }
}

/// Текст между `==UserStyle==` и `==/UserStyle==`.
fn user_style_block(css: &str) -> Option<&str> {
    let start = css.find("==UserStyle==")? + "==UserStyle==".len();
    let end = css[start..].find("==/UserStyle==")? + start;
    Some(&css[start..end])
}

/// Первый комментарий файла, если в нём есть `@name`: блок `/* … */` или
/// идущие подряд строки `// …`.
fn leading_comment(text: &str) -> Option<&str> {
    let rest = text.trim_start_matches('\u{feff}').trim_start();
    let comment = if let Some(body) = rest.strip_prefix("/*") {
        &body[..body.find("*/")?]
    } else if rest.starts_with("//") {
        let mut end = 0;
        for line in rest.split_inclusive('\n') {
            if !line.trim_start().starts_with("//") {
                break;
            }
            end += line.len();
        }
        &rest[..end]
    } else {
        return None;
    };
    comment.contains("@name").then_some(comment)
}

/// `@key value` → `(key, value)`.
fn header_line(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix('@')?;
    let key_end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
    let key = &rest[..key_end];
    (!key.is_empty()).then(|| (key, rest[key_end..].trim()))
}

fn set_field(meta: &mut Meta, key: &str, value: &str) {
    if value.is_empty() {
        return;
    }
    let value = Some(value.to_owned());
    match key {
        "name" => meta.name = value,
        "description" => meta.description = value,
        "author" => meta.author = value,
        "version" => meta.version = value,
        _ => {}
    }
}

/// Разобрать блок `==UserStyle==`: поля построчно, `@var` и `@advanced`
/// могут занимать несколько строк.
fn parse_block(block: &str, meta: &mut Meta) {
    let mut cursor = Cursor::new(block);
    while !cursor.done() {
        cursor.skip_ws();
        if !cursor.eat('@') {
            cursor.rest_of_line();
            continue;
        }
        let key = cursor.word();
        match key.as_str() {
            "var" | "advanced" => {
                if let Some(setting) = parse_setting(&mut cursor)
                    && meta.settings.len() < MAX_SETTINGS
                    && !meta.settings.iter().any(|s| s.name == setting.name)
                {
                    meta.settings.push(setting);
                }
                cursor.rest_of_line();
            }
            "preprocessor" => {
                let value = cursor.rest_of_line().trim().to_lowercase();
                meta.supported = matches!(value.as_str(), "default" | "uso");
                meta.preprocessor = value;
            }
            _ => {
                let value = cursor.rest_of_line();
                set_field(meta, &key, value.trim());
            }
        }
    }
}

/// `@var <вид> <имя> <подпись> <значение>`
fn parse_setting(cursor: &mut Cursor<'_>) -> Option<Setting> {
    cursor.skip_inline_ws();
    let kind_word = cursor.word().to_lowercase();
    cursor.skip_inline_ws();
    let name = cursor.word();
    if name.is_empty() {
        return None;
    }
    cursor.skip_inline_ws();
    let label = cursor.quoted().unwrap_or_else(|| cursor.word());
    let label = if label.is_empty() {
        name.clone()
    } else {
        label
    };
    cursor.skip_inline_ws();
    let raw = cursor.value();

    let mut setting = Setting {
        name,
        label,
        kind: Kind::Text,
        default: String::new(),
        options: Vec::new(),
        min: None,
        max: None,
        step: None,
        unit: None,
    };
    match kind_word.as_str() {
        "text" => setting.default = raw.text(),
        "color" => {
            setting.kind = Kind::Color;
            setting.default = raw.text();
        }
        "checkbox" => {
            setting.kind = Kind::Checkbox;
            let value = raw.text();
            setting.default = if matches!(value.as_str(), "1" | "true") {
                "1".into()
            } else {
                "0".into()
            };
        }
        "select" | "dropdown" | "image" => {
            setting.kind = Kind::Select;
            let (options, default) = select_options(raw);
            if options.is_empty() {
                return None;
            }
            setting.default = default.unwrap_or_else(|| options[0].name.clone());
            setting.options = options;
        }
        "number" | "range" => {
            setting.kind = if kind_word == "range" {
                Kind::Range
            } else {
                Kind::Number
            };
            match raw {
                Raw::List(items) => {
                    let number = |index: usize| match items.get(index) {
                        Some(Raw::Num(value)) => Some(*value),
                        Some(Raw::Str(text)) | Some(Raw::Bare(text)) => text.parse().ok(),
                        _ => None,
                    };
                    let default = number(0).unwrap_or(0.0);
                    setting.min = number(1);
                    setting.max = number(2);
                    setting.step = number(3);
                    setting.unit = items.iter().skip(1).find_map(|item| match item {
                        Raw::Str(unit) if unit.parse::<f64>().is_err() => Some(unit.clone()),
                        _ => None,
                    });
                    setting.default = format_number(default);
                }
                other => setting.default = format_number(other.text().parse().unwrap_or(0.0)),
            }
            if setting.kind == Kind::Range && (setting.min.is_none() || setting.max.is_none()) {
                // ползунку нужны края; без них это просто число
                setting.kind = Kind::Number;
            }
        }
        _ => return None,
    }
    Some(setting)
}

/// Варианты выбора и имя варианта по умолчанию (`*` в подписи).
fn select_options(raw: Raw) -> (Vec<SelectOption>, Option<String>) {
    let mut options = Vec::new();
    let mut default = None;
    let mut push = |key: &str, label: Option<String>, value: Option<String>| {
        // "имя:Подпись*" или просто "Подпись*"
        let (key, starred_key) = strip_star(key);
        let (name, mut text) = match key.split_once(':') {
            Some((name, text)) => (name.trim().to_owned(), text.trim().to_owned()),
            None => (key.trim().to_owned(), key.trim().to_owned()),
        };
        let mut starred = starred_key;
        if let Some(label) = label {
            let (label, starred_label) = strip_star(&label);
            text = label.trim().to_owned();
            starred |= starred_label;
        }
        if name.is_empty() || options.iter().any(|o: &SelectOption| o.name == name) {
            return;
        }
        if starred && default.is_none() {
            default = Some(name.clone());
        }
        options.push(SelectOption {
            value: value.unwrap_or_else(|| name.clone()),
            name,
            label: text,
        });
    };
    match raw {
        Raw::List(items) => {
            for item in items {
                push(&item.text(), None, None);
            }
        }
        Raw::Map(entries) => {
            for (key, label, value) in entries {
                push(&key, label, Some(value.text()));
            }
        }
        _ => {}
    }
    (options, default)
}

fn strip_star(text: &str) -> (&str, bool) {
    match text.trim_end().strip_suffix('*') {
        Some(rest) => (rest, true),
        None => (text, false),
    }
}

/// Значение в заголовке.
#[derive(Debug, Clone, PartialEq)]
enum Raw {
    Str(String),
    Num(f64),
    Bare(String),
    List(Vec<Raw>),
    /// Ключ, подпись (у `@advanced dropdown`) и значение
    Map(Vec<(String, Option<String>, Raw)>),
    Null,
}

impl Raw {
    fn text(&self) -> String {
        match self {
            Self::Str(text) | Self::Bare(text) => text.clone(),
            Self::Num(value) => format_number(*value),
            Self::List(_) | Self::Map(_) | Self::Null => String::new(),
        }
    }
}

/// Разбор заголовка посимвольно.
struct Cursor<'a> {
    text: &'a str,
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(text: &'a str) -> Self {
        Self { text, pos: 0 }
    }

    fn done(&self) -> bool {
        self.pos >= self.text.len()
    }

    fn rest(&self) -> &'a str {
        &self.text[self.pos..]
    }

    fn peek(&self) -> Option<char> {
        self.rest().chars().next()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.pos += c.len_utf8();
        Some(c)
    }

    fn eat(&mut self, expected: char) -> bool {
        if self.peek() == Some(expected) {
            self.pos += expected.len_utf8();
            true
        } else {
            false
        }
    }

    fn skip_ws(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.bump();
        }
    }

    fn skip_inline_ws(&mut self) {
        while self.peek().is_some_and(|c| c == ' ' || c == '\t') {
            self.bump();
        }
    }

    fn word(&mut self) -> String {
        let start = self.pos;
        while self
            .peek()
            .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '-')
        {
            self.bump();
        }
        self.text[start..self.pos].to_owned()
    }

    fn rest_of_line(&mut self) -> &'a str {
        let rest = self.rest();
        let end = rest.find('\n').map_or(rest.len(), |i| i + 1);
        self.pos += end;
        &rest[..end]
    }

    /// `"…"` или `'…'` с экранированием через `\`.
    fn quoted(&mut self) -> Option<String> {
        let quote = self.peek().filter(|c| *c == '"' || *c == '\'')?;
        self.bump();
        let mut out = String::new();
        while let Some(c) = self.bump() {
            match c {
                '\\' => match self.bump() {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some(other) => out.push(other),
                    None => break,
                },
                c if c == quote => return Some(out),
                c => out.push(c),
            }
        }
        Some(out)
    }

    /// `<<<EOT … EOT;` — многострочное значение.
    fn heredoc(&mut self) -> Option<String> {
        let rest = self.rest().strip_prefix("<<<EOT")?;
        let end = rest.find("EOT;").unwrap_or(rest.len());
        let body = rest[..end].trim().to_owned();
        self.pos += "<<<EOT".len() + (end + "EOT;".len()).min(rest.len());
        Some(body)
    }

    /// Значение настройки: до конца строки, если это не строка в кавычках,
    /// список или набор вариантов.
    fn value(&mut self) -> Raw {
        self.value_in(false)
    }

    /// `nested` — внутри списка или набора: там значение заканчивается
    /// запятой или скобкой.
    fn value_in(&mut self, nested: bool) -> Raw {
        self.skip_ws();
        match self.peek() {
            Some('"' | '\'') => Raw::Str(self.quoted().unwrap_or_default()),
            Some('<') if self.rest().starts_with("<<<EOT") => {
                Raw::Str(self.heredoc().unwrap_or_default())
            }
            Some('[') => {
                self.bump();
                let mut items = Vec::new();
                loop {
                    self.skip_ws();
                    if self.done() || self.eat(']') {
                        break;
                    }
                    let before = self.pos;
                    items.push(self.value_in(true));
                    self.skip_ws();
                    self.eat(',');
                    if self.pos == before {
                        self.bump();
                    }
                }
                Raw::List(items)
            }
            Some('{') => {
                self.bump();
                let mut entries = Vec::new();
                loop {
                    self.skip_ws();
                    if self.done() || self.eat('}') {
                        break;
                    }
                    let before = self.pos;
                    let key = self.quoted().unwrap_or_else(|| self.word());
                    self.skip_inline_ws();
                    if self.eat(':') {
                        // {"Подпись": "значение"}
                        let value = self.value_in(true);
                        entries.push((key, None, value));
                    } else {
                        // @advanced dropdown: имя "Подпись" <<<EOT … EOT;
                        let label = self.quoted();
                        let value = self.value_in(true);
                        entries.push((key, label, value));
                    }
                    self.skip_ws();
                    self.eat(',');
                    if self.pos == before {
                        self.bump();
                    }
                }
                Raw::Map(entries)
            }
            Some(c) if c == '-' || c.is_ascii_digit() => {
                let start = self.pos;
                while self
                    .peek()
                    .is_some_and(|c| !c.is_whitespace() && c != ',' && c != ']' && c != '}')
                {
                    self.bump();
                }
                let token = &self.text[start..self.pos];
                match token.parse() {
                    Ok(value) => Raw::Num(value),
                    Err(_) => Raw::Bare(token.to_owned()),
                }
            }
            Some(_) => {
                let start = self.pos;
                // rgba(0, 0, 0, 0.5) в конце строки — одно значение
                let ends = |c: char| c == '\n' || (nested && matches!(c, ',' | ']' | '}'));
                while self.peek().is_some_and(|c| !ends(c)) {
                    self.bump();
                }
                let token = self.text[start..self.pos].trim();
                if token == "null" {
                    Raw::Null
                } else {
                    Raw::Bare(token.to_owned())
                }
            }
            None => Raw::Null,
        }
    }
}

// ───────────────────────────────── подстановка ─────────────────────────────────

/// Текст темы для страницы: секции `@-moz-document` раскрыты, настройки
/// подставлены.
pub fn render(css: &str, meta: &Meta, values: &BTreeMap<String, String>, app_url: &Url) -> String {
    let body = unwrap_moz_document(css, app_url);
    if !meta.supported || meta.settings.is_empty() {
        return body;
    }
    let value_of =
        |setting: &Setting| setting.css_value(values.get(&setting.name).map(String::as_str));
    if meta.preprocessor == "uso" {
        let mut out = body;
        for setting in &meta.settings {
            out = out.replace(&format!("/*[[{}]]*/", setting.name), &value_of(setting));
        }
        return out;
    }
    css_variables(&meta.settings, values) + &body
}

/// Настройки переменными CSS: `:root { --<имя>: <значение>; }`.
pub fn css_variables(settings: &[Setting], values: &BTreeMap<String, String>) -> String {
    let mut css = String::from(":root {\n");
    for setting in settings {
        let value = setting.css_value(values.get(&setting.name).map(String::as_str));
        css.push_str(&format!("  --{}: {};\n", setting.name, value));
    }
    css.push_str("}\n");
    css
}

/// Раскрыть `@-moz-document`: подходящие секции остаются без обёртки,
/// чужие убираются.
fn unwrap_moz_document(css: &str, app_url: &Url) -> String {
    const RULE: &str = "@-moz-document";
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    loop {
        let Some(start) = find_outside_comments(rest, RULE) else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..start]);
        let after = &rest[start + RULE.len()..];
        let Some(open) = find_outside_comments(after, "{") else {
            // обрезанный файл: остаток всё равно не разобрать
            return out;
        };
        let conditions = &after[..open];
        let body_start = open + 1;
        let Some(close) = matching_brace(&after[body_start..]) else {
            return out;
        };
        if conditions_match(conditions, app_url) {
            out.push_str(&after[body_start..body_start + close]);
        }
        rest = &after[body_start + close + 1..];
    }
}

/// Позиция `needle` вне комментариев и строк.
fn find_outside_comments(text: &str, needle: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = text[i + 2..]
                    .find("*/")
                    .map_or(bytes.len(), |end| i + 2 + end + 2);
                continue;
            }
            quote @ (b'"' | b'\'') => {
                i = skip_string(bytes, i, quote);
                continue;
            }
            _ => {}
        }
        if text[i..].starts_with(needle) {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Конец строки CSS, начинающейся в `start`.
fn skip_string(bytes: &[u8], start: usize, quote: u8) -> usize {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'\n' => return i,
            c if c == quote => return i + 1,
            _ => i += 1,
        }
    }
    bytes.len()
}

/// Позиция `}`, закрывающей уже открытый блок.
fn matching_brace(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = text[i + 2..]
                    .find("*/")
                    .map_or(bytes.len(), |end| i + 2 + end + 2);
                continue;
            }
            quote @ (b'"' | b'\'') => {
                i = skip_string(bytes, i, quote);
                continue;
            }
            b'{' => depth += 1,
            b'}' if depth == 0 => return Some(i),
            b'}' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    None
}

/// Подходит ли секция к адресу веб-клиента: `domain()`, `url-prefix()`,
/// `url()`, `regexp()` через запятую — достаточно одного.
fn conditions_match(conditions: &str, app_url: &Url) -> bool {
    parse_conditions(conditions)
        .iter()
        .any(|(function, argument)| condition_matches(function, argument, app_url))
}

/// `domain("a"), url-prefix(b)` → `[("domain", "a"), ("url-prefix", "b")]`.
fn parse_conditions(conditions: &str) -> Vec<(String, String)> {
    let mut cursor = Cursor::new(conditions);
    let mut out = Vec::new();
    loop {
        cursor.skip_ws();
        cursor.eat(',');
        cursor.skip_ws();
        let function = cursor.word().to_lowercase();
        cursor.skip_ws();
        if function.is_empty() || !cursor.eat('(') {
            return out;
        }
        cursor.skip_ws();
        // в кавычках скобки и запятые — часть аргумента (регулярные выражения)
        let argument = match cursor.quoted() {
            Some(quoted) => quoted,
            None => {
                let start = cursor.pos;
                while cursor.peek().is_some_and(|c| c != ')') {
                    cursor.bump();
                }
                conditions[start..cursor.pos].trim().to_owned()
            }
        };
        while cursor.peek().is_some_and(|c| c != ')') {
            cursor.bump();
        }
        cursor.eat(')');
        out.push((function, argument));
    }
}

fn condition_matches(function: &str, argument: &str, app_url: &Url) -> bool {
    let address = app_url.as_str();
    let host = app_url.host_str().unwrap_or_default();
    match function {
        "domain" => host == argument || host.ends_with(&format!(".{argument}")),
        "url-prefix" => address.starts_with(argument),
        "url" => address == argument,
        // у Stylus регулярное выражение должно совпасть с адресом целиком
        "regexp" => match regex::Regex::new(&format!("^(?:{argument})$")) {
            Ok(re) => re.is_match(address),
            Err(error) => {
                tracing::warn!(%error, "regexp() в @-moz-document не разобран");
                false
            }
        },
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const THEME: &str = r#"/* ==UserStyle==
@name           Catppuccin для Stoat
@namespace      github.com/catppuccin
@version        1.2.0
@description    Пастельная тема
@author         catppuccin
@var select flavor "Палитра" ["latte:Latte", "frappe:Frappé", "mocha:Mocha*"]
@var color accent "Акцент" #cba6f7
@var checkbox blur "Размытие" 1
@var range radius "Скругление" [12, 0, 24, 1, "px"]
@var text font "Шрифт" "Inter"
@var select size "Размер" {
  "Мелкий": "12px",
  "Обычный*": "14px"
}
==/UserStyle== */
body { color: var(--accent); }
"#;

    fn url() -> Url {
        Url::parse("https://stoat.chat/app").unwrap()
    }

    #[test]
    fn reads_header_and_settings() {
        let meta = parse(THEME);
        assert_eq!(meta.name.as_deref(), Some("Catppuccin для Stoat"));
        assert_eq!(meta.version.as_deref(), Some("1.2.0"));
        assert_eq!(meta.author.as_deref(), Some("catppuccin"));
        assert!(meta.supported);
        let names: Vec<&str> = meta.settings.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            ["flavor", "accent", "blur", "radius", "font", "size"]
        );

        let flavor = &meta.settings[0];
        assert_eq!(flavor.kind, Kind::Select);
        assert_eq!(flavor.default, "mocha");
        assert_eq!(flavor.options[1].label, "Frappé");

        let radius = &meta.settings[3];
        assert_eq!(radius.kind, Kind::Range);
        assert_eq!(
            (radius.min, radius.max, radius.step),
            (Some(0.0), Some(24.0), Some(1.0))
        );
        assert_eq!(radius.unit.as_deref(), Some("px"));
        assert_eq!(radius.default, "12");

        let size = &meta.settings[5];
        assert_eq!(size.default, "Обычный");
        assert_eq!(size.options[0].value, "12px");
    }

    #[test]
    fn default_preprocessor_mounts_css_variables() {
        let meta = parse(THEME);
        let mut values = BTreeMap::new();
        values.insert("accent".to_owned(), "#ff0000".to_owned());
        values.insert("radius".to_owned(), "100".to_owned());
        values.insert("flavor".to_owned(), "нет такой".to_owned());
        let css = render(THEME, &meta, &values, &url());
        assert!(css.starts_with(":root {\n"));
        assert!(css.contains("--accent: #ff0000;"));
        assert!(css.contains("--radius: 24px;"), "значение ограничено краем");
        assert!(
            css.contains("--flavor: mocha;"),
            "чужое значение заменено на умолчание"
        );
        assert!(css.contains("--size: 14px;"));
        assert!(css.contains("--blur: 1;"));
        assert!(css.ends_with("body { color: var(--accent); }\n"));
    }

    #[test]
    fn uso_dropdown_replaces_placeholders() {
        let theme = r#"/* ==UserStyle==
@name Палитры
@preprocessor uso
@advanced dropdown palette "Палитра" {
  dark "Тёмная*" <<<EOT
  --bg: #111; --fg: #eee; EOT;
  light "Светлая" <<<EOT
  --bg: #fff; --fg: #111; EOT;
}
@advanced color accent "Акцент" #ff00ff
==/UserStyle== */
:root { /*[[palette]]*/ --accent: /*[[accent]]*/; }
"#;
        let meta = parse(theme);
        assert_eq!(meta.preprocessor, "uso");
        assert_eq!(meta.settings[0].options.len(), 2);
        assert_eq!(meta.settings[0].default, "dark");
        assert_eq!(meta.settings[0].options[1].label, "Светлая");

        let mut values = BTreeMap::new();
        values.insert("palette".to_owned(), "light".to_owned());
        let css = render(theme, &meta, &values, &url());
        assert!(css.contains(":root { --bg: #fff; --fg: #111; --accent: #ff00ff; }"));
        assert!(!css.contains("/*[["));
    }

    #[test]
    fn unsupported_preprocessor_keeps_css_as_is() {
        let theme = "/* ==UserStyle==\n@name L\n@preprocessor less\n@var color c \"C\" #fff\n==/UserStyle== */\na{}";
        let meta = parse(theme);
        assert!(!meta.supported);
        assert_eq!(render(theme, &meta, &BTreeMap::new(), &url()), theme);
    }

    #[test]
    fn betterdiscord_style_header_is_read() {
        let theme =
            "/**\n * @name Midnight\n * @author refact0r\n * @description Тёмная тема\n */\nbody{}";
        let meta = parse(theme);
        assert_eq!(meta.name.as_deref(), Some("Midnight"));
        assert_eq!(meta.author.as_deref(), Some("refact0r"));
        assert!(meta.settings.is_empty());
        assert_eq!(
            parse("body { color: red }"),
            Meta {
                preprocessor: "default".into(),
                supported: true,
                ..Meta::default()
            }
        );
    }

    #[test]
    fn plugin_header_is_read() {
        let script = "// ==UserScript==\n// @name        Перевод\n// @version     2.0\n// ==/UserScript==\nrun();";
        let meta = header(script);
        assert_eq!(meta.name.as_deref(), Some("Перевод"));
        assert_eq!(meta.version.as_deref(), Some("2.0"));
        let jsdoc = "/**\n * @name Klipy\n * @description GIF\n */\n(() => {})();";
        assert_eq!(header(jsdoc).description.as_deref(), Some("GIF"));
        assert_eq!(header("console.log('@name x')").name, None);
    }

    #[test]
    fn moz_document_sections_for_this_site_are_unwrapped() {
        let css = r#"a{}
@-moz-document domain("stoat.chat") {
  /* } в комментарии */ b { content: "}"; }
}
@-moz-document domain("example.com") { c{} }
@-moz-document url-prefix("https://stoat.chat/"), domain("x.org") { d{} }
@-moz-document regexp("https://stoat\\.chat/.*") { e{} }
"#;
        let out = unwrap_moz_document(css, &url());
        assert!(out.contains(r#"b { content: "}"; }"#));
        assert!(!out.contains("c{}"));
        assert!(out.contains("d{}"));
        assert!(out.contains("e{}"));
        assert!(!out.contains("@-moz-document"));
    }

    #[test]
    fn value_runs_to_end_of_line() {
        let meta = parse(
            "/* ==UserStyle==\n@name T\n@var color shadow \"Тень\" rgba(0, 0, 0, 0.5)\n==/UserStyle== */",
        );
        assert_eq!(meta.settings[0].default, "rgba(0, 0, 0, 0.5)");
    }

    #[test]
    fn values_are_checked_by_kind() {
        let meta = parse(THEME);
        let by_name = |name: &str| meta.settings.iter().find(|s| s.name == name).unwrap();
        assert_eq!(by_name("blur").normalize("false"), Some("0".into()));
        assert_eq!(by_name("blur").normalize("maybe"), None);
        assert_eq!(by_name("radius").normalize("-5"), Some("0".into()));
        assert_eq!(by_name("radius").normalize("2.5"), Some("2.5".into()));
        assert_eq!(by_name("radius").normalize("NaN"), None);
        assert_eq!(by_name("flavor").normalize("latte"), Some("latte".into()));
        assert_eq!(by_name("flavor").normalize("Latte"), None);
        assert_eq!(
            by_name("font").normalize("Inter} body{display:none"),
            Some("Inter bodydisplay:none".into())
        );
        assert_eq!(by_name("accent").normalize("  "), None);
    }
}
