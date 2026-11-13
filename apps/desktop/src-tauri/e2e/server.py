"""Сервер страницы проверки клиента в WebView2 (run.ps1).

Отдаёт тестовую «веб-клиент» страницу (app/) по адресу
http://127.0.0.1:8765/app/ — его клиент открывает как свой инстанс
(config.toml, [instance] app_url) — и localforage из node_modules. Страница
присылает ход проверки на /log и итог на /result (result.json рядом с
сервером).

Для избранных GIF — GIF, страница с ней в og:image, страница без GIF,
/.well-known/stoat с адресом API и сам API отправки сообщений: отправленное
отдаёт /e2e/sent.

    python server.py <папка для result.json и server.log>
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORT = 8765
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE

FILES = {
    "/app/": (HERE / "app" / "index.html", "text/html; charset=utf-8"),
    "/app/test.js": (HERE / "app" / "test.js", "text/javascript; charset=utf-8"),
    "/app/sw.js": (HERE / "app" / "sw.js", "text/javascript; charset=utf-8"),
    # значок роли 40×32, как картинка autumn с тегом icons
    "/icons/e2e-wide": (HERE / "app" / "wide-icon.svg", "image/svg+xml"),
    # GIF 60×40 из трёх кадров
    "/e2e/cat.gif": (HERE / "app" / "cat.gif", "image/gif"),
    "/app/localforage.js": (
        HERE / "node_modules" / "localforage" / "dist" / "localforage.js",
        "text/javascript; charset=utf-8",
    ),
}


# страница с GIF в теге Open Graph, как у Tenor и Giphy
PAGES = {
    "/e2e/page": '<html><head><meta property="og:title" content="Кот">'
    '<meta property="og:image" content="/e2e/cat.gif"></head><body>кот</body></html>',
    "/e2e/plain": "<html><head><title>Без GIF</title></head><body>текст</body></html>",
}
# отправленные сообщения: путь, тело и заголовки сессии
SENT: list[dict] = []


def log(line: str) -> None:
    print(line, flush=True)
    with open(OUT / "server.log", "a", encoding="utf-8") as file:
        file.write(line + "\n")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/app":
            self.send_response(301)
            self.send_header("Location", "/app/")
            self.end_headers()
            return
        if path == "/e2e/negotiated.gif":
            # как media1.tenor.com/m/… и Giphy: переходу по ссылке — страница,
            # картинке на странице — сам файл
            if "text/html" in self.headers.get("Accept", ""):
                self.reply(PAGES["/e2e/plain"].encode("utf-8"), "text/html; charset=utf-8")
            else:
                self.reply((HERE / "app" / "cat.gif").read_bytes(), "image/gif")
            return
        if path in PAGES:
            self.reply(PAGES[path].encode("utf-8"), "text/html; charset=utf-8")
            return
        if path == "/.well-known/stoat":
            api = f"http://127.0.0.1:{PORT}/api"
            self.reply(json.dumps({"api": api}).encode("utf-8"), "application/json")
            return
        if path == "/e2e/sent":
            self.reply(json.dumps(SENT).encode("utf-8"), "application/json")
            return
        entry = FILES.get(path)
        if entry is None:
            self.send_error(404)
            return
        file, content_type = entry
        self.reply(file.read_bytes(), content_type)

    def reply(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        if self.path == "/log":
            log(f"[page] {body}")
        elif self.path == "/result":
            (OUT / "result.json").write_text(body, encoding="utf-8")
            log("[page] итог записан")
        elif self.path.startswith("/api/channels/") and self.path.endswith("/messages"):
            SENT.append(
                {
                    "path": self.path,
                    "body": json.loads(body),
                    "token": self.headers.get("X-Session-Token"),
                    "idempotency": self.headers.get("Idempotency-Key"),
                }
            )
            self.reply(json.dumps({"_id": "01J0000000000000000000SENT"}).encode("utf-8"), "application/json")
            return
        else:
            self.send_error(404)
            return
        self.send_response(204)
        self.end_headers()

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        log(f"[http] {self.address_string()} {format % args}")


if __name__ == "__main__":
    # консоль Windows по умолчанию в cp1252, а журнал по-русски
    sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    log(f"сервер проверки: http://127.0.0.1:{PORT}/app/")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
