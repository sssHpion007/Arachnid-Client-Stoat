# Установка и запуск

Задача этих файлов — развернуть клиент в **отдельной папке**, ничего не кладя
в каталог официального Stoat и не трогая системные настройки.

## Что скачать

| Платформа | Файл | Как запустить |
|---|---|---|
| Windows | [`bootstrap.ps1`](../bootstrap/bootstrap.ps1) | ПКМ → «Выполнить с помощью PowerShell», либо `powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1` |
| Linux / macOS | [`bootstrap.sh`](../bootstrap/bootstrap.sh) | `chmod +x bootstrap.sh && ./bootstrap.sh` |

Оба скрипта лежат в репозитории и прикладываются к релизам автоматически.

## Что делает бутстрап

1. Создаёт папку (`~/Arachnid-Client` по умолчанию, можно указать свою через `--dir`).
2. Раскладывает структуру: `cache/`, `plugins/`, `themes/`, `logs/`, `vendor/`.
3. Пишет `config.toml` с настройками инстанса и `README.txt` (существующие не
   перезаписывает).
4. Проверяет связь с API и сохраняет ответ `GET /` в `vendor/api-root.json` —
   это и есть «файлы, нужные для работы»: адреса API, gateway, файлового сервиса
   и лимиты инстанса.
5. Скачивает `revolt-models-0.16.3.crate` — официальные модели API (MIT) ровно
   той версии, под которую собран клиент: по ним сверяются схемы и из них
   собирается ядро из исходников.
6. Ищет сборку клиента в релизах GitHub под вашу ОС/архитектуру, скачивает,
   распаковывает и пишет `vendor/VERSION`.
7. Считает `vendor/checksums.txt` по всему скачанному.

Повторный запуск обновляет файлы и ничего не ломает. `--check` (или `-Check` в
PowerShell) только проверяет окружение и связь с инстансом, ничего не записывая.

## Параметры

```bash
./bootstrap.sh --help
./bootstrap.sh --dir ~/apps/stoat        # своя папка
./bootstrap.sh --check                   # только проверки
./bootstrap.sh --no-ui                   # без интерактивного вопроса о пути
./bootstrap.sh --token "$STOAT_TOKEN"    # заодно проверить токен сессии
./bootstrap.sh --github-token "$PAT"     # репозиторий приватный
```

```powershell
.\bootstrap.ps1 -Dir D:\Apps\Arachnid-Client
.\bootstrap.ps1 -Check
.\bootstrap.ps1 -Token $env:STOAT_TOKEN
```

Токен GitHub нужен только для скачивания **приватного** репозитория:
`ARACHNID_CLIENT_GH_TOKEN` или `--github-token`. Токен Stoat (сессии) — только для
проверки, в файлы он не пишется.

## Что появится в папке

```
Arachnid-Client/
├── config.toml      настройки: инстанс, плагины, кэш, UI
├── README.txt       краткая памятка
├── arachnid-client.exe  клиент (после распаковки релиза)
├── cache/           кэш файлов и картинок — можно удалять целиком
├── plugins/         плагины: подпапка на плагин (.wasm + manifest.json)
├── themes/          темы оформления
├── logs/            журналы
└── vendor/          api-root.json, revolt-models-*.crate, checksums.txt, сборка
```

## Как клиент находит папку

Порядок (первое совпадение):

1. переменная `ARACHNID_CLIENT_DIR` — её выставляет запуск из бутстрапа;
2. рядом с исполняемым файлом, если там лежит `config.toml` (portable-режим);
3. системный каталог данных приложения (если запустили без папки).

То есть папку можно перенести на другой диск или флешку — путь нигде не
зашит, а официальный Stoat не задействован вообще.

## Если релиза ещё нет

Пока в репозитории нет тега вида `v0.1.0`, сборки не существует и бутстрап
честно об этом скажет. Варианты:

- собрать локально: [build.md](build.md);
- запустить только ядро для проверки связи: `cargo run -p stoat-core --example probe`.

## Требования

- **Windows**: 10/11 x64, WebView2 Runtime (в Windows 11 уже есть; для 10 —
  [установщик от Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/)).
- **Linux**: glibc-совместимый дистрибутив, WebKitGTK 4.1 (`libwebkit2gtk-4.1-0`).
- **macOS**: 11+, Apple Silicon или Intel.
- Для сборки из исходников: Rust stable и Node.js 20+.
