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
//! Скачанный плагин сначала собирается во временной папке
//! `plugins/.download-<id>` (папки с точкой клиент не читает) и
//! проверяется: `plugin.toml` должен читаться, как у положенного вручную.
//! Только после этого он занимает место старой версии. Новый плагин
//! выключен, как и положенный в папку вручную; у обновлённого остаются
//! включённость, настройки, разрешения и хранилище.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

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

/// Файл плагина в каталоге.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteFile {
    /// Путь внутри папки плагина, через `/`
    path: String,
    /// Размер, байт
    size: u64,
}

/// Название, описание и значок плагина из каталога на одном языке.
#[derive(Debug, Clone, Default)]
struct RemoteAbout {
    about: manifest::About,
    /// Значок — адрес `data:`
    icon: Option<String>,
    /// Почему `plugin.toml` не читается
    error: Option<String>,
}

/// Список каталога на момент запроса.
#[derive(Debug, Clone)]
struct Listing {
    /// Коммит, из которого скачиваются файлы
    commit: String,
    fetched: Instant,
    /// Плагин → его файлы
    plugins: BTreeMap<String, Vec<RemoteFile>>,
    /// Описания: (язык, плагин) → описание
    about: BTreeMap<(String, String), RemoteAbout>,
}

/// Последний список каталога.
static LISTING: Mutex<Option<Listing>> = Mutex::new(None);

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
    let fetched = crate::http::fetch(url, headers, |_| limit)
        .map_err(|error| failure(error, url))?;
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

/// Скачать список каталога.
fn fetch_listing() -> Result<Listing, Failure> {
    let repo = repo()?;
    let broken = |error: url::ParseError| Failure::Broken(error.to_string());
    let address = format!("{API}{repo}/commits/{BRANCH}");
    let url = Url::parse(&address).map_err(broken)?;
    let commit = download(&url, ACCEPT_SHA, 128)?;
    let commit = String::from_utf8_lossy(&commit).trim().to_owned();
    if commit.len() != 40 || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Failure::Broken("GitHub не назвал коммит".into()));
    }
    let tree = format!("{API}{repo}/git/trees/{commit}:{CATALOG_DIR}?recursive=1");
    let url = Url::parse(&tree).map_err(broken)?;
    let plugins = match download(&url, ACCEPT_JSON, MAX_LISTING) {
        Ok(body) => parse_tree(&body)?,
        // папки plugins в репозитории нет — каталог пуст
        Err(Failure::Status(404)) => BTreeMap::new(),
        Err(failure) => return Err(failure),
    };
    tracing::info!(%commit, plugins = plugins.len(), "каталог плагинов получен");
    Ok(Listing {
        commit,
        fetched: Instant::now(),
        plugins,
        about: BTreeMap::new(),
    })
}

/// Список каталога: сохранённый, если он свежий, иначе — новый.
fn listing(refresh: bool) -> Result<Listing, Failure> {
    {
        let cached = LISTING.lock().unwrap_or_else(PoisonError::into_inner);
        let fresh = cached
            .as_ref()
            .filter(|listing| !refresh && listing.fetched.elapsed() < LISTING_TTL);
        if let Some(listing) = fresh {
            return Ok(listing.clone());
        }
    }
    let listing = fetch_listing()?;
    *LISTING.lock().unwrap_or_else(PoisonError::into_inner) = Some(listing.clone());
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
                about: manifest::About {
                    name: Some(id.to_owned()),
                    ..manifest::About::default()
                },
                icon: None,
                error: Some(error),
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
            Some(format!("data:{mime};base64,{}", crate::plugin_host::base64(&body)))
        });
    RemoteAbout {
        about,
        icon,
        error: None,
    }
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

/// Каталог с отметками об установленных плагинах.
fn catalog(
    extensions: &Extensions,
    language: &str,
    refresh: bool,
) -> CmdResult<Vec<CatalogPlugin>> {
    let mut listing = listing(refresh)?;
    let repo = repo()?;
    let language = language.replace('_', "-").to_ascii_lowercase();
    let key = |id: &String| (language.clone(), id.clone());
    let missing: Vec<String> = listing
        .plugins
        .keys()
        .filter(|&id| !listing.about.contains_key(&key(id)))
        .cloned()
        .collect();
    let fetched = !missing.is_empty();
    for id in missing {
        let about = fetch_about(repo, &listing, &id, &language);
        listing.about.insert(key(&id), about);
    }
    if fetched {
        let mut cached = LISTING.lock().unwrap_or_else(PoisonError::into_inner);
        let same = cached.as_ref().map(|cached| &cached.commit) == Some(&listing.commit);
        if same {
            *cached = Some(listing.clone());
        }
    }
    let installed = extensions.folder_versions();
    let plugins = listing
        .plugins
        .iter()
        .map(|(id, files)| {
            let remote = listing.about.get(&key(id)).cloned().unwrap_or_default();
            let local = installed.get(id);
            let update = match (local, remote.about.version.as_deref()) {
                (Some(local), Some(version)) => newer(version, local.as_deref()),
                _ => false,
            };
            CatalogPlugin {
                id: id.clone(),
                name: remote.about.name,
                description: remote.about.description,
                author: remote.about.author,
                version: remote.about.version,
                icon: remote.icon,
                size: files.iter().map(|file| file.size).sum(),
                installed: local.is_some(),
                installed_version: local.cloned().flatten(),
                update: update && remote.error.is_none(),
                error: remote.error,
            }
        })
        .collect();
    Ok(plugins)
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
    listing: &Listing,
    repo: &str,
    id: &str,
    files: &[RemoteFile],
    staging: &Path,
) -> CmdResult<()> {
    for file in files {
        let Some(relative) = manifest::relative_path(&file.path) else {
            continue;
        };
        let url = raw_url(repo, &listing.commit, id, &file.path)?;
        let limit = usize::try_from(file.size).unwrap_or(usize::MAX);
        let body = download(&url, "", limit)?;
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
fn install(extensions: &Extensions, id: &str) -> CmdResult<()> {
    let listing = listing(false)?;
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
    let result = fetch_files(&listing, repo, id, files, &staging)
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
    let task = move || {
        install(&extensions, &id)?;
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
            {"path":"translator/plugin.toml","mode":"100644","type":"blob","size":10},
            {"path":"translator/locales","mode":"040000","type":"tree"},
            {"path":"translator/locales/ru.toml","mode":"100644","type":"blob","size":3},
            {"path":"translator/link","mode":"120000","type":"blob","size":3},
            {"path":"no-manifest/main.js","mode":"100644","type":"blob","size":3},
            {"path":".hidden/plugin.toml","mode":"100644","type":"blob","size":3}
        ]}"#;
        let plugins = parse_tree(body).unwrap();
        assert_eq!(plugins.keys().collect::<Vec<_>>(), ["translator"]);
        let expected = [file("plugin.toml", 10), file("locales/ru.toml", 3)];
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
}
