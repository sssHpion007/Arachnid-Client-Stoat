# Сборка из исходников

## Что нужно

- Rust stable (toolchain закреплён в `rust-toolchain.toml`, rustup подтянет сам)
- **Windows**: MSVC Build Tools + WebView2 Runtime
- **Linux**: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf libssl-dev`
- **macOS**: Xcode Command Line Tools

Node.js не нужен: интерфейс (for-web) загружается с сервера инстанса и в
сборку не входит.

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
