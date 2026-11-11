# Arachnid Client

Клиент [Stoat](https://stoat.chat/) (бывший Revolt) на Rust: своё ядро, Tauri-оболочка
и API плагинов с манифестом прав — без костылей вроде ножниц в чужой DOM.

## Состояние

| Часть | Статус |
|---|---|
| `crates/stoat-core` — REST, gateway, кэш, rate-limit, MFA, боты | готово, 43 теста, проверено на живом API 0.16.3 |
| `crates/stoat-plugin-api` — ABI плагинов и манифест прав | каркас |
| `crates/stoat-plugin-host` — WASM-хост на `wasmi` | план |
| `apps/desktop` — Tauri 2 + webview | чаты, профили, статус, настройки сервера (роли, участники, баны, приглашения, эмодзи), шапка сервера, просмотр картинок, видео и аудио через протокол `media:`. все разделы настроек пользователя и клиента, как в оригинале: «Мой аккаунт», «Профиль», «Сессии», «Мои боты», «Обратная связь», «Голос и видео», «Внешний вид» (тема Material You, акцент, контраст, шрифты, размер сообщений, набор эмодзи), «Уведомления» (системные уведомления и звуки), «Язык» (69 языков интерфейса из каталогов for-web, форматы даты и времени), «ПК» (автозапуск, трей, своя рамка окна, Discord RPC, проверка орфографии, аппаратное ускорение), «Расширенные», «Узнай, что нового» |
| `bootstrap/` — скачиваемый установщик | готово: `bootstrap.sh` и `bootstrap.ps1` |

## Структура

```
crates/stoat-core/        транспорт и протокол (см. docs/stoat-core.md)
crates/stoat-plugin-api/  ABI плагинов, манифест прав
apps/desktop/             Tauri-приложение (src-tauri/ + ui/)
bootstrap/                скачиваемые установщики: bootstrap.sh, bootstrap.ps1
docs/                     документация по частям
plugins/                  примеры плагинов
```

## Установка в отдельную папку (без официального Stoat)

Скачайте один файл и запустите — дальше он сам развернёт всё нужное:

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

```bash
# Linux / macOS
chmod +x bootstrap.sh && ./bootstrap.sh
```

По умолчанию ставит в `~/Arachnid-Client` и создаёт `config.toml`, `cache/`,
`plugins/`, `themes/`, `logs/`, `vendor/` (там `api-root.json`,
`revolt-models-0.16.3.crate` и сама сборка клиента). Официальный Stoat при этом
не задействован, перенос папки ничего не ломает. Подробности —
[docs/install.md](docs/install.md).

Варианты: `--dir <папка>`, `--check` (только проверки), `--github-token <PAT>`
(для приватного репозитория).

## Быстрый старт для разработки

```bash
cargo test --workspace
cargo run -p stoat-core --example probe            # проверка связи с инстансом
cargo run -p stoat-core --example gateway_probe    # проверка gateway
cargo build --release -p arachnid-client               # клиент (см. docs/build.md)
```

## Принципы

- **Типы — из официального крейта.** `revolt-models` 0.16.3 (MIT), а не самописные
  структуры: клиент не разъезжается с API.
- **Токен не попадает в URL** — только в событии `Authenticate` и в заголовке запроса.
- **Плагины — WASM с манифестом прав.** Плагин объявляет, что ему нужно
  (`messages:read`, `messages:rewrite`, `ui:toolbar`, `http:<host>`), и не может
  выйти за эти рамки: ни DOM, ни токена сессии у него нет.
- **Ошибки протокола разбираются терпимо.** Неизвестное событие не ломает поток.

## Переводы интерфейса

Строки интерфейса пишутся английскими msgid браузерного клиента Stoat
(`t("Save")`, `data-i18n="Log In"`), переводы берутся из его каталогов.
Строк, которых в for-web нет, — в своих каталогах `apps/desktop/i18n/<язык>.json`.
Готовые каталоги `apps/desktop/ui/i18n/` собирает скрипт:

```
python3 scripts/i18n_catalogs.py <for-web>/packages/client/components/i18n/catalogs
```

## Документация

- [docs/install.md](docs/install.md) — установка бутстрапом, структура папки, portable-режим
- [docs/build.md](docs/build.md) — сборка из исходников и релизы
- [docs/stoat-core.md](docs/stoat-core.md) — ядро: протокол, решения, что проверено
- [docs/avia-setup-windows.md](docs/avia-setup-windows.md) — референс по Avia Client
  (темы/плагины в JS-клиенте, для сравнения подходов)
- [docs/plugin-api-notes.md](docs/plugin-api-notes.md) — заметки по API плагинов

## Лицензия

AGPL-3.0-or-later.
