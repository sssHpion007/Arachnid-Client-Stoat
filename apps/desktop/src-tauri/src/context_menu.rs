//! Пункты меню форматирования в контекстном меню поля ввода.
//!
//! Правый щелчок по полю сообщения показывает меню WebView2 (вставка,
//! проверка орфографии). В его конец добавляются пункты встроенного плагина
//! «Quality of Life»: «Ссылка…», «Время…», «Таблица…». Какие пункты и с
//! какими подписями (на языке интерфейса), решает `formatting.js` —
//! `window.__arachnidFormatContext.items()`: пусто, если щелчок был не по
//! полю сообщения или меню форматирования выключено. Пока скрипт отвечает,
//! меню ждёт (deferral). Выбранный пункт вызывает
//! `window.__arachnidFormatContext.run(id)`.
//!
//! В Linux и macOS меню webview системы не меняется.

/// Выражение, которое возвращает пункты: `[{ "id": …, "label": … }]`.
#[cfg_attr(not(windows), allow(dead_code))]
const ITEMS_SCRIPT: &str = "window.__arachnidFormatContext?.items() ?? []";

/// Пункт меню от `formatting.js`.
#[derive(serde::Deserialize)]
#[cfg_attr(not(windows), allow(dead_code))]
struct Item {
    id: String,
    label: String,
}

/// Ответ ExecuteScript (JSON значения выражения) → пункты; что-то не то —
/// без пунктов.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_items(json: &str) -> Vec<Item> {
    serde_json::from_str::<Option<Vec<Item>>>(json)
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| !item.id.is_empty() && !item.label.is_empty())
        .collect()
}

/// Скрипт выбранного пункта id.
#[cfg_attr(not(windows), allow(dead_code))]
fn run_script(id: &str) -> String {
    format!("window.__arachnidFormatContext?.run({})", serde_json::Value::from(id))
}

#[cfg(windows)]
mod platform {
    use tauri::WebviewWindow;
    use tauri::webview::PlatformWebview;
    use webview2_com::Microsoft::Web::WebView2::Win32 as wv;
    use webview2_com::{
        ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler,
        ExecuteScriptCompletedHandler,
    };
    use windows::Win32::System::Com::IStream;
    use windows_core::{BOOL, HSTRING, Interface, PCWSTR};

    use super::{ITEMS_SCRIPT, Item, parse_items, run_script};

    pub fn install(window: &WebviewWindow) {
        let result = window.with_webview(|webview| {
            if let Err(error) = setup(&webview) {
                tracing::warn!(%error, "пункты форматирования в контекстном меню не добавлены");
            }
        });
        if let Err(error) = result {
            tracing::warn!(%error, "webview недоступен, контекстное меню не дополнено");
        }
    }

    fn setup(webview: &PlatformWebview) -> windows_core::Result<()> {
        // SAFETY: with_webview вызывает нас в главном потоке, контроллер жив,
        // пока существует окно
        let core = unsafe { webview.controller().CoreWebView2() }?;
        // SAFETY: COM-вызовы в главном потоке
        let environment = unsafe { core.cast::<wv::ICoreWebView2_2>()?.Environment() }?;
        let environment = environment.cast::<wv::ICoreWebView2Environment9>()?;
        let events = core.cast::<wv::ICoreWebView2_11>()?;
        let handler = ContextMenuRequestedEventHandler::create(Box::new(move |sender, args| {
            let (Some(core), Some(args)) = (sender, args) else {
                return Ok(());
            };
            if let Err(error) = request(core, args, environment.clone()) {
                tracing::warn!(%error, "пункты форматирования не добавлены в меню");
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: обработчик живёт, пока его держит WebView2
        unsafe { events.add_ContextMenuRequested(&handler, &mut token) }
    }

    /// Меню поля ввода: спросить у страницы пункты, меню ждёт ответа.
    fn request(
        core: wv::ICoreWebView2,
        args: wv::ICoreWebView2ContextMenuRequestedEventArgs,
        environment: wv::ICoreWebView2Environment9,
    ) -> windows_core::Result<()> {
        let mut editable = BOOL::default();
        // SAFETY: аргументы события действительны во время обработчика
        unsafe { args.ContextMenuTarget()?.IsEditable(&mut editable) }?;
        if !editable.as_bool() {
            return Ok(());
        }
        // SAFETY: то же; меню не покажется, пока не вызван Complete
        let deferral = unsafe { args.GetDeferral() }?;
        let finish = deferral.clone();
        let target = core.clone();
        let done = ExecuteScriptCompletedHandler::create(Box::new(move |error, json| {
            if error.is_ok() {
                let items = parse_items(&json);
                if let Err(error) = add_items(&target, &args, &environment, items) {
                    tracing::warn!(%error, "пункты форматирования не добавлены в меню");
                }
            }
            // SAFETY: deferral этого события, вызывается один раз
            unsafe { deferral.Complete() }
        }));
        let script = HSTRING::from(ITEMS_SCRIPT);
        // SAFETY: строка script живёт до конца вызова, WebView2 её копирует
        let result = unsafe { core.ExecuteScript(PCWSTR(script.as_ptr()), &done) };
        if result.is_err() {
            // обработчик не будет вызван — меню показывается как есть
            // SAFETY: deferral этого события, обработчик его не тронет
            unsafe { finish.Complete() }?;
        }
        result
    }

    /// Разделитель и пункты в конце меню.
    fn add_items(
        core: &wv::ICoreWebView2,
        args: &wv::ICoreWebView2ContextMenuRequestedEventArgs,
        environment: &wv::ICoreWebView2Environment9,
        items: Vec<Item>,
    ) -> windows_core::Result<()> {
        if items.is_empty() {
            return Ok(());
        }
        let create = |label: &str, kind| {
            let wide = HSTRING::from(label);
            let label = PCWSTR(wide.as_ptr());
            // SAFETY: строка wide живёт до конца вызова, WebView2 её копирует
            unsafe { environment.CreateContextMenuItem(label, None::<&IStream>, kind) }
        };
        // SAFETY: аргументы события действительны, пока не вызван Complete
        let collection = unsafe { args.MenuItems() }?;
        let mut count = 0u32;
        // SAFETY: то же
        unsafe { collection.Count(&mut count) }?;
        let separator = create("", wv::COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR)?;
        // SAFETY: то же
        unsafe { collection.InsertValueAtIndex(count, &separator) }?;
        for (index, item) in (count + 1..).zip(items) {
            let entry = create(&item.label, wv::COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND)?;
            let script = HSTRING::from(run_script(&item.id));
            let target = core.clone();
            let selected = CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
                let done = ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
                // SAFETY: обработчик вызывается в главном потоке, строка
                // script живёт вместе с ним
                unsafe { target.ExecuteScript(PCWSTR(script.as_ptr()), &done) }
            }));
            let mut token = 0i64;
            // SAFETY: обработчик живёт, пока его держит пункт меню
            unsafe { entry.add_CustomItemSelected(&selected, &mut token) }?;
            // SAFETY: аргументы события действительны, пока не вызван Complete
            unsafe { collection.InsertValueAtIndex(index, &entry) }?;
        }
        Ok(())
    }
}

/// Добавлять пункты меню форматирования в контекстное меню поля ввода.
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) {
    platform::install(window);
}

/// В Linux и macOS меню webview системы не меняется.
#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::{parse_items, run_script};

    #[test]
    fn items_from_page() {
        let json = r#"[{"id":"link","label":"Ссылка…"},{"id":"time","label":"Время…"}]"#;
        let items = parse_items(json);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "link");
        assert_eq!(items[1].label, "Время…");
        assert!(parse_items("null").is_empty());
        assert!(parse_items("[]").is_empty());
        assert!(parse_items("\"не массив\"").is_empty());
        assert!(parse_items(r#"[{"id":"","label":"x"}]"#).is_empty());
    }

    #[test]
    fn run_script_quotes_id() {
        assert_eq!(run_script("table"), r#"window.__arachnidFormatContext?.run("table")"#);
        assert_eq!(
            run_script("a\")-alert(1)//"),
            r#"window.__arachnidFormatContext?.run("a\")-alert(1)//")"#
        );
    }
}
