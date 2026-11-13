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

# упавшие тесты: "thread '…' panicked at file:line:col:" и строки после неё
# до пустой или "note:" (у assert_eq — значения left и right)
awk '
  function flush() {
    if (file != "") printf "::error file=%s,line=%s::%s\n", file, line, msg
    file = ""
  }
  /panicked at / {
    flush()
    where = $0; sub(/.*panicked at /, "", where); sub(/:$/, "", where)
    split(where, at, ":"); file = at[1]; line = at[2]
    msg = $0; gsub(/%/, "%25", msg); gsub(/\r/, "", msg)
    next
  }
  file != "" && (/^$/ || /^\r$/ || /^note: / || /^test / || length(msg) > 3500) { flush(); next }
  file != "" { text = $0; gsub(/%/, "%25", text); gsub(/\r/, "", text); msg = msg "%0A" text }
  END { flush() }
' "$log"

# cargo fmt --check: "Diff in /path/file.rs:12:" и сама разница до следующей.
# Все места одного файла — одной аннотацией: аннотаций-ошибок на шаг
# показывается не больше 10, а мест в файле бывает больше.
awk '
  function flush() {
    if (file != "") printf "::error file=%s,line=%s::rustfmt: файл не отформатирован%s\n", file, line, diff
    file = ""
  }
  /^Diff in / {
    where = $0; sub(/^Diff in /, "", where); sub(/:$/, "", where)
    at = where; sub(/.*:/, "", at); name = where; sub(/:[0-9]+$/, "", name)
    if (name != file) { flush(); file = name; line = at; diff = "" }
    diff = diff "%0A@@ " at
    next
  }
  file != "" && length(diff) < 60000 { text = $0; gsub(/%/, "%25", text); gsub(/\r/, "", text); diff = diff "%0A" text }
  END { flush() }
' "$log"

exit "$status"
