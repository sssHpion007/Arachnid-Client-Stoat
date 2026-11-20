// Разделы стандартных эмодзи для окна выбора (src/emoji.js) — так, как их
// распределяет Discord.
//
//   node apps/desktop/src-tauri/tools/emoji_categories.mjs
//
// Читает рядом лежащий discord_categories.json и src/emoji_mapping.json,
// пишет src/emoji_categories.json.
//
// * discord_categories.json — разделы Discord и порядок эмодзи в них: набор
//   эмодзи клиента Discord (emojisByCategory, Twemoji 16.0.1) без оттенков
//   кожи. Выгрузка — github.com/y9x/holt, main/src/pages/chat/emoji-data.ts
//   (октябрь 2026); сверено с discord-emoji 2.5.3 (xCykrix/discord_emoji,
//   выгрузка из клиента Discord, март 2025): разделы те же, в новой
//   выгрузке добавлены эмодзи Unicode 16.
// * emoji_mapping.json — список эмодзи for-web (emojiMapping.json). Выбрать
//   можно только их: выбор идёт через ячейку for-web.
//
// В разделы попадает каждый эмодзи for-web, один раз (повторы в списке
// for-web пропускаются), в порядке Discord. Эмодзи, которых у Discord ещё
// нет (новее Unicode 16), ставятся за ближайшим предыдущим по списку for-web
// эмодзи, который у Discord есть, — в его раздел. Эмодзи Discord, которых нет
// у for-web (например, 👩 и 👨 — у for-web только 🧑), пропускаются.
// Сравнение — без селектора варианта U+FE0F; записывается форма for-web.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const discord = JSON.parse(readFileSync(join(here, "discord_categories.json"), "utf8"));
const mapping = JSON.parse(readFileSync(join(here, "../src/emoji_mapping.json"), "utf8"));
const output = join(here, "../src/emoji_categories.json");

const key = (emoji) => emoji.replaceAll("\uFE0F", "");

/** Эмодзи Discord → раздел и место в нём */
const place = new Map();
for (const [category, list] of Object.entries(discord)) {
  list.forEach((emoji, index) => {
    if (!place.has(key(emoji))) place.set(key(emoji), { category, index, after: 0 });
  });
}

/** Эмодзи for-web с местом у Discord */
const placed = [];
const seen = new Set();
let previous = null;
for (const [emoji] of mapping) {
  const k = key(emoji);
  if (seen.has(k)) continue;
  seen.add(k);
  let spot = place.get(k);
  if (spot) {
    previous = spot;
  } else if (previous) {
    // сразу за предыдущим, после уже поставленных за ним
    previous = spot = { ...previous, after: previous.after + 1 };
  } else {
    throw new Error(`не к чему пристроить ${emoji}`);
  }
  placed.push({ emoji, ...spot });
}

const lines = Object.keys(discord).map((category) => {
  const list = placed
    .filter((item) => item.category === category)
    .sort((a, b) => a.index - b.index || a.after - b.after)
    .map((item) => item.emoji);
  console.log(`${category}: ${list.length}`);
  return `  ${JSON.stringify(category)}: ${JSON.stringify(list)}`;
});
writeFileSync(output, `{\n${lines.join(",\n")}\n}\n`);
