# Сборка из исходников

## Что нужно

- Rust stable (toolchain закреплён в `rust-toolchain.toml`, rustup подтянет сам)
- **Windows**: MSVC Build Tools + WebView2 Runtime
- **Linux**: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf libssl-dev`
- **macOS**: Xcode Command Line Tools

Node.js не нужен: интерфейс (for-web) загружается с сервера инстанса и в
сборку не входит. Встроенный набор Twemoji (`apps/desktop/src-tauri/emoji/twemoji.bin`)
лежит в репозитории готовым; Node.js понадобится, только чтобы пересобрать его
из jdecked/twemoji (`emoji/pack.mjs`, команды — в начале файла).

Скачиваемые наборы эмодзи (Fluent 3D, Fluent Color, Fluent Flat, Mutant Remix,
Noto) в сборку не входят. Их собирает `.github/workflows/emoji-packs.yml`
(`emoji/fetch.mjs` + `emoji/pack.mjs`) и выкладывает в пре-релиз
`emoji-packs-v1` вместе с `manifest.json` (размеры файлов). Workflow запускается
сам при изменениях в `apps/desktop/src-tauri/emoji/` и вручную.

## Клиент (Tauri)

```bash
cargo build --release -p arachnid-client
```

Готовый бинарник: `target/release/arachnid-client` (Windows: `arachnid-client.exe`).

Установщики (нужен CLI Tauri):

```bash
cargo install tauri-cli --version "^2"
cd apps/desktop/src-tauri
cargo tauri build
```

Результат: `target/release/bundle/` — `.msi` и `.exe` (NSIS) на Windows,
`.deb`/`.AppImage` на Linux, `.app`/`.dmg` на macOS.

Проверить с локальным for-web (его `mise dev` поднимает сервер на
`http://localhost:5173`): положите рядом с бинарником `config.toml` с
`app_url = "http://localhost:5173"` и запустите клиент.

## Автоматическая сборка

`.github/workflows/windows.yml` собирает архив для Windows (exe, `config.toml`,
`README.txt`, папки `themes/` и `plugins/`) при каждой отправке `main` и рабочих
веток `arena/…`. Так тестовую сборку можно получить из ветки, не сливая её в
`main`: архив лежит в артефактах запуска на вкладке Actions 30 дней.
`.github/workflows/ci.yml` (rustfmt, clippy, тесты) запускается на тех же
ветках и на pull request.

`.github/workflows/release.yml` собирает три платформы и прикладывает
`bootstrap.sh`/`bootstrap.ps1` к релизу. Запуск:

```bash
git tag v0.1.0
git push origin v0.1.0
```

После прогона появится draft-релиз с установщиками; опубликуйте его, и бутстрап
начнёт находить сборку автоматически.

## Портативный режим при сборке

Чтобы получить переносимую сборку, при запуске укажите папку:

```bash
ARACHNID_CLIENT_DIR=/path/to/folder ./arachnid-client
```

или положите `config.toml` рядом с исполняемым файлом — клиент использует
свой каталог вместо системного.

## Проверка в WebView2

`apps/desktop/src-tauri/e2e` — проверка собранного exe в настоящем WebView2.
Клиент открывает тестовую страницу (`e2e/app`) как веб-клиент своего инстанса
(`config.toml`, `app_url = "http://127.0.0.1:8765/app/"`). Страница повторяет
то, на что опирается клиент у for-web: localforage, service worker с
обработчиком `fetch` (как workbox), шторку выбора в `#floating`. Она проверяет:

- картинки Twemoji отдаёт клиент — в первой странице, под service worker и на
  запросы самого service worker (заголовок `Server-Timing` ответа);
- набор эмодзи по умолчанию — Twemoji при первом запуске и в прежних
  настройках с fluent-3d, а выбранный вручную набор остаётся;
- шторка выбора получает кнопки, Mutant Remix скачивается с релиза
  `emoji-packs-v1` и удаляется кнопками шторки, картинки скачанного набора
  отдаёт клиент.

В CI её запускает задача «проверка в WebView2» в `windows.yml` после сборки.
Локально (Windows, Python 3, Node.js):

```powershell
npm install --no-save --prefix apps/desktop/src-tauri/e2e localforage@1.10.0
pwsh apps/desktop/src-tauri/e2e/run.ps1 -Exe target/release/arachnid-client.exe
```
