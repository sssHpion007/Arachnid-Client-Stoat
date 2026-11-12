//! Микрофон, камера и звук без запросов для веб-клиента.
//!
//! Stoat for Desktop (Electron) не спрашивает у пользователя доступ к
//! устройствам: голосовые каналы и камера работают сразу. WebView2 же на
//! каждый `getUserMedia` показывает своё окно «Разрешить/Запретить», а
//! выбранный ответ запоминает в профиле — один случайный «Запретить», и
//! голосовой канал молча остаётся без микрофона.
//!
//! Поэтому веб-клиенту инстанса (и только ему — по origin из `config.toml`)
//! доступ выдаётся заранее:
//!
//! - в профиле WebView2 для origin клиента ставится «Разрешено»
//!   (`ICoreWebView2Profile4::SetPermissionState`) — это заменяет и прежний
//!   «Запретить», если его когда-то нажали;
//! - запросы, которые всё-таки дошли до события `PermissionRequested`,
//!   одобряются, если пришли с того же origin.
//!
//! Динамикам отдельного разрешения в Chromium не нужно; разрешается
//! автовоспроизведение со звуком, чтобы звуки уведомлений и голос собеседников
//! играли сразу после запуска, ещё до первого щелчка по окну.
//!
//! Системный переключатель Windows «Разрешить приложениям доступ к микрофону»
//! остаётся за пользователем: его приложение менять не должно.
//!
//! В Linux и macOS запросы обрабатывает сам webview системы.

use url::Url;

/// Пришёл ли запрос со страницы веб-клиента (тот же origin).
#[cfg_attr(not(windows), allow(dead_code))]
fn from_client(uri: &str, origin: &str) -> bool {
    Url::parse(uri).is_ok_and(|url| url.origin().ascii_serialization() == origin)
}

#[cfg(windows)]
mod platform {
    use tauri::WebviewWindow;
    use tauri::webview::PlatformWebview;
    use webview2_com::Microsoft::Web::WebView2::Win32 as wv;
    use webview2_com::{
        PermissionRequestedEventHandler, SetPermissionStateCompletedHandler, take_pwstr,
    };
    use windows_core::{HSTRING, Interface, PCWSTR, PWSTR};

    use super::from_client;

    /// Что выдаётся клиенту без запроса.
    const ALLOWED: [wv::COREWEBVIEW2_PERMISSION_KIND; 3] = [
        wv::COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        wv::COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        wv::COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
    ];

    pub fn allow(window: &WebviewWindow, origin: String) {
        let result = window.with_webview(move |webview| {
            if let Err(error) = setup(&webview, origin) {
                tracing::warn!(%error, "доступ к микрофону и камере не выдан");
            }
        });
        if let Err(error) = result {
            tracing::warn!(%error, "webview недоступен, доступ к устройствам не выдан");
        }
    }

    fn setup(webview: &PlatformWebview, origin: String) -> windows_core::Result<()> {
        // SAFETY: with_webview вызывает нас в главном потоке, контроллер жив,
        // пока существует окно
        let core = unsafe { webview.controller().CoreWebView2() }?;
        save_in_profile(&core, &origin);

        let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                answer(&args, &origin)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: обработчик живёт, пока его держит WebView2
        unsafe { core.add_PermissionRequested(&handler, &mut token) }
    }

    /// Одобрить запрос устройства, если он пришёл от веб-клиента.
    fn answer(
        args: &wv::ICoreWebView2PermissionRequestedEventArgs,
        origin: &str,
    ) -> windows_core::Result<()> {
        let mut kind = wv::COREWEBVIEW2_PERMISSION_KIND::default();
        let mut uri = PWSTR::null();
        // SAFETY: аргументы события действительны во время обработчика,
        // строку Uri освобождает take_pwstr
        unsafe {
            args.PermissionKind(&mut kind)?;
            if !ALLOWED.contains(&kind) {
                return Ok(());
            }
            args.Uri(&mut uri)?;
            if from_client(&take_pwstr(uri), origin) {
                args.SetState(wv::COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
        }
        Ok(())
    }

    /// «Разрешено» в профиле WebView2 для origin клиента. Нужен Runtime с
    /// `ICoreWebView2Profile4` (1.0.1661+); на старом остаётся обработчик
    /// запросов.
    fn save_in_profile(core: &wv::ICoreWebView2, origin: &str) {
        // SAFETY: COM-вызовы в главном потоке
        let profile = unsafe {
            core.cast::<wv::ICoreWebView2_13>()
                .and_then(|core| core.Profile())
                .and_then(|profile| profile.cast::<wv::ICoreWebView2Profile4>())
        };
        let Ok(profile) = profile else {
            tracing::info!("WebView2 без ICoreWebView2Profile4, разрешения не сохраняются");
            return;
        };
        let wide = HSTRING::from(origin);
        let origin = PCWSTR(wide.as_ptr());
        let state = wv::COREWEBVIEW2_PERMISSION_STATE_ALLOW;
        for kind in ALLOWED {
            let done = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
                if let Err(error) = result {
                    tracing::warn!(%error, kind = kind.0, "разрешение не сохранено в профиле");
                }
                Ok(())
            }));
            // SAFETY: строка wide живёт до конца функции, WebView2 её копирует
            let result = unsafe { profile.SetPermissionState(kind, origin, state, &done) };
            if let Err(error) = result {
                tracing::warn!(%error, kind = kind.0, "разрешение не сохранено в профиле");
            }
        }
    }
}

/// Выдать веб-клиенту микрофон, камеру и автовоспроизведение.
#[cfg(windows)]
pub fn allow_for_client(window: &tauri::WebviewWindow, instance: &crate::instance::Instance) {
    platform::allow(window, instance.origin());
}

/// В Linux и macOS решает webview системы.
#[cfg(not(windows))]
pub fn allow_for_client(_window: &tauri::WebviewWindow, _instance: &crate::instance::Instance) {}

#[cfg(test)]
mod tests {
    use super::from_client;

    #[test]
    fn only_client_origin_gets_devices() {
        let origin = "https://stoat.chat";
        assert!(from_client("https://stoat.chat/app/channel/01H", origin));
        assert!(from_client("https://stoat.chat", origin));
        assert!(!from_client("https://evil.example/stoat.chat", origin));
        assert!(!from_client("https://stoat.chat.evil.example/", origin));
        assert!(!from_client("http://stoat.chat/app", origin));
        assert!(!from_client("не адрес", origin));
    }
}
