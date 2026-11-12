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
//! WebView2 для `https://static.stoat.chat/emoji/*` отвечает из файла набора,
//! если набор есть у клиента, а иначе пропускает запрос в сеть.
//!
//! * Twemoji — набор по умолчанию — встроен в exe (`emoji/twemoji.bin`).
//! * Fluent 3D, Fluent Color, Fluent Flat, Mutant Remix и Noto скачиваются в
//!   «Внешний вид» → «Наборы эмодзи» одним файлом с GitHub (пре-релиз
//!   `emoji-packs-v1`, его собирает `.github/workflows/emoji-packs.yml` из тех
//!   же картинок static.stoat.chat) в папку `emoji/` каталога данных, там же
//!   удаляются. Размеры наборов — в `manifest.json` того же релиза.
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

/// Набор и кодовые точки из адреса картинки for-web.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_address(uri: &str) -> Option<(&str, String)> {
    let (pack, file) = uri.strip_prefix(PREFIX)?.split_once('/')?;
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

/// Наборы клиента: встроенный, скачанные и скачиваемые сейчас.
pub struct EmojiPacks {
    dir: PathBuf,
    builtin: OnceLock<Option<Arc<Pack>>>,
    installed: RwLock<Installed>,
    jobs: Mutex<HashMap<&'static str, Job>>,
    failures: Mutex<HashMap<&'static str, Failure>>,
    manifest: Mutex<Remote>,
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
            installed: RwLock::new(installed),
            jobs: Mutex::default(),
            failures: Mutex::default(),
            manifest: Mutex::default(),
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

    /// Картинка эмодзи из набора клиента; None — пусть грузит сеть.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn svg(&self, pack: &str, stem: &str) -> Option<Vec<u8>> {
        self.pack(pack)?.svg(stem)
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
        if read(&self.installed).contains_key(id) {
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

/// Наборы эмодзи для раздела «Внешний вид».
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
    use std::sync::Arc;

    use tauri::WebviewWindow;
    use tauri::webview::PlatformWebview;
    use webview2_com::Microsoft::Web::WebView2::Win32 as wv;
    use webview2_com::{WebResourceRequestedEventHandler, take_pwstr};
    use windows::Win32::UI::Shell::SHCreateMemStream;
    use windows_core::{HSTRING, Interface, PWSTR, w};

    use super::{EmojiPacks, PREFIX, parse_address};

    /// Картинки неизменны (адрес с версией `?v=1`), как и у static.stoat.chat.
    const HEADERS: &str = "Content-Type: image/svg+xml\r\n\
        Cache-Control: public, max-age=31536000, immutable\r\n\
        Access-Control-Allow-Origin: *";

    pub fn serve(window: &WebviewWindow, packs: Arc<EmojiPacks>) {
        let result = window.with_webview(move |webview| {
            if let Err(error) = setup(&webview, packs) {
                tracing::warn!(%error, "наборы эмодзи клиента не подключены");
            }
        });
        if let Err(error) = result {
            tracing::warn!(%error, "webview недоступен, наборы эмодзи не подключены");
        }
    }

    fn setup(webview: &PlatformWebview, packs: Arc<EmojiPacks>) -> windows_core::Result<()> {
        let env = webview.environment();
        // SAFETY: with_webview вызывает нас в главном потоке, контроллер жив,
        // пока существует окно
        let core = unsafe { webview.controller().CoreWebView2() }?;
        add_filter(&core)?;

        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                respond(&packs, &env, &args)?;
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

    /// Ответить картинкой набора; без неё запрос уходит в сеть как обычно.
    fn respond(
        packs: &EmojiPacks,
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
        if let Some(image) = packs.svg(pack, &stem) {
            let response = response(env, &image)?;
            // SAFETY: ответ передаётся WebView2 во время обработчика
            unsafe { args.SetResponse(&response)? };
        }
        Ok(())
    }

    fn response(
        env: &wv::ICoreWebView2Environment,
        image: &[u8],
    ) -> windows_core::Result<wv::ICoreWebView2WebResourceResponse> {
        let headers = HSTRING::from(HEADERS);
        // SAFETY: поток создаётся из копии данных
        unsafe {
            let stream = SHCreateMemStream(Some(image));
            env.CreateWebResourceResponse(stream.as_ref(), 200, w!("OK"), &headers)
        }
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
        let image = packs.svg(pack, &stem).unwrap();
        assert!(image.starts_with(b"<svg"));

        let svg = |stem: &str| packs.svg("twemoji", stem);
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
    }

    #[test]
    fn missing_pack_goes_to_network() {
        let packs = EmojiPacks::new(temp_dir("missing"));
        assert_eq!(packs.svg("noto", "1f600"), None);
        assert_eq!(packs.svg("unknown", "1f600"), None);
    }

    #[test]
    fn downloaded_pack_is_served_and_deleted() {
        let dir = temp_dir("installed");
        put(&dir, "noto.bin", BUILTIN_DATA);
        put(&dir, "mutant.bin", b"not a pack");
        put(&dir, "fluent-3d.bin.part", b"half");
        let packs = EmojiPacks::new(dir.clone());

        assert!(packs.svg("noto", "1f600").unwrap().starts_with(b"<svg"));
        assert_eq!(packs.svg("mutant", "1f600"), None);
        assert!(!dir.join("fluent-3d.bin.part").exists());

        let overview = packs.overview();
        let noto = state(&overview, "noto");
        assert!(noto.installed);
        assert_eq!(noto.size, Some(BUILTIN_DATA.len() as u64));
        let twemoji = state(&overview, "twemoji");
        assert!(twemoji.builtin && twemoji.installed);

        packs.delete("noto").unwrap();
        assert_eq!(packs.svg("noto", "1f600"), None);
        assert!(!dir.join("noto.bin").exists());
        // удалить уже удалённое — не ошибка
        packs.delete("noto").unwrap();
        let _ = std::fs::remove_dir_all(dir);
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
