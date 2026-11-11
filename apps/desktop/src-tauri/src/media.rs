//! Протокол `media:` — файлы Stoat для webview.
//!
//! WebView2 не показывает сторонние файлы на встроенных страницах, поэтому
//! раньше картинки шли через IPC data-URL'ами: медленно (base64, весь файл
//! через мост) и без видео. Теперь интерфейс ставит в `src` адрес вида
//! `media://localhost/<адрес файла>` (на Windows — `http://media.localhost/…`,
//! так его строит `convertFileSrc`), а Rust скачивает файл общим клиентом
//! с пулом соединений и отдаёт его.
//!
//! Запросы `Range` пробрасываются на CDN: видео и аудио перематываются, не
//! скачиваясь целиком. Небольшие файлы (аватары, эмодзи, картинки) остаются
//! в памяти, чтобы повторный показ не ходил в сеть.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use tauri::http::{Request, Response, StatusCode, header};
use tokio::sync::Mutex;

/// Имя протокола (для `convertFileSrc(url, "media")` в интерфейсе).
pub const SCHEME: &str = "media";

/// Сколько байт отдаём на открытый запрос `Range: bytes=N-`.
///
/// Плеер сам попросит следующий кусок, так что весь файл не держится в памяти.
const CHUNK: u64 = 4 * 1024 * 1024;

/// Самый большой файл, который сохраняется в памяти целиком.
///
/// Аватары, эмодзи и превью весят десятки–сотни килобайт; крупные файлы
/// (оригиналы, видео) в памяти не держим — их повторно отдаст CDN.
const CACHE_ITEM_MAX: usize = 4 * 1024 * 1024;

/// Предел памяти под сохранённые файлы.
const CACHE_TOTAL_MAX: usize = 32 * 1024 * 1024;

/// Файлы на CDN неизменны (новый файл — новый id), webview может их не перезапрашивать.
const CACHE_CONTROL: &str = "public, max-age=604800, immutable";

/// Скачанный файл.
struct Entry {
    content_type: String,
    body: Vec<u8>,
}

/// Файлы в памяти: вытесняются самые старые, когда кончается место.
#[derive(Default)]
struct Store {
    items: HashMap<String, Arc<Entry>>,
    order: VecDeque<String>,
    total: usize,
}

impl Store {
    fn get(&self, url: &str) -> Option<Arc<Entry>> {
        self.items.get(url).cloned()
    }

    fn insert(&mut self, url: String, entry: Arc<Entry>) {
        if entry.body.len() > CACHE_ITEM_MAX || self.items.contains_key(&url) {
            return;
        }
        self.total += entry.body.len();
        self.items.insert(url.clone(), entry);
        self.order.push_back(url);
        while self.total > CACHE_TOTAL_MAX {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(old) = self.items.remove(&oldest) {
                self.total -= old.body.len();
            }
        }
    }
}

/// Диапазон байт из заголовка `Range` (только один диапазон, как шлют плееры).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ByteRange {
    /// `bytes=start-end` или `bytes=start-`
    From { start: u64, end: Option<u64> },
    /// `bytes=-n`: последние n байт
    Suffix(u64),
}

impl ByteRange {
    fn parse(value: &str) -> Option<Self> {
        let spec = value.trim().strip_prefix("bytes=")?;
        // несколько диапазонов плееры не просят; берём первый
        let spec = spec.split(',').next()?.trim();
        let (start, end) = spec.split_once('-')?;
        if start.is_empty() {
            return end.parse().ok().map(Self::Suffix);
        }
        let start = start.parse().ok()?;
        let end = if end.is_empty() {
            None
        } else {
            Some(end.parse().ok()?)
        };
        if end.is_some_and(|end| end < start) {
            return None;
        }
        Some(Self::From { start, end })
    }

    /// Что спросить у CDN: открытый диапазон ограничиваем куском [`CHUNK`].
    fn upstream_header(self) -> String {
        match self {
            Self::From { start, end } => {
                let end = end.unwrap_or(start + CHUNK - 1).min(start + CHUNK - 1);
                format!("bytes={start}-{end}")
            }
            Self::Suffix(length) => format!("bytes=-{}", length.min(CHUNK)),
        }
    }

    /// Границы (включительно) внутри файла длиной `length`.
    fn resolve(self, length: u64) -> Option<(u64, u64)> {
        if length == 0 {
            return None;
        }
        match self {
            Self::From { start, end } => {
                if start >= length {
                    return None;
                }
                let end = end
                    .unwrap_or(u64::MAX)
                    .min(start + CHUNK - 1)
                    .min(length - 1);
                Some((start, end))
            }
            Self::Suffix(0) => None,
            Self::Suffix(count) => {
                let count = count.min(length).min(CHUNK);
                Some((length - count, length - 1))
            }
        }
    }
}

/// Заполненность кэша файлов.
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct MediaStats {
    /// Файлов в памяти
    pub files: usize,
    /// Занято байт
    pub bytes: usize,
    /// Предел, байт
    pub limit: usize,
}

/// Прокси файлов для webview.
pub struct MediaProxy {
    client: reqwest::Client,
    store: Mutex<Store>,
}

impl Default for MediaProxy {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaProxy {
    /// Новый прокси с общим пулом соединений.
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent(concat!("ArachnidClient/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .unwrap_or_default();
        Self {
            client,
            store: Mutex::new(Store::default()),
        }
    }

    /// Сколько файлов и байт сейчас в памяти, и каков предел.
    pub async fn stats(&self) -> MediaStats {
        let store = self.store.lock().await;
        MediaStats {
            files: store.items.len(),
            bytes: store.total,
            limit: CACHE_TOTAL_MAX,
        }
    }

    /// HTTP-клиент для прочих загрузок (картинки эмодзи и т. п.).
    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    /// Ответить на запрос webview.
    pub async fn serve(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let Some(url) = target_url(request.uri().path()) else {
            return empty(StatusCode::BAD_REQUEST);
        };
        let range = request
            .headers()
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(ByteRange::parse);

        if let Some(entry) = self.store.lock().await.get(&url) {
            return respond(&entry.content_type, Body::Shared(&entry.body), range);
        }

        let mut upstream = self.client.get(&url).header(header::ACCEPT, "*/*");
        if let Some(range) = range {
            upstream = upstream.header(header::RANGE, range.upstream_header());
        }
        let response = match upstream.send().await {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(%error, %url, "файл не скачан");
                return empty(StatusCode::BAD_GATEWAY);
            }
        };

        let status = response.status();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .unwrap_or_else(|| guess_content_type(&url).to_string());

        // CDN понял диапазон — отдаём кусок как есть
        if status == StatusCode::PARTIAL_CONTENT {
            let content_range = response.headers().get(header::CONTENT_RANGE).cloned();
            let body = match response.bytes().await {
                Ok(body) => body.to_vec(),
                Err(_) => return empty(StatusCode::BAD_GATEWAY),
            };
            let mut builder = Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_TYPE, content_type)
                .header(header::CACHE_CONTROL, CACHE_CONTROL)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CONTENT_LENGTH, body.len());
            if let Some(content_range) = content_range {
                builder = builder.header(header::CONTENT_RANGE, content_range);
            }
            return builder
                .body(body)
                .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR));
        }

        if status == StatusCode::RANGE_NOT_SATISFIABLE {
            return empty(StatusCode::RANGE_NOT_SATISFIABLE);
        }
        if !status.is_success() {
            return empty(status);
        }

        // файл целиком: CDN диапазоны не поддержал или их не просили
        let body = match response.bytes().await {
            Ok(body) => body.to_vec(),
            Err(_) => return empty(StatusCode::BAD_GATEWAY),
        };
        if body.len() > CACHE_ITEM_MAX {
            // крупный файл отдаём и забываем: вторая копия в памяти ни к чему
            return respond(&content_type, Body::Owned(body), range);
        }
        let entry = Arc::new(Entry { content_type, body });
        self.store.lock().await.insert(url, entry.clone());
        respond(&entry.content_type, Body::Shared(&entry.body), range)
    }
}

/// Тело ответа: из общего кэша (копируется) или своё (отдаётся без копии).
enum Body<'a> {
    Shared(&'a [u8]),
    Owned(Vec<u8>),
}

impl Body<'_> {
    fn bytes(&self) -> &[u8] {
        match self {
            Self::Shared(body) => body,
            Self::Owned(body) => body,
        }
    }

    fn into_vec(self) -> Vec<u8> {
        match self {
            Self::Shared(body) => body.to_vec(),
            Self::Owned(body) => body,
        }
    }
}

/// Ответ из файла, который есть целиком.
fn respond(content_type: &str, body: Body<'_>, range: Option<ByteRange>) -> Response<Vec<u8>> {
    let length = body.bytes().len() as u64;
    let builder = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, CACHE_CONTROL);

    let response = match range {
        None => builder
            .status(StatusCode::OK)
            .header(header::CONTENT_LENGTH, length)
            .body(body.into_vec()),
        Some(range) => match range.resolve(length) {
            Some((start, end)) => {
                let body = body.bytes()[start as usize..=end as usize].to_vec();
                builder
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{end}/{length}"),
                    )
                    .header(header::CONTENT_LENGTH, body.len())
                    .body(body)
            }
            None => builder
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                .body(Vec::new()),
        },
    };
    response.unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = status;
    response
}

/// Адрес файла из пути запроса: `/https%3A%2F%2F…` → `https://…`.
fn target_url(path: &str) -> Option<String> {
    let encoded = path.trim_start_matches('/');
    let url = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .ok()?
        .into_owned();
    // только https: прокси не должен ходить в локальную сеть по http
    url.starts_with("https://").then_some(url)
}

/// Имя файла, безопасное для любой ОС: без каталогов и запрещённых знаков.
pub fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if cleaned.is_empty() {
        "file".into()
    } else {
        cleaned.into()
    }
}

/// Свободное имя в каталоге: `кот.png`, `кот (1).png`, `кот (2).png`…
pub fn free_path(
    dir: &std::path::Path,
    name: &str,
    exists: impl Fn(&std::path::Path) -> bool,
) -> std::path::PathBuf {
    let candidate = dir.join(name);
    if !exists(&candidate) {
        return candidate;
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, Some(extension)),
        _ => (name, None),
    };
    (1..)
        .map(|index| match extension {
            Some(extension) => dir.join(format!("{stem} ({index}).{extension}")),
            None => dir.join(format!("{stem} ({index})")),
        })
        .find(|path| !exists(path))
        .unwrap_or(candidate)
}

impl MediaProxy {
    /// Скачать файл в каталог `dir`; вернуть путь, куда он сохранён.
    pub async fn download(
        &self,
        url: &str,
        name: &str,
        dir: std::path::PathBuf,
    ) -> Result<std::path::PathBuf, String> {
        if !url.starts_with("https://") {
            return Err("неподдерживаемый адрес файла".into());
        }
        let response = self
            .client
            .get(url)
            .header(header::ACCEPT, "*/*")
            .send()
            .await
            .map_err(|error| format!("не удалось скачать файл: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "файл недоступен: HTTP {}",
                response.status().as_u16()
            ));
        }
        let body = response
            .bytes()
            .await
            .map_err(|error| format!("файл не дочитан: {error}"))?;

        let name = safe_file_name(name);
        tauri::async_runtime::spawn_blocking(move || {
            std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
            let path = free_path(&dir, &name, |path| path.exists());
            std::fs::write(&path, &body).map_err(|error| error.to_string())?;
            Ok(path)
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

/// Тип содержимого по расширению: CDN не всегда его присылает.
pub fn guess_content_type(url: &str) -> &'static str {
    let path = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
    let types = [
        (".svg", "image/svg+xml"),
        (".png", "image/png"),
        (".webp", "image/webp"),
        (".gif", "image/gif"),
        (".jpg", "image/jpeg"),
        (".jpeg", "image/jpeg"),
        (".mp4", "video/mp4"),
        (".webm", "video/webm"),
        (".mp3", "audio/mpeg"),
        (".ogg", "audio/ogg"),
        (".wav", "audio/wav"),
    ];
    types
        .iter()
        .find(|(extension, _)| path.ends_with(extension))
        .map_or("application/octet-stream", |(_, kind)| kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_safe() {
        assert_eq!(safe_file_name("кот.png"), "кот.png");
        assert_eq!(safe_file_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_file_name("a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(safe_file_name("  ..  "), "file");
    }

    #[test]
    fn free_path_adds_counter() {
        let dir = std::path::Path::new("/tmp/x");
        let taken = [dir.join("кот.png"), dir.join("кот (1).png")];
        let exists = |path: &std::path::Path| taken.iter().any(|item| item == path);
        assert_eq!(free_path(dir, "кот.png", exists), dir.join("кот (2).png"));
        assert_eq!(free_path(dir, "пёс.png", exists), dir.join("пёс.png"));
        let only = [dir.join("README")];
        assert_eq!(
            free_path(dir, "README", |path| only.iter().any(|item| item == path)),
            dir.join("README (1)")
        );
        let hidden = [dir.join(".env")];
        assert_eq!(
            free_path(dir, ".env", |path| hidden.iter().any(|item| item == path)),
            dir.join(".env (1)")
        );
    }

    #[test]
    fn parses_ranges() {
        assert_eq!(
            ByteRange::parse("bytes=0-"),
            Some(ByteRange::From {
                start: 0,
                end: None
            })
        );
        assert_eq!(
            ByteRange::parse("bytes=10-20"),
            Some(ByteRange::From {
                start: 10,
                end: Some(20)
            })
        );
        assert_eq!(ByteRange::parse("bytes=-500"), Some(ByteRange::Suffix(500)));
        assert_eq!(ByteRange::parse("bytes=20-10"), None);
        assert_eq!(ByteRange::parse("items=0-1"), None);
    }

    #[test]
    fn open_range_is_capped() {
        let range = ByteRange::parse("bytes=0-").unwrap();
        assert_eq!(range.upstream_header(), format!("bytes=0-{}", CHUNK - 1));
        assert_eq!(range.resolve(10), Some((0, 9)));
        assert_eq!(range.resolve(CHUNK * 3), Some((0, CHUNK - 1)));
        assert_eq!(ByteRange::Suffix(4).resolve(10), Some((6, 9)));
        assert_eq!(
            ByteRange::From {
                start: 10,
                end: None
            }
            .resolve(10),
            None
        );
    }

    #[test]
    fn slices_cached_file() {
        let entry = Entry {
            content_type: "video/mp4".into(),
            body: (0u8..10).collect(),
        };
        let response = respond(
            &entry.content_type,
            Body::Shared(&entry.body),
            Some(ByteRange::From {
                start: 2,
                end: Some(4),
            }),
        );
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), &vec![2, 3, 4]);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-4/10");
        assert_eq!(response.headers()[header::CACHE_CONTROL], CACHE_CONTROL);
        let whole = respond("video/mp4", Body::Owned(entry.body.clone()), None);
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.body().len(), 10);
    }

    #[test]
    fn decodes_target() {
        assert_eq!(
            target_url("/https%3A%2F%2Fcdn.stoatusercontent.com%2Fattachments%2F01X").as_deref(),
            Some("https://cdn.stoatusercontent.com/attachments/01X")
        );
        assert_eq!(target_url("/http%3A%2F%2F127.0.0.1%2F"), None);
    }

    #[test]
    fn store_evicts_oldest() {
        let mut store = Store::default();
        let big = || {
            Arc::new(Entry {
                content_type: String::new(),
                body: vec![0; CACHE_ITEM_MAX],
            })
        };
        let count = CACHE_TOTAL_MAX / CACHE_ITEM_MAX + 2;
        for index in 0..count {
            store.insert(format!("u{index}"), big());
        }
        assert!(store.total <= CACHE_TOTAL_MAX);
        assert!(store.get("u0").is_none());
        assert!(store.get(&format!("u{}", count - 1)).is_some());
        // слишком крупный файл в кэш не попадает
        store.insert(
            "huge".into(),
            Arc::new(Entry {
                content_type: String::new(),
                body: vec![0; CACHE_ITEM_MAX + 1],
            }),
        );
        assert!(store.get("huge").is_none());
    }
}
