# Установка и запуск

## Что скачать

Файлы — в [релизах](https://github.com/sssHpion007/Arachnid-Client-Stoat/releases/latest):

| Система | Установщик | Без установки |
|---|---|---|
| Windows 10/11 x64 | `Arachnid-Client-Setup.exe` | `ArachnidClient.exe` |
| Linux x64 | `Arachnid-Client-Setup.deb` (Ubuntu, Debian, Mint…) или `Arachnid-Client-Setup.rpm` (Fedora, openSUSE…) | `ArachnidClient.AppImage` |
| macOS 11+ (Apple Silicon и Intel) | `Arachnid-Client-Setup.dmg` | `ArachnidClient.app.zip` |

Файлы не подписаны сертификатом разработчика, поэтому при первом запуске система
предупредит:

- **Windows:** «Windows защитила ваш компьютер» → «Подробнее» → «Выполнить в любом
  случае».
- **macOS:** правый щелчок по приложению → «Открыть» (или «Системные настройки» →
  «Конфиденциальность и безопасность» → «Всё равно открыть»).
- **Linux, AppImage:** `chmod +x "ArachnidClient.AppImage"`, затем запуск.

## Без установки (portable)

Одиночный файл хранит всё в папке **рядом с собой**, поэтому положите его в
отдельную папку. При первом запуске там появятся:

```
ArachnidClient.exe    клиент (.AppImage в Linux, .app в macOS)
config.toml           адрес веб-клиента и экономия памяти — создаётся вручную, если нужно
desktop.json          настройки раздела «ПК»
webview/              вход, сессия и кэш веб-клиента
themes/               свои темы (docs/extensions.md)
plugins/              плагины
quickcss.css          свой CSS (создаётся редактором QuickCSS)
extensions.json       выбранная тема, её настройки и включённые плагины
favorite-gifs/        избранные GIF: ссылки, описания и превью
logs/                 журналы
```

Папку можно перенести на другой диск или флешку — вместе со входом. Удаление —
удалить папку (и выключить «Запускать вместе с компьютером», если включали).

В macOS распакуйте `ArachnidClient.app.zip` и перенесите `Arachnid Client.app`
в нужную папку до первого запуска: приложение, запущенное прямо из «Загрузок»,
macOS открывает по временному пути только для чтения, и тогда клиент хранит данные
в системном каталоге.

## С установщиком

Установленный клиент хранит данные в системном каталоге приложения:

- **Windows:** `%APPDATA%\com.arachnid.client`
- **Linux:** `~/.local/share/com.arachnid.client`
- **macOS:** `~/Library/Application Support/com.arachnid.client`

## Как клиент находит папку данных

Порядок (первое совпадение):

1. переменная окружения `ARACHNID_CLIENT_DIR`;
2. папка рядом с клиентом — у одиночного файла всегда, у установленного клиента —
   если рядом с ним лежит `config.toml` (portable-режим);
3. системный каталог данных приложения.

## Свой инстанс

Положите в папку данных `config.toml`:

```toml
[instance]
app_url = "https://stoat.example.com"
```

## Требования

- **Windows**: 10/11 x64, WebView2 Runtime (в Windows 11 уже есть; для 10 его
  ставит установщик, для одиночного файла —
  [установщик от Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/)).
- **Linux**: x64, WebKitGTK 4.1 (`libwebkit2gtk-4.1-0`).
- **macOS**: 11+, Apple Silicon или Intel.
- Для сборки из исходников: [build.md](build.md).
