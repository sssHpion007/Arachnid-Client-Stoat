// Статический сервер превью с частичными ответами (Range), как у autumn.
// Запуск: node serve.mjs [порт] — затем открыть http://localhost:8090/
// (плашка «сейчас играет»; прежнее превью плеера — /index.html)
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
// скрипт и словари клиента — для страницы с плашкой (now-playing.html)
const client = fileURLToPath(new URL("../../apps/desktop/src-tauri/src/", import.meta.url));
const port = Number(process.argv[2] ?? 8090);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".json": "application/json; charset=utf-8",
};

/** Вложения, как в autumn: id → [файл превью, имя файла при загрузке] */
const attachments = {
  night: ["night-city.mp3", "night_city_final_v2.mp3"],
  morning: ["morning.mp3", "Утро.mp3"],
  remix: ["night-city.mp3", "Ночной город (ремикс).mp3"],
  bunny: ["big-buck-bunny.mp4", "Big Buck Bunny.mp4"],
  vertical: ["bunny-vertical.mp4", "VID_20261110_183012.mp4"],
  // HEVC (H.265), как у видео из TikTok
  tiktok: ["tiktok-hevc.mp4", "tiktok_7436512345678901234.mp4"],
};

/** Путь запроса → файл: /client/… — из клиента, /attachments/<id>/<имя> —
 *  файл превью, адреса каналов — страница с плашкой */
function resolve(path) {
  if (/^client[/\\]/.test(path)) return join(client, path.slice("client/".length));
  const attachment = /^attachments[/\\]([^/\\]+)[/\\]/.exec(path);
  if (attachment) return attachments[attachment[1]] ? join(root, attachments[attachment[1]][0]) : "";
  if (/^(server|channel)[/\\]/.test(path)) return join(root, "now-playing.html");
  return join(root, path || "now-playing.html");
}

createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^([/\\])+/, "");
  // как autumn: …/<id>/original → …/<id>/<имя файла>
  const original = /^attachments[/\\]([^/\\]+)[/\\]original$/.exec(path);
  if (original && attachments[original[1]]) {
    const location = `/attachments/${original[1]}/${encodeURIComponent(attachments[original[1]][1])}`;
    console.log(`${request.method} ${request.url} → ${location}`);
    response.writeHead(301, { Location: location, "Cache-Control": "no-store" }).end();
    return;
  }
  const file = resolve(path);
  let size;
  try {
    if (!file.startsWith(root) && !file.startsWith(client)) throw new Error();
    size = statSync(file).size;
  } catch {
    response.writeHead(404).end();
    return;
  }
  const headers = {
    "Content-Type": types[extname(file)] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  // скрипты и стили — с меткой версии, чтобы браузер не взял старые из кэша
  if (extname(file) === ".html") {
    const html = readFileSync(file, "utf8").replace(/(src|href)="([\w-]+\.(?:js|css))"/g, (_, attribute, name) => {
      let version = 0;
      try {
        version = Math.floor(statSync(join(root, name)).mtimeMs);
      } catch {}
      return `${attribute}="${name}?v=${version}"`;
    });
    console.log(`${request.method} ${request.url} страница`);
    response.writeHead(200, { ...headers, "Content-Length": Buffer.byteLength(html) });
    response.end(request.method === "HEAD" ? undefined : html);
    return;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    console.log(`${request.method} ${request.url} ${start}-${end}/${size}`);
    response.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    if (request.method === "HEAD") response.end();
    else createReadStream(file, { start, end }).pipe(response);
    return;
  }
  console.log(`${request.method} ${request.url} целиком`);
  response.writeHead(200, { ...headers, "Content-Length": size });
  if (request.method === "HEAD") response.end();
  else createReadStream(file).pipe(response);
}).listen(port, "0.0.0.0", () => console.log(`превью: http://localhost:${port}/`));
