# Как устроена оболочка

Arachnid Client устроен так же, как официальный
[Stoat for Desktop](https://github.com/stoatchat/for-desktop): окно открывает веб-клиент
Stoat с сервера инстанса, а оболочка даёт ему то, чего нет у браузера.
Разница в том, что оболочка написана на Rust (Tauri 2), а вместо встроенного
Chromium используется системный webview: WebView2 в Windows, WebKitGTK в Linux,
WKWebView в macOS.

```
┌──────────────── окно Tauri (WebView2) ─────────────────┐
│  https://stoat.chat/app — for-web без изменений        │
│        │ window.native / window.desktopConfig          │
│        ▼                                               │
│  bridge.js (скрипт инициализации, до скриптов страницы)│
└────────│───────────────────────────────────────────────┘
         │ IPC Tauri (только адрес клиента, только окно main)
         ▼
  desktop.rs: окно, настройки «ПК», трей, автозапуск, Discord RPC
```

## Договор с веб-клиентом

for-web проверяет `window.native`. Если объект есть, он показывает свою строку
заголовка, раздел настроек «ПК» и версии оболочки (`Native.tsx`, `Titlebar.tsx`,
`UserSettings.tsx`). Stoat for Desktop отдаёт эти объекты из preload-скрипта
(`src/world/window.ts`, `src/world/config.ts`); `src/bridge.js` повторяет тот же
договор поверх команд Tauri:

| for-web вызывает | Команда Rust | Что делает |
|---|---|---|
| `native.minimise()` | `native_minimise` | свернуть окно |
| `native.maximise()` | `native_maximise` | развернуть или вернуть размер |
| `native.close()` | `native_close` | закрыть: проходит через «Сворачивать в трей» |
| `native.versions.*()` | — | версии подставлены в скрипт при создании окна |
| `desktopConfig.get()` | — | синхронно, из подставленных настроек |
| `desktopConfig.set(patch)` | `desktop_config_set` | сохранить в `desktop.json`, включить или выключить Discord RPC |
| `desktopConfig.getAutostart()` | `desktop_autostart_get` | включён ли автозапуск |
| `desktopConfig.setAutostart(v)` | `desktop_autostart_set` | включить или выключить, вернуть итог |

`native.versions` выводятся в настройках как «Stoat for Desktop 0.12.0» и строка
`Tauri 2.x, Windows x86_64, WebView 1xx` (поля `electron`, `node`, `chrome`).

`desktopConfig.get()` должен быть синхронным: for-web читает его при отрисовке.
Поэтому Rust подставляет текущие настройки прямо в скрипт при создании окна, а
последнее состояние скрипт держит в `sessionStorage` вкладки, чтобы перезагрузка
страницы (F5) не возвращала старые значения. Изменения, сделанные не со
страницы (окно развернули системной кнопкой или перетаскиванием к краю),
Rust передаёт в `window.__arachnidDesktop.update(...)`.

### Чего нет в договоре и почему

- `onceScreenPicker` / `screenPickerCallback`: for-web использует их, только если
  они есть. Без них демонстрацию экрана выбирает WebView2 своим окном выбора.
- `isWayland`: нужен только Linux-сборке Electron.
- `setBadgeCount` и `onNavigate`: есть в Stoat for Desktop, но for-web их не вызывает.

## Права

Страница загружена с удалённого адреса, а такой странице Tauri разрешает только
команды, на которые есть право. `build.rs` перечисляет команды моста, и Tauri
создаёт для них права `allow-…`. При запуске `lib.rs` выдаёт их capability
`web-client`, привязанной к адресу из `config.toml` (`https://stoat.chat/*`) и к
главному окну. Ни у какой другой страницы доступа к командам нет.

## Окно

- **Адрес.** `config.toml` → `[instance] app_url`, по умолчанию
  `https://stoat.chat/app` (как у Stoat for Desktop без `--force-server`). Только
  https; http разрешён для localhost (разработка своего инстанса).
- **Переходы.** Как `will-navigate` в Stoat for Desktop: окно не уходит с origin
  веб-клиента. `window.open` (ссылки с `target="_blank"`) открывает http, https и
  mailto в системе, новое окно не создаётся.
- **Рамка.** `customFrame` убирает системную рамку при запуске; кнопки и
  перетаскивание даёт строка заголовка for-web (`-webkit-app-region: drag`,
  WebView2 понимает её сам). Как и в Stoat for Desktop, смена рамки действует
  после перезапуска.
- **Аппаратное ускорение.** При выключенном WebView2 запускается с `--disable-gpu`
  (после перезапуска).
- **Проверка орфографии.** У WebView2 нет переключателя, как
  `session.setSpellCheckerEnabled` в Electron, поэтому при выключенной настройке
  мост ставит полям ввода `spellcheck="false"` и возвращает исходное значение при
  включении. Подсказки и «Добавить в словарь» — в стандартном контекстном меню.
- **Профиль webview** (`webview/` в каталоге данных): вход, `localStorage`, кэш.
  В portable-режиме лежит рядом с exe, поэтому папку можно переносить с входом.
- **Перетаскивание файлов.** Системный обработчик Tauri выключен
  (`dragDropEnabled: false`), чтобы работало HTML5-перетаскивание вложений в чат.
- Фон окна `#191919` до загрузки страницы, минимальный размер 300×300, как у
  Stoat for Desktop.

## Нативное, что даёт сам webview

Уведомления (Notification API), микрофон и камера, демонстрация экрана
(`getDisplayMedia`), масштаб (Ctrl + колесо, Ctrl + `+` `-` `0`), перезагрузка
(F5, Ctrl + R) и контекстное меню с подсказками орфографии — стандартные
возможности WebView2. Разрешения на уведомления и микрофон WebView2 спрашивает
своим окном и запоминает в профиле.
