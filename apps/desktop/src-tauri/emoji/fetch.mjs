// Скачать картинки набора эмодзи с static.stoat.chat — те же файлы, что
// for-web показывает в сообщениях, — для упаковки в .bin (pack.mjs).
//
//   node fetch.mjs <набор> <emoji-test.txt> <twemoji.bin> <папка для SVG>
//
// Запускает .github/workflows/emoji-packs.yml. Какие картинки нужны:
//
// * все эмодзи из emoji-test.txt той версии, по которой Stoat собирает
//   наборы (stoatchat/javascript-genemoji, data/emoji-test.txt);
// * всё, что есть во встроенном Twemoji: genemoji подставляет картинки
//   Twemoji туда, где в наборе своих нет, так что сервер отдаёт их и для
//   остальных наборов (буквы флагов, эмодзи новее emoji-test.txt).
//
// Формы с селектором варианта fe0f и без него — одна картинка (как в
// genemoji); для каждой пробуется сначала полная форма, затем остальные.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [pack, emojiTest, twemoji, output] = process.argv.slice(2);
if (!pack || !emojiTest || !twemoji || !output) {
  console.error("использование: node fetch.mjs <набор> <emoji-test.txt> <twemoji.bin> <папка>");
  process.exit(1);
}

const BASE = `https://static.stoat.chat/emoji/${pack}/`;
const CONCURRENCY = 24;
const ATTEMPTS = 4;

const key = (stem) =>
  stem
    .split("-")
    .filter((part) => part !== "fe0f")
    .join("-");

/** Формы записи каждого ключа: полная форма первой */
const forms = new Map();
function addForm(stem, first = false) {
  const k = key(stem);
  const list = forms.get(k) ?? [];
  if (!list.includes(stem)) first ? list.unshift(stem) : list.push(stem);
  forms.set(k, list);
}

// emoji-test.txt: "1F636 200D 1F32B FE0F ; fully-qualified # 😶‍🌫️ …"
for (const line of readFileSync(emojiTest, "utf8").split("\n")) {
  const match = /^([0-9A-F ]+);\s*([a-z-]+)/.exec(line);
  if (!match) continue;
  // как toCodepoint в for-web: шестнадцатеричные без ведущих нулей
  const stem = match[1]
    .trim()
    .split(/\s+/)
    .map((code) => parseInt(code, 16).toString(16))
    .join("-");
  addForm(stem, match[2] === "fully-qualified");
}

// ключи встроенного Twemoji (формат — в pack.mjs)
{
  const data = readFileSync(twemoji);
  if (data.toString("ascii", 0, 4) !== "AEMJ") throw new Error("twemoji.bin: не тот формат");
  let at = 5;
  const count = data.readUInt32LE(at);
  at += 4;
  for (let i = 0; i < count; i++) {
    const length = data[at];
    addForm(data.toString("ascii", at + 1, at + 1 + length));
    at += 1 + length + 8;
  }
}
for (const [k, list] of forms) if (!list.includes(k)) list.push(k);

mkdirSync(output, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Картинка по имени файла; null — такой на сервере нет */
async function download(stem) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${BASE}${stem}.svg?v=1`);
      if (response.status === 404 || response.status === 403) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      const head = body.subarray(0, 256).toString("utf8").trimStart();
      if (!head.startsWith("<svg") && !head.startsWith("<?xml")) return null;
      return body;
    } catch (error) {
      if (attempt >= ATTEMPTS) throw new Error(`${stem}: ${error.message}`);
      await sleep(1000 * attempt);
    }
  }
}

const queue = [...forms.entries()];
let fetched = 0;
let missing = 0;

async function worker() {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [k, list] = next;
    let body = null;
    for (const stem of list) {
      body = await download(stem);
      if (body) break;
    }
    if (body) {
      writeFileSync(join(output, `${k}.svg`), body);
      fetched++;
    } else missing++;
    if ((fetched + missing) % 500 === 0) console.log(`${pack}: ${fetched + missing} из ${forms.size}`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`${pack}: скачано ${fetched}, нет на сервере ${missing}`);

// сервер недоступен или отдаёт не то — набор не публикуется
if (fetched < forms.size * 0.9) {
  console.error(`${pack}: скачано слишком мало картинок`);
  process.exit(1);
}
