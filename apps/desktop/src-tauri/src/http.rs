//! Загрузка файлов по HTTPS средствами Windows (WinHTTP).
//!
//! Нужна для скачиваемых наборов эмодзи (`emoji_packs.rs`), запросов
//! плагинов с разрешением на сеть (`plugin_host.rs`) и ссылок избранных GIF
//! (`favorite_gifs.rs`). WinHTTP — часть
//! системы: не тянет в клиент отдельный HTTP-стек с TLS и сам берёт прокси из
//! настроек Windows (`WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY`), так что загрузка
//! идёт тем же путём, что и у браузера. Переадресации (GitHub отдаёт файлы
//! релиза с другого адреса) WinHTTP выполняет сам.
//!
//! Сессия WinHTTP одна на процесс: соединения с сервером (и рукопожатия TLS)
//! переиспользуются между запросами — картинки эмодзи с сервера идут сотнями,
//! а по HTTP/2 одновременные запросы идут по одному соединению.

use std::ffi::c_void;
use std::sync::{Arc, Mutex, PoisonError};

use url::Url;
use windows::Win32::Foundation::GetLastError;
use windows::Win32::Networking::WinHttp as wh;
use windows_core::{HSTRING, PCWSTR, w};

/// Сколько ждать соединения и данных, мс.
const TIMEOUT_MS: i32 = 30_000;

/// Заголовки ответа, которые читает загрузка.
const STATUS: u32 = wh::WINHTTP_QUERY_STATUS_CODE;
const LENGTH: u32 = wh::WINHTTP_QUERY_CONTENT_LENGTH;

/// Размер куска при чтении ответа.
const CHUNK: usize = 64 * 1024;

/// Почему загрузка не удалась.
#[derive(Debug)]
pub enum Error {
    /// Ошибка WinHTTP (нет сети, имя не найдено, TLS…): код Win32
    Network(u32),
    /// Сервер ответил не 200
    Status(u32),
    /// Адрес не подходит для загрузки
    Url,
    /// Получатель данных прервал загрузку (отмена, ошибка записи)
    Stopped(StopReason),
}

/// Почему получатель прервал загрузку.
#[derive(Debug)]
pub enum StopReason {
    Cancelled,
    TooLarge,
    Io(std::io::Error),
}

impl From<windows_core::Error> for Error {
    fn from(error: windows_core::Error) -> Self {
        // ошибки WinHTTP приходят как HRESULT_FROM_WIN32(код)
        Self::Network((error.code().0 as u32) & 0xFFFF)
    }
}

/// Ошибка последнего вызова WinHTTP, вернувшего пустой дескриптор.
fn last_error() -> Error {
    // SAFETY: читает код ошибки текущего потока
    Error::Network(unsafe { GetLastError() }.0)
}

/// Дескриптор WinHTTP, закрывается при выходе из области видимости.
struct Handle(*mut c_void);

impl Handle {
    fn new(raw: *mut c_void) -> Result<Self, Error> {
        if raw.is_null() {
            Err(last_error())
        } else {
            Ok(Self(raw))
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: дескриптор получен от WinHTTP и закрывается один раз
        let _ = unsafe { wh::WinHttpCloseHandle(self.0) };
    }
}

/// Сессия WinHTTP.
struct Session(Handle);

// SAFETY: дескрипторы WinHTTP можно использовать из любых потоков; сессия
// только открывает соединения и закрывается после последнего запроса (Arc)
unsafe impl Send for Session {}
unsafe impl Sync for Session {}

/// Общая сессия; открывается при первом запросе (снова — если не открылась).
fn session() -> Result<Arc<Session>, Error> {
    static SESSION: Mutex<Option<Arc<Session>>> = Mutex::new(None);
    let mut shared = SESSION.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(session) = shared.as_ref() {
        return Ok(Arc::clone(session));
    }
    // SAFETY: строка агента статическая, дескриптор закрывает Handle
    let session = unsafe {
        let handle = Handle::new(wh::WinHttpOpen(
            w!("Arachnid Client"),
            wh::WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        ))?;
        wh::WinHttpSetTimeouts(handle.0, TIMEOUT_MS, TIMEOUT_MS, TIMEOUT_MS, TIMEOUT_MS)?;
        // HTTP/2 (Windows 10 1607+): одновременные запросы к одному серверу
        // идут по одному соединению; где его нет — HTTP/1.1
        let option = wh::WINHTTP_OPTION_ENABLE_HTTP_PROTOCOL;
        let http2 = wh::WINHTTP_PROTOCOL_FLAG_HTTP2.to_ne_bytes();
        let raw = Some(handle.0.cast_const());
        if let Err(error) = wh::WinHttpSetOption(raw, option, Some(http2.as_slice())) {
            tracing::debug!(%error, "HTTP/2 в WinHTTP недоступен");
        }
        Arc::new(Session(handle))
    };
    *shared = Some(Arc::clone(&session));
    Ok(session)
}

/// Сервер, порт и путь запроса.
struct Target {
    host: HSTRING,
    port: u16,
    path: HSTRING,
    flags: wh::WINHTTP_OPEN_REQUEST_FLAGS,
}

impl Target {
    fn of(url: &Url) -> Result<Self, Error> {
        let secure = match url.scheme() {
            "https" => true,
            "http" => false,
            _ => return Err(Error::Url),
        };
        Ok(Self {
            host: HSTRING::from(url.host_str().ok_or(Error::Url)?),
            port: url.port_or_known_default().ok_or(Error::Url)?,
            path: HSTRING::from(&url[url::Position::BeforePath..]),
            flags: if secure {
                wh::WINHTTP_FLAG_SECURE
            } else {
                wh::WINHTTP_OPEN_REQUEST_FLAGS(0)
            },
        })
    }
}

/// Открыть запрос: дескриптор соединения нужен, пока жив запрос.
///
/// # Safety
///
/// Строки `verb` и `target` должны жить, пока жив запрос.
unsafe fn open(
    session: &Session,
    verb: &HSTRING,
    target: &Target,
) -> Result<(Handle, Handle), Error> {
    // SAFETY: дескрипторы закрывает Handle, строки живут у вызывающего
    unsafe {
        let raw = wh::WinHttpConnect(session.0.0, &target.host, target.port, 0);
        let connection = Handle::new(raw)?;
        let request = Handle::new(wh::WinHttpOpenRequest(
            connection.0,
            verb,
            &target.path,
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            target.flags,
        ))?;
        Ok((connection, request))
    }
}

/// Скачать `url`. `on_length` получает размер из Content-Length (если он
/// есть) до первых данных, `on_data` — данные по кускам.
pub fn get(
    url: &Url,
    on_length: impl FnOnce(Option<u64>),
    on_data: impl FnMut(&[u8]) -> Result<(), StopReason>,
) -> Result<(), Error> {
    let target = Target::of(url)?;
    let verb = HSTRING::from("GET");
    let session = session()?;
    // SAFETY: строки живут до конца функции; запрос закрывается раньше
    // соединения (порядок полей кортежа), сессию держит Arc
    unsafe {
        let (_connection, request) = open(&session, &verb, &target)?;
        wh::WinHttpSendRequest(request.0, None, None, 0, 0, 0)?;
        wh::WinHttpReceiveResponse(request.0, std::ptr::null_mut())?;

        let status = query_number::<u32>(&request, STATUS)?;
        if status != 200 {
            return Err(Error::Status(status));
        }
        let length = query_number::<u64>(&request, LENGTH);
        on_length(length.ok());
        read_body(&request, on_data)
    }
}

/// Ответ на запрос плагина.
pub struct Response {
    /// Код ответа
    pub status: u32,
    /// Заголовки: имя в нижнем регистре и значение
    pub headers: Vec<(String, String)>,
    /// Тело
    pub body: Vec<u8>,
}

/// Запрос плагина: любой метод, свои заголовки (`Имя: значение\r\n…`) и
/// тело. Переадресации не выполняются: ответ 3xx возвращается как есть, и
/// адрес из `Location` плагин запрашивает снова — со своей проверкой
/// разрешённых адресов. Тело больше `limit` байт — ошибка.
pub fn request(
    method: &str,
    url: &Url,
    headers: &str,
    body: &[u8],
    limit: usize,
) -> Result<Response, Error> {
    let target = Target::of(url)?;
    let verb = HSTRING::from(method);
    let extra: Vec<u16> = headers.encode_utf16().collect();
    let length = u32::try_from(body.len()).map_err(|_| Error::Url)?;
    let session = session()?;
    // SAFETY: строки и тело живут до конца функции; запрос закрывается
    // раньше соединения, сессию держит Arc
    unsafe {
        let (_connection, request) = open(&session, &verb, &target)?;
        let redirects = wh::WINHTTP_DISABLE_REDIRECTS.to_ne_bytes();
        wh::WinHttpSetOption(
            Some(request.0.cast_const()),
            wh::WINHTTP_OPTION_DISABLE_FEATURE,
            Some(redirects.as_slice()),
        )?;
        let headers = (!extra.is_empty()).then_some(extra.as_slice());
        let optional = (!body.is_empty()).then(|| body.as_ptr().cast::<c_void>());
        wh::WinHttpSendRequest(request.0, headers, optional, length, length, 0)?;
        wh::WinHttpReceiveResponse(request.0, std::ptr::null_mut())?;

        let status = query_number::<u32>(&request, STATUS)?;
        let headers = parse_headers(&raw_headers(&request)?);
        let mut data = Vec::new();
        read_body(&request, |chunk| {
            if data.len() + chunk.len() > limit {
                return Err(StopReason::TooLarge);
            }
            data.extend_from_slice(chunk);
            Ok(())
        })?;
        Ok(Response {
            status,
            headers,
            body: data,
        })
    }
}

/// Ответ на запрос по ссылке пользователя.
pub struct Fetched {
    /// Заголовки: имя в нижнем регистре и значение
    pub headers: Vec<(String, String)>,
    /// Тело — не больше предела
    pub body: Vec<u8>,
    /// Тело прочитано целиком (не упёрлось в предел)
    pub complete: bool,
}

/// GET по ссылке, которую дал пользователь (избранные GIF): переадресации
/// WinHTTP выполняет сам, ответ — только 200. `limit` по заголовкам ответа
/// решает, сколько байт тела прочитать: тело длиннее обрезается
/// (`complete: false`), 0 — тело не читается вовсе.
pub fn fetch(
    url: &Url,
    headers: &str,
    limit: impl FnOnce(&[(String, String)]) -> usize,
) -> Result<Fetched, Error> {
    let target = Target::of(url)?;
    let verb = HSTRING::from("GET");
    let extra: Vec<u16> = headers.encode_utf16().collect();
    let session = session()?;
    // SAFETY: строки живут до конца функции; запрос закрывается раньше
    // соединения, сессию держит Arc
    unsafe {
        let (_connection, request) = open(&session, &verb, &target)?;
        let headers = (!extra.is_empty()).then_some(extra.as_slice());
        wh::WinHttpSendRequest(request.0, headers, None, 0, 0, 0)?;
        wh::WinHttpReceiveResponse(request.0, std::ptr::null_mut())?;

        let status = query_number::<u32>(&request, STATUS)?;
        if status != 200 {
            return Err(Error::Status(status));
        }
        let headers = parse_headers(&raw_headers(&request)?);
        let limit = limit(&headers);
        let mut body = Vec::new();
        let mut complete = true;
        if limit == 0 {
            return Ok(Fetched {
                headers,
                body,
                complete,
            });
        }
        let read = read_body(&request, |chunk| {
            let room = limit - body.len();
            if chunk.len() > room {
                body.extend_from_slice(&chunk[..room]);
                return Err(StopReason::TooLarge);
            }
            body.extend_from_slice(chunk);
            Ok(())
        });
        match read {
            Ok(()) => {}
            Err(Error::Stopped(StopReason::TooLarge)) => complete = false,
            Err(error) => return Err(error),
        }
        Ok(Fetched {
            headers,
            body,
            complete,
        })
    }
}

/// Прочитать тело ответа по кускам.
///
/// # Safety
///
/// `request` — запрос, для которого уже получен ответ.
unsafe fn read_body(
    request: &Handle,
    mut on_data: impl FnMut(&[u8]) -> Result<(), StopReason>,
) -> Result<(), Error> {
    let mut buffer = vec![0u8; CHUNK];
    let capacity = CHUNK as u32;
    loop {
        let mut read = 0u32;
        let target = buffer.as_mut_ptr().cast();
        // SAFETY: буфер на `capacity` байт живёт до конца цикла
        unsafe { wh::WinHttpReadData(request.0, target, capacity, &mut read)? };
        if read == 0 {
            return Ok(());
        }
        on_data(&buffer[..read as usize]).map_err(Error::Stopped)?;
    }
}

/// Заголовки ответа одной строкой, как пришли (`HTTP/1.1 200 OK\r\n…`).
///
/// # Safety
///
/// `request` — запрос, для которого уже получен ответ.
unsafe fn raw_headers(request: &Handle) -> Result<String, Error> {
    let info = wh::WINHTTP_QUERY_RAW_HEADERS_CRLF;
    let mut size = 0u32;
    // SAFETY: без буфера WinHTTP только сообщает нужный размер в байтах
    // (и отвечает ошибкой ERROR_INSUFFICIENT_BUFFER)
    let _ = unsafe {
        wh::WinHttpQueryHeaders(
            request.0,
            info,
            PCWSTR::null(),
            None,
            &mut size,
            std::ptr::null_mut(),
        )
    };
    if size == 0 {
        return Ok(String::new());
    }
    let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
    // SAFETY: буфер на `size` байт живёт до конца функции
    unsafe {
        wh::WinHttpQueryHeaders(
            request.0,
            info,
            PCWSTR::null(),
            Some(buffer.as_mut_ptr().cast()),
            &mut size,
            std::ptr::null_mut(),
        )?;
    }
    let length = (size as usize / 2).min(buffer.len());
    Ok(String::from_utf16_lossy(&buffer[..length]))
}

/// Разобрать заголовки ответа: строка состояния пропускается, имена — в
/// нижнем регистре, повторы склеиваются через запятую (`Set-Cookie` — через
/// перевод строки, как в fetch).
fn parse_headers(raw: &str) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in raw.split("\r\n").skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name.is_empty() {
            continue;
        }
        match headers.iter_mut().find(|(known, _)| *known == name) {
            Some((known, joined)) => {
                joined.push_str(if *known == "set-cookie" { "\n" } else { ", " });
                joined.push_str(value);
            }
            None => headers.push((name, value.to_owned())),
        }
    }
    headers
}

/// Числовой заголовок ответа: `u32` или `u64`.
trait Number: Default {
    const FLAG: u32;
}

impl Number for u32 {
    const FLAG: u32 = wh::WINHTTP_QUERY_FLAG_NUMBER;
}

impl Number for u64 {
    const FLAG: u32 = wh::WINHTTP_QUERY_FLAG_NUMBER64;
}

/// Прочитать числовой заголовок ответа.
///
/// # Safety
///
/// `request` — запрос, для которого уже получен ответ.
unsafe fn query_number<T: Number>(request: &Handle, info: u32) -> Result<T, Error> {
    let mut value = T::default();
    let mut size = std::mem::size_of::<T>() as u32;
    // SAFETY: буфер — `value` нужного размера, индекс заголовка не нужен
    unsafe {
        wh::WinHttpQueryHeaders(
            request.0,
            info | T::FLAG,
            PCWSTR::null(),
            Some((&raw mut value).cast()),
            &mut size,
            std::ptr::null_mut(),
        )?;
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_headers_are_joined_like_fetch() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nVary: a\r\nvary: b\r\n\
                   Set-Cookie: x=1\r\nSet-Cookie: y=2\r\nbroken\r\n\r\n";
        let headers = parse_headers(raw);
        let get = |name: &str| {
            headers
                .iter()
                .find(|(known, _)| known == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(get("content-type"), Some("text/plain"));
        assert_eq!(get("vary"), Some("a, b"));
        assert_eq!(get("set-cookie"), Some("x=1\ny=2"));
        assert_eq!(headers.len(), 3);
    }
}
