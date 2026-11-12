//! Twemoji — набор эмодзи по умолчанию — из exe, без запросов к серверу.
//!
//! for-web рисует каждый стандартный эмодзи картинкой
//! `https://static.stoat.chat/emoji/<набор>/<кодовые точки>.svg?v=1`
//! (`unicodeEmojiUrl` в UnicodeEmoji.tsx). Каждая картинка — отдельный
//! запрос; пока она не пришла, на месте эмодзи пусто. Прежний набор лежит в
//! кэше webview, а новый приходится скачивать заново, и при медленной связи
//! с static.stoat.chat (в России Stoat заблокирован) эмодзи и сам выбор
//! набора в настройках появляются с большой задержкой.
//!
//! Поэтому набор Twemoji встроен в клиент (`emoji/twemoji.bin`, собирается
//! `emoji/pack.mjs` из jdecked/twemoji той же версии, что и у официального
//! набора Stoat), а его адреса WebView2 отдаёт из exe: обработчик
//! `WebResourceRequested` для `https://static.stoat.chat/emoji/twemoji/*`.
//! Картинки, которых во встроенном наборе нет, по-прежнему идут в сеть.
//! Остальные наборы не встроены: ими пользуются реже, а места они занимают
//! во много раз больше.
//!
//! В Linux и macOS адреса не перехватываются: картинки идут с сервера.
//!
//! Графика Twemoji — © Twitter, Inc. и другие участники, CC-BY 4.0
//! (`emoji/LICENSE-GRAPHICS`).

use std::io::Read;
use std::sync::OnceLock;

/// Встроенный набор (формат описан в `emoji/pack.mjs`).
const PACK: &[u8] = include_bytes!("../emoji/twemoji.bin");

/// Адреса картинок набора Twemoji у for-web.
#[cfg_attr(not(windows), allow(dead_code))]
const PREFIX: &str = "https://static.stoat.chat/emoji/twemoji/";

/// Селектор варианта эмодзи: формы с ним и без него — одна картинка.
const VARIATION_SELECTOR: &str = "fe0f";

type Index = Vec<(&'static str, &'static [u8])>;

/// Оглавление набора: ключи по возрастанию и сжатые SVG.
fn index() -> &'static Index {
    static INDEX: OnceLock<Index> = OnceLock::new();
    INDEX.get_or_init(|| {
        parse(PACK).unwrap_or_else(|| {
            tracing::warn!("встроенный набор Twemoji повреждён");
            Vec::new()
        })
    })
}

fn read_u32(bytes: &[u8]) -> Option<usize> {
    let bytes: [u8; 4] = bytes.get(..4)?.try_into().ok()?;
    usize::try_from(u32::from_le_bytes(bytes)).ok()
}

fn parse(data: &'static [u8]) -> Option<Index> {
    let rest = data.strip_prefix(b"ATWE")?;
    let (&version, rest) = rest.split_first()?;
    if version != 1 {
        return None;
    }
    let count = read_u32(rest)?;
    let mut rest = rest.get(4..)?;

    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        let (&length, tail) = rest.split_first()?;
        let length = usize::from(length);
        let key = std::str::from_utf8(tail.get(..length)?).ok()?;
        let tail = tail.get(length..)?;
        let offset = read_u32(tail)?;
        let size = read_u32(tail.get(4..)?)?;
        rest = tail.get(8..)?;
        entries.push((key, offset, size));
    }

    let blobs = rest;
    entries
        .into_iter()
        .map(|(key, offset, size)| {
            let end = offset.checked_add(size)?;
            Some((key, blobs.get(offset..end)?))
        })
        .collect()
}

/// Ключ картинки: кодовые точки без селектора варианта.
fn key_of(stem: &str) -> String {
    stem.split('-')
        .filter(|part| *part != VARIATION_SELECTOR)
        .collect::<Vec<_>>()
        .join("-")
}

/// Кодовые точки из адреса картинки Twemoji.
#[cfg_attr(not(windows), allow(dead_code))]
fn stem_of(uri: &str) -> Option<String> {
    let path = uri.strip_prefix(PREFIX)?;
    let file = path.split(['?', '#']).next()?;
    let stem = file.strip_suffix(".svg")?;
    let hex = |byte: u8| byte.is_ascii_hexdigit() || byte == b'-';
    let valid = !stem.is_empty() && stem.bytes().all(hex);
    valid.then(|| stem.to_ascii_lowercase())
}

/// SVG эмодзи из встроенного набора.
#[cfg_attr(not(windows), allow(dead_code))]
fn svg(stem: &str) -> Option<Vec<u8>> {
    let key = key_of(stem);
    let entries = index();
    let position = entries
        .binary_search_by(|(entry, _)| (*entry).cmp(key.as_str()))
        .ok()?;
    let mut image = Vec::new();
    brotli_decompressor::Decompressor::new(entries[position].1, 4096)
        .read_to_end(&mut image)
        .ok()?;
    Some(image)
}

#[cfg(windows)]
mod platform {
    use tauri::WebviewWindow;
    use tauri::webview::PlatformWebview;
    use webview2_com::Microsoft::Web::WebView2::Win32 as wv;
    use webview2_com::{WebResourceRequestedEventHandler, take_pwstr};
    use windows::Win32::UI::Shell::SHCreateMemStream;
    use windows_core::{HSTRING, Interface, PWSTR, w};

    use super::{PREFIX, stem_of, svg};

    /// Картинки неизменны (адрес с версией `?v=1`), как и у static.stoat.chat.
    const HEADERS: &str = "Content-Type: image/svg+xml\r\n\
        Cache-Control: public, max-age=31536000, immutable\r\n\
        Access-Control-Allow-Origin: *";

    pub fn serve(window: &WebviewWindow) {
        let result = window.with_webview(|webview| {
            if let Err(error) = setup(&webview) {
                tracing::warn!(%error, "встроенный Twemoji не подключён");
            }
        });
        if let Err(error) = result {
            tracing::warn!(%error, "webview недоступен, встроенный Twemoji не подключён");
        }
    }

    fn setup(webview: &PlatformWebview) -> windows_core::Result<()> {
        let env = webview.environment();
        // SAFETY: with_webview вызывает нас в главном потоке, контроллер жив,
        // пока существует окно
        let core = unsafe { webview.controller().CoreWebView2() }?;
        add_filter(&core)?;

        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                respond(&env, &args)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: обработчик живёт, пока его держит WebView2
        unsafe { core.add_WebResourceRequested(&handler, &mut token) }
    }

    /// Фильтр адресов набора. С `ICoreWebView2_22` он видит и запросы
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

    /// Ответить картинкой из exe; без неё запрос уходит в сеть как обычно.
    fn respond(
        env: &wv::ICoreWebView2Environment,
        args: &wv::ICoreWebView2WebResourceRequestedEventArgs,
    ) -> windows_core::Result<()> {
        let mut uri = PWSTR::null();
        // SAFETY: аргументы события действительны во время обработчика,
        // строку Uri освобождает take_pwstr
        unsafe { args.Request()?.Uri(&mut uri)? };
        let uri = take_pwstr(uri);
        if let Some(image) = stem_of(&uri).and_then(|stem| svg(&stem)) {
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

/// Отдавать картинки Twemoji из exe.
#[cfg(windows)]
pub fn serve(window: &tauri::WebviewWindow) {
    platform::serve(window);
}

/// В Linux и macOS картинки идут с сервера.
#[cfg(not(windows))]
pub fn serve(_window: &tauri::WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_has_every_twemoji() {
        let entries = index();
        assert_eq!(entries.len(), 4009);
        assert!(entries.windows(2).all(|pair| pair[0].0 < pair[1].0));
    }

    #[test]
    fn web_client_addresses_are_found() {
        let stem = stem_of("https://static.stoat.chat/emoji/twemoji/1f600.svg?v=1").unwrap();
        assert_eq!(stem, "1f600");
        let image = svg(&stem).unwrap();
        assert!(image.starts_with(b"<svg"));

        // ❤️ for-web запрашивает с fe0f, у Twemoji файл без него — та же картинка
        assert_eq!(svg("2764-fe0f"), svg("2764"));
        assert!(svg("2764").is_some());
        // ZWJ-последовательность с fe0f внутри: 🏳️‍🌈
        assert!(svg("1f3f3-200d-1f308").is_some());
        assert_eq!(svg("1f3f3-fe0f-200d-1f308"), svg("1f3f3-200d-1f308"));
        // #️⃣ и флаг Уэльса (теги)
        assert!(svg("23-fe0f-20e3").is_some());
        assert!(svg("1f3f4-e0067-e0062-e0077-e006c-e0073-e007f").is_some());
    }

    #[test]
    fn other_addresses_go_to_network() {
        assert_eq!(stem_of("https://static.stoat.chat/emoji/fluent-3d/1f600.svg?v=1"), None);
        assert_eq!(stem_of("https://static.stoat.chat/emoji/twemoji/../x.svg"), None);
        assert_eq!(stem_of("https://static.stoat.chat/emoji/twemoji/.svg"), None);
        assert_eq!(svg("ffffff"), None);
    }
}
