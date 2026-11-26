// Статический сервер превью меню форматирования.
// Запуск: npm i && node serve.mjs [порт] — затем открыть http://localhost:8091/
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2] ?? 8091);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

createServer((request, response) => {
  let path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^[/\\]+/, "");
  if (path === "" || path.startsWith("..")) path = "index.html";
  const file = join(root, path);
  try {
    if (!statSync(file).isFile()) throw new Error();
  } catch {
    response.writeHead(404).end("нет файла");
    return;
  }
  response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(response);
}).listen(port, "0.0.0.0", () => console.log(`превью: http://localhost:${port}/`));
