// Сборка twemoji.bin — набора Twemoji, который клиент отдаёт веб-клиенту
// сам, без запросов к static.stoat.chat (src/emoji.rs).
//
// Источник тот же, что у официального набора Stoat (stoatchat/javascript-
// genemoji, подмодуль packs/twemoji): SVG из jdecked/twemoji той же версии.
//
//   git clone https://github.com/jdecked/twemoji /tmp/twemoji
//   git -C /tmp/twemoji checkout b6b55fef1e8636b540a6d016a4729ca8cdf2e60b
//   node apps/desktop/src-tauri/emoji/pack.mjs /tmp/twemoji
//
// Формат (числа — little-endian):
//
//   "ATWE" | версия: u8 = 1 | количество: u32
//   записи по возрастанию ключа: длина ключа: u8 | ключ | смещение: u32 | длина: u32
//   данные: SVG, каждый сжат Brotli отдельно (смещения — от начала данных)
//
// Ключ — имя файла без «.svg» и без селекторов варианта fe0f: так genemoji
// сводит к одному файлу все формы записи эмодзи (с fe0f и без), и так же
// emoji.rs ищет запрошенный адрес.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const source = process.argv[2];
if (!source) {
  console.error("укажите папку с репозиторием jdecked/twemoji");
  process.exit(1);
}

const svgDir = join(source, "assets", "svg");
const key = (stem) =>
  stem
    .split("-")
    .filter((part) => part !== "fe0f")
    .join("-");

const files = new Map();
for (const name of readdirSync(svgDir).sort()) {
  if (!name.endsWith(".svg")) continue;
  const k = key(name.slice(0, -4));
  // формы с fe0f и без — одна картинка; первая по имени остаётся
  if (!files.has(k)) files.set(k, join(svgDir, name));
}

const keys = [...files.keys()].sort();
const blobs = keys.map((k) =>
  brotliCompressSync(readFileSync(files.get(k)), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }),
);

const header = [Buffer.from("ATWE"), Buffer.from([1])];
const count = Buffer.alloc(4);
count.writeUInt32LE(keys.length);
header.push(count);

let offset = 0;
keys.forEach((k, index) => {
  const name = Buffer.from(k, "ascii");
  const entry = Buffer.alloc(1 + name.length + 8);
  entry.writeUInt8(name.length, 0);
  name.copy(entry, 1);
  entry.writeUInt32LE(offset, 1 + name.length);
  entry.writeUInt32LE(blobs[index].length, 5 + name.length);
  header.push(entry);
  offset += blobs[index].length;
});

const out = Buffer.concat([...header, ...blobs]);
writeFileSync(new URL("./twemoji.bin", import.meta.url), out);
console.log(`twemoji.bin: ${keys.length} эмодзи, ${out.length} байт`);
