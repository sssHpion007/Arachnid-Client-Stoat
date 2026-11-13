//! Избранные GIF встроенного плагина «Quality of Life» (`gifs.js`).
//!
//! Всё хранится только на компьютере, в каталоге данных:
//!
//! ```text
//! favorite-gifs/favorites.json      список по порядку: ссылка, описание…
//! favorite-gifs/previews/<id>.webp  превью — один кадр, до 240 px в ширину
//! ```
//!
//! Сами GIF на диск не скачиваются: окно воспроизводит их по ссылке и только
//! пока на плитку наведён указатель, а до того показывает превью в несколько
//! килобайт. Кадр для превью снимает страница (WebView2 разбирает все
//! форматы, которые умеет показывать), а файл для неё скачивает клиент:
//! чужие сайты не дают странице рисовать свои файлы на холсте (CORS). Превью
//! страница получает по адресам `http://arachnid.localhost/favorite-gifs/
//! <id>.webp` — схема файлов расширений ([`crate::extensions`]).
//!
//! Ссылку на страницу (Tenor, Giphy, Imgur, любой сайт) клиент разбирает по
//! тем же тегам Open Graph и Twitter, по которым сервис встраивания Stoat
//! (January) строит встраивание в чате: видео или картинка страницы.
//! Запросы идут через WinHTTP ([`crate::http`]), поэтому разбор ссылок
//! работает только в Windows.

// без WinHTTP разбор ссылок нужен только тестам
#![cfg_attr(not(windows), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::State;
use url::Url;

use crate::{CmdResult, CommandError};

/// Каталог избранного в каталоге данных.
pub const DIR: &str = "favorite-gifs";
/// Начало адресов превью в схеме файлов расширений.
pub const ASSET_PREFIX: &str = "/favorite-gifs/";
const LIST_FILE: &str = "favorites.json";
const PREVIEWS_DIR: &str = "previews";

/// Больше GIF в избранное не добавляется.
const MAX_FAVORITES: usize = 5000;
/// Самая длинная ссылка.
const MAX_URL: usize = 4096;
/// Самое длинное описание (в символах).
const MAX_TEXT: usize = 500;
/// Самое большое превью.
const MAX_PREVIEW: usize = 512 * 1024;
/// Самая большая сторона GIF.
const MAX_SIDE: u32 = 16384;
/// Больше файл для превью не скачивается.
const MAX_MEDIA: usize = 48 * 1024 * 1024;
/// Столько читается от страницы: теги Open Graph — в её начале.
const MAX_PAGE: usize = 2 * 1024 * 1024;
/// Заголовки запросов по ссылкам пользователя.
const REQUEST_HEADERS: &str =
    "Accept: text/html,application/xhtml+xml,image/*,video/*;q=0.9,*/*;q=0.8\r\n";

/// Что воспроизводит плитка.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// `<video>`: mp4, webm
    Video,
    /// `<img>`: gif, webp, png…
    Image,
}

/// GIF в избранном.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Favorite {
    /// 16 шестнадцатеричных цифр
    pub id: String,
    /// Что отправляется в чат: ссылка, которую добавили
    pub url: String,
    /// Прямая ссылка на файл, который воспроизводит плитка
    pub media: String,
    pub kind: Kind,
    /// Размеры кадра: по ним сетка раскладывается до загрузки превью
    pub width: u32,
    pub height: u32,
    /// Описание пользователя: по нему ищется GIF
    #[serde(default)]
    pub description: String,
    /// Запрос, по которому GIF нашли в Gifbox
    #[serde(default)]
    pub query: String,
    /// Когда добавлена, мс от 1970 года
    #[serde(default)]
    pub added: u64,
    /// Сколько раз отправлена и когда последний раз
    #[serde(default)]
    pub sent: u32,
    #[serde(default)]
    pub last_sent: u64,
    /// Версия превью: растёт с каждым новым превью (адрес обходит кеш
    /// страницы), 0 — превью нет
    #[serde(default)]
    pub preview: u32,
}

/// GIF, которую добавляют.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewFavorite {
    pub url: String,
    pub media: String,
    pub kind: Kind,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub query: String,
}

/// Список для страницы.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// Начало адресов превью: `<base><id>.webp?v=<preview>`
    pub base: String,
    pub favorites: Vec<Favorite>,
}

/// Файл на диске.
#[derive(Debug, Default, Deserialize)]
struct ListFile {
    #[serde(default)]
    favorites: Vec<Favorite>,
}

#[derive(Serialize)]
struct ListFileRef<'a> {
    favorites: &'a [Favorite],
}

/// Избранные GIF: список в памяти и на диске.
pub struct FavoriteGifs {
    dir: PathBuf,
    list: Mutex<Vec<Favorite>>,
}

impl FavoriteGifs {
    /// Прочитать список. Превью, которых нет в списке, удаляются; GIF, у
    /// которых пропал файл превью, получают превью заново (страница).
    pub fn new(dir: PathBuf) -> Self {
        let mut list = load(&dir.join(LIST_FILE));
        let previews = dir.join(PREVIEWS_DIR);
        for favorite in &mut list {
            let file = previews.join(format!("{}.webp", favorite.id));
            if favorite.preview > 0 && !file.is_file() {
                favorite.preview = 0;
            }
        }
        prune_previews(&previews, &list);
        Self {
            dir,
            list: Mutex::new(list),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Vec<Favorite>> {
        self.list.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn list(&self) -> Vec<Favorite> {
        self.lock().clone()
    }

    /// Изменить список и сохранить его; при ошибке список не меняется.
    fn change<T>(
        &self,
        change: impl FnOnce(&mut Vec<Favorite>) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut list = self.lock();
        let mut next = list.clone();
        let value = change(&mut next)?;
        if let Err(error) = self.save(&next) {
            return Err(format!("список не сохранён: {error}"));
        }
        *list = next;
        Ok(value)
    }

    fn save(&self, list: &[Favorite]) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let text = serde_json::to_string_pretty(&ListFileRef { favorites: list })?;
        write_atomically(&self.dir.join(LIST_FILE), text.as_bytes())
    }

    fn preview_file(&self, id: &str) -> PathBuf {
        self.dir.join(PREVIEWS_DIR).join(format!("{id}.webp"))
    }

    /// Добавить GIF в начало. Если такая ссылка уже есть, GIF поднимается
    /// в начало, а непустое описание заменяет прежнее.
    pub fn add(&self, new: NewFavorite) -> Result<Favorite, String> {
        let url = checked_url(&new.url)?;
        let media = checked_url(&new.media)?;
        let sides = 1..=MAX_SIDE;
        if !sides.contains(&new.width) || !sides.contains(&new.height) {
            return Err("размеры GIF не подходят".into());
        }
        let description = clean_text(&new.description);
        let query = clean_text(&new.query);
        self.change(|list| {
            if let Some(index) = list.iter().position(|known| known.url == url) {
                let mut known = list.remove(index);
                if !description.is_empty() {
                    known.description = description;
                }
                list.insert(0, known.clone());
                return Ok(known);
            }
            if list.len() >= MAX_FAVORITES {
                return Err(format!("в избранном уже {MAX_FAVORITES} GIF"));
            }
            let favorite = Favorite {
                id: new_id(list),
                url,
                media,
                kind: new.kind,
                width: new.width,
                height: new.height,
                description,
                query,
                added: now_ms(),
                sent: 0,
                last_sent: 0,
                preview: 0,
            };
            list.insert(0, favorite.clone());
            Ok(favorite)
        })
    }

    /// Новое описание.
    pub fn describe(&self, id: &str, description: &str) -> Result<Favorite, String> {
        let description = clean_text(description);
        self.change(|list| {
            let favorite = find(list, id)?;
            favorite.description = description;
            Ok(favorite.clone())
        })
    }

    /// Убрать GIF вместе с превью.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        self.change(|list| {
            let before = list.len();
            list.retain(|favorite| favorite.id != id);
            if list.len() == before {
                return Err(missing());
            }
            Ok(())
        })?;
        if valid_id(id) {
            let _ = std::fs::remove_file(self.preview_file(id));
        }
        Ok(())
    }

    /// Поставить GIF на место `index` (0 — в самый верх).
    pub fn move_to(&self, id: &str, index: usize) -> Result<(), String> {
        self.change(|list| {
            let from = list
                .iter()
                .position(|favorite| favorite.id == id)
                .ok_or_else(missing)?;
            let favorite = list.remove(from);
            list.insert(index.min(list.len()), favorite);
            Ok(())
        })
    }

    /// GIF отправили в чат.
    pub fn mark_sent(&self, id: &str) -> Result<(), String> {
        self.change(|list| {
            let favorite = find(list, id)?;
            favorite.sent = favorite.sent.saturating_add(1);
            favorite.last_sent = now_ms();
            Ok(())
        })
    }

    /// Сохранить превью (WebP).
    pub fn set_preview(&self, id: &str, preview: &[u8]) -> Result<Favorite, String> {
        if preview.len() > MAX_PREVIEW {
            return Err("превью больше 512 КБ".into());
        }
        if !is_webp(preview) {
            return Err("превью — не WebP".into());
        }
        if !valid_id(id) {
            return Err(missing());
        }
        let file = self.preview_file(id);
        self.change(|list| {
            let favorite = find(list, id)?;
            let written = file
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|()| write_atomically(&file, preview));
            if let Err(error) = written {
                return Err(format!("превью не сохранено: {error}"));
            }
            favorite.preview = favorite.preview.saturating_add(1);
            Ok(favorite.clone())
        })
    }

    /// Файл превью по пути адреса после [`ASSET_PREFIX`] (`<id>.webp`).
    pub fn preview(&self, path: &str) -> Option<Vec<u8>> {
        let id = path.strip_suffix(".webp")?;
        if !valid_id(id) {
            return None;
        }
        std::fs::read(self.preview_file(id)).ok()
    }
}

fn find<'a>(list: &'a mut [Favorite], id: &str) -> Result<&'a mut Favorite, String> {
    list.iter_mut()
        .find(|favorite| favorite.id == id)
        .ok_or_else(missing)
}

fn missing() -> String {
    "этой GIF нет в избранном".into()
}

fn load(path: &Path) -> Vec<Favorite> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            tracing::warn!(%error, "избранные GIF не читаются");
            return Vec::new();
        }
    };
    match serde_json::from_str::<ListFile>(&text) {
        Ok(file) => file
            .favorites
            .into_iter()
            .filter(|favorite| valid_id(&favorite.id))
            .collect(),
        Err(error) => {
            tracing::warn!(%error, "ошибка в списке избранных GIF");
            // испорченный файл не затирается: его можно поправить вручную
            let _ = std::fs::copy(path, path.with_extension("json.broken"));
            Vec::new()
        }
    }
}

/// Удалить превью, которых нет в списке.
fn prune_previews(dir: &Path, list: &[Favorite]) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let id = name.strip_suffix(".webp").unwrap_or(&name);
        let known = list
            .iter()
            .any(|favorite| favorite.id == id && favorite.preview > 0);
        if !known {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn write_atomically(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, data)?;
    std::fs::rename(&temp, path)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

/// Новый id, которого ещё нет в списке.
fn new_id(list: &[Favorite]) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    // младшие 64 бита наносекунд: у GIF, добавленных подряд, они разные
    let mut seed = nanos as u64;
    loop {
        let id = format!("{seed:016x}");
        if !list.iter().any(|favorite| favorite.id == id) {
            return id;
        }
        seed = seed.wrapping_add(1);
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Ссылка http(s) не длиннее [`MAX_URL`].
fn parse_url(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    if raw.len() > MAX_URL {
        return Err("слишком длинная ссылка".into());
    }
    let url = Url::parse(raw).map_err(|_| "это не ссылка".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return Err("нужна ссылка http:// или https://".into());
    }
    Ok(url)
}

fn checked_url(raw: &str) -> Result<String, String> {
    parse_url(raw).map(String::from)
}

/// Текст в одну строку без управляющих символов, не длиннее [`MAX_TEXT`].
fn clean_text(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let line = words.join(" ");
    line.chars()
        .filter(|c| !c.is_control())
        .take(MAX_TEXT)
        .collect()
}

/// Файл WebP: `RIFF<размер>WEBP`.
fn is_webp(data: &[u8]) -> bool {
    data.len() > 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP"
}

// ───────────────────────────────── ссылки ─────────────────────────────────

/// Что воспроизводить по ссылке.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    /// Прямая ссылка на файл
    pub media: String,
    pub kind: Kind,
}

/// Вид файла по типу из Content-Type. SVG не подходит: Stoat не встраивает
/// его в чат.
fn kind_of_type(mime: &str) -> Option<Kind> {
    let mime = mime.trim().to_ascii_lowercase();
    if mime.starts_with("video/") {
        Some(Kind::Video)
    } else if mime.starts_with("image/") && !mime.starts_with("image/svg") {
        Some(Kind::Image)
    } else {
        None
    }
}

/// Вид файла по расширению в пути ссылки.
fn kind_of_path(url: &Url) -> Option<Kind> {
    let path = url.path().to_ascii_lowercase();
    let extension = path.rsplit_once('.')?.1;
    match extension {
        "mp4" | "webm" | "m4v" | "mov" => Some(Kind::Video),
        "gif" | "webp" | "apng" | "png" | "jpg" | "jpeg" | "avif" => Some(Kind::Image),
        _ => None,
    }
}

/// Тип без параметров (`text/html; charset=utf-8` → `text/html`).
fn content_type(headers: &[(String, String)]) -> String {
    let value = headers
        .iter()
        .find(|(name, _)| name == "content-type")
        .map_or("", |(_, value)| value.as_str());
    let essence = value.split(';').next().unwrap_or("");
    essence.trim().to_ascii_lowercase()
}

const ATTRIBUTE_PATTERN: &str = r#"(?is)([a-z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#;
static META: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<meta\b([^>]*)>").unwrap());
static ATTRIBUTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(ATTRIBUTE_PATTERN).unwrap());

/// Теги `<meta>` страницы: имя (`property`, `name` или `itemprop`) в нижнем
/// регистре и значение `content`.
fn meta_tags(html: &str) -> Vec<(String, String)> {
    let mut tags = Vec::new();
    for meta in META.captures_iter(html) {
        let mut name = None;
        let mut content = None;
        for attribute in ATTRIBUTE.captures_iter(&meta[1]) {
            let value = attribute
                .get(2)
                .or_else(|| attribute.get(3))
                .or_else(|| attribute.get(4))
                .map_or("", |value| value.as_str());
            match attribute[1].to_ascii_lowercase().as_str() {
                "property" | "name" | "itemprop" => name = Some(value.to_ascii_lowercase()),
                "content" => content = Some(decode_entities(value)),
                _ => {}
            }
        }
        if let (Some(name), Some(content)) = (name, content) {
            tags.push((name, content.trim().to_owned()));
        }
    }
    tags
}

/// Сущности HTML в значении атрибута.
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        match entity(rest) {
            Some((c, length)) => {
                out.push(c);
                rest = &rest[length..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Сущность в начале `rest` (`&amp;`, `&#47;`…): символ и длина вместе с `;`.
fn entity(rest: &str) -> Option<(char, usize)> {
    let end = rest.find(';').filter(|&end| end <= 10)?;
    let name = &rest[1..end];
    let c = match name {
        "amp" => '&',
        "quot" => '"',
        "apos" => '\'',
        "lt" => '<',
        "gt" => '>',
        _ => {
            let number = name.strip_prefix('#')?;
            let code = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => number.parse().ok()?,
            };
            char::from_u32(code)?
        }
    };
    Some((c, end + 1))
}

/// Видео или картинка страницы по тегам Open Graph и Twitter: сначала
/// видео (оно легче GIF той же длины), потом GIF, потом любая картинка.
fn page_media(html: &str, base: &Url) -> Option<Resolved> {
    let tags = meta_tags(html);
    let values = |names: &[&str]| -> Vec<Url> {
        names
            .iter()
            .flat_map(|name| tags.iter().filter(move |(tag, _)| tag == *name))
            .filter_map(|(_, value)| base.join(value).ok())
            .filter(|url| matches!(url.scheme(), "http" | "https"))
            .collect()
    };
    let video_type = tags
        .iter()
        .find(|(name, _)| name == "og:video:type")
        .map(|(_, value)| value.to_ascii_lowercase());
    let typed_video = video_type
        .as_deref()
        .is_some_and(|mime| mime.starts_with("video/"));
    let og_video = values(&["og:video:secure_url", "og:video:url", "og:video"]);
    let stream = values(&["twitter:player:stream"]);
    let video = og_video
        .into_iter()
        .find(|url| typed_video || kind_of_path(url) == Some(Kind::Video))
        .or_else(|| stream.into_iter().next());
    if let Some(url) = video {
        return Some(Resolved {
            media: url.into(),
            kind: Kind::Video,
        });
    }
    let images = values(&[
        "og:image:secure_url",
        "og:image:url",
        "og:image",
        "twitter:image",
        "twitter:image:src",
    ]);
    let gif = images
        .iter()
        .position(|url| url.path().to_ascii_lowercase().ends_with(".gif"));
    let image = images.into_iter().nth(gif.unwrap_or(0))?;
    Some(Resolved {
        media: image.into(),
        kind: Kind::Image,
    })
}

#[cfg(windows)]
fn network_error(error: crate::http::Error) -> String {
    use crate::http::{Error, StopReason};

    match error {
        Error::Network(code) => format!("сайт недоступен (код Windows {code})"),
        Error::Status(status) => format!("сайт ответил {status}"),
        Error::Url => "ссылка не подходит".to_owned(),
        Error::Stopped(StopReason::TooLarge) => "файл слишком большой".to_owned(),
        Error::Stopped(_) => "загрузка прервана".to_owned(),
    }
}

/// Найти файл по ссылке: сама ссылка на картинку или видео — или страница,
/// где они указаны.
#[cfg(windows)]
pub fn resolve(raw: &str) -> Result<Resolved, String> {
    let url = parse_url(raw)?;
    let limit = |headers: &[(String, String)]| match kind_of_type(&content_type(headers)) {
        Some(_) => 0,
        None => MAX_PAGE,
    };
    let fetched = crate::http::fetch(&url, REQUEST_HEADERS, limit).map_err(network_error)?;
    let mime = content_type(&fetched.headers);
    let binary = mime.is_empty() || mime.ends_with("octet-stream");
    let by_path = if binary { kind_of_path(&url) } else { None };
    if let Some(kind) = kind_of_type(&mime).or(by_path) {
        return Ok(Resolved {
            media: url.into(),
            kind,
        });
    }
    if !mime.contains("html") {
        return Err(format!("по ссылке не GIF и не страница ({mime})"));
    }
    let html = String::from_utf8_lossy(&fetched.body);
    page_media(&html, &url).ok_or_else(|| "на странице нет GIF, видео или картинки".to_owned())
}

/// Скачать файл для превью.
#[cfg(windows)]
pub fn download(raw: &str) -> Result<Vec<u8>, String> {
    let url = parse_url(raw)?;
    let fetched =
        crate::http::fetch(&url, REQUEST_HEADERS, |_| MAX_MEDIA).map_err(network_error)?;
    if !fetched.complete {
        return Err("файл больше 48 МБ".into());
    }
    let mime = content_type(&fetched.headers);
    let binary = mime.is_empty() || mime.ends_with("octet-stream");
    if kind_of_type(&mime).is_none() && !binary {
        return Err(format!("по ссылке не картинка и не видео ({mime})"));
    }
    Ok(fetched.body)
}

#[cfg(not(windows))]
pub fn resolve(_raw: &str) -> Result<Resolved, String> {
    Err("ссылки избранных GIF открываются только в Windows".into())
}

#[cfg(not(windows))]
pub fn download(_raw: &str) -> Result<Vec<u8>, String> {
    Err("ссылки избранных GIF открываются только в Windows".into())
}

// ──────────────────────────────── команды ────────────────────────────────

fn error(message: String) -> CommandError {
    CommandError::new("favorite-gifs", message)
}

#[tauri::command]
pub fn favorite_gifs_list(gifs: State<'_, Arc<FavoriteGifs>>) -> Listing {
    Listing {
        base: format!("{}{}", crate::extensions::ASSET_BASE, &ASSET_PREFIX[1..]),
        favorites: gifs.list(),
    }
}

#[tauri::command]
pub fn favorite_gifs_add(
    favorite: NewFavorite,
    gifs: State<'_, Arc<FavoriteGifs>>,
) -> CmdResult<Favorite> {
    gifs.add(favorite).map_err(error)
}

#[tauri::command]
pub fn favorite_gifs_describe(
    id: String,
    description: String,
    gifs: State<'_, Arc<FavoriteGifs>>,
) -> CmdResult<Favorite> {
    gifs.describe(&id, &description).map_err(error)
}

#[tauri::command]
pub fn favorite_gifs_remove(id: String, gifs: State<'_, Arc<FavoriteGifs>>) -> CmdResult<()> {
    gifs.remove(&id).map_err(error)
}

#[tauri::command]
pub fn favorite_gifs_move(
    id: String,
    index: usize,
    gifs: State<'_, Arc<FavoriteGifs>>,
) -> CmdResult<()> {
    gifs.move_to(&id, index).map_err(error)
}

#[tauri::command]
pub fn favorite_gifs_sent(id: String, gifs: State<'_, Arc<FavoriteGifs>>) -> CmdResult<()> {
    gifs.mark_sent(&id).map_err(error)
}

#[tauri::command]
pub fn favorite_gifs_set_preview(
    id: String,
    preview: Vec<u8>,
    gifs: State<'_, Arc<FavoriteGifs>>,
) -> CmdResult<Favorite> {
    gifs.set_preview(&id, &preview).map_err(error)
}

#[tauri::command]
pub async fn favorite_gifs_resolve(url: String) -> CmdResult<Resolved> {
    tauri::async_runtime::spawn_blocking(move || resolve(&url))
        .await?
        .map_err(error)
}

/// Файл отдаётся странице как есть (ArrayBuffer), без JSON.
#[tauri::command]
pub async fn favorite_gifs_download(url: String) -> CmdResult<tauri::ipc::Response> {
    let data = tauri::async_runtime::spawn_blocking(move || download(&url))
        .await?
        .map_err(error)?;
    Ok(tauri::ipc::Response::new(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("arachnid-gifs-{name}-{nanos:x}"))
    }

    fn new_gif(url: &str) -> NewFavorite {
        NewFavorite {
            url: url.into(),
            media: format!("{url}.mp4"),
            kind: Kind::Video,
            width: 200,
            height: 100,
            description: "  кот\n смеётся ".into(),
            query: "cat".into(),
        }
    }

    const WEBP: &[u8] = b"RIFF\x10\0\0\0WEBPVP8 \x04\0\0\0abcd";

    fn ids(gifs: &FavoriteGifs) -> Vec<String> {
        gifs.list().into_iter().map(|gif| gif.id).collect()
    }

    #[test]
    fn favorites_are_kept_in_order_and_survive_restart() {
        let dir = temp_dir("order");
        let gifs = FavoriteGifs::new(dir.clone());
        let first = gifs.add(new_gif("https://tenor.com/view/a")).unwrap();
        assert_eq!(first.description, "кот смеётся");
        let second = gifs.add(new_gif("https://tenor.com/view/b")).unwrap();
        let third = gifs.add(new_gif("https://tenor.com/view/c")).unwrap();
        let (a, b, c) = (first.id.as_str(), second.id.as_str(), third.id.as_str());
        // новые — в начале
        assert_eq!(ids(&gifs), [c, b, a]);
        // перетаскивание и «в самый верх»
        gifs.move_to(c, 2).unwrap();
        assert_eq!(ids(&gifs), [b, a, c]);
        gifs.move_to(c, 0).unwrap();
        assert_eq!(ids(&gifs), [c, b, a]);
        // та же ссылка не дублируется, а поднимается
        let again = gifs.add(new_gif("https://tenor.com/view/a")).unwrap();
        assert_eq!(again.id, a);
        assert_eq!(ids(&gifs), [a, c, b]);

        gifs.describe(b, "танец").unwrap();
        gifs.mark_sent(b).unwrap();
        let restarted = FavoriteGifs::new(dir.clone());
        assert_eq!(ids(&restarted), ids(&gifs));
        let saved = restarted.list().pop().unwrap();
        assert_eq!((saved.description.as_str(), saved.sent), ("танец", 1));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn previews_are_stored_and_removed_with_favorite() {
        let dir = temp_dir("previews");
        let gifs = FavoriteGifs::new(dir.clone());
        let gif = gifs.add(new_gif("https://giphy.com/gifs/x")).unwrap();
        assert!(gifs.set_preview(&gif.id, b"not a webp").is_err());
        let updated = gifs.set_preview(&gif.id, WEBP).unwrap();
        assert_eq!(updated.preview, 1);
        let name = format!("{}.webp", gif.id);
        assert_eq!(gifs.preview(&name).as_deref(), Some(WEBP));
        assert_eq!(gifs.preview("../favorites.json"), None);
        // лишние файлы в папке превью удаляются при запуске
        let stray = dir.join(PREVIEWS_DIR).join("0123456789abcdef.webp");
        std::fs::write(&stray, WEBP).unwrap();
        let restarted = FavoriteGifs::new(dir.clone());
        assert!(!stray.exists());
        restarted.remove(&gif.id).unwrap();
        assert!(!restarted.preview_file(&gif.id).exists());
        assert!(restarted.list().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bad_input_is_refused() {
        let dir = temp_dir("refused");
        let gifs = FavoriteGifs::new(dir.clone());
        assert!(gifs.add(new_gif("file:///C:/secret.gif")).is_err());
        assert!(gifs.add(new_gif("not a link")).is_err());
        let mut flat = new_gif("https://example.com/a.gif");
        flat.height = 0;
        assert!(gifs.add(flat).is_err());
        assert!(gifs.move_to("0123456789abcdef", 0).is_err());
        assert!(gifs.list().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn page_media_prefers_video_then_gif() {
        let base = Url::parse("https://tenor.com/view/cat-123").unwrap();
        let html = r#"<html><head>
            <meta property="og:image" content="https://media.tenor.com/a/cat.png">
            <meta property='og:image' content='/a/cat.gif?x=1&amp;y=2'>
            <meta content="https://media.tenor.com/a/cat.mp4" property="og:video">
            </head></html>"#;
        let media = page_media(html, &base).unwrap();
        assert_eq!(media.media, "https://media.tenor.com/a/cat.mp4");
        assert_eq!(media.kind, Kind::Video);

        let gif_only = html.replace("og:video", "og:description");
        let media = page_media(&gif_only, &base).unwrap();
        assert_eq!(media.media, "https://tenor.com/a/cat.gif?x=1&y=2");
        assert_eq!(media.kind, Kind::Image);

        // видеоплеер (страница, а не файл) не подходит
        let player = r#"<meta property="og:video" content="https://youtube.com/embed/x">
            <meta property="og:video:type" content="text/html">
            <meta name="twitter:image" content="https://i.ytimg.com/x.jpg">"#;
        let media = page_media(player, &base).unwrap();
        assert_eq!(media.media, "https://i.ytimg.com/x.jpg");
        assert_eq!(page_media("<p>нет тегов</p>", &base), None);
    }

    #[test]
    fn entities_are_decoded() {
        assert_eq!(decode_entities("a&amp;b&#47;c&#x2F;&quot;"), "a&b/c/\"");
        assert_eq!(decode_entities("a & b &x;"), "a & b &x;");
    }

    #[test]
    fn kind_is_taken_from_type_or_extension() {
        assert_eq!(kind_of_type("video/mp4"), Some(Kind::Video));
        assert_eq!(kind_of_type("Image/GIF"), Some(Kind::Image));
        assert_eq!(kind_of_type("image/svg+xml"), None);
        assert_eq!(kind_of_type("text/html"), None);
        let path_kind = |raw: &str| kind_of_path(&Url::parse(raw).unwrap());
        assert_eq!(path_kind("https://x.com/a.WEBM?b"), Some(Kind::Video));
        assert_eq!(path_kind("https://x.com/a.gif"), Some(Kind::Image));
        assert_eq!(path_kind("https://x.com/view/a"), None);
    }
}
