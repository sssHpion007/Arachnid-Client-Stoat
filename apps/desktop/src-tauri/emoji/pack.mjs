// Сборка файла набора эмодзи (.bin), который клиент отдаёт веб-клиенту сам,
// без запросов к static.stoat.chat (src/emoji_packs.rs).
//
//   node pack.mjs <папка с SVG> <файл .bin>
//
// Встроенный Twemoji (twemoji.bin) — из jdecked/twemoji той же версии, что и у
// официального набора Stoat (stoatchat/javascript-genemoji, подмодуль
// packs/twemoji):
//
//   git clone https://github.com/jdecked/twemoji /tmp/twemoji
//   git -C /tmp/twemoji checkout b6b55fef1e8636b540a6d016a4729ca8cdf2e60b
//   node apps/desktop/src-tauri/emoji/pack.mjs /tmp/twemoji/assets/svg apps/desktop/src-tauri/emoji/twemoji.bin
//
// Скачиваемые наборы собирает .github/workflows/emoji-packs.yml: fetch.mjs
// берёт их картинки с static.stoat.chat, этот скрипт упаковывает.
//
// Формат (числа — little-endian):
//
//   "AEMJ" | версия: u8 = 1 | количество: u32
//   записи по возрастанию ключа: длина ключа: u8 | ключ | смещение: u32 | длина: u32
//   данные: SVG, каждый сжат Brotli отдельно (смещения — от начала данных)
//
// Ключ — имя файла без «.svg» и без селекторов варианта fe0f: так genemoji
// сводит к одной картинке все формы записи эмодзи (с fe0f и без), и так же
// emoji_packs.rs ищет запрошенный адрес.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const [source, output] = process.argv.slice(2);
if (!source || !output) {
  console.error("использование: node pack.mjs <папка с SVG> <файл .bin>");
  process.exit(1);
}

const key = (stem) =>
  stem
    .toLowerCase()
    .split("-")
    .filter((part) => part !== "fe0f")
    .join("-");

const files = new Map();
for (const name of readdirSync(source).sort()) {
  if (!name.endsWith(".svg")) continue;
  const k = key(name.slice(0, -4));
  if (!/^[0-9a-f]+(-[0-9a-f]+)*$/.test(k)) continue;
  // формы с fe0f и без — одна картинка; первая по имени остаётся
  if (!files.has(k)) files.set(k, join(source, name));
}

const keys = [...files.keys()].sort();
const blobs = keys.map((k) =>
  brotliCompressSync(readFileSync(files.get(k)), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }),
);

const header = [Buffer.from("AEMJ"), Buffer.from([1])];
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
writeFileSync(output, out);
console.log(`${output}: ${keys.length} эмодзи, ${out.length} байт`);
