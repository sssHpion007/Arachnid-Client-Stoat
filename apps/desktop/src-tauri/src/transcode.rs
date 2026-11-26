//! Перекодирование видео, которые WebView2 не показывает.
//!
//! WebView2 — это Edge, а Edge декодирует HEVC (H.265) только через
//! «Расширения для видео HEVC» из Microsoft Store (Media Foundation). Chrome
//! и Vivaldi обращаются к декодеру видеокарты сами (D3D11VA), поэтому видео
//! с телефона или из TikTok в браузере играет, а в клиенте — нет. То же с
//! редкими форматами, которых нет у Chromium вовсе.
//!
//! Такое видео клиент перекодирует в H.264 — его WebView2 играет всегда:
//!
//! 1. плеер (`player.js`) видит, что видео не играет, и по нажатию на ▶
//!    просит перекодировать его ([`media_transcode`]), а потом, пока задача
//!    идёт, спрашивает её состояние;
//! 2. файл скачивается через WinHTTP ([`crate::http`]) во временную папку;
//! 3. ffmpeg декодирует его — видеокартой (D3D11VA, как Chrome), а если она
//!    не умеет, то сам, — и кодирует в H.264 кодировщиком Windows (Media
//!    Foundation) и в AAC, не больше 1920 px по длинной стороне;
//! 4. страница получает готовый файл по адресу
//!    `http://arachnid.localhost/media/<id>/<имя файла>` (схема файлов
//!    расширений, [`crate::extensions`]) — частями, как у autumn, чтобы
//!    работала перемотка.
//!
//! ffmpeg — свой, собранный в CI только из нужных частей, без GPL
//! (`apps/desktop/ffmpeg/build.sh`): несколько мегабайт, встроенных в exe
//! (переменная сборки `ARACHNID_FFMPEG`, см. `build.rs`). Перед первым
//! перекодированием он записывается во временную папку и работает там в
//! объекте задания Windows: закрылся клиент — завершился и ffmpeg.
//!
//! Готовые файлы живут, пока работает клиент (видео, которое for-web
//! показал заново, не перекодируется второй раз); при следующем запуске
//! временная папка очищается. Задачи выполняются по одной.

// без встроенного ffmpeg (не Windows, сборка без ARACHNID_FFMPEG) от модуля
// остаются команда, отвечающая «нечем», и разбор, нужный тестам
#![cfg_attr(not(all(windows, arachnid_ffmpeg)), allow(dead_code))]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, mpsc};

use serde::Serialize;
use tauri::State;
use url::Url;

/// Начало адресов готовых файлов в схеме файлов расширений.
pub const ASSET_PREFIX: &str = "/media/";
/// Папка во временном каталоге системы.
const DIR: &str = "arachnid-client-media";
/// Самая длинная ссылка.
const MAX_URL: usize = 4096;
/// Больше файл не скачивается.
const MAX_SOURCE: u64 = 4 * 1024 * 1024 * 1024;
/// Больше задач не запоминается: дальше новые не принимаются.
const MAX_JOBS: usize = 500;
/// Самое длинное имя файла в адресе.
const MAX_NAME: usize = 200;
/// Больше байт за один ответ на запрос части файла не отдаётся.
const MAX_CHUNK: u64 = 4 * 1024 * 1024;
/// Длинная сторона перекодированного видео не больше этого.
const MAX_SIDE: u32 = 1920;
/// Битрейт H.264: вдвое больше исходного (HEVC сжимает примерно вдвое
/// лучше), но в этих пределах, бит/с.
const MIN_BITRATE: u64 = 2_000_000;
const MAX_BITRATE: u64 = 16_000_000;
/// Битрейт, если исходный узнать не удалось, бит/с.
const DEFAULT_BITRATE: u64 = 6_000_000;

/// Состояние задачи — ответ странице.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    /// Перекодировать нечем: не Windows или сборка без ffmpeg
    Unavailable,
    /// Задачи ещё нет (спросили, не запуская)
    Idle,
    /// Ждёт своей очереди
    Queued,
    /// Файл скачивается; доля скачанного, если известен размер
    Downloading { progress: Option<f64> },
    /// Перекодируется; доля готового, если известна длительность
    Converting { progress: Option<f64> },
    /// Готово: адрес для `<video>`
    Done { src: String },
    /// Не получилось: `network`, `large`, `convert`, `io`, `url`, `busy`
    Failed { code: &'static str },
}

struct Job {
    id: String,
    name: String,
    status: Status,
}

#[derive(Default)]
struct Jobs {
    /// Ссылка → задача
    by_url: HashMap<String, Job>,
    /// Номер задачи → готовый файл
    files: HashMap<String, PathBuf>,
    next: u64,
}

/// Перекодирование видео: задачи и их файлы.
pub struct Transcoder {
    dir: PathBuf,
    jobs: Mutex<Jobs>,
    /// Очередь задач (ссылки); поток работы запускается с первой задачей
    queue: Mutex<Option<mpsc::Sender<String>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Transcoder {
    /// Перекодирование во временной папке системы; файлы прошлого запуска
    /// удаляются.
    pub fn in_temp_dir() -> Self {
        Self::with_dir(std::env::temp_dir().join(DIR))
    }

    fn with_dir(dir: PathBuf) -> Self {
        if dir.exists()
            && let Err(error) = std::fs::remove_dir_all(&dir)
        {
            let place = dir.display();
            tracing::warn!(%error, %place, "не удалось очистить папку перекодированных видео");
        }
        Self {
            dir,
            jobs: Mutex::new(Jobs::default()),
            queue: Mutex::new(None),
        }
    }

    /// Есть ли чем перекодировать.
    pub const fn available() -> bool {
        cfg!(all(windows, arachnid_ffmpeg))
    }

    /// Состояние задачи для ссылки; `start` — создать её, если её нет.
    pub fn request(self: &Arc<Self>, url: &str, name: &str, start: bool) -> Status {
        if !Self::available() {
            return Status::Unavailable;
        }
        if url.len() > MAX_URL
            || !Url::parse(url).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
        {
            return Status::Failed { code: "url" };
        }
        let mut jobs = lock(&self.jobs);
        if let Some(job) = jobs.by_url.get_mut(url) {
            // сеть могла вернуться — такую задачу можно повторить
            let retry = start && job.status == Status::Failed { code: "network" };
            if !retry {
                return job.status.clone();
            }
            job.status = Status::Queued;
        } else {
            if !start {
                return Status::Idle;
            }
            if jobs.by_url.len() >= MAX_JOBS {
                return Status::Failed { code: "busy" };
            }
            jobs.next += 1;
            let job = Job {
                id: jobs.next.to_string(),
                name: file_name(name),
                status: Status::Queued,
            };
            jobs.by_url.insert(url.to_owned(), job);
        }
        drop(jobs);
        if self.enqueue(url) {
            Status::Queued
        } else {
            self.set(url, Status::Failed { code: "io" });
            Status::Failed { code: "io" }
        }
    }

    /// Поставить задачу в очередь (поток работы — при первой задаче).
    fn enqueue(self: &Arc<Self>, url: &str) -> bool {
        let mut queue = lock(&self.queue);
        if queue.is_none() {
            let (sender, receiver) = mpsc::channel::<String>();
            let transcoder = Arc::clone(self);
            let spawned = std::thread::Builder::new()
                .name("transcode".into())
                .spawn(move || {
                    for url in receiver {
                        transcoder.process(&url);
                    }
                });
            if let Err(error) = spawned {
                tracing::warn!(%error, "поток перекодирования не запустился");
                return false;
            }
            *queue = Some(sender);
        }
        queue
            .as_ref()
            .is_some_and(|sender| sender.send(url.to_owned()).is_ok())
    }

    fn set(&self, url: &str, status: Status) {
        if let Some(job) = lock(&self.jobs).by_url.get_mut(url) {
            job.status = status;
        }
    }

    /// Выполнить задачу.
    fn process(&self, url: &str) {
        let Some((id, name)) = lock(&self.jobs)
            .by_url
            .get(url)
            .map(|job| (job.id.clone(), job.name.clone()))
        else {
            return;
        };
        let started = std::time::Instant::now();
        let status = match self.transcode(url, &id) {
            Ok(path) => {
                let seconds = started.elapsed().as_secs_f32();
                tracing::info!(%url, seconds, "видео перекодировано");
                lock(&self.jobs).files.insert(id.clone(), path);
                Status::Done {
                    src: media_url(&id, &name),
                }
            }
            Err(code) => {
                tracing::warn!(%url, code, "видео не перекодировано");
                Status::Failed { code }
            }
        };
        self.set(url, status);
    }

    /// Скачать и перекодировать: путь готового файла или код ошибки.
    fn transcode(&self, url: &str, id: &str) -> Result<PathBuf, &'static str> {
        std::fs::create_dir_all(&self.dir).map_err(|_| "io")?;
        let source = self.dir.join(format!("{id}.source"));
        let partial = self.dir.join(format!("{id}.part.mp4"));
        let output = self.dir.join(format!("{id}.mp4"));
        let result = self
            .download(url, &source)
            .and_then(|size| self.convert(url, &source, size, &partial));
        let _ = std::fs::remove_file(&source);
        if let Err(code) = result {
            let _ = std::fs::remove_file(&partial);
            return Err(code);
        }
        std::fs::rename(&partial, &output).map_err(|_| "io")?;
        Ok(output)
    }

    /// Файл для ответа странице.
    fn file(&self, id: &str) -> Option<PathBuf> {
        lock(&self.jobs).files.get(id).cloned()
    }
}

// ──────────────────────────────── Windows ────────────────────────────────

#[cfg(all(windows, arachnid_ffmpeg))]
mod platform {
    use std::cell::Cell;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    use windows_core::PCWSTR;

    use super::{Status, Transcoder};
    use crate::http::{self, StopReason};

    /// ffmpeg, собранный `apps/desktop/ffmpeg/build.sh`.
    const FFMPEG: &[u8] = include_bytes!(env!("ARACHNID_FFMPEG_PATH"));
    /// Процесс без окна консоли.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    /// Как часто обновлять ход задачи.
    const INTERVAL: Duration = Duration::from_millis(150);
    /// Столько последних байт вывода ошибок ffmpeg попадает в журнал.
    const LOG_TAIL: usize = 2000;

    /// Объект задания Windows: процессы в нём завершаются вместе с клиентом
    /// (дескриптор закрывается только при выходе).
    struct KillOnClose(HANDLE);

    // SAFETY: дескриптор объекта задания можно использовать из любого потока
    unsafe impl Send for KillOnClose {}
    unsafe impl Sync for KillOnClose {}

    fn job_object() -> Option<&'static KillOnClose> {
        static JOB: OnceLock<Option<KillOnClose>> = OnceLock::new();
        JOB.get_or_init(|| {
            // SAFETY: структура передаётся с её настоящим размером
            unsafe {
                let job = CreateJobObjectW(None, PCWSTR::null()).ok()?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&info).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .ok()?;
                Some(KillOnClose(job))
            }
        })
        .as_ref()
    }

    impl Transcoder {
        pub(super) fn download(&self, url: &str, path: &Path) -> Result<u64, &'static str> {
            let address = url::Url::parse(url).map_err(|_| "url")?;
            let file = std::fs::File::create(path).map_err(|_| "io")?;
            let mut file = std::io::BufWriter::new(file);
            let total = Cell::new(None);
            let mut received = 0u64;
            let mut reported = Instant::now();
            self.set(url, Status::Downloading { progress: None });
            let on_data = |chunk: &[u8]| {
                received += chunk.len() as u64;
                if received > super::MAX_SOURCE {
                    return Err(StopReason::TooLarge);
                }
                file.write_all(chunk).map_err(StopReason::Io)?;
                if reported.elapsed() >= INTERVAL {
                    reported = Instant::now();
                    let progress = total
                        .get()
                        .map(|total: u64| received as f64 / total.max(1) as f64);
                    self.set(url, Status::Downloading { progress });
                }
                Ok(())
            };
            let result = http::get(&address, |length| total.set(length), on_data);
            match result {
                Ok(()) => {}
                Err(http::Error::Stopped(StopReason::TooLarge)) => return Err("large"),
                Err(http::Error::Stopped(StopReason::Io(_))) => return Err("io"),
                Err(error) => {
                    tracing::warn!(?error, "видео для перекодирования не скачалось");
                    return Err("network");
                }
            }
            file.flush().map_err(|_| "io")?;
            Ok(received)
        }

        /// ffmpeg во временной папке (записывается перед первой задачей).
        fn ffmpeg(&self) -> Result<PathBuf, &'static str> {
            let path = self.dir.join("ffmpeg.exe");
            let written =
                std::fs::metadata(&path).is_ok_and(|meta| meta.len() == FFMPEG.len() as u64);
            if !written {
                let temp = self.dir.join("ffmpeg.exe.tmp");
                std::fs::write(&temp, FFMPEG).map_err(|_| "io")?;
                std::fs::rename(&temp, &path).map_err(|_| "io")?;
            }
            Ok(path)
        }

        pub(super) fn convert(
            &self,
            url: &str,
            source: &Path,
            size: u64,
            output: &Path,
        ) -> Result<(), &'static str> {
            let ffmpeg = self.ffmpeg()?;
            let probe = command(&ffmpeg)
                .args(["-hide_banner", "-nostdin", "-i"])
                .arg(source)
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .output()
                .map_err(|_| "convert")?;
            let info = String::from_utf8_lossy(&probe.stderr);
            let probe = super::Probe::parse(&info);
            if !probe.video {
                tracing::warn!(info = tail(&info), "ffmpeg не нашёл видео в файле");
                return Err("convert");
            }
            let bitrate = super::target_bitrate(probe.bitrate, size, probe.duration);
            // видеокарта не справилась посреди файла — ещё раз без неё
            for hardware in [true, false] {
                self.set(
                    url,
                    Status::Converting {
                        progress: Some(0.0),
                    },
                );
                let args = super::convert_args(hardware, bitrate);
                let Err(log) = self.run(url, &ffmpeg, &args, source, output, probe.duration) else {
                    return Ok(());
                };
                tracing::warn!(hardware, log = tail(&log), "ffmpeg не перекодировал видео");
            }
            Err("convert")
        }

        /// Запустить ffmpeg и следить за ходом (`-progress pipe:1`); ошибка —
        /// конец вывода ошибок ffmpeg.
        fn run(
            &self,
            url: &str,
            ffmpeg: &Path,
            args: &super::ConvertArgs,
            source: &Path,
            output: &Path,
            duration: Option<f64>,
        ) -> Result<(), String> {
            let mut child = command(ffmpeg)
                .args(&args.input)
                .arg("-i")
                .arg(source)
                .args(&args.output)
                .arg(output)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|error| error.to_string())?;
            if let Some(job) = job_object() {
                // SAFETY: дескриптор процесса жив, пока жив `child`
                let process = HANDLE(child.as_raw_handle());
                if let Err(error) = unsafe { AssignProcessToJobObject(job.0, process) } {
                    tracing::warn!(%error, "ffmpeg не помещён в объект задания");
                }
            }
            // вывод ошибок читается отдельно: иначе ffmpeg встанет, заполнив канал
            let mut stderr = child.stderr.take();
            let errors = std::thread::spawn(move || {
                let mut text = String::new();
                if let Some(stderr) = stderr.as_mut() {
                    let _ = stderr.read_to_string(&mut text);
                }
                text
            });
            let mut reported = Instant::now();
            if let Some(stdout) = child.stdout.take() {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let Some(time) = super::progress_time(&line) else {
                        continue;
                    };
                    if reported.elapsed() < INTERVAL {
                        continue;
                    }
                    reported = Instant::now();
                    let progress = duration
                        .filter(|duration| *duration > 0.0)
                        .map(|duration| (time / duration).clamp(0.0, 1.0));
                    self.set(url, Status::Converting { progress });
                }
            }
            let status = child.wait().map_err(|error| error.to_string())?;
            let log = errors.join().unwrap_or_default();
            if status.success() { Ok(()) } else { Err(log) }
        }
    }

    fn command(ffmpeg: &Path) -> Command {
        let mut command = Command::new(ffmpeg);
        command
            .stdin(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        command
    }

    /// Конец текста для журнала.
    fn tail(text: &str) -> &str {
        let mut start = text.len().saturating_sub(LOG_TAIL);
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text[start..].trim()
    }
}

#[cfg(not(all(windows, arachnid_ffmpeg)))]
impl Transcoder {
    fn download(&self, _url: &str, _path: &std::path::Path) -> Result<u64, &'static str> {
        Err("convert")
    }

    fn convert(
        &self,
        _url: &str,
        _source: &std::path::Path,
        _size: u64,
        _output: &std::path::Path,
    ) -> Result<(), &'static str> {
        Err("convert")
    }
}

// ─────────────────────────────── разбор и адреса ───────────────────────────────

/// Что ffmpeg сообщил о файле (`ffmpeg -i <файл>`).
#[derive(Debug, Default, PartialEq)]
struct Probe {
    /// Длительность, с
    duration: Option<f64>,
    /// Общий битрейт, кбит/с
    bitrate: Option<u64>,
    /// Есть ли дорожка видео
    video: bool,
}

impl Probe {
    /// `  Duration: 00:00:08.03, start: 0.000000, bitrate: 145 kb/s`
    /// `  Stream #0:0[0x1](eng): Video: hevc (Main) …`
    fn parse(info: &str) -> Self {
        let mut probe = Self::default();
        for line in info.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("Duration: ") {
                let mut fields = rest.split(", ");
                probe.duration = fields.next().and_then(parse_clock);
                probe.bitrate = fields
                    .find_map(|field| field.strip_prefix("bitrate: "))
                    .and_then(|value| value.strip_suffix(" kb/s"))
                    .and_then(|value| value.parse().ok());
            } else if line.starts_with("Stream #") && line.contains(": Video: ") {
                probe.video = true;
            }
        }
        probe
    }
}

/// `01:02:03.45` → секунды.
fn parse_clock(clock: &str) -> Option<f64> {
    let mut parts = clock.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

/// Битрейт H.264 по исходному, бит/с.
fn target_bitrate(source_kbps: Option<u64>, size: u64, duration: Option<f64>) -> u64 {
    let source = source_kbps.map(|kbps| kbps * 1000).or_else(|| {
        duration
            .filter(|duration| *duration > 0.0)
            .map(|duration| (size as f64 * 8.0 / duration) as u64)
    });
    match source {
        Some(source) => (source * 2).clamp(MIN_BITRATE, MAX_BITRATE),
        None => DEFAULT_BITRATE,
    }
}

/// Аргументы ffmpeg до входного файла и после него (перед выходным).
struct ConvertArgs {
    input: Vec<String>,
    output: Vec<String>,
}

fn convert_args(hardware: bool, bitrate: u64) -> ConvertArgs {
    let mut input: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error"]
        .map(String::from)
        .into();
    if hardware {
        // декодер видеокарты; не сможет открыться — ffmpeg декодирует сам
        input.extend(["-hwaccel", "d3d11va"].map(String::from));
    }
    // длинная сторона — не больше MAX_SIDE, стороны чётные (H.264 4:2:0),
    // 8 бит 4:2:0 (у видео с телефона бывает 10 бит)
    let scale = format!(
        "scale=w='min(iw,{MAX_SIDE})':h='min(ih,{MAX_SIDE})':\
         force_original_aspect_ratio=decrease:force_divisible_by=2,format=nv12"
    );
    let bitrate = bitrate.to_string();
    let output = [
        ("-map", "0:v:0"),
        ("-map", "0:a:0?"),
        ("-vf", scale.as_str()),
        ("-c:v", "h264_mf"),
        ("-b:v", bitrate.as_str()),
        // ключевой кадр раз в пару секунд: быстрая перемотка
        ("-g", "60"),
        ("-c:a", "aac"),
        ("-b:a", "160k"),
        // оглавление в начале файла: видео играет, не дочитав его до конца
        ("-movflags", "+faststart"),
        ("-progress", "pipe:1"),
    ]
    .into_iter()
    .flat_map(|(name, value)| [name.to_owned(), value.to_owned()])
    .chain(["-nostats".to_owned()])
    .collect();
    ConvertArgs { input, output }
}

/// Строка хода ffmpeg `out_time_us=8034104` → секунды.
fn progress_time(line: &str) -> Option<f64> {
    let micros: f64 = line.strip_prefix("out_time_us=")?.trim().parse().ok()?;
    Some(micros / 1_000_000.0)
}

/// Имя файла для адреса: без путей и управляющих символов.
fn file_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\'))
        .take(MAX_NAME)
        .collect();
    let clean = clean.trim();
    if clean.is_empty() || clean == "." || clean == ".." {
        "video.mp4".into()
    } else {
        clean.into()
    }
}

/// Адрес готового файла: `http://arachnid.localhost/media/<id>/<имя>`.
fn media_url(id: &str, name: &str) -> String {
    let base = format!("{}{}", crate::extensions::ASSET_BASE, &ASSET_PREFIX[1..]);
    let Ok(mut url) = Url::parse(&base) else {
        return base;
    };
    if let Ok(mut segments) = url.path_segments_mut() {
        segments.pop_if_empty().extend([id, name]);
    }
    url.into()
}

/// Запрошенная часть файла `bytes=начало-конец` (конец включительно);
/// без заголовка — с начала. Больше [`MAX_CHUNK`] за раз не отдаётся.
fn byte_range(header: Option<&str>, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let (start, end) = match header {
        None => (0, len - 1),
        Some(header) => {
            let spec = header.trim().strip_prefix("bytes=")?;
            // несколько частей сразу браузер для видео не просит
            let (start, end) = spec.split(',').next()?.trim().split_once('-')?;
            match (start.trim(), end.trim()) {
                ("", "") => return None,
                ("", suffix) => {
                    let suffix: u64 = suffix.parse().ok()?;
                    (len.saturating_sub(suffix), len - 1)
                }
                (start, "") => (start.parse().ok()?, len - 1),
                (start, end) => (start.parse().ok()?, end.parse::<u64>().ok()?.min(len - 1)),
            }
        }
    };
    if start > end || start >= len {
        return None;
    }
    Some((start, end.min(start + MAX_CHUNK - 1)))
}

/// Ответ на запрос готового файла (`<id>/<имя>` после [`ASSET_PREFIX`]).
pub fn asset(
    transcoder: &Transcoder,
    path: &str,
    range: Option<&str>,
) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};

    let empty = |status: u16| {
        tauri::http::Response::builder()
            .status(status)
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap_or_default()
    };
    let id = path.split('/').next().unwrap_or_default();
    let Some(file) = transcoder.file(id) else {
        return empty(404);
    };
    let Ok(mut file) = std::fs::File::open(file) else {
        return empty(404);
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or_default();
    let Some((start, end)) = byte_range(range, len) else {
        return tauri::http::Response::builder()
            .status(416)
            .header("Content-Range", format!("bytes */{len}"))
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap_or_default();
    };
    let mut body = vec![0; (end - start + 1) as usize];
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut body).is_err() {
        return empty(500);
    }
    // всегда частью (206): так браузер сразу знает, что файл можно
    // перематывать, и не ждёт его целиком
    tauri::http::Response::builder()
        .status(206)
        .header("Content-Type", "video/mp4")
        .header("Accept-Ranges", "bytes")
        .header("Content-Range", format!("bytes {start}-{end}/{len}"))
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-cache")
        .body(body)
        .unwrap_or_default()
}

// ──────────────────────────────── команда ────────────────────────────────

/// Перекодировать видео по ссылке (`start`) или узнать, как идёт задача.
/// `name` — имя файла для адреса готового видео (подпись в плеере).
#[tauri::command]
pub fn media_transcode(
    url: String,
    name: String,
    start: bool,
    transcoder: State<'_, Arc<Transcoder>>,
) -> Status {
    transcoder.inner().request(&url, &name, start)
}

/// Самое длинное поле отчёта плеера, символов
const REPORT_LIMIT: usize = 400;

/// Отчёт плеера о сбое загрузки — в журнал клиента: по нему видно, почему
/// файл не загрузился (текст ошибки Chromium, состояние элемента).
#[tauri::command]
pub fn media_report(url: String, event: String, detail: String) {
    let cut = |text: &str| text.chars().take(REPORT_LIMIT).collect::<String>();
    let (url, event, detail) = (cut(&url), cut(&event), cut(&detail));
    tracing::warn!(%url, %event, %detail, "плеер: сбой загрузки");
}

#[cfg(test)]
mod tests {
    use super::*;

    const INFO: &str = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.mp4':\n  \
        Metadata:\n    major_brand     : isom\n  \
        Duration: 00:01:08.50, start: 0.000000, bitrate: 1450 kb/s\n  \
        Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv), 1080x1920, 1300 kb/s, 30 fps\n  \
        Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s\n\
        At least one output file must be specified\n";

    #[test]
    fn probe_reads_duration_bitrate_and_video() {
        let probe = Probe::parse(INFO);
        assert_eq!(probe.duration, Some(68.5));
        assert_eq!(probe.bitrate, Some(1450));
        assert!(probe.video);

        let audio = Probe::parse("  Duration: N/A, bitrate: N/A\n  Stream #0:0: Audio: mp3\n");
        assert_eq!(audio, Probe::default());
        assert_eq!(parse_clock("01:02:03.5"), Some(3723.5));
        assert_eq!(parse_clock("N/A"), None);
    }

    #[test]
    fn bitrate_is_doubled_and_limited() {
        assert_eq!(target_bitrate(Some(1450), 0, None), 2_900_000);
        assert_eq!(target_bitrate(Some(100), 0, None), MIN_BITRATE);
        assert_eq!(target_bitrate(Some(50_000), 0, None), MAX_BITRATE);
        // без битрейта — по размеру и длительности
        assert_eq!(target_bitrate(None, 5_000_000, Some(10.0)), 8_000_000);
        assert_eq!(target_bitrate(None, 5_000_000, None), DEFAULT_BITRATE);
    }

    #[test]
    fn progress_lines_are_parsed() {
        assert_eq!(progress_time("out_time_us=8034104"), Some(8.034104));
        assert_eq!(progress_time("out_time_us=N/A"), None);
        assert_eq!(progress_time("out_time=00:00:08.03"), None);
    }

    #[test]
    fn hardware_decoding_goes_before_input() {
        let args = convert_args(true, 3_000_000);
        assert!(
            args.input
                .windows(2)
                .any(|pair| pair == ["-hwaccel", "d3d11va"])
        );
        assert!(
            args.output
                .windows(2)
                .any(|pair| pair == ["-b:v", "3000000"])
        );
        assert!(
            args.output
                .windows(2)
                .any(|pair| pair == ["-c:v", "h264_mf"])
        );
        assert!(
            !convert_args(false, 3_000_000)
                .input
                .iter()
                .any(|arg| arg == "-hwaccel")
        );
    }

    #[test]
    fn ranges_are_clamped() {
        assert_eq!(byte_range(None, 10), Some((0, 9)));
        assert_eq!(byte_range(Some("bytes=0-"), 10), Some((0, 9)));
        assert_eq!(byte_range(Some("bytes=2-4"), 10), Some((2, 4)));
        assert_eq!(byte_range(Some("bytes=5-100"), 10), Some((5, 9)));
        assert_eq!(byte_range(Some("bytes=-3"), 10), Some((7, 9)));
        assert_eq!(byte_range(Some("bytes=10-"), 10), None);
        assert_eq!(byte_range(Some("bytes=4-2"), 10), None);
        assert_eq!(byte_range(Some("items=0-1"), 10), None);
        assert_eq!(byte_range(None, 0), None);
        let big = 100 * MAX_CHUNK;
        assert_eq!(byte_range(Some("bytes=0-"), big), Some((0, MAX_CHUNK - 1)));
    }

    #[test]
    fn names_and_addresses_are_safe() {
        assert_eq!(file_name("../клип 1.mp4"), "..клип 1.mp4");
        assert_eq!(file_name("a/b\\c\n.mov"), "abc.mov");
        assert_eq!(file_name("  "), "video.mp4");
        assert_eq!(file_name(".."), "video.mp4");
        let url = media_url("7", "клип #1?.mp4");
        assert!(
            url.ends_with("/media/7/%D0%BA%D0%BB%D0%B8%D0%BF%20%231%3F.mp4"),
            "{url}"
        );
        assert!(url.starts_with(crate::extensions::ASSET_BASE));
    }

    #[test]
    fn unavailable_without_ffmpeg() {
        let dir = std::env::temp_dir().join(format!("arachnid-transcode-{}", std::process::id()));
        let transcoder = Arc::new(Transcoder::with_dir(dir));
        // не запуская: задача скачивала бы файл
        let status = transcoder.request("https://example.com/a.mp4", "a.mp4", false);
        let expected = if Transcoder::available() {
            Status::Idle
        } else {
            Status::Unavailable
        };
        assert_eq!(status, expected);
        let wrong = transcoder.request("file:///C:/a.mp4", "a.mp4", false);
        if Transcoder::available() {
            assert_eq!(wrong, Status::Failed { code: "url" });
        }
    }

    #[test]
    fn status_is_serialized_for_the_page() {
        let json = serde_json::to_value(Status::Converting {
            progress: Some(0.5),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "state": "converting", "progress": 0.5 })
        );
        let json = serde_json::to_value(Status::Failed { code: "network" }).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "state": "failed", "code": "network" })
        );
    }
}
