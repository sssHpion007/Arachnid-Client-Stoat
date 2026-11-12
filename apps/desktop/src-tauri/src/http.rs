//! Загрузка файлов по HTTPS средствами Windows (WinHTTP).
//!
//! Нужна для скачиваемых наборов эмодзи (`emoji_packs.rs`). WinHTTP — часть
//! системы: не тянет в клиент отдельный HTTP-стек с TLS и сам берёт прокси из
//! настроек Windows (`WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY`), так что загрузка
//! идёт тем же путём, что и у браузера. Переадресации (GitHub отдаёт файлы
//! релиза с другого адреса) WinHTTP выполняет сам.

use std::ffi::c_void;

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

/// Скачать `url`. `on_length` получает размер из Content-Length (если он
/// есть) до первых данных, `on_data` — данные по кускам.
pub fn get(
    url: &Url,
    on_length: impl FnOnce(Option<u64>),
    mut on_data: impl FnMut(&[u8]) -> Result<(), StopReason>,
) -> Result<(), Error> {
    let secure = match url.scheme() {
        "https" => true,
        "http" => false,
        _ => return Err(Error::Url),
    };
    let host = HSTRING::from(url.host_str().ok_or(Error::Url)?);
    let port = url.port_or_known_default().ok_or(Error::Url)?;
    let path = HSTRING::from(&url[url::Position::BeforePath..]);
    let flags = if secure {
        wh::WINHTTP_FLAG_SECURE
    } else {
        wh::WINHTTP_OPEN_REQUEST_FLAGS(0)
    };

    // SAFETY: строки живут до конца функции, дескрипторы закрывает Handle
    // (запрос — раньше соединения, соединение — раньше сессии)
    unsafe {
        let session = Handle::new(wh::WinHttpOpen(
            w!("Arachnid Client"),
            wh::WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        ))?;
        wh::WinHttpSetTimeouts(session.0, TIMEOUT_MS, TIMEOUT_MS, TIMEOUT_MS, TIMEOUT_MS)?;
        let connection = Handle::new(wh::WinHttpConnect(session.0, &host, port, 0))?;
        let request = Handle::new(wh::WinHttpOpenRequest(
            connection.0,
            w!("GET"),
            &path,
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            flags,
        ))?;
        wh::WinHttpSendRequest(request.0, None, None, 0, 0, 0)?;
        wh::WinHttpReceiveResponse(request.0, std::ptr::null_mut())?;

        let status = query_number::<u32>(&request, STATUS)?;
        if status != 200 {
            return Err(Error::Status(status));
        }
        let length = query_number::<u64>(&request, LENGTH);
        on_length(length.ok());

        let mut buffer = vec![0u8; CHUNK];
        let capacity = CHUNK as u32;
        loop {
            let mut read = 0u32;
            let target = buffer.as_mut_ptr().cast();
            wh::WinHttpReadData(request.0, target, capacity, &mut read)?;
            if read == 0 {
                return Ok(());
            }
            on_data(&buffer[..read as usize]).map_err(Error::Stopped)?;
        }
    }
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
