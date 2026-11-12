//! Наборы эмодзи без загрузки с сервера Stoat: встроенный Twemoji и
//! скачиваемые остальные.
//!
//! for-web рисует каждый стандартный эмодзи картинкой
//! `https://static.stoat.chat/emoji/<набор>/<кодовые точки>.svg?v=1`
//! (`unicodeEmojiUrl` в UnicodeEmoji.tsx). Каждая картинка — отдельный
//! запрос; пока она не пришла, на месте эмодзи пусто, а новый набор после
//! выбора в настройках скачивается заново. При медленной связи со
//! static.stoat.chat (в России Stoat заблокирован) эмодзи и смена набора
//! появляются с большой задержкой.
//!
//! Поэтому картинки отдаёт сам клиент: обработчик `WebResourceRequested`
//! WebView2 для `https://static.stoat.chat/emoji/<набор>/*` отвечает
//! картинкой из файла набора, если набор есть у клиента, а иначе сам берёт
//! её с сервера. Странице картинка уходит растром PNG, а не SVG: так цена
//! каждой задачи страницы не растёт с числом показанных эмодзи (подробно —
//! в `emoji_raster.rs`). Рисование идёт в фоновых потоках, ответ странице
//! откладывается (deferral WebView2) до готовой картинки; нарисованные
//! картинки остаются в памяти.
//!
//! * Twemoji — набор по умолчанию — встроен в exe (`emoji/twemoji.bin`).
//! * Fluent 3D, Fluent Color, Fluent Flat, Mutant Remix и Noto скачиваются в
//!   шторке выбора набора («Внешний вид» → «Emoji Pack», `emoji_packs.js`)
//!   одним файлом с GitHub (пре-релиз `emoji-packs-v1`, его собирает
//!   `.github/workflows/emoji-packs.yml` из тех же картинок static.stoat.chat)
//!   в папку `emoji/` каталога данных, там же удаляются. Размеры наборов — в
//!   `manifest.json` того же релиза.
//!
//! * Fluent Color и Fluent Flat в Windows 11 уже есть: это эмодзи системного
//!   шрифта Segoe UI Emoji (`system_emoji.rs`). Если они в нём есть, наборы
//!   не скачиваются — картинки рисуются из шрифта, а в шрифте нет только
//!   флагов. Скачанная раньше копия набора остаётся главнее шрифта, пока её
//!   не удалят.
//!
//! Формат файла описан в `emoji/pack.mjs`. Скачанный набор не читается в
//! память целиком: в памяти только оглавление, картинка читается с диска по
//! запросу.
//!
//! Скачивание (WinHTTP, `http.rs`) и подмена адресов есть только в Windows; в
//! Linux и macOS картинки идут с сервера.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{
    Arc, Mutex, MutexGuard, OnceLock, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::emoji_raster::{self, Cache, Image};
use crate::system_emoji::{self, SystemEmoji};
use crate::{CmdResult, CommandError, extensions};

/// Наборы for-web (`UNICODE_EMOJI_PACKS` в UnicodeEmoji.tsx).
pub const PACKS: [&str; 6] = [
    "fluent-3d",
    "fluent-color",
    "fluent-flat",
    "mutant",
    "noto",
    "twemoji",
];

/// Набор, встроенный в клиент.
const BUILTIN: &str = "twemoji";

/// Встроенный набор (формат описан в `emoji/pack.mjs`).
const BUILTIN_DATA: &[u8] = include_bytes!("../emoji/twemoji.bin");

/// Папка скачанных наборов в каталоге данных.
pub const DIR: &str = "emoji";

/// Релиз со скачиваемыми наборами; номер — версия формата файла.
const RELEASE: &str =
    "https://github.com/sssHpion007/Arachnid-Client-Stoat/releases/download/emoji-packs-v1";

/// Начало файла набора и версия формата.
const MAGIC: &[u8; 4] = b"AEMJ";
const FORMAT: u8 = 1;

/// Адреса картинок у for-web.
#[cfg_attr(not(windows), allow(dead_code))]
const PREFIX: &str = "https://static.stoat.chat/emoji/";

/// Селектор варианта эмодзи: формы с ним и без него — одна картинка.
const VARIATION_SELECTOR: &str = "fe0f";

/// Сколько байт нарисованных картинок держать в памяти. PNG эмодзи — от
/// 3 КБ (Twemoji, 96 px) до 60 КБ (Fluent 3D): это тысячи картинок.
const IMAGES_BUDGET: usize = 32 * 1024 * 1024;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn read<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(PoisonError::into_inner)
}

fn write<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(PoisonError::into_inner)
}

// ─────────────────────────────── файл набора ───────────────────────────────

/// Оглавление: ключи по возрастанию и место сжатой картинки в файле.
struct Index {
    keys: Vec<Box<str>>,
    /// Смещение от начала файла и длина
    spans: Vec<(u64, u64)>,
    /// Конец последней картинки — файл не может быть короче
    end: u64,
}

fn corrupt() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "не файл набора эмодзи")
}

fn read_u32(reader: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0u8; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_index(reader: &mut impl Read) -> io::Result<Index> {
    let mut head = [0u8; 5];
    reader.read_exact(&mut head)?;
    if head[..4] != MAGIC[..] || head[4] != FORMAT {
        return Err(corrupt());
    }
    let count = read_u32(reader)?;

    let mut keys = Vec::new();
    let mut entries = Vec::new();
    let mut header = 9u64;
    for _ in 0..count {
        let mut length = [0u8; 1];
        reader.read_exact(&mut length)?;
        let mut key = vec![0u8; usize::from(length[0])];
        reader.read_exact(&mut key)?;
        let key = String::from_utf8(key).map_err(|_| corrupt())?;
        let offset = u64::from(read_u32(reader)?);
        let size = u64::from(read_u32(reader)?);
        header += 1 + u64::from(length[0]) + 8;
        keys.push(key.into_boxed_str());
        entries.push((offset, size));
    }
    if !keys.is_sorted() {
        return Err(corrupt());
    }

    // смещения в файле — от начала данных, то есть после оглавления
    let spans: Vec<_> = entries
        .into_iter()
        .map(|(offset, size)| (header + offset, size))
        .collect();
    let end = spans
        .iter()
        .map(|(start, size)| start + size)
        .fold(header, u64::max);
    Ok(Index { keys, spans, end })
}

/// Где лежат картинки набора.
enum Data {
    Builtin(&'static [u8]),
    File(Mutex<File>),
}

struct Pack {
    index: Index,
    data: Data,
    /// Размер файла набора
    size: u64,
}

impl Pack {
    fn builtin() -> io::Result<Self> {
        let mut reader = BUILTIN_DATA;
        let index = read_index(&mut reader)?;
        let size = BUILTIN_DATA.len() as u64;
        if index.end > size {
            return Err(corrupt());
        }
        let data = Data::Builtin(BUILTIN_DATA);
        Ok(Self { index, data, size })
    }

    fn open(path: &Path) -> io::Result<Self> {
        let file = File::open(path)?;
        let size = file.metadata()?.len();
        let index = read_index(&mut BufReader::new(&file))?;
        if index.end > size {
            return Err(corrupt());
        }
        let data = Data::File(Mutex::new(file));
        Ok(Self { index, data, size })
    }

    fn len(&self) -> usize {
        self.index.keys.len()
    }

    /// SVG эмодзи по кодовым точкам из адреса.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn svg(&self, stem: &str) -> Option<Vec<u8>> {
        let key = key_of(stem);
        let keys = &self.index.keys;
        let found = keys.binary_search_by(|entry| (**entry).cmp(key.as_str()));
        let position = found.ok()?;
        let (start, size) = self.index.spans[position];
        let compressed = self.read(start, size)?;
        let mut image = Vec::new();
        brotli_decompressor::Decompressor::new(compressed.as_ref(), 4096)
            .read_to_end(&mut image)
            .ok()?;
        Some(image)
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    fn read(&self, start: u64, size: u64) -> Option<Cow<'_, [u8]>> {
        let length = usize::try_from(size).ok()?;
        match &self.data {
            Data::Builtin(bytes) => {
                let start = usize::try_from(start).ok()?;
                let end = start.checked_add(length)?;
                bytes.get(start..end).map(Cow::Borrowed)
            }
            Data::File(file) => {
                let mut file = lock(file);
                file.seek(SeekFrom::Start(start)).ok()?;
                let mut buffer = vec![0u8; length];
                file.read_exact(&mut buffer).ok()?;
                Some(Cow::Owned(buffer))
            }
        }
    }
}

/// Ключ картинки: кодовые точки без селектора варианта.
#[cfg_attr(not(windows), allow(dead_code))]
fn key_of(stem: &str) -> String {
    stem.split('-')
        .filter(|part| *part != VARIATION_SELECTOR)
        .collect::<Vec<_>>()
        .join("-")
}

/// Ключ нарисованной картинки в памяти.
#[cfg_attr(not(windows), allow(dead_code))]
fn image_key(pack: &str, stem: &str, side: u32) -> String {
    format!("{pack}/{stem}@{side}")
}

/// Картинка с сервера (набора нет у клиента или в нём нет этого эмодзи,
/// как флагов в системном шрифте) — тоже растром.
#[cfg(windows)]
fn from_network(uri: &str, side: u32) -> Result<Image, Unavailable> {
    use crate::http::{Error, StopReason};

    /// Картинки наборов меньше (самые крупные — Fluent 3D, ~100 КБ).
    const LIMIT: usize = 4 * 1024 * 1024;

    let url = url::Url::parse(uri).map_err(|_| Unavailable::Failed)?;
    let mut body = Vec::new();
    let on_data = |chunk: &[u8]| {
        if body.len() + chunk.len() > LIMIT {
            return Err(StopReason::TooLarge);
        }
        body.extend_from_slice(chunk);
        Ok(())
    };
    match crate::http::get(&url, |_| {}, on_data) {
        Ok(()) => {}
        Err(Error::Status(404)) => return Err(Unavailable::Missing),
        Err(error) => {
            tracing::debug!(?error, uri, "картинка эмодзи с сервера не получена");
            return Err(Unavailable::Failed);
        }
    }
    let Some(png) = emoji_raster::from_svg(&body, side) else {
        return Err(Unavailable::Failed);
    };
    Ok(Image::new(png, "network"))
}

#[cfg(not(windows))]
#[allow(dead_code)]
fn from_network(_uri: &str, _side: u32) -> Result<Image, Unavailable> {
    Err(Unavailable::Failed)
}

/// Набор и кодовые точки из адреса картинки for-web; только наборы for-web.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_address(uri: &str) -> Option<(&'static str, String)> {
    let (pack, file) = uri.strip_prefix(PREFIX)?.split_once('/')?;
    let pack = PACKS.into_iter().find(|id| *id == pack)?;
    let file = file.split(['?', '#']).next()?;
    let stem = file.strip_suffix(".svg")?;
    let hex = |byte: u8| byte.is_ascii_hexdigit() || byte == b'-';
    let valid = !stem.is_empty() && stem.bytes().all(hex);
    valid.then(|| (pack, stem.to_ascii_lowercase()))
}

// ─────────────────────────────── состояние ───────────────────────────────

/// Почему набор не скачан — странице, которая пишет это словами.
#[derive(Clone, Debug, Serialize)]
pub struct Failure {
    /// network, status, missing, corrupt, io, unsupported, cancelled
    kind: &'static str,
    /// Код ошибки Windows или HTTP
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<u32>,
    /// Текст ошибки файловой системы
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl Failure {
    fn new(kind: &'static str) -> Self {
        Self {
            kind,
            code: None,
            message: None,
        }
    }

    fn io(error: io::Error) -> Self {
        Self {
            message: Some(error.to_string()),
            ..Self::new("io")
        }
    }

    fn cancelled(&self) -> bool {
        self.kind == "cancelled"
    }
}

#[cfg(windows)]
impl From<crate::http::Error> for Failure {
    fn from(error: crate::http::Error) -> Self {
        use crate::http::{Error, StopReason};
        match error {
            Error::Network(code) => Self {
                code: Some(code),
                ..Self::new("network")
            },
            Error::Status(404) => Self::new("missing"),
            Error::Status(code) => Self {
                code: Some(code),
                ..Self::new("status")
            },
            Error::Url => Self::new("network"),
            Error::Stopped(StopReason::Cancelled) => Self::new("cancelled"),
            Error::Stopped(StopReason::TooLarge) => Self::new("corrupt"),
            Error::Stopped(StopReason::Io(error)) => Self::io(error),
        }
    }
}

/// manifest.json релиза.
#[derive(Deserialize)]
struct Manifest {
    packs: HashMap<String, RemotePack>,
}

#[derive(Deserialize)]
struct RemotePack {
    size: u64,
}

/// Что известно о manifest.json.
#[derive(Clone, Default)]
enum Remote {
    #[default]
    Unknown,
    Loading,
    Ready(Arc<Manifest>),
    Failed(Failure),
}

/// Идущее скачивание.
struct Job {
    received: u64,
    total: Option<u64>,
    cancel: Arc<AtomicBool>,
}

/// Скачанные наборы по названию.
type Installed = HashMap<&'static str, Arc<Pack>>;

/// Наборы клиента: встроенный, скачанные, скачиваемые сейчас и системные.
pub struct EmojiPacks {
    dir: PathBuf,
    builtin: OnceLock<Option<Arc<Pack>>>,
    /// Шрифт эмодзи Windows; читается, когда о нём спросят впервые
    system: OnceLock<Option<SystemEmoji>>,
    installed: RwLock<Installed>,
    jobs: Mutex<HashMap<&'static str, Job>>,
    failures: Mutex<HashMap<&'static str, Failure>>,
    manifest: Mutex<Remote>,
    /// Нарисованные картинки по набору, кодовым точкам и стороне
    images: Mutex<Cache>,
}

/// Почему картинки нет.
#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(not(windows), allow(dead_code))]
enum Unavailable {
    /// Такого эмодзи в наборе нет (у сервера тоже) — 404
    Missing,
    /// Сеть или сервер не ответили, картинка не рисуется — 502
    Failed,
}

/// Состояние для страницы настроек.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// Наборы можно скачивать (Windows)
    supported: bool,
    /// Размеры наборов на сервере: unknown, loading, ready, failed
    sizes: &'static str,
    sizes_error: Option<Failure>,
    packs: Vec<PackState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PackState {
    id: &'static str,
    builtin: bool,
    /// Набор есть в Windows: скачивать не нужно
    system: bool,
    installed: bool,
    /// Размер файла: скачанного или на сервере
    size: Option<u64>,
    /// Сколько эмодзи в скачанном наборе
    count: Option<usize>,
    download: Option<Progress>,
    error: Option<Failure>,
}

#[derive(Serialize)]
struct Progress {
    received: u64,
    total: Option<u64>,
}

impl EmojiPacks {
    /// Наборы из папки `dir` (её создаёт первое скачивание).
    pub fn new(dir: PathBuf) -> Self {
        let mut installed = HashMap::new();
        for id in downloadable() {
            // недокачанный файл от прошлого запуска
            let _ = std::fs::remove_file(part_path(&dir, id));
            let path = file_path(&dir, id);
            if !path.exists() {
                continue;
            }
            match Pack::open(&path) {
                Ok(pack) => {
                    installed.insert(id, Arc::new(pack));
                }
                Err(error) => {
                    tracing::warn!(%error, pack = id, "скачанный набор эмодзи не читается");
                }
            }
        }
        Self {
            dir,
            builtin: OnceLock::new(),
            system: OnceLock::new(),
            installed: RwLock::new(installed),
            jobs: Mutex::default(),
            failures: Mutex::default(),
            manifest: Mutex::default(),
            images: Mutex::new(Cache::new(IMAGES_BUDGET)),
        }
    }

    fn pack(&self, id: &str) -> Option<Arc<Pack>> {
        if id == BUILTIN {
            let builtin = self.builtin.get_or_init(|| match Pack::builtin() {
                Ok(pack) => Some(Arc::new(pack)),
                Err(error) => {
                    tracing::warn!(%error, "встроенный набор Twemoji повреждён");
                    None
                }
            });
            return builtin.clone();
        }
        read(&self.installed).get(id).cloned()
    }

    fn system(&self) -> Option<&SystemEmoji> {
        self.system.get_or_init(SystemEmoji::load).as_ref()
    }

    /// Набор есть в Windows (шрифт читается только для таких наборов).
    fn in_system(&self, id: &str) -> bool {
        system_emoji::covers(id) && self.system().is_some_and(|system| system.provides(id))
    }

    /// Уже нарисованная картинка (из памяти, без рисования).
    #[cfg_attr(not(windows), allow(dead_code))]
    fn cached(&self, pack: &str, stem: &str, side: u32) -> Option<Image> {
        lock(&self.images).get(&image_key(pack, stem, side))
    }

    /// Картинка эмодзи стороной `side` пикселей из памяти или набора клиента
    /// (нарисованная остаётся в памяти); None — у клиента её нет, она
    /// берётся с сервера (`from_server`). Вызывается вне главного потока.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn drawn(&self, pack: &str, stem: &str, side: u32) -> Option<Image> {
        let key = image_key(pack, stem, side);
        if let Some(image) = lock(&self.images).get(&key) {
            return Some(image);
        }
        let image = self.local(pack, stem, side)?;
        lock(&self.images).insert(key, image.clone());
        Some(image)
    }

    /// Картинка с сервера по адресу `uri`, о котором спросила страница;
    /// тоже остаётся в памяти. Вызывается вне главного потока.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn from_server(
        &self,
        pack: &str,
        stem: &str,
        uri: &str,
        side: u32,
    ) -> Result<Image, Unavailable> {
        let image = from_network(uri, side)?;
        lock(&self.images).insert(image_key(pack, stem, side), image.clone());
        Ok(image)
    }

    /// Картинка из набора клиента: `builtin`, `downloaded` или `system`.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn local(&self, pack: &str, stem: &str, side: u32) -> Option<Image> {
        let svg = self.pack(pack).and_then(|local| local.svg(stem));
        if let Some(png) = svg.and_then(|svg| emoji_raster::from_svg(&svg, side)) {
            let source = if pack == BUILTIN {
                "builtin"
            } else {
                "downloaded"
            };
            return Some(Image::new(png, source));
        }
        if !self.in_system(pack) {
            return None;
        }
        let png = self.system()?.png(pack, stem, side)?;
        Some(Image::new(png, "system"))
    }

    /// Забыть нарисованные картинки набора: он появился или удалён.
    fn forget_images(&self, id: &str) {
        lock(&self.images).forget(&format!("{id}/"));
    }

    fn overview(&self) -> Overview {
        let remote = lock(&self.manifest).clone();
        let manifest = match &remote {
            Remote::Ready(manifest) => Some(Arc::clone(manifest)),
            _ => None,
        };
        let remote_size = |id: &str| Some(manifest.as_ref()?.packs.get(id)?.size);

        let installed = read(&self.installed);
        let jobs = lock(&self.jobs);
        let failures = lock(&self.failures);
        let packs = PACKS
            .iter()
            .map(|&id| {
                let builtin = id == BUILTIN;
                let local = installed.get(id);
                let size = match local {
                    Some(pack) => Some(pack.size),
                    None if builtin => None,
                    None => remote_size(id),
                };
                PackState {
                    id,
                    builtin,
                    system: self.in_system(id),
                    installed: builtin || local.is_some(),
                    size,
                    count: local.map(|pack| pack.len()),
                    download: jobs.get(id).map(|job| Progress {
                        received: job.received,
                        total: job.total,
                    }),
                    error: failures.get(id).cloned(),
                }
            })
            .collect();

        let (sizes, sizes_error) = match remote {
            Remote::Unknown => ("unknown", None),
            Remote::Loading => ("loading", None),
            Remote::Ready(_) => ("ready", None),
            Remote::Failed(failure) => ("failed", Some(failure)),
        };
        Overview {
            supported: cfg!(windows),
            sizes,
            sizes_error,
            packs,
        }
    }

    /// Узнать размеры наборов, когда страница спрашивает о них впервые.
    fn load_manifest_once(self: &Arc<Self>, app: &AppHandle) {
        {
            let mut remote = lock(&self.manifest);
            if !matches!(*remote, Remote::Unknown) || !cfg!(windows) {
                return;
            }
            *remote = Remote::Loading;
        }
        let packs = Arc::clone(self);
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("emoji-manifest".into())
            .spawn(move || {
                let _ = packs.manifest();
                notify(&app);
            });
        if let Err(error) = spawned {
            *lock(&self.manifest) = Remote::Failed(Failure::io(error));
        }
    }

    /// manifest.json: из памяти или с сервера (вызывается вне главного потока).
    fn manifest(&self) -> Result<Arc<Manifest>, Failure> {
        if let Remote::Ready(manifest) = &*lock(&self.manifest) {
            return Ok(Arc::clone(manifest));
        }
        let result = fetch_manifest().map(Arc::new);
        *lock(&self.manifest) = match &result {
            Ok(manifest) => Remote::Ready(Arc::clone(manifest)),
            Err(failure) => Remote::Failed(failure.clone()),
        };
        result
    }

    /// Начать скачивание набора в отдельном потоке.
    fn start(self: &Arc<Self>, app: &AppHandle, id: &'static str) {
        if read(&self.installed).contains_key(id) || self.in_system(id) {
            return;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut jobs = lock(&self.jobs);
            if jobs.contains_key(id) {
                return;
            }
            let job = Job {
                received: 0,
                total: None,
                cancel: Arc::clone(&cancel),
            };
            jobs.insert(id, job);
        }
        lock(&self.failures).remove(id);

        let packs = Arc::clone(self);
        let thread_app = app.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("emoji-{id}"))
            .spawn(move || {
                let result = packs.download(&thread_app, id, &cancel);
                lock(&packs.jobs).remove(id);
                match result {
                    Ok(()) => tracing::info!(pack = id, "набор эмодзи скачан"),
                    Err(failure) if failure.cancelled() => {}
                    Err(failure) => {
                        tracing::warn!(?failure, pack = id, "набор эмодзи не скачан");
                        lock(&packs.failures).insert(id, failure);
                    }
                }
                notify(&thread_app);
            });
        if let Err(error) = spawned {
            lock(&self.jobs).remove(id);
            lock(&self.failures).insert(id, Failure::io(error));
        }
    }

    fn download(
        &self,
        app: &AppHandle,
        id: &'static str,
        cancel: &AtomicBool,
    ) -> Result<(), Failure> {
        let manifest = self.manifest()?;
        let Some(remote) = manifest.packs.get(id) else {
            return Err(Failure::new("missing"));
        };
        let total = remote.size;
        std::fs::create_dir_all(&self.dir).map_err(Failure::io)?;
        let part = part_path(&self.dir, id);
        let result = self
            .fetch(app, id, total, &part, cancel)
            .and_then(|()| self.install(id, &part, cancel));
        if result.is_err() {
            let _ = std::fs::remove_file(&part);
        }
        result
    }

    /// Обновить ход скачивания.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn progress(&self, id: &str, received: u64, total: u64) {
        if let Some(job) = lock(&self.jobs).get_mut(id) {
            job.received = received;
            job.total = Some(total);
        }
    }

    #[cfg(windows)]
    fn fetch(
        &self,
        app: &AppHandle,
        id: &str,
        total: u64,
        part: &Path,
        cancel: &AtomicBool,
    ) -> Result<(), Failure> {
        use std::io::Write;
        use std::time::{Duration, Instant};

        use crate::http::StopReason;

        /// Как часто обновлять полосу загрузки на странице.
        const INTERVAL: Duration = Duration::from_millis(150);

        let address = format!("{RELEASE}/{id}.bin");
        let url = url::Url::parse(&address).map_err(|_| Failure::new("network"))?;
        let mut file = io::BufWriter::new(File::create(part).map_err(Failure::io)?);
        let mut received = 0u64;
        let mut reported = Instant::now();
        self.progress(id, 0, total);
        notify(app);

        let on_data = |chunk: &[u8]| {
            if cancel.load(Ordering::Relaxed) {
                return Err(StopReason::Cancelled);
            }
            received += chunk.len() as u64;
            if received > total {
                return Err(StopReason::TooLarge);
            }
            file.write_all(chunk).map_err(StopReason::Io)?;
            if reported.elapsed() >= INTERVAL {
                reported = Instant::now();
                self.progress(id, received, total);
                notify(app);
            }
            Ok(())
        };
        crate::http::get(&url, |_| {}, on_data)?;

        file.flush().map_err(Failure::io)?;
        file.get_ref().sync_all().map_err(Failure::io)?;
        if received != total {
            return Err(Failure::new("corrupt"));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    fn fetch(
        &self,
        _app: &AppHandle,
        _id: &str,
        _total: u64,
        _part: &Path,
        _cancel: &AtomicBool,
    ) -> Result<(), Failure> {
        Err(Failure::new("unsupported"))
    }

    /// Проверить скачанный файл и подключить набор.
    fn install(&self, id: &'static str, part: &Path, cancel: &AtomicBool) -> Result<(), Failure> {
        drop(Pack::open(part).map_err(|_| Failure::new("corrupt"))?);
        if cancel.load(Ordering::Relaxed) {
            return Err(Failure::new("cancelled"));
        }
        let path = file_path(&self.dir, id);
        std::fs::rename(part, &path).map_err(Failure::io)?;
        let pack = Pack::open(&path).map_err(Failure::io)?;
        write(&self.installed).insert(id, Arc::new(pack));
        self.forget_images(id);
        Ok(())
    }

    fn cancel(&self, id: &str) {
        if let Some(job) = lock(&self.jobs).get(id) {
            job.cancel.store(true, Ordering::Relaxed);
        }
    }

    /// Удалить скачанный набор (и остановить его скачивание).
    fn delete(&self, id: &'static str) -> io::Result<()> {
        self.cancel(id);
        lock(&self.failures).remove(id);
        // файл открыт с FILE_SHARE_DELETE: удаляется, даже если картинку
        // из него сейчас читают
        write(&self.installed).remove(id);
        self.forget_images(id);
        match std::fs::remove_file(file_path(&self.dir, id)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
}

/// Наборы, которые скачиваются.
fn downloadable() -> impl Iterator<Item = &'static str> {
    PACKS.into_iter().filter(|id| *id != BUILTIN)
}

fn file_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.bin"))
}

fn part_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.bin.part"))
}

#[cfg(windows)]
fn fetch_manifest() -> Result<Manifest, Failure> {
    use crate::http::StopReason;

    /// manifest.json маленький; больше — не он.
    const LIMIT: usize = 64 * 1024;

    let address = format!("{RELEASE}/manifest.json");
    let url = url::Url::parse(&address).map_err(|_| Failure::new("network"))?;
    let mut body = Vec::new();
    let on_data = |chunk: &[u8]| {
        if body.len() + chunk.len() > LIMIT {
            return Err(StopReason::TooLarge);
        }
        body.extend_from_slice(chunk);
        Ok(())
    };
    crate::http::get(&url, |_| {}, on_data)?;
    serde_json::from_slice(&body).map_err(|_| Failure::new("corrupt"))
}

#[cfg(not(windows))]
fn fetch_manifest() -> Result<Manifest, Failure> {
    Err(Failure::new("unsupported"))
}

/// Сообщить настройкам веб-клиента, что состояние наборов изменилось.
fn notify(app: &AppHandle) {
    extensions::call_page(app, "emojiPacksChanged()");
}

fn known(id: &str) -> CmdResult<&'static str> {
    downloadable()
        .find(|pack| *pack == id)
        .ok_or_else(|| CommandError::new("emoji", format!("нет скачиваемого набора «{id}»")))
}

// ─────────────────────────────── команды ───────────────────────────────

/// Наборы эмодзи для шторки выбора набора (`emoji_packs.js`).
#[tauri::command]
pub fn emoji_packs(app: AppHandle, packs: State<'_, Arc<EmojiPacks>>) -> Overview {
    packs.load_manifest_once(&app);
    packs.overview()
}

/// Скачать набор; ход скачивания приходит событием `emojiPacksChanged`.
#[tauri::command]
pub fn emoji_pack_download(
    app: AppHandle,
    packs: State<'_, Arc<EmojiPacks>>,
    id: String,
) -> CmdResult<Overview> {
    let id = known(&id)?;
    if !cfg!(windows) {
        return Err(CommandError::new(
            "emoji",
            "скачивание наборов есть только в Windows",
        ));
    }
    packs.start(&app, id);
    Ok(packs.overview())
}

/// Остановить скачивание набора.
#[tauri::command]
pub fn emoji_pack_cancel(packs: State<'_, Arc<EmojiPacks>>, id: String) -> CmdResult<Overview> {
    packs.cancel(known(&id)?);
    Ok(packs.overview())
}

/// Удалить скачанный набор.
#[tauri::command]
pub fn emoji_pack_delete(packs: State<'_, Arc<EmojiPacks>>, id: String) -> CmdResult<Overview> {
    let id = known(&id)?;
    packs
        .delete(id)
        .map_err(|error| CommandError::new("io", error.to_string()))?;
    Ok(packs.overview())
}

// ─────────────────────────────── WebView2 ───────────────────────────────

#[cfg(windows)]
mod platform {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    use tauri::webview::PlatformWebview;
    use tauri::{AppHandle, Manager, WebviewWindow};
    use webview2_com::Microsoft::Web::WebView2::Win32 as wv;
    use webview2_com::{WebResourceRequestedEventHandler, take_pwstr};
    use windows::Win32::System::Com::IStream;
    use windows::Win32::UI::Shell::SHCreateMemStream;
    use windows_core::{HSTRING, Interface, PCWSTR, PWSTR, w};

    use super::{EmojiPacks, PREFIX, Unavailable, parse_address};
    use crate::emoji_raster::{self, Image, Workers};

    /// Запрос, ответ на который ждёт картинку из фонового потока.
    struct Pending {
        args: wv::ICoreWebView2WebResourceRequestedEventArgs,
        deferral: wv::ICoreWebView2Deferral,
        env: wv::ICoreWebView2Environment,
    }

    thread_local! {
        /// Ждущие запросы; объекты WebView2 живут только в главном потоке
        static PENDING: RefCell<HashMap<u64, Pending>> = RefCell::new(HashMap::new());
    }

    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    /// Сколько картинок брать с сервера одновременно: столько же соединений
    /// с одним сервером открывает Chromium.
    const NETWORK_THREADS: usize = 6;

    /// Чем отвечать на запросы картинок окна.
    struct Delivery {
        packs: Arc<EmojiPacks>,
        app: AppHandle,
        /// Рисование картинок наборов клиента
        drawing: Workers,
        /// Картинки с сервера: ожидание сети не держит рисование
        network: Arc<Workers>,
        /// Сторона картинки в пикселях
        side: u32,
    }

    /// Картинки неизменны (адрес с версией `?v=1`), как и у static.stoat.chat.
    /// `Server-Timing` говорит, что картинку отдал клиент (видно в DevTools и
    /// в `PerformanceResourceTiming.serverTiming`).
    fn headers(source: &str) -> HSTRING {
        HSTRING::from(format!(
            "Content-Type: image/png\r\n\
             Cache-Control: public, max-age=31536000, immutable\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Access-Control-Expose-Headers: Server-Timing\r\n\
             Timing-Allow-Origin: *\r\n\
             Server-Timing: arachnid;desc=\"{source}\""
        ))
    }

    pub fn serve(window: &WebviewWindow, packs: Arc<EmojiPacks>) {
        let delivery = Delivery {
            packs,
            app: window.app_handle().clone(),
            drawing: Workers::for_drawing("emoji-image"),
            network: Arc::new(Workers::new("emoji-network", NETWORK_THREADS)),
            side: side(window),
        };
        tracing::info!(side = delivery.side, "картинки эмодзи: PNG");
        let result = window.with_webview(move |webview| {
            if let Err(error) = setup(&webview, delivery) {
                tracing::warn!(%error, "наборы эмодзи клиента не подключены");
            }
        });
        if let Err(error) = result {
            tracing::warn!(%error, "webview недоступен, наборы эмодзи не подключены");
        }
    }

    /// Сторона картинки — под самый крупный масштаб среди экранов: окно
    /// можно перенести на любой из них.
    fn side(window: &WebviewWindow) -> u32 {
        let current = window.scale_factor().unwrap_or(1.0);
        let monitors = window.available_monitors().unwrap_or_default();
        let scale = monitors
            .iter()
            .map(|monitor| monitor.scale_factor())
            .fold(current, f64::max);
        emoji_raster::side(scale)
    }

    fn setup(webview: &PlatformWebview, delivery: Delivery) -> windows_core::Result<()> {
        let env = webview.environment();
        // SAFETY: with_webview вызывает нас в главном потоке, контроллер жив,
        // пока существует окно
        let core = unsafe { webview.controller().CoreWebView2() }?;
        add_filter(&core)?;

        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                respond(&delivery, &env, &args)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: обработчик живёт, пока его держит WebView2
        unsafe { core.add_WebResourceRequested(&handler, &mut token) }
    }

    /// Фильтр адресов картинок. С `ICoreWebView2_22` он видит и запросы
    /// service worker (у for-web он есть).
    fn add_filter(core: &wv::ICoreWebView2) -> windows_core::Result<()> {
        let filter = HSTRING::from(format!("{PREFIX}*"));
        let context = wv::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
        let sources = wv::COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL;
        let Ok(newer) = core.cast::<wv::ICoreWebView2_22>() else {
            // SAFETY: COM-вызов в главном потоке
            return unsafe { core.AddWebResourceRequestedFilter(&filter, context) };
        };
        // SAFETY: COM-вызов в главном потоке
        unsafe {
            newer.AddWebResourceRequestedFilterWithRequestSourceKinds(&filter, context, sources)
        }
    }

    /// Ответить картинкой: сразу, если она уже нарисована, иначе — когда её
    /// нарисует фоновый поток. Адреса не наборов for-web идут в сеть как
    /// обычно.
    fn respond(
        delivery: &Delivery,
        env: &wv::ICoreWebView2Environment,
        args: &wv::ICoreWebView2WebResourceRequestedEventArgs,
    ) -> windows_core::Result<()> {
        let mut uri = PWSTR::null();
        // SAFETY: аргументы события действительны во время обработчика,
        // строку Uri освобождает take_pwstr
        unsafe { args.Request()?.Uri(&mut uri)? };
        let uri = take_pwstr(uri);
        let Some((pack, stem)) = parse_address(&uri) else {
            return Ok(());
        };
        let side = delivery.side;
        if let Some(image) = delivery.packs.cached(pack, &stem, side) {
            let response = image_response(env, &image)?;
            // SAFETY: ответ передаётся WebView2 во время обработчика
            return unsafe { args.SetResponse(&response) };
        }

        // SAFETY: COM-вызов в главном потоке; deferral держит запрос, пока
        // не вызван Complete
        let deferral = unsafe { args.GetDeferral() }?;
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let pending = Pending {
            args: args.clone(),
            deferral,
            env: env.clone(),
        };
        PENDING.with_borrow_mut(|map| map.insert(id, pending));

        let packs = Arc::clone(&delivery.packs);
        let app = delivery.app.clone();
        let network = Arc::clone(&delivery.network);
        delivery.drawing.run(move || {
            let drawn = catch_unwind(AssertUnwindSafe(|| packs.drawn(pack, &stem, side)));
            match drawn {
                Ok(Some(image)) => answer(&app, id, Ok(image)),
                Ok(None) => network.run(move || {
                    let server = || packs.from_server(pack, &stem, &uri, side);
                    let fetched = catch_unwind(AssertUnwindSafe(server));
                    answer(&app, id, fetched.unwrap_or(Err(Unavailable::Failed)));
                }),
                Err(_) => answer(&app, id, Err(Unavailable::Failed)),
            }
        });
        Ok(())
    }

    /// Передать готовый ответ в главный поток.
    fn answer(app: &AppHandle, id: u64, result: Result<Image, Unavailable>) {
        let posted = app.run_on_main_thread(move || complete(id, result));
        if let Err(error) = posted {
            tracing::debug!(%error, "ответ с картинкой эмодзи не передан окну");
        }
    }

    /// Ответить на отложенный запрос (главный поток).
    fn complete(id: u64, result: Result<Image, Unavailable>) {
        let Some(pending) = PENDING.with_borrow_mut(|map| map.remove(&id)) else {
            return;
        };
        let response = match &result {
            Ok(image) => image_response(&pending.env, image),
            Err(reason) => error_response(&pending.env, *reason),
        };
        let answered = response.and_then(|response| {
            // SAFETY: аргументы события живы, пока не вызван Complete
            unsafe { pending.args.SetResponse(&response) }
        });
        if let Err(error) = &answered {
            tracing::debug!(%error, "ответ с картинкой эмодзи не принят");
        }
        // SAFETY: Complete вызывается один раз, в главном потоке
        if let Err(error) = unsafe { pending.deferral.Complete() } {
            tracing::debug!(%error, "запрос картинки эмодзи не завершён");
        }
    }

    fn image_response(
        env: &wv::ICoreWebView2Environment,
        image: &Image,
    ) -> windows_core::Result<wv::ICoreWebView2WebResourceResponse> {
        let headers = headers(image.source);
        // SAFETY: поток создаётся из копии данных
        unsafe {
            let stream = SHCreateMemStream(Some(&image.png[..]));
            env.CreateWebResourceResponse(stream.as_ref(), 200, w!("OK"), &headers)
        }
    }

    /// Картинки нет: 404, если её нет и на сервере, иначе 502. Не кэшируется
    /// — следующий запрос попробует снова.
    fn error_response(
        env: &wv::ICoreWebView2Environment,
        reason: Unavailable,
    ) -> windows_core::Result<wv::ICoreWebView2WebResourceResponse> {
        let (status, phrase): (i32, PCWSTR) = match reason {
            Unavailable::Missing => (404, w!("Not Found")),
            Unavailable::Failed => (502, w!("Bad Gateway")),
        };
        let headers = w!("Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *");
        // SAFETY: COM-вызов в главном потоке, тела у ответа нет
        unsafe { env.CreateWebResourceResponse(None::<&IStream>, status, phrase, headers) }
    }
}

/// Отдавать картинки наборов клиента вместо static.stoat.chat.
#[cfg(windows)]
pub fn serve(window: &tauri::WebviewWindow, packs: Arc<EmojiPacks>) {
    platform::serve(window, packs);
}

/// В Linux и macOS картинки идут с сервера.
#[cfg(not(windows))]
pub fn serve(_window: &tauri::WebviewWindow, _packs: Arc<EmojiPacks>) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Пустая временная папка для наборов.
    fn temp_dir(name: &str) -> PathBuf {
        let process = std::process::id();
        let dir = std::env::temp_dir().join(format!("arachnid-emoji-{name}-{process}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Адрес картинки набора `pack`, как его строит for-web.
    fn address(pack: &str, file: &str) -> String {
        format!("https://static.stoat.chat/emoji/{pack}/{file}")
    }

    fn put(dir: &Path, name: &str, data: &[u8]) {
        std::fs::write(dir.join(name), data).unwrap();
    }

    fn state<'a>(overview: &'a Overview, id: &str) -> &'a PackState {
        overview.packs.iter().find(|pack| pack.id == id).unwrap()
    }

    /// Сторона картинок в проверках.
    const SIDE: u32 = 48;

    fn is_png(image: &Image) -> bool {
        image.png.starts_with(b"\x89PNG")
    }

    /// Картинка набора клиента: PNG и кто её отдал.
    fn local(packs: &EmojiPacks, pack: &str, stem: &str) -> Option<(Vec<u8>, &'static str)> {
        let image = packs.local(pack, stem, SIDE)?;
        assert!(is_png(&image), "{pack}/{stem}");
        Some((image.png.to_vec(), image.source))
    }

    #[test]
    fn builtin_pack_has_every_twemoji() {
        let pack = Pack::builtin().unwrap();
        assert_eq!(pack.len(), 4009);
        assert!(pack.index.end <= pack.size);
    }

    #[test]
    fn web_client_addresses_are_found() {
        let packs = EmojiPacks::new(temp_dir("lookup"));
        let uri = address("twemoji", "1f600.svg?v=1");
        let (pack, stem) = parse_address(&uri).unwrap();
        assert_eq!((pack, stem.as_str()), ("twemoji", "1f600"));
        let (_, source) = local(&packs, pack, &stem).unwrap();
        assert_eq!(source, "builtin");

        let svg = |stem: &str| local(&packs, "twemoji", stem).map(|(image, _)| image);
        // ❤️ for-web запрашивает с fe0f, у Twemoji файл без него — та же картинка
        assert_eq!(svg("2764-fe0f"), svg("2764"));
        assert!(svg("2764").is_some());
        // ZWJ-последовательность с fe0f внутри: 🏳️‍🌈
        assert!(svg("1f3f3-200d-1f308").is_some());
        assert_eq!(svg("1f3f3-fe0f-200d-1f308"), svg("1f3f3-200d-1f308"));
        // #️⃣ и флаг Уэльса (теги)
        assert!(svg("23-fe0f-20e3").is_some());
        assert!(svg("1f3f4-e0067-e0062-e0077-e006c-e0073-e007f").is_some());
        assert_eq!(svg("ffffff"), None);
    }

    #[test]
    fn other_addresses_are_not_parsed() {
        assert_eq!(parse_address(&address("twemoji", "../x.svg")), None);
        assert_eq!(parse_address(&address("twemoji", ".svg")), None);
        assert_eq!(parse_address(&address("twemoji", "1f600.png")), None);
        let foreign = "https://example.com/emoji/twemoji/1f600.svg";
        assert_eq!(parse_address(foreign), None);
        let uri = address("fluent-3d", "1f600.svg?v=1");
        assert_eq!(parse_address(&uri).map(|(pack, _)| pack), Some("fluent-3d"));
        // не набор for-web — не наше
        assert_eq!(parse_address(&address("other", "1f600.svg")), None);
    }

    #[test]
    fn missing_pack_goes_to_network() {
        let packs = EmojiPacks::new(temp_dir("missing"));
        assert_eq!(local(&packs, "noto", "1f600"), None);
        assert_eq!(local(&packs, "unknown", "1f600"), None);
    }

    #[test]
    fn drawn_images_are_kept() {
        let packs = EmojiPacks::new(temp_dir("kept"));
        assert!(packs.cached("twemoji", "1f600", SIDE).is_none());
        let image = packs.drawn("twemoji", "1f600", SIDE).unwrap();
        assert!(is_png(&image) && image.source == "builtin");
        let pixmap = resvg::tiny_skia::Pixmap::decode_png(&image.png).unwrap();
        assert_eq!((pixmap.width(), pixmap.height()), (SIDE, SIDE));
        let kept = packs.cached("twemoji", "1f600", SIDE).unwrap();
        assert!(Arc::ptr_eq(&kept.png, &image.png));
        // другая сторона — другая картинка
        assert!(packs.cached("twemoji", "1f600", SIDE * 2).is_none());
    }

    #[test]
    fn downloaded_pack_is_served_and_deleted() {
        let dir = temp_dir("installed");
        put(&dir, "noto.bin", BUILTIN_DATA);
        put(&dir, "mutant.bin", b"not a pack");
        put(&dir, "fluent-3d.bin.part", b"half");
        let packs = EmojiPacks::new(dir.clone());

        let (_, source) = local(&packs, "noto", "1f600").unwrap();
        assert_eq!(source, "downloaded");
        assert_eq!(local(&packs, "mutant", "1f600"), None);
        assert!(packs.drawn("noto", "1f600", SIDE).is_some());
        assert!(!dir.join("fluent-3d.bin.part").exists());

        let overview = packs.overview();
        let noto = state(&overview, "noto");
        assert!(noto.installed);
        assert_eq!(noto.size, Some(BUILTIN_DATA.len() as u64));
        let twemoji = state(&overview, "twemoji");
        assert!(twemoji.builtin && twemoji.installed);

        packs.delete("noto").unwrap();
        assert_eq!(local(&packs, "noto", "1f600"), None);
        // нарисованное из удалённого набора забыто
        assert!(packs.cached("noto", "1f600", SIDE).is_none());
        assert!(!dir.join("noto.bin").exists());
        // удалить уже удалённое — не ошибка
        packs.delete("noto").unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn system_packs_need_no_download() {
        let packs = EmojiPacks::new(temp_dir("system"));
        let system = SystemEmoji::load();
        let overview = packs.overview();
        for id in PACKS {
            let expected = system.as_ref().is_some_and(|system| system.provides(id));
            assert_eq!(state(&overview, id).system, expected, "{id}");
        }
        assert!(!state(&overview, "fluent-3d").system);
        assert!(!state(&overview, "twemoji").system);
        if state(&overview, "fluent-color").system {
            let (_, source) = local(&packs, "fluent-color", "1f600").unwrap();
            assert_eq!(source, "system");
            // флагов в шрифте нет: они идут с сервера
            assert_eq!(local(&packs, "fluent-color", "1f1f7-1f1fa"), None);
        }
    }

    #[test]
    fn only_downloadable_packs_are_accepted() {
        assert_eq!(known("noto").unwrap(), "noto");
        assert!(known("twemoji").is_err());
        assert!(known("../x").is_err());
    }

    #[test]
    fn broken_files_are_rejected() {
        let mut other_format: &[u8] = b"ATWE\x01\0\0\0\0";
        assert!(read_index(&mut other_format).is_err());
        let mut truncated = &BUILTIN_DATA[..1000];
        assert!(read_index(&mut truncated).is_err());
        let mut empty: &[u8] = b"AEMJ\x01\0\0\0\0";
        assert!(read_index(&mut empty).unwrap().keys.is_empty());
    }
}
