# Проверка клиента в настоящем WebView2: собранный exe открывает тестовую
# страницу (app/) как веб-клиент своего инстанса, страница проходит шаги
# (app/test.js) и присылает итог серверу (server.py).
#
#   pwsh run.ps1 -Exe <путь к arachnid-client.exe>
#
# Нужны Python 3 и localforage в e2e/node_modules:
#   npm install --no-save --prefix apps/desktop/src-tauri/e2e localforage@1.10.0
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$work = Join-Path ([System.IO.Path]::GetTempPath()) "arachnid-e2e"
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
$data = Join-Path $work "data"
$out = Join-Path $work "out"
New-Item -ItemType Directory -Force -Path $data, $out | Out-Null

# свой каталог данных: чистый профиль WebView2 и адрес тестового инстанса
Set-Content -Encoding utf8 -Path (Join-Path $data "config.toml") -Value @"
[instance]
app_url = "http://127.0.0.1:8765/app/"
"@

$server = Start-Process -PassThru -NoNewWindow -FilePath python `
  -ArgumentList @((Join-Path $here "server.py"), $out) `
  -RedirectStandardOutput (Join-Path $work "server.out.txt") `
  -RedirectStandardError (Join-Path $work "server.err.txt")
Start-Sleep -Seconds 2

$env:ARACHNID_CLIENT_DIR = $data
$env:RUST_LOG = "info"
$client = Start-Process -PassThru -FilePath (Resolve-Path $Exe)

$result = Join-Path $out "result.json"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while (-not (Test-Path $result) -and (Get-Date) -lt $deadline -and -not $client.HasExited) {
  Start-Sleep -Seconds 1
}
$exited = $client.HasExited

Stop-Process -Id $client.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Write-Host "──────── server.log ────────"
if (Test-Path (Join-Path $out "server.log")) { Get-Content (Join-Path $out "server.log") }
Write-Host "──────── журнал клиента ────────"
Get-ChildItem -Path (Join-Path $data "logs") -File -ErrorAction SilentlyContinue |
  ForEach-Object { Get-Content $_.FullName }

# журналы — для артефакта проверки
$logs = Join-Path $here "logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
Copy-Item -Recurse -Force -Path (Join-Path $out "*") -Destination $logs -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force -Path (Join-Path $data "logs") -Destination $logs -ErrorAction SilentlyContinue

if (-not (Test-Path $result)) {
  if ($exited) { Write-Error "клиент завершился, не дождавшись итога" }
  Write-Error "итога нет за $TimeoutSeconds с"
}

$checks = (Get-Content -Raw $result | ConvertFrom-Json).results
$failed = @($checks | Where-Object { -not $_.ok })
Write-Host "──────── итог ────────"
foreach ($check in $checks) {
  $mark = if ($check.ok) { "OK  " } else { "FAIL" }
  Write-Host "$mark [шаг $($check.step)] $($check.name)"
}
if ($failed.Count -gt 0) {
  Write-Error "не прошло проверок: $($failed.Count) из $($checks.Count)"
}
Write-Host "все проверки прошли: $($checks.Count)"
