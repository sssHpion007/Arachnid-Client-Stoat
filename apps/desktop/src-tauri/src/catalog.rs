//! Каталог плагинов: папка `plugins/` репозитория клиента на GitHub.
//!
//! Окно «Каталог плагинов» в разделе «Плагины» показывает плагины-папки из
//! репозитория, скачивает их в папку плагинов, обновляет, если в каталоге
//! версия выше установленной, и скачивает заново. Установленным считается
//! плагин-папка с тем же именем, что и в каталоге.
//!
//! Список файлов — два запроса к API GitHub: последний коммит ветки и дерево
//! папки `plugins` в нём. Без входа API отвечает 60 раз в час с одного
//! адреса, поэтому список хранится [`LISTING_TTL`]. Файлы идут с
//! raw.githubusercontent.com по тому же коммиту — все файлы плагина всегда
//! из одной версии.
//!
//! Каталог сохраняется в [`CACHE_FILE`] рядом с папкой плагинов: окно
//! показывает его сразу, без сети, а свежесть проверяет одним запросом —
//! коммит тот же, значит, и список тот же. Новый коммит — новое дерево, но
//! описания плагинов, чьи файлы не изменились (те же SHA), не скачиваются
//! снова. Недостающие описания скачиваются по [`PARALLEL`] сразу.
//!
//! Скачанный плагин сначала собирается во временной папке
//! `plugins/.download-<id>` (папки с точкой клиент не читает) и
//! проверяется: `plugin.toml` должен читаться, как у положенного вручную.
//! Только после этого он занимает место старой версии. Новый плагин
//! выключен, как и положенный в папку вручную; у обновлённого остаются
//! включённость, настройки, разрешения и хранилище.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use url::Url;

use crate::extensions::{self, Extensions};
use crate::{CmdResult, CommandError, desktop, manifest};

/// Ветка репозитория, из которой берутся плагины.
const BRANCH: &str = "main";
/// Папка каталога в репозитории.
const CATALOG_DIR: &str = "plugins";
/// Начало адресов API GitHub и файлов репозитория.
const API: &str = "https://api.github.com/repos/";
const RAW: &str = "https://raw.githubusercontent.com/";
/// Заголовки запросов к API: коммит — одной строкой, дерево — JSON.
const ACCEPT_SHA: &str = "Accept: application/vnd.github.sha\r\n";
const ACCEPT_JSON: &str = "Accept: application/vnd.github+json\r\n";
/// Сколько хранить список файлов: API GitHub без входа отвечает 60 раз в
/// час с одного адреса.
const LISTING_TTL: Duration = Duration::from_secs(10 * 60);
/// Больше этого ответ API со списком файлов не читается.
const MAX_LISTING: usize = 4 * 1024 * 1024;
/// Больше этого `plugin.toml`, перевод или значок для окна каталога не
/// скачиваются.
const MAX_ABOUT_FILE: usize = 256 * 1024;
/// Больше стольких файлов и байт плагин из каталога не скачивается.
const MAX_FILES: usize = 256;
const MAX_PLUGIN_SIZE: u64 = 64 * 1024 * 1024;
/// Временная папка скачиваемого плагина внутри папки плагинов.
const DOWNLOAD_PREFIX: &str = ".download-";
/// Сохранённый каталог — в папке данных, рядом с папкой плагинов.
const CACHE_FILE: &str = "catalog-cache.json";
/// Сколько описаний плагинов скачивается одновременно.
const PARALLEL: usize = 6;
/// Как часто сообщать странице ход скачивания плагина.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Файл плагина в каталоге.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct RemoteFile {
    /// Путь внутри папки плагина, через `/`
    path: String,
    /// Размер, байт
    size: u64,
    /// SHA содержимого в git: по нему видно, что файл не менялся
    #[serde(default)]
    sha: String,
}

/// Название, описание и значок плагина из каталога на одном языке.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RemoteAbout {
    name: Option<String>,
    version: Option<String>,
    author: Option<String>,
    description: Option<String>,
    /// Значок — адрес `data:`
    icon: Option<String>,
    /// Почему `plugin.toml` не читается
    error: Option<String>,
    /// Отпечаток файлов плагина ([`signature`]), с которых снято описание
    #[serde(default)]
    signature: String,
}

/// Список каталога на момент запроса.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Listing {
    /// Коммит, из которого скачиваются файлы
    commit: String,
    /// Когда коммит последний раз сверялся с GitHub
    checked: SystemTime,
    /// Плагин → его файлы
    plugins: BTreeMap<String, Vec<RemoteFile>>,
    /// Описания: язык → плагин → описание
    about: BTreeMap<String, BTreeMap<String, RemoteAbout>>,
}

impl Listing {
    /// Сверялся с GitHub недавно: снова спрашивать незачем.
    fn fresh(&self) -> bool {
        self.checked.elapsed().is_ok_and(|age| age < LISTING_TTL)
    }

    /// Описание плагина `id` на языке `language`.
    fn about(&self, language: &str, id: &str) -> Option<&RemoteAbout> {
        self.about.get(language)?.get(id)
    }
}

/// Последний список каталога (при первом обращении — из [`CACHE_FILE`]).
static LISTING: Mutex<Option<Listing>> = Mutex::new(None);

/// Отпечаток файлов плагина: пути, размеры и SHA.
fn signature(files: &[RemoteFile]) -> String {
    let parts: Vec<String> = files
        .iter()
        .map(|file| format!("{}:{}:{}", file.path, file.size, file.sha))
        .collect();
    parts.join("\n")
}

/// Код языка для ключей описаний: `pt_BR` → `pt-br`.
fn language_key(language: &str) -> String {
    language.replace('_', "-").to_ascii_lowercase()
}

/// Сохранённый каталог для окна: показать сразу, пока идёт проверка.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCatalog {
    plugins: Vec<CatalogPlugin>,
    /// Сверялся с GitHub недавно — проверять снова не нужно
    fresh: bool,
}

/// Ход скачивания плагина для окна каталога.
#[derive(Serialize)]
struct Progress<'a> {
    id: &'a str,
    received: u64,
    total: u64,
}

/// Плагин каталога для окна «Каталог плагинов».
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPlugin {
    /// Имя папки плагина
    id: String,
    name: Option<String>,
    description: Option<String>,
    author: Option<String>,
    /// Версия в каталоге
    version: Option<String>,
    /// Значок — адрес `data:`
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
    /// Размер всех файлов, байт
    size: u64,
    /// Плагин-папка с этим именем уже есть
    installed: bool,
    /// Её версия
    #[serde(skip_serializing_if = "Option::is_none")]
    installed_version: Option<String>,
    /// В каталоге версия выше установленной
    update: bool,
    /// Почему плагин каталога не читается
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Почему каталог не получен.
#[derive(Debug)]
enum Failure {
    /// Сеть есть только в Windows (WinHTTP)
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
    /// Нет сети, имя не найдено, TLS: код Windows
    #[cfg_attr(not(windows), allow(dead_code))]
    Network(u32),
    /// GitHub ограничил запросы без входа
    #[cfg_attr(not(windows), allow(dead_code))]
    Limit,
    /// Сервер ответил не 200
    #[cfg_attr(not(windows), allow(dead_code))]
    Status(u32),
    /// Ответ больше предела
    #[cfg_attr(not(windows), allow(dead_code))]
    TooLarge,
    /// Ответ не тот, что ожидался
    Broken(String),
}

impl From<Failure> for CommandError {
    fn from(failure: Failure) -> Self {
        let (code, args, message) = match failure {
            Failure::Unsupported => (
                "catalogUnsupported",
                vec![],
                "каталог плагинов есть только в Windows".to_owned(),
            ),
            Failure::Network(code) => (
                "catalogUnreachable",
                vec![code.to_string()],
                format!("GitHub недоступен (код Windows {code})"),
            ),
            Failure::Limit => (
                "catalogLimit",
                vec![],
                "GitHub ограничил запросы, попробуйте позже".to_owned(),
            ),
            Failure::Status(status) => (
                "catalogStatus",
                vec![status.to_string()],
                format!("GitHub ответил {status}"),
            ),
            Failure::TooLarge => (
                "catalogTooLarge",
                vec![],
                "файл каталога слишком большой".to_owned(),
            ),
            Failure::Broken(error) => (
                "catalogBroken",
                vec![error.clone()],
                format!("каталог не читается: {error}"),
            ),
        };
        CommandError::translated("catalog", code, args, message)
    }
}

/// Ошибка загрузки → почему каталог не получен.
#[cfg(windows)]
fn failure(error: crate::http::Error, url: &Url) -> Failure {
    use crate::http::{Error, StopReason};

    match error {
        Error::Network(code) => Failure::Network(code),
        Error::Status(403 | 429) => Failure::Limit,
        Error::Status(status) => Failure::Status(status),
        Error::Url => Failure::Broken(format!("адрес {url} не подходит")),
        Error::Stopped(StopReason::TooLarge) => Failure::TooLarge,
        Error::Stopped(_) => Failure::Network(0),
    }
}

/// Скачать файл целиком, не больше `limit` байт.
#[cfg(windows)]
fn download(url: &Url, headers: &str, limit: usize) -> Result<Vec<u8>, Failure> {
    let fetched =
        crate::http::fetch(url, headers, |_| limit).map_err(|error| failure(error, url))?;
    if !fetched.complete {
        return Err(Failure::TooLarge);
    }
    Ok(fetched.body)
}

/// Сеть — средствами Windows (WinHTTP), как и наборы эмодзи.
#[cfg(not(windows))]
fn download(_url: &Url, _headers: &str, _limit: usize) -> Result<Vec<u8>, Failure> {
    Err(Failure::Unsupported)
}

/// Скачать файл размером не больше `size` байт; `on_chunk` получает длину
/// каждого пришедшего куска — для полосы загрузки.
#[cfg(windows)]
fn download_counted(
    url: &Url,
    size: u64,
    mut on_chunk: impl FnMut(usize),
) -> Result<Vec<u8>, Failure> {
    use crate::http::StopReason;

    let mut body = Vec::new();
    let on_data = |chunk: &[u8]| {
        if (body.len() + chunk.len()) as u64 > size {
            return Err(StopReason::TooLarge);
        }
        body.extend_from_slice(chunk);
        on_chunk(chunk.len());
        Ok(())
    };
    crate::http::get(url, |_| {}, on_data).map_err(|error| failure(error, url))?;
    Ok(body)
}

#[cfg(not(windows))]
fn download_counted(
    _url: &Url,
    _size: u64,
    _on_chunk: impl FnMut(usize),
) -> Result<Vec<u8>, Failure> {
    Err(Failure::Unsupported)
}

/// `владелец/репозиторий` из адреса репозитория клиента.
fn repo() -> Result<&'static str, Failure> {
    let repo = extensions::REPOSITORY
        .strip_prefix("https://github.com/")
        .map(|path| path.trim_end_matches('/'))
        .map(|path| path.strip_suffix(".git").unwrap_or(path))
        .filter(|path| {
            let mut parts = path.split('/');
            let valid = |part: Option<&str>| part.is_some_and(manifest::valid_id);
            valid(parts.next()) && valid(parts.next()) && parts.next().is_none()
        });
    repo.ok_or_else(|| Failure::Broken("репозиторий клиента — не GitHub".into()))
}

/// Адрес файла плагина `id` в коммите `commit`.
fn raw_url(repo: &str, commit: &str, id: &str, path: &str) -> Result<Url, Failure> {
    let broken = || Failure::Broken(format!("адрес файла {id}/{path} не подходит"));
    let mut url = Url::parse(RAW).map_err(|_| broken())?;
    url.path_segments_mut()
        .map_err(|_| broken())?
        .pop_if_empty()
        .extend(repo.split('/'))
        .push(commit)
        .push(CATALOG_DIR)
        .push(id)
        .extend(path.split('/'));
    Ok(url)
}

/// Плагины из ответа API `git/trees/…?recursive=1` для папки `plugins`:
/// папки с `plugin.toml`, файлы — с путями, которые годятся для папки
/// плагина.
fn parse_tree(body: &[u8]) -> Result<BTreeMap<String, Vec<RemoteFile>>, Failure> {
    #[derive(Deserialize)]
    struct Tree {
        tree: Vec<Item>,
        #[serde(default)]
        truncated: bool,
    }
    #[derive(Deserialize)]
    struct Item {
        path: String,
        #[serde(default)]
        mode: String,
        #[serde(rename = "type")]
        kind: String,
        #[serde(default)]
        size: u64,
        #[serde(default)]
        sha: String,
    }

    let broken = |error: serde_json::Error| Failure::Broken(error.to_string());
    let tree: Tree = serde_json::from_slice(body).map_err(broken)?;
    if tree.truncated {
        return Err(Failure::Broken("GitHub отдал не весь список файлов".into()));
    }
    let mut plugins: BTreeMap<String, Vec<RemoteFile>> = BTreeMap::new();
    for item in tree.tree {
        // папки, подмодули и символические ссылки не скачиваются
        if item.kind != "blob" || item.mode == "120000" {
            continue;
        }
        let Some((id, path)) = item.path.split_once('/') else {
            continue;
        };
        if !manifest::valid_id(id) || manifest::relative_path(path).is_none() {
            continue;
        }
        let file = RemoteFile {
            path: path.to_owned(),
            size: item.size,
            sha: item.sha,
        };
        plugins.entry(id.to_owned()).or_default().push(file);
    }
    plugins.retain(|_, files| has_manifest(files));
    Ok(plugins)
}

/// Есть ли среди файлов `plugin.toml`.
fn has_manifest(files: &[RemoteFile]) -> bool {
    files.iter().any(|f| f.path == manifest::PLUGIN_MANIFEST)
}

/// Последний коммит ветки каталога.
fn fetch_commit(repo: &str) -> Result<String, Failure> {
    let address = format!("{API}{repo}/commits/{BRANCH}");
    let url = Url::parse(&address).map_err(|error| Failure::Broken(error.to_string()))?;
    let commit = download(&url, ACCEPT_SHA, 128)?;
    let commit = String::from_utf8_lossy(&commit).trim().to_owned();
    if commit.len() != 40 || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Failure::Broken("GitHub не назвал коммит".into()));
    }
    Ok(commit)
}

/// Плагины каталога в коммите `commit`.
fn fetch_tree(repo: &str, commit: &str) -> Result<BTreeMap<String, Vec<RemoteFile>>, Failure> {
    let tree = format!("{API}{repo}/git/trees/{commit}:{CATALOG_DIR}?recursive=1");
    let url = Url::parse(&tree).map_err(|error| Failure::Broken(error.to_string()))?;
    match download(&url, ACCEPT_JSON, MAX_LISTING) {
        Ok(body) => parse_tree(&body),
        // папки plugins в репозитории нет — каталог пуст
        Err(Failure::Status(404)) => Ok(BTreeMap::new()),
        Err(failure) => Err(failure),
    }
}

/// Файл сохранённого каталога.
fn cache_path(extensions: &Extensions) -> PathBuf {
    extensions.plugins_dir().with_file_name(CACHE_FILE)
}

/// Прочитать сохранённый каталог; не читается — как будто его нет.
fn load_cache(path: &Path) -> Option<Listing> {
    let data = std::fs::read(path).ok()?;
    serde_json::from_slice(&data)
        .inspect_err(|error| tracing::warn!(%error, "сохранённый каталог плагинов не читается"))
        .ok()
}

/// Сохранить каталог: сначала во временный файл, потом на место.
fn save_cache(path: &Path, listing: &Listing) {
    let temp = path.with_extension("json.tmp");
    let result = serde_json::to_vec(listing)
        .map_err(std::io::Error::other)
        .and_then(|data| std::fs::write(&temp, data))
        .and_then(|()| std::fs::rename(&temp, path));
    if let Err(error) = result {
        tracing::warn!(%error, "каталог плагинов не сохранён");
    }
}

/// Каталог в памяти, при первом обращении — из файла.
fn cached(path: &Path) -> Option<Listing> {
    let mut cached = LISTING.lock().unwrap_or_else(PoisonError::into_inner);
    if cached.is_none() {
        *cached = load_cache(path);
    }
    cached.clone()
}

/// Запомнить каталог в памяти и в файле.
fn remember(path: &Path, listing: &Listing) {
    *LISTING.lock().unwrap_or_else(PoisonError::into_inner) = Some(listing.clone());
    save_cache(path, listing);
}

/// Список каталога: сохранённый, если он свежий; иначе — сверить коммит
/// и скачать дерево, только если коммит другой.
fn listing(path: &Path, refresh: bool) -> Result<Listing, Failure> {
    let old = cached(path);
    if let Some(listing) = old.as_ref().filter(|listing| !refresh && listing.fresh()) {
        return Ok(listing.clone());
    }
    let repo = repo()?;
    let commit = fetch_commit(repo)?;
    let listing = match old {
        Some(mut listing) if listing.commit == commit => {
            listing.checked = SystemTime::now();
            listing
        }
        old => {
            let plugins = fetch_tree(repo, &commit)?;
            // описания плагинов, чьи файлы не менялись, остаются
            let mut about: BTreeMap<String, BTreeMap<String, RemoteAbout>> = BTreeMap::new();
            for (language, entries) in old.map(|old| old.about).unwrap_or_default() {
                let kept: BTreeMap<String, RemoteAbout> = entries
                    .into_iter()
                    .filter(|(id, entry)| {
                        plugins
                            .get(id)
                            .is_some_and(|files| entry.signature == signature(files))
                    })
                    .collect();
                if !kept.is_empty() {
                    about.insert(language, kept);
                }
            }
            tracing::info!(%commit, plugins = plugins.len(), "каталог плагинов получен");
            Listing {
                commit,
                checked: SystemTime::now(),
                plugins,
                about,
            }
        }
    };
    remember(path, &listing);
    Ok(listing)
}

/// Перевод для языка интерфейса: точное совпадение кода, иначе — язык без
/// региона (`pt-BR` → `pt`), как у переводов установленных плагинов.
fn pick_locale<'a>(files: &'a [RemoteFile], language: &str) -> Option<&'a str> {
    let wanted = language.replace('_', "-").to_ascii_lowercase();
    let prefix = format!("{}/", manifest::LOCALES_DIR);
    let codes: Vec<&str> = files
        .iter()
        .filter_map(|file| file.path.strip_prefix(&prefix)?.strip_suffix(".toml"))
        .filter(|code| !code.contains('/'))
        .collect();
    let base = wanted.split('-').next().unwrap_or_default();
    codes
        .iter()
        .find(|code| code.to_ascii_lowercase() == wanted)
        .or_else(|| codes.iter().find(|code| code.to_ascii_lowercase() == base))
        .copied()
}

/// Текст файла плагина из каталога.
fn download_text(repo: &str, listing: &Listing, id: &str, path: &str) -> Result<String, Failure> {
    let url = raw_url(repo, &listing.commit, id, path)?;
    let body = download(&url, "", MAX_ABOUT_FILE)?;
    let error = format!("{path} — не UTF-8");
    String::from_utf8(body).map_err(|_| Failure::Broken(error))
}

/// Название, описание и значок плагина из каталога на языке `language`.
fn fetch_about(repo: &str, listing: &Listing, id: &str, language: &str) -> RemoteAbout {
    let files = listing.plugins.get(id).map(Vec::as_slice).unwrap_or(&[]);
    let parsed = download_text(repo, listing, id, manifest::PLUGIN_MANIFEST)
        .map_err(|failure| CommandError::from(failure).message)
        .and_then(|text| manifest::catalog_about(&text));
    let (mut about, icon) = match parsed {
        Ok(parsed) => parsed,
        Err(error) => {
            tracing::warn!(plugin = id, %error, "plugin.toml из каталога не читается");
            return RemoteAbout {
                name: Some(id.to_owned()),
                error: Some(error),
                signature: signature(files),
                ..RemoteAbout::default()
            };
        }
    };
    if let Some(code) = pick_locale(files, language) {
        let path = format!("{}/{code}.toml", manifest::LOCALES_DIR);
        if let Ok(text) = download_text(repo, listing, id, &path) {
            let (name, description) = manifest::locale_about(&text);
            about.name = name.or(about.name);
            about.description = description.or(about.description);
        }
    }
    let icon = icon
        .filter(|icon| files.iter().any(|file| &file.path == icon))
        .and_then(|icon| {
            let url = raw_url(repo, &listing.commit, id, &icon).ok()?;
            let body = download(&url, "", MAX_ABOUT_FILE).ok()?;
            let mime = extensions::mime_type(Path::new(&icon));
            let data = crate::plugin_host::base64(&body);
            Some(format!("data:{mime};base64,{data}"))
        });
    RemoteAbout {
        name: about.name,
        version: about.version,
        author: about.author,
        description: about.description,
        icon,
        error: None,
        signature: signature(files),
    }
}

/// Описания плагинов `ids` — по [`PARALLEL`] одновременно.
fn fetch_abouts(
    repo: &str,
    listing: &Listing,
    ids: &[String],
    language: &str,
) -> Vec<(String, RemoteAbout)> {
    let mut fetched = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(PARALLEL) {
        std::thread::scope(|scope| {
            let tasks: Vec<_> = chunk
                .iter()
                .map(|id| scope.spawn(move || fetch_about(repo, listing, id, language)))
                .collect();
            for (id, task) in chunk.iter().zip(tasks) {
                if let Ok(about) = task.join() {
                    fetched.push((id.clone(), about));
                }
            }
        });
    }
    fetched
}

/// Новее ли версия `remote`, чем `local`: числа через точку сравниваются
/// как числа (`1.10.0` новее `1.9.2`). Установленная без версии или с
/// версией не из чисел — новее любая другая.
fn newer(remote: &str, local: Option<&str>) -> bool {
    let Some(local) = local else {
        return true;
    };
    let numbers = |version: &str| -> Option<Vec<u64>> {
        let version = version.trim().trim_start_matches(['v', 'V']);
        let core = version.split(['-', '+']).next().unwrap_or_default();
        core.split('.').map(|part| part.parse().ok()).collect()
    };
    match (numbers(remote), numbers(local)) {
        (Some(mut remote), Some(mut local)) => {
            let length = remote.len().max(local.len());
            remote.resize(length, 0);
            local.resize(length, 0);
            remote > local
        }
        _ => remote.trim() != local.trim(),
    }
}

/// Плагины каталога с отметками об установленных.
fn view(extensions: &Extensions, listing: &Listing, language: &str) -> Vec<CatalogPlugin> {
    let installed = extensions.folder_versions();
    listing
        .plugins
        .iter()
        .map(|(id, files)| {
            let remote = listing.about(language, id).cloned().unwrap_or_default();
            let local = installed.get(id);
            let update = match (local, remote.version.as_deref()) {
                (Some(local), Some(version)) => newer(version, local.as_deref()),
                _ => false,
            };
            CatalogPlugin {
                id: id.clone(),
                name: remote.name,
                description: remote.description,
                author: remote.author,
                version: remote.version,
                icon: remote.icon,
                size: files.iter().map(|file| file.size).sum(),
                installed: local.is_some(),
                installed_version: local.cloned().flatten(),
                update: update && remote.error.is_none(),
                error: remote.error,
            }
        })
        .collect()
}

/// Каталог с отметками об установленных плагинах.
fn catalog(
    extensions: &Extensions,
    language: &str,
    refresh: bool,
) -> CmdResult<Vec<CatalogPlugin>> {
    let path = cache_path(extensions);
    let mut listing = listing(&path, refresh)?;
    let language = language_key(language);
    let missing: Vec<String> = listing
        .plugins
        .keys()
        .filter(|id| listing.about(&language, id).is_none())
        .cloned()
        .collect();
    if !missing.is_empty() {
        let fetched = fetch_abouts(repo()?, &listing, &missing, &language);
        let entries = listing.about.entry(language.clone()).or_default();
        entries.extend(fetched);
        // пока скачивались описания, каталог могли обновить — тогда не трогать
        let same = LISTING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .is_some_and(|cached| cached.commit == listing.commit);
        if same {
            remember(&path, &listing);
        }
    }
    Ok(view(extensions, &listing, &language))
}

/// Сохранённый каталог без сети; `None` — его нет или нет описаний на
/// этом языке.
fn saved(extensions: &Extensions, language: &str) -> Option<SavedCatalog> {
    let listing = cached(&cache_path(extensions))?;
    let language = language_key(language);
    let complete = listing
        .plugins
        .keys()
        .all(|id| listing.about(&language, id).is_some());
    complete.then(|| SavedCatalog {
        fresh: listing.fresh(),
        plugins: view(extensions, &listing, &language),
    })
}

/// Сообщить окну каталога, сколько скачано.
fn report(app: &AppHandle, id: &str, received: u64, total: u64) {
    let progress = Progress {
        id,
        received,
        total,
    };
    if let Ok(json) = serde_json::to_string(&progress) {
        extensions::call_page(app, &format!("catalogProgress({json})"));
    }
}

/// Ошибка записи скачанного плагина.
fn not_written(error: std::io::Error) -> CommandError {
    CommandError::translated(
        "catalog",
        "pluginNotWritten",
        vec![error.to_string()],
        format!("плагин не записан: {error}"),
    )
}

/// Скачать файлы плагина `id` в папку `staging` и проверить, что плагин
/// читается.
fn fetch_files(
    app: &AppHandle,
    listing: &Listing,
    repo: &str,
    id: &str,
    files: &[RemoteFile],
    staging: &Path,
) -> CmdResult<()> {
    let total: u64 = files.iter().map(|file| file.size).sum();
    let mut received = 0u64;
    let mut reported = Instant::now();
    report(app, id, 0, total);
    for file in files {
        let Some(relative) = manifest::relative_path(&file.path) else {
            continue;
        };
        let url = raw_url(repo, &listing.commit, id, &file.path)?;
        let body = download_counted(&url, file.size, |length| {
            received += length as u64;
            if reported.elapsed() >= PROGRESS_INTERVAL {
                reported = Instant::now();
                report(app, id, received.min(total), total);
            }
        })?;
        if body.len() as u64 != file.size {
            let error = format!("{} скачан не целиком", file.path);
            return Err(Failure::Broken(error).into());
        }
        let path = staging.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(not_written)?;
        }
        std::fs::write(&path, &body).map_err(not_written)?;
    }
    report(app, id, total, total);
    // скачанный плагин должен читаться, как положенный вручную
    let invalid = |error: String| {
        CommandError::translated(
            "catalog",
            "pluginInvalid",
            vec![error.clone()],
            format!("скачанный плагин не читается: {error}"),
        )
    };
    let path = staging.join(manifest::PLUGIN_MANIFEST);
    let text = std::fs::read_to_string(path).map_err(not_written)?;
    manifest::parse_plugin(staging, &text).map_err(invalid)?;
    Ok(())
}

/// Скачать плагин `id` из каталога во временную папку и поставить его на
/// место установленного.
fn install(app: &AppHandle, extensions: &Extensions, id: &str) -> CmdResult<()> {
    let listing = listing(&cache_path(extensions), false)?;
    let repo = repo()?;
    let Some(files) = listing.plugins.get(id) else {
        return Err(CommandError::translated(
            "catalog",
            "catalogMissing",
            vec![],
            "этого плагина нет в каталоге",
        ));
    };
    let total: u64 = files.iter().map(|file| file.size).sum();
    if files.len() > MAX_FILES || total > MAX_PLUGIN_SIZE {
        return Err(CommandError::translated(
            "catalog",
            "catalogPluginTooLarge",
            vec![],
            "плагин больше 64 МБ или из больше чем 256 файлов",
        ));
    }
    let dir = extensions.plugins_dir();
    let staging = dir.join(format!("{DOWNLOAD_PREFIX}{id}"));
    std::fs::create_dir_all(&dir).map_err(not_written)?;
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(not_written)?;
    }
    let result = fetch_files(app, &listing, repo, id, files, &staging)
        .and_then(|()| extensions.replace_plugin(id, &staging).map_err(not_written));
    if result.is_err() && staging.exists() {
        let removed = std::fs::remove_dir_all(&staging);
        if let Err(error) = removed {
            tracing::warn!(%error, "временная папка плагина не удалена");
        }
    }
    result
}

/// Каталог плагинов на языке интерфейса; `refresh` — не брать сохранённый
/// список.
#[tauri::command]
pub async fn extensions_catalog(
    language: String,
    refresh: bool,
    extensions: State<'_, Arc<Extensions>>,
) -> CmdResult<Vec<CatalogPlugin>> {
    let extensions = Arc::clone(extensions.inner());
    let task = move || catalog(&extensions, &language, refresh);
    tauri::async_runtime::spawn_blocking(task).await?
}

/// Сохранённый каталог на языке интерфейса — без сети, чтобы окно
/// показало плагины сразу; `null` — сохранённого нет.
#[tauri::command]
pub async fn extensions_catalog_saved(
    language: String,
    extensions: State<'_, Arc<Extensions>>,
) -> CmdResult<Option<SavedCatalog>> {
    let extensions = Arc::clone(extensions.inner());
    let task = move || saved(&extensions, &language);
    Ok(tauri::async_runtime::spawn_blocking(task).await?)
}

/// Скачать плагин из каталога: установить, обновить или скачать заново.
/// Возвращает каталог с новыми отметками.
#[tauri::command]
pub async fn extensions_install_plugin(
    id: String,
    language: String,
    app: AppHandle,
    extensions: State<'_, Arc<Extensions>>,
) -> CmdResult<Vec<CatalogPlugin>> {
    let extensions = Arc::clone(extensions.inner());
    let handle = app.clone();
    let task = move || {
        install(&handle, &extensions, &id)?;
        tracing::info!(plugin = %id, "плагин скачан из каталога");
        catalog(&extensions, &language, false)
    };
    let result = tauri::async_runtime::spawn_blocking(task).await?;
    desktop::refresh_tray(&app);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, size: u64) -> RemoteFile {
        RemoteFile {
            path: path.to_owned(),
            size,
            sha: String::new(),
        }
    }

    fn files(paths: &[&str]) -> Vec<RemoteFile> {
        paths.iter().map(|path| file(path, 1)).collect()
    }

    #[test]
    fn repository_is_github() {
        let repo = repo().unwrap();
        assert_eq!(repo.split('/').count(), 2);
        assert!(extensions::REPOSITORY.ends_with(repo));
    }

    #[test]
    fn raw_url_points_to_commit() {
        let url = raw_url("o/r", "abc", "tr", "locales/ru.toml").unwrap();
        assert_eq!(
            url.as_str(),
            "https://raw.githubusercontent.com/o/r/abc/plugins/tr/locales/ru.toml"
        );
        let url = raw_url("o/r", "abc", "x", "my file.svg").unwrap();
        assert!(url.as_str().ends_with("/plugins/x/my%20file.svg"));
    }

    #[test]
    fn tree_lists_plugin_folders() {
        let body = br#"{"sha":"t","truncated":false,"tree":[
            {"path":"README.md","mode":"100644","type":"blob","size":5},
            {"path":"translator","mode":"040000","type":"tree"},
            {"path":"translator/plugin.toml","mode":"100644","type":"blob","size":10,"sha":"aa"},
            {"path":"translator/locales","mode":"040000","type":"tree"},
            {"path":"translator/locales/ru.toml","mode":"100644","type":"blob","size":3},
            {"path":"translator/link","mode":"120000","type":"blob","size":3},
            {"path":"no-manifest/main.js","mode":"100644","type":"blob","size":3},
            {"path":".hidden/plugin.toml","mode":"100644","type":"blob","size":3}
        ]}"#;
        let plugins = parse_tree(body).unwrap();
        assert_eq!(plugins.keys().collect::<Vec<_>>(), ["translator"]);
        let mut manifest = file("plugin.toml", 10);
        manifest.sha = "aa".into();
        let expected = [manifest, file("locales/ru.toml", 3)];
        assert_eq!(plugins["translator"], expected);
        let truncated = br#"{"truncated":true,"tree":[]}"#;
        assert!(parse_tree(truncated).is_err());
    }

    #[test]
    fn locale_follows_interface_language() {
        let list = files(&["plugin.toml", "locales/ru.toml", "locales/pt-BR.toml"]);
        assert_eq!(pick_locale(&list, "ru"), Some("ru"));
        assert_eq!(pick_locale(&list, "pt_br"), Some("pt-BR"));
        assert_eq!(pick_locale(&list, "ru-RU"), Some("ru"));
        assert_eq!(pick_locale(&list, "en"), None);
    }

    #[test]
    fn versions_compare_as_numbers() {
        assert!(newer("1.10.0", Some("1.9.2")));
        assert!(newer("1.2.1", Some("1.2")));
        assert!(!newer("1.2.0", Some("1.2")));
        assert!(!newer("1.2.0", Some("1.3.0")));
        assert!(newer("v2.0.0", Some("1.9.9")));
        assert!(newer("1.0.0", None));
        assert!(newer("beta", Some("alpha")));
        assert!(!newer("beta", Some("beta")));
    }

    #[test]
    fn signature_follows_file_contents() {
        let before = files(&["plugin.toml", "main.js"]);
        let mut after = before.clone();
        assert_eq!(signature(&before), signature(&after));
        after[1].sha = "changed".into();
        assert_ne!(signature(&before), signature(&after));
    }

    #[test]
    fn cache_survives_restart() {
        let dir = std::env::temp_dir().join(format!("arachnid-catalog-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CACHE_FILE);
        let mut about = BTreeMap::new();
        let entry = RemoteAbout {
            name: Some("Переводчик".into()),
            ..RemoteAbout::default()
        };
        about.insert(
            "ru".to_owned(),
            BTreeMap::from([("translator".to_owned(), entry)]),
        );
        let listing = Listing {
            commit: "c".repeat(40),
            checked: SystemTime::now(),
            plugins: BTreeMap::from([("translator".to_owned(), files(&["plugin.toml"]))]),
            about,
        };
        save_cache(&path, &listing);
        let loaded = load_cache(&path).unwrap();
        assert_eq!(loaded.commit, listing.commit);
        assert!(loaded.fresh());
        let name = loaded
            .about("ru", "translator")
            .and_then(|entry| entry.name.as_deref());
        assert_eq!(name, Some("Переводчик"));
        std::fs::write(&path, "не json").unwrap();
        assert!(load_cache(&path).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
