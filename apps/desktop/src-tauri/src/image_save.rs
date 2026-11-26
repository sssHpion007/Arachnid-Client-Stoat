//! «Скачать изображение» в меню эмодзи (`emoji.js`): окно выбора эмодзи и
//! меню сообщения с эмодзи.
//!
//! Картинку берёт страница — ту же, что она показывает (стандартные эмодзи
//! клиент отдаёт растром PNG из своего набора, `emoji_packs.rs`, так что они
//! не идут заново с сервера), — и передаёт её команде `image_save`. Клиент
//! проверяет, что это картинка, спрашивает обычным окном «Сохранить как»
//! Windows, куда её записать (имя файла — имя эмодзи, расширение — по
//! содержимому), и записывает файл.
//!
//! Окно сохранения модальное для окна клиента и работает в своём потоке с
//! однопоточной квартирой COM (как требует IFileDialog): главный поток при
//! этом не занят, страница отвечает.

use crate::{CmdResult, CommandError};

/// Картинки больше не сохраняются: у эмодзи — сотни килобайт.
const MAX_IMAGE: usize = 32 * 1024 * 1024;
/// Самое длинное имя файла без расширения, символов.
const MAX_NAME: usize = 120;
/// Имя файла, если у картинки нет имени.
const FALLBACK_NAME: &str = "emoji";
/// Имена устройств Windows: файлом с таким именем (и любым расширением) не
/// сохранить.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Расширение файла по содержимому картинки; не картинка — `None`.
pub fn extension(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("png");
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Some("gif");
    }
    if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        return Some("webp");
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if data.len() >= 12 && &data[4..12] == b"ftypavif" {
        return Some("avif");
    }
    // SVG — текст: начало документа, без BOM и пробелов
    let head = String::from_utf8_lossy(&data[..data.len().min(4096)]);
    let head = head.trim_start_matches('\u{feff}').trim_start();
    let svg = head.starts_with("<svg") || (head.starts_with("<?xml") && head.contains("<svg"));
    svg.then_some("svg")
}

/// Имя файла для сохранения: имя эмодзи без символов, запрещённых в именах
/// файлов Windows, и расширение по содержимому.
pub fn file_name(name: &str, extension: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let stem: String = trimmed(&cleaned).chars().take(MAX_NAME).collect();
    let mut stem = trimmed(&stem).to_owned();
    if stem.is_empty() {
        stem = FALLBACK_NAME.to_owned();
    }
    let device = stem.split('.').next().unwrap_or_default().trim_end();
    if RESERVED.contains(&device.to_ascii_uppercase().as_str()) {
        stem.insert(0, '_');
    }
    format!("{stem}.{extension}")
}

/// Без точек и пробелов по краям: Windows их отбрасывает.
fn trimmed(text: &str) -> &str {
    text.trim_matches(|c: char| c == '.' || c.is_whitespace())
}

/// Почему картинка не сохранена. Страница показывает текст по коду на
/// языке интерфейса (`errors` в `locales/*.json`), `Display` — для журнала.
#[derive(Debug)]
enum SaveError {
    TooLarge,
    NotImage,
    /// Файл не записан: путь и ошибка
    #[cfg_attr(not(windows), allow(dead_code))]
    NotWritten(String, String),
    /// Поток окна сохранения упал
    #[cfg_attr(not(windows), allow(dead_code))]
    DialogFailed,
    /// Ошибка окна сохранения
    #[cfg_attr(not(windows), allow(dead_code))]
    Dialog(String),
    /// Сохранение есть только в Windows
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge => f.write_str("картинка больше 32 МБ"),
            Self::NotImage => f.write_str("это не картинка"),
            Self::NotWritten(path, error) => write!(f, "файл не записан ({path}): {error}"),
            Self::DialogFailed => f.write_str("окно сохранения завершилось с ошибкой"),
            Self::Dialog(error) => write!(f, "окно сохранения: {error}"),
            Self::Unsupported => f.write_str("сохранение картинок есть только в Windows"),
        }
    }
}

fn error(error: SaveError) -> CommandError {
    let (code, args) = match &error {
        SaveError::TooLarge => ("imageTooLarge", Vec::new()),
        SaveError::NotImage => ("notImage", Vec::new()),
        SaveError::NotWritten(path, detail) => ("notWritten", vec![path.clone(), detail.clone()]),
        SaveError::DialogFailed => ("dialogFailed", Vec::new()),
        SaveError::Dialog(detail) => ("dialog", vec![detail.clone()]),
        SaveError::Unsupported => ("saveUnsupported", Vec::new()),
    };
    CommandError::translated("image-save", code, args, error.to_string())
}

/// Спросить, куда сохранить картинку, и записать её. Возвращает путь к
/// файлу; `None` — окно сохранения закрыли, ничего не записано.
#[tauri::command]
pub async fn image_save(
    window: tauri::WebviewWindow,
    name: String,
    data: Vec<u8>,
) -> CmdResult<Option<String>> {
    if data.len() > MAX_IMAGE {
        return Err(error(SaveError::TooLarge));
    }
    let extension = extension(&data).ok_or_else(|| error(SaveError::NotImage))?;
    let name = file_name(&name, extension);
    save(&window, name, extension, data).await
}

#[cfg(windows)]
async fn save(
    window: &tauri::WebviewWindow,
    name: String,
    extension: &'static str,
    data: Vec<u8>,
) -> CmdResult<Option<String>> {
    // HWND не передать в другой поток — передаётся число
    let owner = window.hwnd()?.0 as isize;
    let saved = tauri::async_runtime::spawn_blocking(move || {
        // свой поток: квартира COM в потоках пула может быть уже другой
        std::thread::spawn(move || {
            let chosen = dialog::choose(owner, &name, extension).map_err(SaveError::Dialog)?;
            let Some(path) = chosen else {
                return Ok(None);
            };
            std::fs::write(&path, &data)
                .map_err(|e| SaveError::NotWritten(path.display().to_string(), e.to_string()))?;
            Ok::<_, SaveError>(Some(path.display().to_string()))
        })
        .join()
        .unwrap_or(Err(SaveError::DialogFailed))
    })
    .await?;
    saved.map_err(error)
}

#[cfg(not(windows))]
async fn save(
    _window: &tauri::WebviewWindow,
    _name: String,
    _extension: &'static str,
    _data: Vec<u8>,
) -> CmdResult<Option<String>> {
    Err(error(SaveError::Unsupported))
}

#[cfg(windows)]
mod dialog {
    use std::ffi::{OsString, c_void};
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;

    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance,
        CoInitializeEx, CoTaskMemFree, CoUninitialize,
    };
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{
        FOS_FORCEFILESYSTEM, FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST, FileSaveDialog,
        IFileSaveDialog, SIGDN_FILESYSPATH,
    };
    use windows_core::{HRESULT, HSTRING, PCWSTR};

    /// Окно «Сохранить как» с именем `name` и одним типом файла; `None` —
    /// окно закрыли без выбора.
    pub fn choose(owner: isize, name: &str, extension: &str) -> Result<Option<PathBuf>, String> {
        // SAFETY: COM инициализируется и освобождается в этом же потоке, все
        // строки живут дольше вызовов, которым они переданы.
        unsafe {
            let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
            let result = show(HWND(owner as *mut c_void), name, extension);
            if init.is_ok() {
                CoUninitialize();
            }
            result.map_err(|e| e.message().to_string())
        }
    }

    unsafe fn show(
        owner: HWND,
        name: &str,
        extension: &str,
    ) -> windows_core::Result<Option<PathBuf>> {
        unsafe {
            let dialog: IFileSaveDialog =
                CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)?;
            let options = dialog.GetOptions()?;
            dialog.SetOptions(
                options | FOS_OVERWRITEPROMPT | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST,
            )?;
            let label = HSTRING::from(format!("{} (*.{extension})", extension.to_uppercase()));
            let pattern = HSTRING::from(format!("*.{extension}"));
            let types = [COMDLG_FILTERSPEC {
                pszName: PCWSTR(label.as_ptr()),
                pszSpec: PCWSTR(pattern.as_ptr()),
            }];
            dialog.SetFileTypes(&types)?;
            dialog.SetDefaultExtension(&HSTRING::from(extension))?;
            dialog.SetFileName(&HSTRING::from(name))?;
            if let Err(error) = dialog.Show(Some(owner)) {
                if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                    return Ok(None);
                }
                return Err(error);
            }
            let path = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
            let chosen = PathBuf::from(OsString::from_wide(path.as_wide()));
            CoTaskMemFree(Some(path.0 as *const c_void));
            Ok(Some(chosen))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_follows_content() {
        assert_eq!(extension(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), Some("png"));
        assert_eq!(extension(b"GIF89a\x01\0\x01\0"), Some("gif"));
        assert_eq!(extension(b"RIFF\x10\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(extension(b"\xFF\xD8\xFF\xE0\0\x10JFIF"), Some("jpg"));
        assert_eq!(extension(b"\0\0\0\x1cftypavif\0\0\0\0"), Some("avif"));
        assert_eq!(extension(b"<svg width=\"1\"/>"), Some("svg"));
        assert_eq!(
            extension("\u{feff}\n<?xml version=\"1.0\"?>\n<svg/>".as_bytes()),
            Some("svg")
        );
        // страница с ошибкой или пустой ответ — не картинка
        assert_eq!(extension(b"<!DOCTYPE html><html></html>"), None);
        assert_eq!(extension(b"<?xml version=\"1.0\"?><feed/>"), None);
        assert_eq!(extension(b"RIFF\x10\0\0\0WAVE"), None);
        assert_eq!(extension(b""), None);
    }

    #[test]
    fn file_name_is_safe_for_windows() {
        assert_eq!(file_name("grinning", "png"), "grinning.png");
        assert_eq!(file_name("thumbs:up/down?", "png"), "thumbs_up_down_.png");
        assert_eq!(file_name("  ..cat face.. ", "gif"), "cat face.gif");
        assert_eq!(file_name("a\u{0}b\nc", "png"), "a_b_c.png");
        assert_eq!(file_name("", "webp"), "emoji.webp");
        assert_eq!(file_name(" ... ", "png"), "emoji.png");
        assert_eq!(file_name("con", "png"), "_con.png");
        assert_eq!(file_name("LPT1.old", "png"), "_LPT1.old.png");
        assert_eq!(file_name("console", "png"), "console.png");
        assert_eq!(file_name("кот", "png"), "кот.png");
        let long = file_name(&"я".repeat(500), "png");
        assert_eq!(long.chars().count(), MAX_NAME + 4);
    }
}
