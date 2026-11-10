# Сборка из исходников

## Что нужно

- Rust stable (toolchain закреплён в `rust-toolchain.toml`, rustup подтянет сам)
- **Windows**: MSVC Build Tools + WebView2 Runtime
- **Linux**: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf libssl-dev`
- **macOS**: Xcode Command Line Tools

## Ядро (без GUI)

Работает везде, собирается и тестируется без графических библиотек:

```bash
cargo test -p stoat-core
cargo run -p stoat-core --example probe           # связь с инстансом
cargo run -p stoat-core --example gateway_probe   # gateway
STOAT_TOKEN=... cargo run -p stoat-core --example gateway_probe
```

## Клиент (Tauri)

```bash
cargo build --release -p tauri-stoat
```

Готовый бинарник: `target/release/tauri-stoat` (Windows: `tauri-stoat.exe`).

Установщики (нужен CLI Tauri):

```bash
cargo install tauri-cli --version "^2"
cd apps/desktop/src-tauri
cargo tauri build
```

Результат: `target/release/bundle/` — `.msi` и `.exe` (NSIS) на Windows,
`.deb`/`.AppImage` на Linux, `.app`/`.dmg` на macOS.

Для проверки интерфейса без установщика:

```bash
cd apps/desktop/src-tauri
cargo tauri dev
```

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
TAURI_STOAT_DIR=/path/to/folder ./tauri-stoat
```

или положите `config.toml` рядом с исполняемым файлом — клиент использует
свой каталог вместо системного.
