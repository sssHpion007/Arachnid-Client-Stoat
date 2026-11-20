//! Чёткий значок окна и трея в Windows.
//!
//! Tauri ставит окну одну картинку — первый кадр `icons/icon.ico` — и только
//! как малый значок (`WM_SETICON` с `ICON_SMALL`). Большого значка у окна
//! нет, и для панели задач и Alt+Tab Windows растягивает малый. Трей получает
//! ту же картинку и сжимает её как придётся.
//!
//! Поэтому значки берутся из ресурса exe: tauri-build вшивает туда
//! `icons/icon.ico` со всеми кадрами (256, 64, 48, 40, 32, 24, 20, 16), и
//! `LoadImageW` выбирает кадр под точный размер для текущего масштаба экрана.
//! Малый и большой значки ставятся отдельно и обновляются, когда окно
//! переезжает на монитор с другим масштабом.
//!
//! В Linux и macOS значки не трогаются: там Tauri справляется сам.

#[cfg(windows)]
mod platform {
    use std::sync::Mutex;

    use tauri::WebviewWindow;
    use tauri::tray::TrayIcon;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::HiDpi::{GetDpiForSystem, GetDpiForWindow, GetSystemMetricsForDpi};
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, HICON, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_DEFAULTCOLOR, LoadImageW,
        SM_CXICON, SM_CXSMICON, SendMessageW, WM_SETICON,
    };
    use windows::core::PCWSTR;

    /// Номер ресурса, под которым tauri-build вшивает значок приложения.
    const ICON_RESOURCE: u16 = 32512;

    /// Значки, поставленные окну (малый и большой): при замене их нужно
    /// освободить. Значок, который поставил сам Tauri, принадлежит ему.
    static WINDOW_ICONS: Mutex<[isize; 2]> = Mutex::new([0; 2]);

    /// Кадр значка из ресурса exe точно нужного размера.
    fn load(size: i32) -> Option<HICON> {
        let module = unsafe { GetModuleHandleW(PCWSTR::null()) }.ok()?;
        let handle = unsafe {
            LoadImageW(
                Some(module.into()),
                PCWSTR(usize::from(ICON_RESOURCE) as *const u16),
                IMAGE_ICON,
                size,
                size,
                LR_DEFAULTCOLOR,
            )
        }
        .ok()?;
        Some(HICON(handle.0))
    }

    /// Малый (заголовок) и большой (панель задач, Alt+Tab) значки окна под
    /// масштаб монитора, на котором оно находится.
    pub fn apply_window(window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let dpi = unsafe { GetDpiForWindow(hwnd) };
        if dpi == 0 {
            return;
        }
        let Ok(mut owned) = WINDOW_ICONS.lock() else {
            return;
        };
        let kinds = [(ICON_SMALL, SM_CXSMICON), (ICON_BIG, SM_CXICON)];
        for (slot, (kind, metric)) in kinds.into_iter().enumerate() {
            let size = unsafe { GetSystemMetricsForDpi(metric, dpi) };
            let Some(icon) = load(size) else {
                tracing::warn!("значок окна {size}×{size} не загружен из ресурса");
                continue;
            };
            unsafe {
                SendMessageW(
                    hwnd,
                    WM_SETICON,
                    Some(WPARAM(kind as usize)),
                    Some(LPARAM(icon.0 as isize)),
                );
            }
            let previous = std::mem::replace(&mut owned[slot], icon.0 as isize);
            if previous != 0 {
                let _ = unsafe { DestroyIcon(HICON(previous as *mut _)) };
            }
        }
    }

    /// Значок трея под масштаб системы (трей Windows рисуется в нём).
    pub fn apply_tray(tray: &TrayIcon) {
        let size = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, GetDpiForSystem()) };
        let Ok(size) = u32::try_from(size) else {
            return;
        };
        if size == 0 {
            return;
        }
        let result = tray.with_inner_tray_icon(move |inner| {
            let icon = tray_icon::Icon::from_resource(ICON_RESOURCE, Some((size, size)));
            let icon = icon.map_err(|error| error.to_string())?;
            let set = inner.set_icon(Some(icon));
            set.map_err(|error| error.to_string())
        });
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(%error, size, "значок трея не загружен"),
            Err(error) => tracing::warn!(%error, "значок трея не обновлён"),
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use tauri::WebviewWindow;
    use tauri::tray::TrayIcon;

    pub fn apply_window(_window: &WebviewWindow) {}

    pub fn apply_tray(_tray: &TrayIcon) {}
}

pub use platform::{apply_tray, apply_window};
