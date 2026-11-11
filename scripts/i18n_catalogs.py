#!/usr/bin/env python3
"""Собрать каталоги переводов интерфейса: apps/desktop/ui/i18n/<язык>.json.

Строки интерфейса пишутся английскими msgid браузерного клиента Stoat
(for-web): t("Save"), data-i18n="Log In". Перевод берётся из .po-файлов
for-web, а строки, которых в for-web нет (функции клиента для ПК), — из
своих каталогов apps/desktop/i18n/<язык>.json ({msgid: перевод}).

В каждый выходной файл попадают только msgid, которые встречаются в
интерфейсе, поэтому каталоги маленькие. Скрипт печатает строки, у которых
нет русского перевода ни в for-web, ни в своём каталоге, и завершается с
ошибкой, если такие есть: русский — основной язык проекта.

Запуск (каталоги for-web лежат в packages/client/components/i18n/catalogs):

    python3 scripts/i18n_catalogs.py /путь/к/for-web/.../i18n/catalogs
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "apps" / "desktop" / "ui"
OWN = ROOT / "apps" / "desktop" / "i18n"
OUT = UI / "i18n"

# t("…"), t('…') и `t(\n  "…"` — первый аргумент-литерал
CALL = re.compile(r"""\b(?:t|rich)\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')""")
# data-i18n="…", data-i18n-title="…", data-i18n-placeholder="…"
ATTR = re.compile(r"""data-i18n(?:-title|-placeholder)?="([^"]*)\"""")
# пометка для строк, которые собираются в коде: /* i18n */ "…"
MARK = re.compile(r"""/\*\s*i18n\s*\*/\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')""")


def load_po(path: Path) -> dict[str, str]:
    """msgid → msgstr из .po (без контекстов и множественных форм gettext)."""
    result: dict[str, str] = {}
    msgid = msgstr = None
    field = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("msgid "):
            if msgid:
                result[msgid] = msgstr or ""
            msgid, msgstr, field = ast.literal_eval(line[6:]), "", "id"
        elif line.startswith("msgstr "):
            msgstr, field = ast.literal_eval(line[7:]), "str"
        elif line.startswith('"') and field == "id":
            msgid += ast.literal_eval(line)
        elif line.startswith('"') and field == "str":
            msgstr += ast.literal_eval(line)
        elif not line.strip():
            field = None
    if msgid:
        result[msgid] = msgstr or ""
    return result


def used_msgids() -> set[str]:
    found: set[str] = set()
    for path in sorted(UI.glob("*.js")) + sorted(UI.glob("*.html")):
        if path.name == "i18n.js":
            continue
        text = path.read_text(encoding="utf-8")
        for match in CALL.finditer(text):
            found.add(ast.literal_eval(match.group(1)))
        for match in MARK.finditer(text):
            found.add(ast.literal_eval(match.group(1)))
        for match in ATTR.finditer(text):
            found.add(match.group(1).replace("&amp;", "&").replace("&quot;", '"'))
    return found


def language_files() -> list[str]:
    """Имена каталогов из списка языков в i18n.js (поле file)."""
    text = (UI / "i18n.js").read_text(encoding="utf-8")
    return sorted(set(re.findall(r'file: "([^"]+)"', text)))


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    catalogs = Path(sys.argv[1])
    msgids = used_msgids()
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("*.json"):
        stale.unlink()

    missing_ru: list[str] = []
    total = 0
    for name in language_files():
        upstream = load_po(catalogs / name / "messages.po") if (catalogs / name / "messages.po").exists() else {}
        own_path = OWN / f"{name}.json"
        own = json.loads(own_path.read_text(encoding="utf-8")) if own_path.exists() else {}
        catalog: dict[str, str] = {}
        for msgid in sorted(msgids):
            value = own.get(msgid) or upstream.get(msgid) or ""
            if value and value != msgid:
                catalog[msgid] = value
            elif name == "ru" and not value:
                missing_ru.append(msgid)
        (OUT / f"{name}.json").write_text(
            json.dumps(catalog, ensure_ascii=False, indent=0, sort_keys=True) + "\n", encoding="utf-8"
        )
        total += 1

    unused = sorted(set(json.loads((OWN / "ru.json").read_text(encoding="utf-8"))) - msgids) if (OWN / "ru.json").exists() else []
    print(f"строк в интерфейсе: {len(msgids)}, каталогов: {total}")
    if unused:
        print(f"в своём каталоге {len(unused)} неиспользуемых строк:")
        for msgid in unused:
            print("  -", msgid)
    if missing_ru:
        print(f"нет русского перевода ({len(missing_ru)}):")
        for msgid in missing_ru:
            print("  +", json.dumps(msgid, ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
