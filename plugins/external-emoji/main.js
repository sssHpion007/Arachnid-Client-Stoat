// Внешние эмодзи в сообщениях Stoat (for-web).
//
// Ссылка вида [:feels:](https://cdn.discordapp.com/emojis/….png?size=48) —
// так Discord и его клиенты вставляют эмодзи с других серверов — в for-web
// выглядит как ссылка «:feels:», а под сообщением большой картинкой висит
// встраивание той же ссылки. Плагин показывает такую ссылку как обычное
// эмодзи в строке текста, а встраивание прячет.
//
// Что считается эмодзи: текст ссылки — только «:имя:», ссылка — картинка
// (.png, .gif, .webp, .jpg, .avif) с любого сайта или эмодзи Discord
// (`/emojis/<число>`). Сообщение только из эмодзи, как и у for-web,
// показывает их крупно: одно — 96 px, несколько — 48 px (`--emoji-size-large`
// и `--emoji-size-medium` темы Stoat).
//
// Картинка грузится через прокси встраиваний Stoat (January), как и
// встраивания: адрес прокси виден по встраиваниям тех же ссылок и
// запоминается. Пока он не известен, картинка грузится напрямую. Не
// загрузилась — остаётся ссылка, как без плагина.
//
// Ссылка for-web остаётся на месте (скрыта), картинка встаёт перед ней:
// разметку сообщения строит Solid, и при правке сообщения она строится
// заново — тогда плагин заменяет ссылки снова.
//
// В ответах (строка над сообщением) for-web показывает ссылки без адреса,
// поэтому там остаётся «:имя:».

"use strict";

const OWN = "arachnid-external-emoji";
/** Отметка ссылки: `shown` — вместо неё эмодзи, `failed` — картинка не загрузилась */
const MARK = `data-${OWN}`;
/** Размер эмодзи в сообщении только из эмодзи: `large` или `medium` */
const SIZE = `data-${OWN}-size`;
/** Спрятанное встраивание картинки эмодзи */
const EMBED = `data-${OWN}-embed`;
/** Адрес прокси встраиваний (January) — в localStorage */
const PROXY_KEY = `${OWN}:proxy`;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const NAME = /^:([\p{L}\p{N}_~-]{1,64}):$/u;
const IMAGE_PATH = /\.(?:png|apng|gif|webp|jpe?g|avif)$/i;
const DISCORD_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const DISCORD_EMOJI = /^\/emojis\/\d+(?:\.[a-z]+)?$/i;
/** Размер картинки эмодзи Discord: чётко и в крупном виде на экранах с масштабом */
const DISCORD_SIZE = "128";
const PICTOGRAPHIC = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Regional_Indicator}|\u200d|\ufe0f)+$/u;
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

// ─────────────────────────────── адреса ───────────────────────────────

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

let proxyBase = null;
try {
  proxyBase = localStorage.getItem(PROXY_KEY);
} catch {
  proxyBase = null;
}
if (proxyBase && parseUrl(proxyBase)?.protocol !== "https:") proxyBase = null;

/** Адрес картинки встраивания → адрес исходной картинки и адрес прокси */
function unproxy(src) {
  const url = parseUrl(src);
  if (!url) return { original: src, base: null };
  const original = url.pathname.endsWith("/proxy") ? url.searchParams.get("url") : null;
  if (!original) return { original: url.href, base: null };
  return { original: parseUrl(original)?.href ?? original, base: `${url.origin}${url.pathname}` };
}

function rememberProxy(base) {
  if (!base || base === proxyBase || parseUrl(base)?.protocol !== "https:") return;
  proxyBase = base;
  try {
    localStorage.setItem(PROXY_KEY, base);
  } catch {
    // без хранилища адрес живёт до перезагрузки
  }
}

/** Адрес эмодзи из ссылки for-web или `null`, если ссылка — не эмодзи */
function emojiOf(anchor) {
  if (anchor.hasAttribute(MARK) || anchor.childElementCount) return null;
  if (anchor.closest("[contenteditable]")) return null;
  const name = NAME.exec(anchor.textContent.trim())?.[1];
  const url = name ? parseUrl(anchor.getAttribute("href") ?? "") : null;
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const discord = DISCORD_HOSTS.has(url.hostname) && DISCORD_EMOJI.test(url.pathname);
  if (!discord && !IMAGE_PATH.test(url.pathname)) return null;
  const image = new URL(url.href);
  if (discord) image.searchParams.set("size", DISCORD_SIZE);
  return { name, href: url.href, image: image.href };
}

// ─────────────────────────────── эмодзи ───────────────────────────────

/** Сообщение (элемент с id-ULID), в котором узел */
function messageRoot(node) {
  for (let element = node instanceof Element ? node : node?.parentElement; element; element = element.parentElement) {
    if (ULID.test(element.id)) return element;
    if (element === document.body) break;
  }
  return null;
}

/** Показать ссылку снова: картинка эмодзи не загрузилась */
function restore(anchor, image) {
  image.remove();
  anchor.setAttribute(MARK, "failed");
  const root = messageRoot(anchor);
  if (root) refresh(root);
}

/** Поставить эмодзи вместо ссылки; `true` — поставлено */
function convert(anchor) {
  const emoji = emojiOf(anchor);
  if (!emoji) return false;
  const image = document.createElement("img");
  image.className = `emoji ${OWN}`;
  image.alt = `:${emoji.name}:`;
  image.title = `:${emoji.name}:`;
  image.draggable = false;
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.dataset.href = emoji.href;
  let direct = !proxyBase;
  image.addEventListener("error", () => {
    // прокси не отдал картинку — напрямую, а если и так нет — снова ссылка
    if (!direct) {
      direct = true;
      image.src = emoji.image;
    } else {
      restore(anchor, image);
    }
  });
  image.src = direct ? emoji.image : `${proxyBase}?url=${encodeURIComponent(emoji.image)}`;
  anchor.setAttribute(MARK, "shown");
  anchor.before(image);
  return true;
}

/** Блок текста сообщения — BreakText for-web (div с word-break: break-word) */
function textBox(node, root) {
  for (let element = node.parentElement; element && element !== root; element = element.parentElement) {
    if (element.localName === "div" && getComputedStyle(element).wordBreak === "break-word") return element;
  }
  return null;
}

/** Сколько эмодзи в тексте сообщения, если в нём нет ничего, кроме эмодзи; иначе 0 */
function onlyEmoji(box) {
  let count = box.querySelectorAll("img.emoji").length;
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(`a[${MARK}="shown"]`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.data.replace(/\s+/g, "");
    if (!text) continue;
    // эмодзи текстом (системный набор эмодзи)
    const graphemes = segmenter ? [...segmenter.segment(text)].map((part) => part.segment) : [...text];
    if (!graphemes.every((grapheme) => PICTOGRAPHIC.test(grapheme))) return 0;
    count += graphemes.length;
  }
  return count;
}

/** Крупные эмодзи, спрятанные встраивания и забытые картинки в сообщении */
function refresh(root) {
  // картинки, чья ссылка пропала (сообщение перестроено не целиком)
  for (const image of root.querySelectorAll(`img.${OWN}`)) {
    const anchor = image.nextElementSibling;
    if (anchor?.localName !== "a" || anchor.getAttribute(MARK) !== "shown") image.remove();
  }

  const anchors = [...root.querySelectorAll(`a[${MARK}="shown"]`)];
  const links = new Set(anchors.map((anchor) => anchor.previousElementSibling?.dataset.href).filter(Boolean));

  // встраивания тех же картинок под сообщением
  for (const media of root.querySelectorAll("img[src], video[src]")) {
    if (media.classList.contains(OWN) || media.classList.contains("emoji")) continue;
    const frame = media.parentElement;
    if (!frame || !frame.getAttribute("style")?.includes("aspect-ratio")) continue;
    const { original, base } = unproxy(media.getAttribute("src"));
    const hidden = links.has(original);
    if (hidden) {
      rememberProxy(base);
      frame.setAttribute(EMBED, "");
    } else if (frame.hasAttribute(EMBED)) {
      frame.removeAttribute(EMBED);
    }
  }

  // сообщение только из эмодзи — крупно, как у for-web
  const boxes = new Set(anchors.map((anchor) => textBox(anchor, root)).filter(Boolean));
  for (const box of root.querySelectorAll(`[${SIZE}]`)) boxes.add(box);
  for (const box of boxes) {
    const count = box.querySelector(`a[${MARK}="shown"]`) ? onlyEmoji(box) : 0;
    const size = count === 1 ? "large" : count > 1 ? "medium" : null;
    if (size && box.getAttribute(SIZE) !== size) box.setAttribute(SIZE, size);
    if (!size && box.hasAttribute(SIZE)) box.removeAttribute(SIZE);
  }
}

// ─────────────────────────────── страница ───────────────────────────────

const INTERESTING = "a[href], img, video";

/** Новые узлы: заменить ссылки, запомнить сообщения, которые стоит обновить */
function scan(node, roots) {
  const anchors = node.localName === "a" ? [node] : node.querySelectorAll("a[href]");
  for (const anchor of anchors) convert(anchor);
  if (node.matches(INTERESTING) || node.querySelector(INTERESTING)) {
    const root = messageRoot(node);
    if (root) roots.add(root);
  }
}

const observer = new MutationObserver((records) => {
  const roots = new Set();
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) scan(node, roots);
    }
    if (record.removedNodes.length) {
      const root = messageRoot(record.target);
      if (root) roots.add(root);
    }
  }
  for (const root of roots) if (root.isConnected) refresh(root);
});

const initial = new Set();
for (const anchor of document.querySelectorAll("a[href]")) {
  if (convert(anchor)) {
    const root = messageRoot(anchor);
    if (root) initial.add(root);
  }
}
for (const root of initial) refresh(root);
observer.observe(document.body, { childList: true, subtree: true });
