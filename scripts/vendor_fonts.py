#!/usr/bin/env python3
"""Шрифты раздела «Внешний вид» из пакетов @fontsource (как в for-web, fonts.ts).

Использование:
    python3 scripts/vendor_fonts.py <каталог с распакованными пакетами>

В каталоге лежат пакеты `npm pack` в подкаталогах вида
`_fontsource_open-sans/package`. Скрипт берёт те же начертания, что
загружает браузерный клиент, только латиницу и кириллицу, и пишет
`apps/desktop/ui/fonts/extra/*.woff2` и `apps/desktop/ui/fonts-extra.css`.
Браузер скачивает файл шрифта, только когда шрифт выбран.
"""

import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "apps" / "desktop" / "ui"
OUT = UI / "fonts" / "extra"
CSS = UI / "fonts-extra.css"

SUBSETS = ("latin", "latin-ext", "cyrillic", "cyrillic-ext")

# пакет → файлы CSS (начертания из fonts.ts for-web)
FONTS = {
    "open-sans": ["300", "400", "500", "600", "700", "400-italic"],
    "opendyslexic": ["400", "700", "400-italic"],
    "atkinson-hyperlegible": ["400", "700", "400-italic"],
    "roboto": ["400", "700", "400-italic"],
    "noto-sans": ["400", "700", "400-italic"],
    "bitter": ["300", "400", "600", "700"],
    "lato": ["300", "400", "700", "400-italic"],
    "lexend": ["300", "400", "700"],
    "montserrat": ["300", "400", "600", "700", "400-italic"],
    "poppins": ["300", "400", "600", "700", "400-italic"],
    "raleway": ["300", "400", "600", "700", "400-italic"],
    "ubuntu": ["300", "400", "500", "700", "400-italic"],
    "comic-neue": ["300", "400", "700", "400-italic"],
    "variable/ibm-plex-sans": ["wght"],
    "variable/plus-jakarta-sans": ["wght"],
    "variable/jetbrains-mono": ["wght", "wght-italic"],
    "roboto-mono": ["400"],
    "source-code-pro": ["400"],
    "space-mono": ["400"],
    "ubuntu-mono": ["400"],
    "ibm-plex-mono": ["400"],
}

BLOCK = re.compile(r"/\* (?P<name>[^*]+) \*/\s*@font-face\s*\{(?P<body>[^}]*)\}")


def package_dir(source: Path, name: str) -> Path:
    if name.startswith("variable/"):
        return source / ("_fontsource-variable_" + name.split("/", 1)[1]) / "package"
    return source / ("_fontsource_" + name) / "package"


def main() -> None:
    source = Path(sys.argv[1])
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    css = [
        "/* Шрифты раздела «Внешний вид» (fonts.ts в for-web), пакеты @fontsource.",
        "   Создан scripts/vendor_fonts.py — не править вручную.",
        "   Лицензии — fonts/extra/LICENSE-*.txt (SIL OFL 1.1 и Apache 2.0). */",
        "",
    ]
    for name, styles in FONTS.items():
        package = package_dir(source, name)
        license_file = package / "LICENSE"
        if license_file.exists():
            shutil.copy(license_file, OUT / f"LICENSE-{name.split('/')[-1]}.txt")
        for style in styles:
            text = (package / f"{style}.css").read_text()
            for match in BLOCK.finditer(text):
                # метка блока — «open-sans-cyrillic-ext-400-normal»
                label = match["name"].strip()
                if not any(f"-{subset}-" in label for subset in SUBSETS):
                    continue
                body = match["body"]
                woff2 = re.search(r"url\(\./files/([^)]+\.woff2)\)", body)
                if not woff2:
                    continue
                shutil.copy(package / "files" / woff2[1], OUT / woff2[1])
                body = re.sub(
                    r"src:[^;]+;",
                    f"src: url(\"fonts/extra/{woff2[1]}\") format(\"woff2\");",
                    body,
                )
                lines = [line.strip() for line in body.strip().splitlines() if line.strip()]
                css.append("@font-face {")
                css.extend("  " + line for line in lines)
                css.append("}")
                css.append("")
    CSS.write_text("\n".join(css))
    size = sum(path.stat().st_size for path in OUT.glob("*.woff2"))
    print(f"{len(list(OUT.glob('*.woff2')))} файлов, {size / 1024 / 1024:.1f} МБ")


if __name__ == "__main__":
    main()
