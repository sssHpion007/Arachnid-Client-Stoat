#!/usr/bin/env bash
# Запустить команду cargo и превратить её ошибки в аннотации GitHub.
#
# Логи Actions доступны не всем инструментам, а аннотации отдаются через
# обычный API (check-runs/{id}/annotations), поэтому ошибки компиляции,
# предупреждения clippy, упавшие тесты и неотформатированные файлы видны
# прямо в PR и в API без скачивания логов.
#
#   .github/scripts/annotate.sh cargo clippy -p arachnid-client -- -D warnings
set -uo pipefail

# цветной вывод ломает разбор строк
export CARGO_TERM_COLOR=never

log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}

# error[E0308]: текст  /  warning: текст, а через строку — "  --> file:line:col"
awk '
  /^(error|warning)(\[[A-Za-z0-9]+\])?: / { kind = ($1 ~ /^error/) ? "error" : "warning"; msg = $0; next }
  kind != "" && /^ *--> / {
    split($2, at, ":")
    gsub(/%/, "%25", msg); gsub(/\r/, "", msg)
    printf "::%s file=%s,line=%s,col=%s::%s\n", kind, at[1], at[2], at[3], msg
    kind = ""
  }
' "$log"

# упавшие тесты: "thread '…' panicked at file:line:col:" и следующая строка
awk '
  /panicked at / {
    where = $0; sub(/.*panicked at /, "", where); sub(/:$/, "", where)
    split(where, at, ":"); getline detail
    printf "::error file=%s,line=%s::%s — %s\n", at[1], at[2], $0, detail
  }
' "$log"

# cargo fmt --check: "Diff in /path/file.rs:12:"
grep -E '^Diff in ' "$log" | sed -E 's#^Diff in (.*):([0-9]+):?$#::error file=\1,line=\2::rustfmt: файл не отформатирован#' || true

exit "$status"
