"""Сервер страницы проверки клиента в WebView2 (run.ps1).

Отдаёт тестовую «веб-клиент» страницу (app/) по адресу
http://127.0.0.1:8765/app/ — его клиент открывает как свой инстанс
(config.toml, [instance] app_url) — и localforage из node_modules. Страница
присылает ход проверки на /log и итог на /result (result.json рядом с
сервером).

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
    "/app/localforage.js": (
        HERE / "node_modules" / "localforage" / "dist" / "localforage.js",
        "text/javascript; charset=utf-8",
    ),
}


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
        entry = FILES.get(path)
        if entry is None:
            self.send_error(404)
            return
        file, content_type = entry
        body = file.read_bytes()
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
        else:
            self.send_error(404)
            return
        self.send_response(204)
        self.end_headers()

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        log(f"[http] {self.address_string()} {format % args}")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    log(f"сервер проверки: http://127.0.0.1:{PORT}/app/")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
