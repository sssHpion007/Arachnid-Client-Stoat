#!/usr/bin/env bash
# Arachnid Client: портативный бутстрап.
#
# Создаёт рядом с собой изолированный каталог (~/Arachnid-Client по умолчанию),
# скачивает в него нужные файлы и готовит всё для запуска клиента — так, чтобы
# ничего не приходилось класть в папку с официальным Stoat.
#
# Использование:
#   ./bootstrap.sh                  # установка/обновление в ~/Arachnid-Client
#   ./bootstrap.sh --dir ~/games/stoat --no-ui   # без интерактивных вопросов
#   ./bootstrap.sh --check          # только проверить окружение, ничего не менять
#
# Скрипт идемпотентен: повторный запуск обновляет уже скачанное, а не ломает его.

set -euo pipefail

APP_NAME="Arachnid-Client"
DEFAULT_DIR="${HOME}/Arachnid-Client"

# ── изменение этих значений меняет только «что качать», не логику ────────────
ARACHNID_CLIENT_REPO="sssHpion007/Arachnid-Client-Stoat"

INSTALL_DIR=""
CHECK_ONLY=0
INTERACTIVE=1
TOKEN="${STOAT_TOKEN:-}"
GH_TOKEN="${ARACHNID_CLIENT_GH_TOKEN:-${GITHUB_TOKEN:-}}"

# ────────────────────────────────── цвета ───────────────────────────────────
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else
  B=""; DIM=""; G=""; Y=""; R=""; N=""
fi

info() { printf '%s\n' "${B}::$1${N} ${2:-}"; }
ok()   { printf '   %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '   %s!%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '%s✗ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# ─────────────────────────────── разбор аргументов ──────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --dir=*) INSTALL_DIR="${1#*=}"; shift ;;
    --check|--dry-run) CHECK_ONLY=1; shift ;;
    --yes|-y|--no-ui) INTERACTIVE=0; shift ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --token=*) TOKEN="${1#*=}"; shift ;;
    --github-token) GH_TOKEN="${2:-}"; shift 2 ;;
    --github-token=*) GH_TOKEN="${1#*=}"; shift ;;
    -h|--help) usage ;;
    *) die "неизвестный аргумент: $1 (см. --help)" ;;
  esac
done

[ -n "$INSTALL_DIR" ] || INSTALL_DIR="$DEFAULT_DIR"
# убираем хвостовой слеш, чтобы пути дальше были предсказуемы
INSTALL_DIR="${INSTALL_DIR%/}"

# ─────────────────────────────────── ОС ─────────────────────────────────────
detect_platform() {
  case "$(uname -s)" in
    Linux*)
      case "$(uname -m)" in
        x86_64|amd64) PLATFORM="linux"; ARCH="x86_64" ;;
        aarch64|arm64) PLATFORM="linux"; ARCH="aarch64" ;;
        *) die "неизвестная архитектура: $(uname -m)" ;;
      esac
      ;;
    Darwin*)
      PLATFORM="macos"
      case "$(uname -m)" in
        arm64) ARCH="aarch64" ;;
        x86_64) ARCH="x86_64" ;;
        *) die "неизвестная архитектура: $(uname -m)" ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*)
      PLATFORM="windows"; ARCH="x86_64"
      warn "вы в Git Bash / MSYS. Рекомендуется запускать bootstrap.ps1 из PowerShell"
      ;;
    *)
      die "неподдерживаемая ОС: $(uname -s). На Windows используйте bootstrap.ps1"
      ;;
  esac
}

# ──────────────────────────────── инструменты ───────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

download() {
  # download <url> <куда>
  local url="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  local -a auth=()
  # ассеты приватного репозитория отдаются только с токеном:
  # либо через api.github.com/.../releases/assets/<id>, либо через github.com
  if [ -n "${GH_TOKEN}" ]; then
    if [ "${url#https://api.github.com/}" != "$url" ]; then
      auth=(-H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/octet-stream")
    elif [ "${url#https://github.com/}" != "$url" ]; then
      auth=(-H "Authorization: Bearer ${GH_TOKEN}")
    fi
  fi
  if have curl; then
    curl -fsSL --retry 3 --connect-timeout 15 "${auth[@]}" -o "$dest" "$url"
  elif have wget; then
    wget -q -O "$dest" --tries=3 "$url"
  else
    die "нужен curl или wget"
  fi
}

fetch_text() {
  local url="$1"
  local -a auth=()
  if [ -n "${GH_TOKEN}" ] && [ "${url#https://api.github.com/}" != "$url" ]; then
    auth=(-H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json")
  fi
  if have curl; then
    curl -fsSL --retry 2 --connect-timeout 15 "${auth[@]}" "$url"
  elif have wget; then
    if [ ${#auth[@]} -gt 0 ]; then
      wget -q -O - --tries=2 --header="Authorization: Bearer ${GH_TOKEN}" "$url"
    else
      wget -q -O - --tries=2 "$url"
    fi
  else
    return 1
  fi
}


# Достать значение строкового поля из плоского JSON-объекта.
extract_json_field() {
  local key="$1"
  sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1
}

# ─────────────────────────────── структура ──────────────────────────────────
create_layout() {
  info "каталог" "$INSTALL_DIR"
  mkdir -p \
    "$INSTALL_DIR/logs" \
    "$INSTALL_DIR/vendor" \
    "$INSTALL_DIR/themes" \
    "$INSTALL_DIR/plugins"
  ok "созданы logs/, vendor/, themes/, plugins/ (профиль webview/ клиент создаст сам)"

  # конфиги берём из файлов рядом со скриптом; иначе пишем минимальный вариант
  local here
  here="$(cd "$(dirname "$0")" && pwd)"

  if [ ! -f "$INSTALL_DIR/config.toml" ]; then
    if [ -f "$here/config.toml" ]; then
      cp "$here/config.toml" "$INSTALL_DIR/config.toml"
    else
      cat > "$INSTALL_DIR/config.toml" <<'CFG'
[instance]
# адрес веб-клиента Stoat, который открывается в окне
app_url = "https://stoat.chat/app"
CFG
    fi
    ok "создан config.toml"
  else
    ok "config.toml уже есть — не трогаю"
  fi

  if [ ! -f "$INSTALL_DIR/README.txt" ]; then
    if [ -f "$here/README.txt" ]; then
      cp "$here/README.txt" "$INSTALL_DIR/README.txt"
    else
      printf 'Arachnid Client: запустите arachnid-client.exe из этой папки.\n' > "$INSTALL_DIR/README.txt"
    fi
    ok "создан README.txt"
  fi
}

# ──────────────────────────── интернет и инстанс ────────────────────────────
check_instance() {
  info "инстанс" "проверяю связь с API"
  local api_root="${ARACHNID_CLIENT_API_URL:-https://api.stoat.chat}"
  local body
  if body="$(fetch_text "${api_root}/")"; then
    local version ws
    version="$(printf '%s' "$body" | tr -d '\n' | sed -n 's/.*"stoat"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    ws="$(printf '%s' "$body" | tr -d '\n' | sed -n 's/.*"ws"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    ok "API отвечает, версия ${version:-?}"
    [ -n "$ws" ] && ok "gateway: $ws"
    if [ "$CHECK_ONLY" = "1" ]; then
      ok "ответ содержит конфигурацию (в режиме --check не сохраняю)"
    else
      mkdir -p "$INSTALL_DIR/vendor"
      printf '%s\n' "$body" > "$INSTALL_DIR/vendor/api-root.json"
    fi
    return 0
  fi
  warn "API недоступен — установка продолжится, клиент проверит связь при запуске"
  return 1
}

check_token() {
  [ -n "$TOKEN" ] || return 0
  info "аккаунт" "проверяю токен"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "x-session-token: ${TOKEN}" https://api.stoat.chat/users/@me 2>/dev/null || echo 000)"
  case "$code" in
    200) ok "токен принят, сессия рабочая" ;;
    401|403) warn "токен отклонён (HTTP $code) — проверьте его в настройках Stoat" ;;
    000) warn "не удалось проверить токен (нет сети)" ;;
    *) warn "неожиданный ответ HTTP $code" ;;
  esac
}

# ───────────────────────────── vendor: файлы для работы ─────────────────────
# Что лежит в vendor/:
#   api-root.json   — ответ инстанса на `GET /` (адреса CDN, gateway, лимиты)
#   checksums.txt   — контрольные суммы скачанного
fetch_vendor() {
  info "vendor" "контрольные суммы"
  (
    cd "$INSTALL_DIR" || exit 1
    : > vendor/checksums.txt
    for f in vendor/api-root.json; do
      [ -f "$f" ] || continue
      if have sha256sum; then
        sha256sum "$f" >> vendor/checksums.txt
      elif have shasum; then
        shasum -a 256 "$f" >> vendor/checksums.txt
      fi
    done
  )
  [ -s "$INSTALL_DIR/vendor/checksums.txt" ] && ok "записаны checksums.txt"
}

# ───────────────────────────── сам клиент (релиз) ───────────────────────────
fetch_client() {
  info "клиент" "ищу сборку в релизах ${ARACHNID_CLIENT_REPO}"

  local api="https://api.github.com/repos/${ARACHNID_CLIENT_REPO}/releases/latest"
  local json
  if ! json="$(fetch_text "$api")"; then
    warn "не удалось получить список релизов"
    if [ -z "${GH_TOKEN}" ]; then
      warn "репозиторий приватный: передайте токен --github-token <PAT с правами repo>"
      warn "или переменной окружения ARACHNID_CLIENT_GH_TOKEN"
    fi
    warn "клиент можно собрать из исходников: см. docs/build.md"
    return 0
  fi

  local tag
  tag="$(printf '%s' "$json" | tr -d '\n' | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ -z "$tag" ]; then
    warn "в релизах пока нет собранных версий"
    warn "это ожидаемо: сборка клиента появится после первого CI-прогона"
    warn "пока можно собрать локально: docs/build.md"
    return 0
  fi


  # разбираем список ассетов: python3 или jq, что найдётся
  local asset_json
  if have python3; then
    asset_json="$(printf '%s' "$json" | python3 -c '
import json, sys
platform, arch = sys.argv[1], sys.argv[2]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
assets = data.get("assets", [])
def score(a):
    n = a.get("name", "").lower()
    if platform not in n and not (platform == "windows" and n.endswith(".msi")):
        return -1
    return 2 if arch.lower() in n else 1
best = max(assets, key=score, default=None)
if best is not None and score(best) > 0:
    print(json.dumps({"name": best["name"], "api": best["url"], "browser": best["browser_download_url"]}))
' "$PLATFORM" "$ARCH")"
  elif have jq; then
    asset_json="$(printf '%s' "$json" | jq -c --arg p "$PLATFORM" --arg a "$ARCH" '
      [.assets[] | select(.name | ascii_downcase | contains($p))]
      | sort_by(if (.name | ascii_downcase | contains($a)) then 0 else 1 end)
      | first | if . then {name, api: .url, browser: .browser_download_url} else empty end')"
  else
    warn "нужен python3 или jq, чтобы разобрать список релизов"
    return 0
  fi

  if [ -z "$asset_json" ]; then
    warn "в релизе $tag нет файла для ${PLATFORM}/${ARCH}"
    warn "доступные файлы: https://github.com/${ARACHNID_CLIENT_REPO}/releases"
    return 0
  fi

  name="$(printf '%s' "$asset_json" | extract_json_field name)"
  local api_url browser_url
  api_url="$(printf '%s' "$asset_json" | extract_json_field api)"
  browser_url="$(printf '%s' "$asset_json" | extract_json_field browser)"

  # приватный репозиторий: browser_download_url отдаёт 404, работает только API
  if [ -n "${GH_TOKEN}" ] && [ -n "$api_url" ]; then
    url="$api_url"
  else
    url="$browser_url"
  fi

  info "клиент" "версия $tag → $name"
  if download "$url" "$INSTALL_DIR/vendor/$name"; then
    ok "скачано: vendor/$name ($(du -h "$INSTALL_DIR/vendor/$name" | cut -f1))"
    case "$name" in
      *.tar.gz|*.zip)
        info "клиент" "распаковываю"
        local stage="$INSTALL_DIR/vendor/unpack"
        rm -rf "$stage" && mkdir -p "$stage"
        case "$name" in
          *.tar.gz) tar xzf "$INSTALL_DIR/vendor/$name" -C "$stage" ;;
          *.zip)
            if have unzip; then
              unzip -qo "$INSTALL_DIR/vendor/$name" -d "$stage"
            else
              warn "нет unzip — распакуйте vendor/$name вручную в эту папку"
              return 0
            fi
            ;;
        esac

        # в архиве клиент лежит в подпапке (Arachnid-Client/) — поднимаем содержимое наверх
        local inner
        inner="$(find "$stage" -mindepth 1 -maxdepth 1 -type d | head -n1)"
        if [ -n "$inner" ] && [ "$(find "$stage" -mindepth 1 -maxdepth 1 | wc -l)" = "1" ]; then
          cp -R "$inner"/. "$INSTALL_DIR"/
        else
          cp -R "$stage"/. "$INSTALL_DIR"/
        fi
        rm -rf "$stage"

        chmod +x "$INSTALL_DIR"/arachnid-client* 2>/dev/null || true
        ok "распаковано в $INSTALL_DIR"
        ;;
      *.AppImage)
        chmod +x "$INSTALL_DIR/$name" && ok "сделан исполняемым: $name"
        ;;
      *)
        ok "файл установщика лежит в vendor/ — запустите его вручную"
        ;;
    esac
    printf '%s\n' "$tag" > "$INSTALL_DIR/vendor/VERSION"
  else
    warn "не удалось скачать сборку"
  fi
}

# ──────────────────────────────── проверки ──────────────────────────────────
report_tools() {
  info "проверка" "что есть в системе"
  have curl && ok "curl" || warn "curl не найден (нужен для докачки файлов)"
  have unzip && ok "unzip" || warn "unzip не найден (нужен для .zip релизов)"
  have sha256sum || have shasum && ok "sha256" || warn "нет утилиты контрольных сумм"
  have git && ok "git" || warn "git не найден (нужен только для сборки из исходников)"
  have cargo && ok "cargo $(cargo --version 2>/dev/null | awk '{print $2}')" || warn "Rust не установлен (нужен только для сборки из исходников)"
}

print_next_steps() {
  cat <<NEXT

${B}Готово.${N} Всё лежит в ${B}${INSTALL_DIR}${N} — официальный Stoat не задействован.

Что дальше:
  1. Откройте папку:            cd "${INSTALL_DIR}"
  2. Свой инстанс (если нужен): config.toml, app_url (по умолчанию stoat.chat/app)
  3. Запустите клиент:          ${LAUNCH_HINT}

Повторный запуск этого скрипта обновляет файлы и ничего не ломает.
Удаление — просто удалить папку.

NEXT
}

# ─────────────────────────────────── main ───────────────────────────────────
detect_platform
info "платформа" "${PLATFORM}/${ARCH}"
[ "$PLATFORM" = "windows" ] && LAUNCH_HINT="arachnid-client.exe"
[ "$PLATFORM" = "linux" ] && LAUNCH_HINT="./arachnid-client"
[ "$PLATFORM" = "macos" ] && LAUNCH_HINT="open 'Arachnid Client.app'"

report_tools

if [ "$CHECK_ONLY" = "1" ]; then
  info "режим" "--check: ничего не меняю"
  check_instance || true
  check_token || true
  exit 0
fi

if [ "$INTERACTIVE" = "1" ] && [ -t 0 ]; then
  printf '%s\n' ""
  printf '%s' "${B}Куда ставить?${N} [${INSTALL_DIR}]: "
  read -r answer
  [ -n "$answer" ] && INSTALL_DIR="${answer%/}"
fi

create_layout
check_instance || true
check_token || true
fetch_vendor
fetch_client
print_next_steps
