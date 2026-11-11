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
    foreach ($sub in @("logs", "vendor")) {
        New-Item -ItemType Directory -Path (Join-Path $Dir $sub) -Force | Out-Null
    }
    Ok "созданы logs\, vendor\ (профиль webview\ клиент создаст сам)"

    $config = Join-Path $Dir "config.toml"
    if (-not (Test-Path $config)) {
        @'
# Конфигурация Arachnid Client.
# Клиент открывает официальный веб-клиент Stoat, как Stoat for Desktop.

[instance]
# Адрес веб-клиента, который открывается в окне.
# Свой инстанс: адрес его веб-клиента, например "https://stoat.example.com".
app_url = "https://stoat.chat/app"
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

 config.toml   адрес веб-клиента Stoat (по умолчанию stoat.chat/app)
 desktop.json  настройки раздела «ПК» (создаётся при первом запуске)
 webview\      вход, сессия и кэш веб-клиента
 logs\         журналы
 vendor\       ответ инстанса и установщик сборки

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
    Info "vendor: контрольные суммы"
    $lines = @()
    foreach ($file in @((Join-Path $Dir "vendor\api-root.json"))) {
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
    Write-Host "  2. Свой инстанс:         config.toml, app_url (по умолчанию stoat.chat/app)"
    Write-Host "  3. Запустить:            arachnid-client.exe (или установщик из vendor\)"
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
