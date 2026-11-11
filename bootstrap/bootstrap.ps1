# Arachnid Client: портативный бутстрап для Windows.
#
# Создаёт отдельную папку, скачивает в неё нужные файлы и готовит клиент к
# запуску — официальный Stoat при этом не задействован.
#
# Запуск (PowerShell):
#   .\bootstrap.ps1                          # установка в $HOME\Arachnid-Client
#   .\bootstrap.ps1 -Dir D:\Apps\Arachnid-Client # своя папка
#   .\bootstrap.ps1 -Check                   # только проверить окружение
#
# Если PowerShell блокирует запуск скриптов:
#   powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1

[CmdletBinding()]
param(
    [string]$Dir = (Join-Path $HOME "Arachnid-Client"),
    [switch]$Check,
    [string]$Token = $env:STOAT_TOKEN
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repo = "sssHpion007/Arachnid-Client-Stoat"
$ModelsVersion = "0.16.3"
$ApiRoot = "https://api.stoat.chat"

function Info($text) { Write-Host ":: $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "   [ok] $text" -ForegroundColor Green }
function Warn($text) { Write-Host "   [!]  $text" -ForegroundColor Yellow }
function Die($text)  { Write-Host "[x] $text" -ForegroundColor Red; exit 1 }

function Download($url, $dest) {
    $parent = Split-Path -Parent $dest
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -Headers @{ "User-Agent" = "Arachnid-Client-bootstrap" }
}

function FetchText($url) {
    try {
        return (Invoke-WebRequest -Uri $url -UseBasicParsing -Headers @{
            "User-Agent" = "Arachnid-Client-bootstrap"
            "Accept"     = "application/vnd.github+json"
        }).Content
    } catch {
        return $null
    }
}

function Get-Sha256($path) {
    return (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower()
}

# ────────────────────────────── проверки системы ────────────────────────────
function Report-Environment {
    Info "проверка окружения"
    $os = [System.Environment]::OSVersion.VersionString
    Ok "Windows: $os"
    if ([Environment]::Is64BitOperatingSystem) { Ok "64-битная система" } else { Warn "32-битная система: релизы не поддерживаются" }

    $webview = Get-ChildItem "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients" -ErrorAction SilentlyContinue |
        Where-Object { $_.PSChildName -eq "{F3017226-FE2A-4295-9C7F-95BAF4DC24F3}" }
    if ($webview) { Ok "WebView2 Runtime установлен" }
    else { Warn "WebView2 Runtime не найден — клиент не запустится без него. Скачайте с https://developer.microsoft.com/microsoft-edge/webview2/" }

    if (Get-Command git -ErrorAction SilentlyContinue) { Ok "git есть" } else { Warn "git нет (нужен только для сборки из исходников)" }
    if (Get-Command cargo -ErrorAction SilentlyContinue) { Ok "cargo есть (Rust)" } else { Warn "Rust нет (нужен только для сборки из исходников)" }
}

# ─────────────────────────────── структура ──────────────────────────────────
function New-Layout {
    Info "каталог: $Dir"
    foreach ($sub in @("cache\autumn", "cache\embeds", "plugins", "themes", "logs", "vendor")) {
        New-Item -ItemType Directory -Path (Join-Path $Dir $sub) -Force | Out-Null
    }
    Ok "созданы cache\, plugins\, themes\, logs\, vendor\"

    $config = Join-Path $Dir "config.toml"
    if (-not (Test-Path $config)) {
        @'
# Конфигурация Arachnid Client.
# Токен сюда НЕ пишется: он хранится в системном хранилище (Credential Manager).

[instance]
api_url = "https://api.stoat.chat"
ws_url  = "wss://events.stoat.chat"
# Свой сервер:
# api_url = "https://stoat.example.com/api"
# ws_url  = "wss://stoat.example.com/events"

[app]
name = "Arachnid Client"
check_updates = true

[plugins]
enabled = true
dir = "plugins"
memory_limit_mib = 64
call_timeout_ms = 50

[ui]
theme = "dark"
density = "cozy"

[cache]
max_size_mib = 512
'@ | Set-Content -Path $config -Encoding UTF8
        Ok "создан config.toml"
    } else {
        Ok "config.toml уже есть — не трогаю"
    }

    $readme = Join-Path $Dir "README.txt"
    if (-not (Test-Path $readme)) {
        @'
Arachnid Client — портативная установка (Windows)
=============================================

 config.toml   настройки (инстанс, плагины, кэш)
 plugins\      плагины (папка на плагин: .wasm + manifest.json)
 themes\       темы оформления
 cache\        кэш файлов и картинок, можно удалять целиком
 logs\         журналы
 vendor\       скачанные зависимости и установщик сборки

Запуск: arachnid-client.exe
Удаление: удалить всю папку. Ничего вне неё клиент не создаёт.
Перенос: папку можно скопировать на другой диск или флешку.
'@ | Set-Content -Path $readme -Encoding UTF8
        Ok "создан README.txt"
    }
}

# ─────────────────────────────── сеть и инстанс ─────────────────────────────
function Test-Instance {
    Info "инстанс: проверяю $ApiRoot"
    $content = FetchText "$ApiRoot/"
    if (-not $content) {
        Warn "API недоступен — клиент проверит связь при запуске"
        return
    }
    New-Item -ItemType Directory -Path (Join-Path $Dir "vendor") -Force | Out-Null
    $content | Set-Content -Path (Join-Path $Dir "vendor\api-root.json") -Encoding UTF8
    try {
        $root = $content | ConvertFrom-Json
        Ok "API отвечает, версия $($root.stoat)"
        if ($root.ws) { Ok "gateway: $($root.ws)" }
        if ($root.features.autumn.url) { Ok "файлы: $($root.features.autumn.url)" }
        if ($root.stoat -and $root.stoat -ne $ModelsVersion) {
            Warn "API $($root.stoat), модели в коде собраны под $ModelsVersion"
        }
    } catch {
        Ok "ответ получен (разобрать JSON не удалось)"
    }
}

function Test-Token {
    if (-not $Token) { return }
    Info "аккаунт: проверяю токен"
    try {
        $response = Invoke-WebRequest -Uri "$ApiRoot/users/@me" -UseBasicParsing -Headers @{
            "x-session-token" = $Token
        }
        if ($response.StatusCode -eq 200) { Ok "токен принят" }
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code -eq 401 -or $code -eq 403) { Warn "токен отклонён (HTTP $code)" }
        else { Warn "не удалось проверить токен: $($_.Exception.Message)" }
    }
}

# ───────────────────────────────── vendor ───────────────────────────────────
function Get-Vendor {
    Info "vendor: скачиваю рабочие файлы"
    $crate = Join-Path $Dir "vendor\revolt-models-$ModelsVersion.crate"
    if (Test-Path $crate) {
        Ok "revolt-models $ModelsVersion уже скачан"
    } else {
        try {
            Download "https://static.crates.io/crates/revolt-models/revolt-models-$ModelsVersion.crate" $crate
            Ok "revolt-models $ModelsVersion ($([math]::Round((Get-Item $crate).Length / 1MB, 1)) МиБ)"
        } catch {
            Warn "не удалось скачать revolt-models — не критично"
        }
    }

    $lines = @()
    foreach ($file in @($crate, (Join-Path $Dir "vendor\api-root.json"))) {
        if (Test-Path $file) {
            $name = Split-Path -Leaf $file
            $lines += "$(Get-Sha256 $file)  vendor/$name"
        }
    }
    if ($lines.Count -gt 0) {
        $lines | Set-Content -Path (Join-Path $Dir "vendor\checksums.txt") -Encoding UTF8
        Ok "записаны checksums.txt"
    }
}

# ─────────────────────────────── релиз клиента ─────────────────────────────
function Get-Client {
    Info "клиент: ищу сборку в релизах $Repo"
    $json = FetchText "https://api.github.com/repos/$Repo/releases/latest"
    if (-not $json) {
        Warn "релизов нет или репозиторий недоступен"
        Warn "сборка из исходников: docs\build.md"
        return
    }

    $release = $json | ConvertFrom-Json
    if (-not $release.tag_name) {
        Warn "в релизах пока нет собранных версий — они появятся после первого CI-прогона"
        Warn "собрать локально: docs\build.md"
        return
    }

    $asset = $release.assets |
        Where-Object { $_.name -match "windows" } |
        Sort-Object { if ($_.name -match "\.msi$|\.exe$") { 0 } else { 1 } } |
        Select-Object -First 1

    if (-not $asset) {
        Warn "в релизе $($release.tag_name) нет файла для Windows"
        Warn "посмотрите https://github.com/$Repo/releases"
        return
    }

    Info "клиент: версия $($release.tag_name) → $($asset.name)"
    $dest = Join-Path $Dir "vendor\$($asset.name)"
    try {
        Download $asset.browser_download_url $dest
        Ok "скачано: vendor\$($asset.name) ($([math]::Round((Get-Item $dest).Length / 1MB, 1)) МиБ)"
        $release.tag_name | Set-Content -Path (Join-Path $Dir "vendor\VERSION") -Encoding UTF8
        Ok "запустите установщик из vendor\ или положите portable-сборку в эту папку"
    } catch {
        Warn "не удалось скачать сборку: $($_.Exception.Message)"
    }
}

function Show-NextSteps {
    Write-Host ""
    Write-Host "Готово. Всё лежит в $Dir — официальный Stoat не задействован." -ForegroundColor Green
    Write-Host ""
    Write-Host "Дальше:"
    Write-Host "  1. Открыть папку:        explorer `"$Dir`""
    Write-Host "  2. Настроить инстанс:    config.toml"
    Write-Host "  3. Запустить:            arachnid-client.exe (или установщик из vendor\)"
    Write-Host "  4. Плагины:              $Dir\plugins (подпапка на плагин)"
    Write-Host ""
    Write-Host "Повторный запуск обновляет файлы, ничего не ломая. Удаление — удалить папку."
    Write-Host ""
}

# ─────────────────────────────────── main ───────────────────────────────────
Report-Environment

if ($Check) {
    Info "-Check: ничего не меняю"
    Test-Instance
    Test-Token
    exit 0
}

if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
New-Layout
Test-Instance
Test-Token
Get-Vendor
Get-Client
Show-NextSteps
