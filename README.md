# Tauri-Stoat

Клиент [Stoat](https://stoat.chat/) (бывший Revolt) на Rust: своё ядро, Tauri-оболочка
и API плагинов с манифестом прав — без костылей вроде ножниц в чужой DOM.

## Состояние

| Часть | Статус |
|---|---|
| `crates/stoat-core` — REST, gateway, кэш, rate-limit | готово, 23 теста, проверено на живом API 0.16.3 |
| `crates/stoat-plugin-api` — ABI плагинов и манифест прав | каркас |
| `crates/stoat-plugin-host` — WASM-хост на `wasmi` | план |
| `apps/desktop` — Tauri 2 + webview | план |

## Структура

```
crates/stoat-core/        транспорт и протокол (см. docs/stoat-core.md)
crates/stoat-plugin-api/  ABI плагинов, манифест прав
apps/desktop/             Tauri-приложение
docs/                     документация по частям
plugins/                  примеры плагинов
```

## Быстрый старт

```bash
cargo test --workspace
cargo run -p stoat-core --example probe            # проверка связи с инстансом
cargo run -p stoat-core --example gateway_probe    # проверка gateway
```

## Принципы

- **Типы — из официального крейта.** `revolt-models` 0.16.3 (MIT), а не самописные
  структуры: клиент не разъезжается с API.
- **Токен не попадает в URL** — только в событии `Authenticate` и в заголовке запроса.
- **Плагины — WASM с манифестом прав.** Плагин объявляет, что ему нужно
  (`messages:read`, `messages:rewrite`, `ui:toolbar`, `http:<host>`), и не может
  выйти за эти рамки: ни DOM, ни токена сессии у него нет.
- **Ошибки протокола разбираются терпимо.** Неизвестное событие не ломает поток.

## Документация

- [docs/stoat-core.md](docs/stoat-core.md) — ядро: протокол, решения, что проверено
- [docs/avia-setup-windows.md](docs/avia-setup-windows.md) — референс по Avia Client
  (темы/плагины в JS-клиенте, для сравнения подходов)
- [docs/plugin-api-notes.md](docs/plugin-api-notes.md) — заметки по API плагинов

## Лицензия

AGPL-3.0-or-later.
