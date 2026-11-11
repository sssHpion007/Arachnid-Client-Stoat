// Интерфейс клиента по образцу официального Stoat (for-web).
// Всё состояние приходит из Rust, здесь только отрисовка и ввод.
"use strict";

const bridge = window.__TAURI__;
const invoke = bridge && bridge.core && bridge.core.invoke;
const listen = bridge && bridge.event && bridge.event.listen;

const ICONS = window.STOAT_ICONS || {};
const SVG_NS = "http://www.w3.org/2000/svg";
const el = (id) => document.getElementById(id);

const messagesEl = el("messages");
const inputEl = el("input");

/** Сколько сообщений просить за раз (как браузерный клиент). */
const PAGE_SIZE = 50;
/** Сообщения одного автора дальше 7 минут друг от друга не склеиваются. */
const GROUP_WINDOW_MS = 7 * 60 * 1000;
/** Ответов к одному сообщению — не больше пяти (ограничение API). */
const MAX_REPLIES = 5;

const state = {
  me: null,
  workspace: null,
  serverId: null, // null — «Беседы» (личные сообщения)
  channelId: null,
  messages: [],
  reachedStart: false,
  loadingOlder: false,
  lastRead: null, // до какого сообщения канал был прочитан при открытии
  replies: [], // [{ message, mention }]
  editing: null, // id сообщения, которое правится на месте
  stickToBottom: true,
  showMembers: readSetting("members", true),
  collapsed: new Set(readSetting("collapsed", [])),
  media: new Map(), // адрес → data-URL (или null, если файла нет)
  mediaInFlight: new Map(),
  typing: new Map(), // id канала → Map(id пользователя → таймер)
};

// ─────────────────────────── помощники ───────────────────────────

function readSetting(key, fallback) {
  try {
    const raw = localStorage.getItem("stoat.ui." + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeSetting(key, value) {
  try {
    localStorage.setItem("stoat.ui." + key, JSON.stringify(value));
  } catch {
    /* хранилище недоступно — настройка просто не запомнится */
  }
}

/** Создать элемент: h("div", { class: "x", text: "…", onclick }, [дети]). */
function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") Object.assign(node.style, value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/** Иконка Material Symbols по имени (как <Symbol> в официальном клиенте). */
function symbol(name, size = 20) {
  const node = svg("svg", { viewBox: "0 -960 960 960", class: "symbol", "aria-hidden": "true" });
  node.style.setProperty("--symbol-size", size + "px");
  node.append(svg("path", { d: ICONS[name] || "" }));
  return node;
}

function setIcon(button, name, size) {
  button.replaceChildren(symbol(name, size));
}

/** Две первые буквы имени — как запасной аватар оригинала. */
function initials(name) {
  const words = String(name || "?").trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2);
  return Array.from(letters).slice(0, 2).join("").toUpperCase();
}

let toastTimer = null;
function toast(text, kind = "") {
  const node = el("toast");
  node.textContent = text;
  node.className = "toast " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add("hidden"), 3600);
}

const KNOWN_ERRORS = {
  RateLimited: "слишком часто — подождите немного",
  rate_limited: "слишком часто — подождите немного",
  MissingPermission: "нет прав на это действие",
  NotFound: "не найдено (возможно, удалено)",
  EmptyMessage: "пустое сообщение",
  PayloadTooLarge: "слишком длинное сообщение",
  TooManyReplies: "слишком много ответов в одном сообщении",
  Unauthorized: "сессия истекла — войдите заново",
  unauthorized: "сначала войдите в аккаунт",
  InvalidSession: "сессия истекла — войдите заново",
};

function describe(error) {
  if (!error) return "неизвестная ошибка";
  const text = String(error.message || error.kind || error);
  for (const [code, human] of Object.entries(KNOWN_ERRORS)) {
    if (error.kind === code || text.includes(code)) return human;
  }
  if (/network|сетев|connect/i.test(text)) return "нет связи с сервером";
  return text;
}

async function call(cmd, args = {}) {
  if (!invoke) throw new Error("нет моста Tauri");
  return invoke(cmd, args);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h("textarea", { style: { position: "fixed", opacity: "0" } });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/** Цвет ника: `#ff0000`, `hsl(…)`, градиент или число. */
function paintName(node, colour) {
  if (!colour) return;
  const text = String(colour).trim();
  if (/gradient\(/i.test(text)) {
    node.style.background = text;
    node.style.backgroundClip = "text";
    node.style.webkitBackgroundClip = "text";
    node.style.color = "transparent";
    return;
  }
  node.style.color = /^\d+$/.test(text)
    ? "#" + Number(text).toString(16).padStart(6, "0").slice(-6)
    : text;
}

function humanSize(bytes) {
  if (!bytes) return "";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

// ─────────────────────────── время ───────────────────────────

function parseTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function clockText(date) {
  return date ? date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "";
}

/** Дата для разделителя (формат «LL» в оригинале). */
function dateText(date) {
  return date ? date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) : "";
}

/** Время в шапке сообщения: «Сегодня в 12:30», «Вчера в …», иначе дата. */
function calendarText(date) {
  if (!date) return "";
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(date, now)) return "Сегодня в " + clockText(date);
  if (sameDay(date, yesterday)) return "Вчера в " + clockText(date);
  return date.toLocaleDateString("ru-RU") + " " + clockText(date);
}

// ─────────────────────────── файлы ───────────────────────────

// WebView2 не грузит сторонние картинки на встроенных страницах, поэтому
// файлы скачивает Rust (команда fetch_media) и отдаёт готовые data-URL.
function mediaUrl(url) {
  if (!url) return Promise.resolve(null);
  if (state.media.has(url)) return Promise.resolve(state.media.get(url));
  const running = state.mediaInFlight.get(url);
  if (running) return running;

  const task = call("fetch_media", { url })
    .then((data) => data || null)
    .catch((error) => {
      console.warn("не удалось загрузить файл:", url, error);
      return null;
    })
    .then((data) => {
      // неудачу не запоминаем: Rust сам решает, когда пробовать снова
      if (data) state.media.set(url, data);
      state.mediaInFlight.delete(url);
      return data;
    });
  state.mediaInFlight.set(url, task);
  return task;
}

/** <img>, который получит картинку, когда она скачается. */
function image(url, props = {}) {
  const img = h("img", { alt: "", draggable: "false", ...props });
  const known = state.media.get(url);
  if (known) {
    img.src = known;
  } else {
    mediaUrl(url).then((data) => {
      if (!data) return;
      img.addEventListener("load", keepBottom, { once: true });
      img.src = data;
    });
  }
  return img;
}

/**
 * Аватар (Avatar.tsx): круг 32×32 в SVG, при необходимости с «дыркой»
 * под статус и под счётчик — маски объявлены в app.html.
 */
function avatar({ url, name, size = 32, presence = null, badge = null }) {
  const node = svg("svg", { viewBox: "0 0 32 32", width: size, height: size, class: "avatar" });
  const mask =
    presence && badge ? "mask-status-badge" : presence ? "mask-status" : badge ? "mask-badge" : "mask-avatar";
  const group = svg("g", { mask: `url(#${mask})` });
  group.append(svg("rect", { x: 0, y: 0, width: 32, height: 32, class: "avatar-fallback" }));
  const letters = svg("text", { x: 16, y: 16.5, "text-anchor": "middle", "dominant-baseline": "central" });
  letters.textContent = initials(name);
  group.append(letters);
  node.append(group);

  const place = (data) => {
    const picture = svg("image", { x: 0, y: 0, width: 32, height: 32, preserveAspectRatio: "xMidYMid slice" });
    picture.setAttribute("href", data);
    letters.remove();
    group.append(picture);
  };
  if (url) {
    const known = state.media.get(url);
    if (known) place(known);
    else mediaUrl(url).then((data) => data && place(data));
  }

  if (presence) node.append(svg("circle", { cx: 27, cy: 27, r: 5, class: "presence " + presence }));
  if (badge) {
    node.append(svg("circle", { cx: 27, cy: 5, r: 5, class: "badge-circle" }));
    if (typeof badge === "number") {
      const count = svg("text", {
        x: 27,
        y: 5.5,
        "text-anchor": "middle",
        "dominant-baseline": "central",
        class: "badge-text",
      });
      count.textContent = badge > 9 ? "9+" : String(badge);
      node.append(count);
    }
  }
  return node;
}

// ─────────────────────────── эмодзи ───────────────────────────

// Юникод-эмодзи рисуются картинками из комплекта (twemoji Stoat), как в
// браузерном клиенте; редкие — через ядро с static.stoat.chat.
const UNICODE_EMOJI_RE =
  /\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])*(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])*)*/gu;
/** Свои эмодзи в тексте Stoat — `:ULID:`. */
const CUSTOM_EMOJI_RE = /:([0-9A-Z]{26}):/g;

const spriteFiles = new Map(); // номер файла → строки SVG
const spriteWaiters = new Map();
const unicodeCache = new Map(); // код → data-URL или "none"

function emojiCodepoint(text) {
  const points = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === 0xfe0f) continue;
    points.push(code.toString(16));
  }
  return points.join("-");
}

function spriteEntry(codepoint) {
  const map = window.EMOJI_MAP || {};
  return map[codepoint] || map[codepoint.replace(/-fe0f/g, "")] || null;
}

async function spriteUrl(codepoint) {
  const entry = spriteEntry(codepoint);
  if (!entry) return null;
  const [file, line] = entry;
  if (!spriteFiles.has(file)) {
    if (!spriteWaiters.has(file)) {
      spriteWaiters.set(
        file,
        fetch(`emoji/${file}.txt`)
          .then((response) => (response.ok ? response.text() : ""))
          .then((text) => text.split("\n"))
          .catch(() => []),
      );
    }
    spriteFiles.set(file, await spriteWaiters.get(file));
  }
  const source = spriteFiles.get(file)[line];
  return source ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source) : null;
}

async function unicodeEmojiUrl(text) {
  const codepoint = emojiCodepoint(text);
  if (!codepoint) return null;
  const cached = unicodeCache.get(codepoint);
  if (cached) return cached === "none" ? null : cached;
  let data = await spriteUrl(codepoint);
  if (!data) data = await call("fetch_emoji", { codepoint }).catch(() => null);
  unicodeCache.set(codepoint, data || "none");
  return data;
}

function unicodeEmojiNode(text) {
  const slot = h("span", { class: "emoji", text });
  unicodeEmojiUrl(text).then((data) => {
    if (!data) return;
    slot.replaceWith(h("img", { class: "emoji", alt: text, src: data, draggable: "false" }));
  });
  return slot;
}

function customEmojiNode(id, url) {
  const known = customEmojiIndex.get(id);
  const label = ":" + (known ? known.name : id) + ":";
  if (!url) return document.createTextNode(label);
  return image(url, { class: "emoji", alt: label, title: label });
}

// ─────────────────────────── текст сообщения ───────────────────────────

const LINK_RE = /https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/g;
const MENTION_RE = /<@([0-9A-Z]{26})>/g;
const MESSAGE_LINK_RE =
  /^https?:\/\/(?:stoat\.chat|app\.revolt\.chat|revolt\.chat|rvlt\.gg)\/(?:server\/([0-9A-Z]{26})\/)?channel\/([0-9A-Z]{26})\/([0-9A-Z]{26})/i;

/** Ближайшее совпадение среди нескольких регулярных выражений. */
function nearestMatch(text, patterns) {
  let best = null;
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match && (!best || match.index < best.match.index)) best = { kind, match };
  }
  return best;
}

/** Текст с упоминаниями, ссылками и эмодзи. `emoji` — карта id → адрес. */
function richText(text, emoji = {}) {
  const frag = document.createDocumentFragment();
  let rest = String(text || "");
  const patterns = [
    ["mention", MENTION_RE],
    ["custom", CUSTOM_EMOJI_RE],
    ["link", LINK_RE],
    ["unicode", UNICODE_EMOJI_RE],
  ];
  while (rest) {
    const hit = nearestMatch(rest, patterns);
    if (!hit) {
      frag.append(rest);
      break;
    }
    const { kind, match } = hit;
    if (match.index > 0) frag.append(rest.slice(0, match.index));
    if (kind === "mention") frag.append(mentionNode(match[1]));
    else if (kind === "custom") frag.append(customEmojiNode(match[1], emoji[match[1]] || customEmojiUrl(match[1])));
    else if (kind === "link") frag.append(linkNode(match[0], match[0]));
    else frag.append(unicodeEmojiNode(match[0]));
    rest = rest.slice(match.index + match[0].length);
  }
  return frag;
}

function customEmojiUrl(id) {
  const cdn = state.workspace && state.workspace.cdn;
  return cdn ? `${cdn.replace(/\/$/, "")}/emojis/${id}` : null;
}

function mentionNode(userId) {
  const node = h("span", { class: "mention", text: "@" + userName(userId) });
  node.onclick = (event) => openUserCard(event, userId);
  return node;
}

function linkNode(href, label) {
  const info = messageLinkInfo(href);
  if (info) {
    const known = findChannel(info.channel);
    const button = h("button", { class: "message-link", type: "button", title: "Перейти к сообщению" }, [
      symbol("chevron_right", 16),
      known ? known.channel.name : "сообщение",
    ]);
    button.onclick = () => jumpToMessage(info);
    return button;
  }
  return h("a", { href, target: "_blank", rel: "noreferrer", text: label });
}

function messageLinkInfo(href) {
  const match = MESSAGE_LINK_RE.exec(href || "");
  return match ? { server: match[1] || null, channel: match[2], message: match[3] } : null;
}

/** Оформленный текст по кускам от ядра (жирный, код, спойлер, ссылка). */
function segmentsNode(message) {
  const frag = document.createDocumentFragment();
  const emoji = message.emoji || {};
  const parts =
    message.segments && message.segments.length ? message.segments : [{ kind: "text", text: message.content || "" }];
  for (const part of parts) {
    if (part.kind === "text") {
      frag.append(richText(part.text, emoji));
    } else if (part.kind === "link") {
      frag.append(linkNode(part.href || part.text, part.text));
    } else if (part.kind === "codeblock") {
      frag.append(h("pre", { class: "md-codeblock", text: part.text }));
    } else if (part.kind === "code") {
      frag.append(h("code", { class: "md-code", text: part.text }));
    } else {
      const node = h("span", { class: "md-" + part.kind }, [richText(part.text, emoji)]);
      if (part.kind === "spoiler") node.onclick = () => node.classList.add("shown");
      frag.append(node);
    }
  }
  return frag;
}

/** Только эмодзи (до десяти) — показываются крупно, как в оригинале. */
function isJumbo(content) {
  if (!content || content.length > 400) return false;
  let count = 0;
  const rest = content
    .replace(CUSTOM_EMOJI_RE, () => {
      count += 1;
      return "";
    })
    .replace(UNICODE_EMOJI_RE, () => {
      count += 1;
      return "";
    });
  return count > 0 && count <= 10 && rest.trim() === "";
}

/** Короткий текст сообщения для ответа и уведомлений. */
function plainPreview(message) {
  const text = (message.content || "")
    .replace(MENTION_RE, (_, id) => "@" + userName(id))
    .replace(CUSTOM_EMOJI_RE, (_, id) => ":" + ((customEmojiIndex.get(id) || {}).name || "emoji") + ":")
    .replace(/\s+/g, " ")
    .trim();
  if (text) return text;
  if (message.attachments && message.attachments.length) return "Вложение";
  if (message.embeds && message.embeds.length) return "Встраивание";
  return "";
}

// ─────────────────────────── поиск по состоянию ───────────────────────────

function* allChannels() {
  const ws = state.workspace;
  if (!ws) return;
  for (const server of ws.servers) {
    for (const category of server.categories) {
      for (const channel of category.channels) yield { channel, server };
    }
  }
  for (const channel of ws.dms) yield { channel, server: null };
}

function findChannel(channelId) {
  if (!channelId) return null;
  for (const entry of allChannels()) if (entry.channel.id === channelId) return entry;
  const ws = state.workspace;
  if (ws && ws.notes === channelId) return { channel: notesChannel(), server: null };
  return null;
}

function notesChannel() {
  return {
    id: state.workspace.notes,
    name: "Заметки",
    kind: "notes",
    description: null,
    icon: null,
    unread: false,
    mentions: 0,
  };
}

function currentChannel() {
  const found = findChannel(state.channelId);
  return found ? found.channel : null;
}

function serverById(id) {
  const ws = state.workspace;
  return ws && id ? ws.servers.find((server) => server.id === id) || null : null;
}

/** Имя пользователя для упоминаний и подписей. */
function userName(userId) {
  if (state.me && state.me.id === userId) return state.me.display_name || state.me.username;
  const members = membersCache.get(state.serverId) || [];
  const member = members.find((item) => item.id === userId);
  if (member) return member.name;
  const author = state.messages.find((item) => item.author_id === userId);
  if (author) return author.author;
  const dm = state.workspace && state.workspace.dms.find((item) => item.recipient === userId);
  if (dm) return dm.name;
  return "неизвестный";
}

function myName() {
  const me = state.me;
  return me ? me.display_name || me.username : "";
}

// ─────────────────────────── непрочитанное ───────────────────────────

function recountServer(server) {
  let unread = false;
  let mentions = 0;
  for (const category of server.categories) {
    for (const channel of category.channels) {
      unread = unread || channel.unread;
      mentions += channel.mentions || 0;
    }
  }
  server.unread = unread;
  server.mentions = mentions;
}

const ackTimers = new Map();

/** Отметить канал прочитанным до сообщения (с небольшой задержкой: API ограничивает частоту). */
function ackChannel(channelId, messageId) {
  if (!channelId || !messageId || messageId.startsWith("pending:")) return;
  const found = findChannel(channelId);
  if (found) {
    found.channel.unread = false;
    found.channel.mentions = 0;
    if (!found.channel.last_read || found.channel.last_read < messageId) found.channel.last_read = messageId;
    if (found.server) recountServer(found.server);
    renderRail();
    renderSidebar();
  }
  clearTimeout(ackTimers.get(channelId));
  ackTimers.set(
    channelId,
    setTimeout(() => {
      ackTimers.delete(channelId);
      call("ack_channel", { channelId, messageId }).catch((error) =>
        console.warn("не удалось отметить канал прочитанным:", error),
      );
    }, 500),
  );
}

/** Прочитать открытый канал, если пользователь действительно видит его конец. */
function ackVisible() {
  const channel = currentChannel();
  if (!channel || !document.hasFocus() || !state.stickToBottom) return;
  const last = [...state.messages].reverse().find((item) => !item.pending);
  if (channel.unread && last) ackChannel(channel.id, last.id);
}

function noteIncoming(message) {
  const found = findChannel(message.channel);
  if (!found) {
    // канал, которого нет в дереве (новая личка) — дерево нужно обновить
    scheduleWorkspaceRefresh();
    return;
  }
  const { channel, server } = found;
  if (!channel.last_message_id || channel.last_message_id < message.id) channel.last_message_id = message.id;
  const mine = state.me && message.author_id === state.me.id;
  if (!mine) {
    channel.unread = true;
    if (state.me && (message.mentions || []).includes(state.me.id)) channel.mentions = (channel.mentions || 0) + 1;
  }
  if (server) recountServer(server);
  else state.workspace.dms.sort((a, b) => (b.last_message_id || "").localeCompare(a.last_message_id || ""));
  renderRail();
  renderSidebar();
}

// ─────────────────────────── рельс серверов ───────────────────────────

function railEntry({ selected, alert, title, content, onclick, oncontextmenu }) {
  const entry = h("div", { class: "rail-entry" + (selected ? " selected" : "") + (alert ? " alert" : "") });
  const button = h("button", { class: "rail-button", type: "button", title, onclick, oncontextmenu }, [content]);
  entry.append(button);
  return { entry, button };
}

function renderRail() {
  const rail = el("rail");
  const ws = state.workspace;
  rail.textContent = "";
  if (!ws) return;

  const home = railEntry({
    selected: state.serverId === null,
    title: "Беседы",
    content: symbol("home", 22),
    onclick: () => selectServer(null),
  });
  home.button.classList.add("home");
  rail.append(home.entry);

  if (state.me) {
    const me = railEntry({
      title: myName(),
      content: avatar({ url: state.me.avatar, name: myName(), size: 42, presence: state.me.presence || "Online" }),
      onclick: (event) => toggleAccountMenu(event),
    });
    rail.append(me.entry);
  }

  // непрочитанные личные сообщения поднимаются в рельс, как в оригинале
  for (const dm of ws.dms.filter((item) => item.unread).slice(0, 9)) {
    const entry = railEntry({
      alert: true,
      title: dm.name,
      content: avatar({ url: dm.icon, name: dm.name, size: 42, badge: dm.mentions || true }),
      onclick: () => openChannel(dm),
    });
    rail.append(entry.entry);
  }

  rail.append(h("div", { class: "rail-divider" }));

  for (const server of ws.servers) {
    const entry = railEntry({
      selected: state.serverId === server.id,
      alert: server.unread,
      title: server.name,
      content: avatar({ url: server.icon, name: server.name, size: 42, badge: server.mentions || null }),
      onclick: () => selectServer(server.id),
      oncontextmenu: (event) => openServerMenu(event, server),
    });
    rail.append(entry.entry);
  }
}

// ─────────────────────────── боковая панель ───────────────────────────

function menuButton({ icon, name, status, attention, onclick, oncontextmenu, trailing }) {
  const text = h("span", { class: "menu-button-text" }, [
    h("span", { class: "menu-button-name", text: name }),
    status ? h("span", { class: "menu-button-status", text: status }) : null,
  ]);
  return h(
    "button",
    { class: "menu-button" + (attention ? " " + attention : ""), type: "button", title: name, onclick, oncontextmenu },
    [h("span", { class: "menu-button-icon" }, [icon]), text, trailing || null],
  );
}

function attentionOf(channel) {
  if (channel.id === state.channelId) return "selected";
  if (channel.unread || channel.mentions) return "active";
  return "";
}

function unreadMarker(channel) {
  if (channel.id === state.channelId) return null;
  if (channel.mentions) return h("span", { class: "mention-badge", text: String(channel.mentions) });
  return null;
}

function channelIcon(channel, size = 20) {
  if (channel.icon && channel.kind !== "dm" && channel.kind !== "group") {
    return image(channel.icon);
  }
  const names = { text: "tag", voice: "volume_up", dm: "alternate_email", group: "group", notes: "note_stack" };
  return symbol(names[channel.kind] || "tag", size);
}

function renderSidebar() {
  const ws = state.workspace;
  const header = el("sidebar-header");
  const list = el("channels");
  list.textContent = "";
  header.textContent = "";
  if (!ws) return;

  if (state.serverId === null) {
    header.className = "sidebar-header";
    header.append(h("span", { class: "sidebar-header-title", text: "Беседы" }));

    if (ws.notes) {
      const notes = notesChannel();
      list.append(
        menuButton({
          icon: symbol("note_stack", 22),
          name: "Заметки",
          attention: attentionOf(notes),
          onclick: () => openChannel(notes),
        }),
      );
    }

    list.append(categoryLabel("Личные сообщения", null));
    if (!ws.dms.length) list.append(h("div", { class: "sidebar-note", text: "Пока нет переписок" }));
    for (const dm of ws.dms) {
      const icon =
        dm.kind === "dm"
          ? avatar({ url: dm.icon, name: dm.name, presence: dm.presence || "Offline" })
          : avatar({ url: dm.icon, name: dm.name });
      list.append(
        menuButton({
          icon,
          name: dm.name,
          status: dm.kind === "dm" ? dm.description : null,
          attention: attentionOf(dm),
          trailing: unreadMarker(dm),
          onclick: () => openChannel(dm),
          oncontextmenu: (event) => openChannelMenu(event, dm),
        }),
      );
    }
    return;
  }

  const server = serverById(state.serverId);
  if (!server) return;
  header.className = "sidebar-header server";
  header.append(
    h("span", { class: "sidebar-header-title", text: server.name }),
  );
  header.oncontextmenu = (event) => openServerMenu(event, server);

  if (!server.categories.length) {
    list.append(h("div", { class: "sidebar-note", text: "Нет доступных каналов" }));
    return;
  }
  for (const category of server.categories) {
    const key = server.id + "/" + category.id;
    const open = !state.collapsed.has(key);
    list.append(categoryLabel(category.title, key, open));
    for (const channel of category.channels) {
      // в свёрнутой категории остаются открытый и непрочитанные каналы
      if (!open && channel.id !== state.channelId && !channel.unread) continue;
      list.append(
        menuButton({
          icon: channelIcon(channel),
          name: channel.name,
          attention: attentionOf(channel),
          trailing: unreadMarker(channel),
          onclick: () => openChannel(channel),
          oncontextmenu: (event) => openChannelMenu(event, channel),
        }),
      );
    }
  }
}

function categoryLabel(title, key, open = true) {
  const node = h("div", { class: "category" + (open ? " open" : "") }, [
    key ? symbol("chevron_right", 14) : null,
    h("span", { class: "category-title", text: title }),
  ]);
  if (key) {
    node.onclick = () => {
      if (state.collapsed.has(key)) state.collapsed.delete(key);
      else state.collapsed.add(key);
      writeSetting("collapsed", [...state.collapsed]);
      renderSidebar();
    };
  }
  return node;
}

function selectServer(serverId) {
  state.serverId = serverId;
  closeMenus();
  renderRail();
  renderSidebar();
  const ws = state.workspace;
  if (!ws) return;

  let target = null;
  if (serverId === null) {
    target = ws.dms[0] || (ws.notes ? notesChannel() : null);
  } else {
    const server = serverById(serverId);
    const remembered = readSetting("last." + serverId, null);
    const channels = server ? server.categories.flatMap((category) => category.channels) : [];
    target = channels.find((channel) => channel.id === remembered) || channels.find((c) => c.kind === "text") || channels[0];
  }
  if (target) openChannel(target);
  else closeChannel();
}

// ─────────────────────────── шапка канала ───────────────────────────

function renderHeader() {
  const channel = currentChannel();
  const icon = el("chat-icon");
  const membersButton = el("btn-members");
  icon.textContent = "";
  if (!channel) {
    el("chat-title").textContent = "Arachnid Client";
    el("chat-sub").textContent = "";
    el("chat-divider").classList.add("hidden");
    membersButton.classList.add("hidden");
    return;
  }
  icon.append(channelIcon(channel, 24));
  el("chat-title").textContent = channel.name;
  const description = channel.kind === "dm" ? channel.description : (channel.description || "").split("\n")[0];
  el("chat-sub").textContent = description || "";
  el("chat-sub").title = channel.description || "";
  el("chat-divider").classList.toggle("hidden", !description);

  const isServer = state.serverId !== null;
  membersButton.classList.toggle("hidden", !isServer);
  membersButton.classList.toggle("active", state.showMembers);
}

function setConnection(kind, text) {
  el("conn").className = "connection " + kind;
  el("conn-text").textContent = text;
}

// ─────────────────────────── канал ───────────────────────────

function closeChannel() {
  state.channelId = null;
  state.messages = [];
  state.replies = [];
  state.editing = null;
  renderHeader();
  renderComposer();
  renderMembers();
  showState(null, "Выберите канал", "Серверы — слева, беседы — под значком дома.");
}

function showState(icon, title, text) {
  messagesEl.replaceChildren(
    h("div", { class: "messages-state" }, [
      icon,
      title ? h("h2", { text: title }) : null,
      text ? h("div", { text }) : null,
    ]),
  );
}

let openToken = 0;

async function openChannel(channel, { reload = false } = {}) {
  if (!channel) return;
  if (!reload && state.channelId === channel.id && state.messages.length) return;
  const token = ++openToken;

  const found = findChannel(channel.id);
  if (found && found.server) {
    state.serverId = found.server.id;
    writeSetting("last." + found.server.id, channel.id);
  } else if (found) {
    state.serverId = null;
  }

  if (state.channelId !== channel.id) {
    state.replies = [];
    state.editing = null;
    inputEl.value = drafts.get(channel.id) || "";
  }
  state.channelId = channel.id;
  state.lastRead = channel.unread ? channel.last_read || null : null;
  state.messages = [];
  state.reachedStart = false;
  state.stickToBottom = true;
  closeMenus();
  toggleEmojiPicker(false);
  renderRail();
  renderSidebar();
  renderHeader();
  renderComposer();
  renderTyping();
  loadMembers(state.serverId);
  if (state.serverId !== null) loadServerEmoji(state.serverId);

  showState(h("div", { class: "spinner" }));
  try {
    const history = await call("channel_history", { channelId: channel.id, limit: PAGE_SIZE });
    if (token !== openToken) return; // пользователь уже ушёл в другой канал
    state.messages = markMine(history.messages || []);
    state.reachedStart = history.has_more === false || state.messages.length < PAGE_SIZE;
    renderMessages({ toBottom: true });
    ackVisible();
    focusInput();
  } catch (error) {
    if (token !== openToken) return;
    showState(symbol("info", 32), "Не удалось загрузить историю", describe(error));
  }
}

async function loadOlder() {
  if (state.loadingOlder || state.reachedStart || !state.messages.length) return;
  const oldest = state.messages.find((item) => !item.pending);
  if (!oldest) return;
  const channelId = state.channelId;
  state.loadingOlder = true;
  try {
    const page = await call("channel_history", { channelId, before: oldest.id, limit: PAGE_SIZE });
    if (state.channelId !== channelId) return;
    const older = markMine(page.messages || []).filter(
      (message) => !state.messages.some((item) => item.id === message.id),
    );
    if (older.length < PAGE_SIZE) state.reachedStart = true;
    if (!older.length) {
      renderMessages();
      return;
    }
    state.messages = older.concat(state.messages);
    renderMessages();
  } catch (error) {
    console.warn("не удалось подгрузить старые сообщения:", error);
  } finally {
    state.loadingOlder = false;
  }
}

function markMine(list) {
  for (const message of list) {
    message.mine = Boolean(state.me && message.author_id === state.me.id);
  }
  return list;
}

async function jumpToMessage(info) {
  const found = findChannel(info.channel);
  if (!found) {
    await copyText(`https://stoat.chat/channel/${info.channel}/${info.message}`);
    toast("Канал недоступен — ссылка скопирована");
    return;
  }
  if (state.channelId !== info.channel) await openChannel(found.channel);
  for (let depth = 0; depth < 10; depth += 1) {
    const node = messagesEl.querySelector(`.message[data-id="${info.message}"]`);
    if (node) {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.classList.add("flash");
      setTimeout(() => node.classList.remove("flash"), 1600);
      return;
    }
    if (state.reachedStart) break;
    await loadOlder();
  }
  toast("Сообщение не найдено в истории", "error");
}

// ─────────────────────────── лента ───────────────────────────

function distanceFromBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
}

/** Картинка догрузилась: лента у низа должна остаться у низа. */
function keepBottom() {
  if (state.stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * Перерисовать ленту. Позиция сохраняется относительно низа, поэтому
 * подгрузка старых сообщений сверху не сдвигает то, что читает пользователь.
 */
function renderMessages({ toBottom = false } = {}) {
  const keep = distanceFromBottom();
  const frag = document.createDocumentFragment();
  const channel = currentChannel();
  const list = state.messages;

  if (state.reachedStart && channel) frag.append(conversationStart(channel));
  if (!list.length && !state.reachedStart) {
    showState(h("div", { class: "spinner" }));
    return;
  }

  let unreadPlaced = false;
  list.forEach((message, index) => {
    const previous = list[index - 1] || null;
    const date = parseTime(message.timestamp);
    const previousDate = previous ? parseTime(previous.timestamp) : null;
    const newDay = !previous || !date || !previousDate || !sameDay(date, previousDate);
    if (newDay && date) frag.append(divider(dateText(date), false));

    // «новое» — перед первым сообщением после прочитанного (не самым первым в ленте)
    const firstUnread =
      !unreadPlaced &&
      state.lastRead &&
      previous &&
      !message.pending &&
      message.id > state.lastRead &&
      previous.id <= state.lastRead;
    if (firstUnread) {
      unreadPlaced = true;
      frag.append(divider(null, true));
    }

    // правила склейки из Messages.tsx
    const tail =
      previous &&
      !newDay &&
      !firstUnread &&
      previous.author_id === message.author_id &&
      previous.author === message.author &&
      previous.avatar === message.avatar &&
      !previous.system &&
      !message.system &&
      !(message.replies && message.replies.length) &&
      date &&
      previousDate &&
      date - previousDate < GROUP_WINDOW_MS;

    frag.append(messageNode(message, Boolean(tail)));
  });

  messagesEl.replaceChildren(frag);
  if (toBottom || state.stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  else messagesEl.scrollTop = messagesEl.scrollHeight - messagesEl.clientHeight - keep;
}

function conversationStart(channel) {
  const title = channel.kind === "text" || channel.kind === "voice" ? "#" + channel.name : channel.name;
  const text =
    channel.kind === "notes"
      ? "Сюда можно сохранять заметки — их видите только вы."
      : "Это начало переписки.";
  return h("div", { class: "conversation-start" }, [h("h1", { text: title }), h("p", { text })]);
}

function divider(dateLabel, unread) {
  return h("div", { class: "divider" + (unread ? " unread" : "") }, [
    unread ? h("span", { class: "new", text: "НОВОЕ" }) : null,
    dateLabel ? h("time", { text: dateLabel }) : null,
  ]);
}

function messageNode(message, tail) {
  const date = parseTime(message.timestamp);
  const mentioned = Boolean(state.me && (message.mentions || []).includes(state.me.id));
  const classes = ["message", tail ? "tail" : "head"];
  if (mentioned) classes.push("mentioned");
  if (message.system) classes.push("system");
  if (message.pending) classes.push("pending");
  if (message.failed) classes.push("failed");
  const node = h("div", { class: classes.join(" "), dataset: { id: message.id } });

  // ответы рисуются над сообщением
  if (!message.system) {
    for (const replyId of message.replies || []) node.append(replyLine(replyId));
  }

  const info = h("div", { class: "message-info" });
  if (message.system) {
    info.append(symbol(systemIcon(message.content), 20));
  } else if (tail) {
    info.append(h("time", { text: message.edited ? "(изм.)" : clockText(date), title: date ? date.toLocaleString() : "" }));
  } else {
    const picture = avatar({ url: message.avatar, name: message.author, size: 36 });
    picture.onclick = (event) => openUserCard(event, message.author_id);
    info.append(picture);
  }

  const content = h("div", { class: "message-content" });
  if (!tail && !message.system) {
    const name = h("span", { class: "username", text: message.author, title: message.username || message.author });
    paintName(name, message.colour);
    name.onclick = (event) => openUserCard(event, message.author_id);
    name.oncontextmenu = (event) => openUserMenu(event, { id: message.author_id, name: message.author });
    const head = h("div", { class: "message-head" }, [
      name,
      h("time", { text: calendarText(date), title: date ? date.toLocaleString() : "" }),
      message.edited ? h("span", { class: "edited", text: "(изменено)" }) : null,
    ]);
    content.append(head);
  }

  if (state.editing === message.id) {
    content.append(editBox(message));
  } else {
    const text = h("div", { class: "message-text" + (isJumbo(message.content) ? " jumbo" : "") });
    text.append(segmentsNode(message));
    if (text.textContent || text.childElementCount) content.append(text);
    if (tail && message.edited) content.append(h("span", { class: "edited", text: "(изменено)" }));
  }

  if (message.attachments && message.attachments.length) content.append(attachmentsNode(message.attachments));
  if (message.embeds && message.embeds.length) {
    content.append(h("div", { class: "embeds" }, message.embeds.map(embedNode)));
  }
  if (message.failed) content.append(failedHint(message));

  node.append(h("div", { class: "message-row" }, [info, content]));
  if (!message.pending && !message.system) node.append(messageToolbar(message, node));

  node.addEventListener("contextmenu", (event) => {
    if (event.target.closest("a")) return;
    openMessageMenu(event, message);
  });
  return node;
}

function systemIcon(text) {
  if (/присоединя|добавля/.test(text)) return "person_add";
  if (/выходит|убирает|исключ|заблокир/.test(text)) return "logout";
  if (/закрепля|открепля/.test(text)) return "keep";
  if (/звонок/.test(text)) return "call";
  return "info";
}

function replyLine(replyId) {
  const target = state.messages.find((item) => item.id === replyId);
  const node = h("div", { class: "reply-line" });
  if (target) {
    const name = h("span", { class: "username", text: target.author });
    paintName(name, target.colour);
    node.append(
      avatar({ url: target.avatar, name: target.author, size: 14 }),
      name,
      h("span", { class: "reply-text", text: plainPreview(target) }),
    );
    node.onclick = () => jumpToMessage({ channel: state.channelId, message: replyId });
  } else {
    node.append(h("span", { class: "reply-text missing", text: "Сообщение не загружено" }));
    node.onclick = () => jumpToMessage({ channel: state.channelId, message: replyId });
  }
  return node;
}

function attachmentsNode(files) {
  const box = h("div", { class: "attachments" });
  for (const file of files) {
    if (file.kind === "image" && file.url) {
      const img = image(file.url, { class: "attachment-image", title: file.name, alt: file.name });
      box.append(h("a", { href: file.url, target: "_blank", rel: "noreferrer" }, [img]));
      continue;
    }
    box.append(
      h("a", { class: "file", href: file.url || null, target: "_blank", rel: "noreferrer" }, [
        symbol(file.kind === "image" ? "image" : "description", 28),
        h("span", { class: "file-text" }, [
          h("span", { class: "file-name", text: file.name }),
          h("span", { class: "file-size", text: humanSize(file.size) }),
        ]),
        file.url ? symbol("download", 20) : null,
      ]),
    );
  }
  return box;
}

function embedNode(embed) {
  if (embed.kind === "image" && embed.image) {
    const img = image(embed.image, { class: "embed-media" });
    if (embed.width && embed.height) img.style.aspectRatio = `${embed.width} / ${embed.height}`;
    return img;
  }
  if (embed.kind === "video" && embed.url) {
    return h("a", { class: "file", href: embed.url, target: "_blank", rel: "noreferrer" }, [
      symbol("description", 28),
      h("span", { class: "file-text" }, [h("span", { class: "file-name", text: embed.url })]),
    ]);
  }
  const box = h("div", { class: "embed" });
  if (embed.site) box.append(h("span", { class: "embed-site", text: embed.site }));
  if (embed.title) {
    box.append(
      embed.url
        ? h("a", { class: "embed-title", href: embed.url, target: "_blank", rel: "noreferrer", text: embed.title })
        : h("span", { class: "embed-title", text: embed.title }),
    );
  }
  if (embed.description) box.append(h("div", { class: "embed-text" }, [richText(embed.description)]));
  if (embed.image) {
    const img = image(embed.image, { class: "embed-media" });
    if (embed.width && embed.height) img.style.aspectRatio = `${embed.width} / ${embed.height}`;
    box.append(img);
  }
  return box;
}

/** Панель действий при наведении (MessageToolbar.tsx). */
function messageToolbar(message, node) {
  const bar = h("div", { class: "message-toolbar" });
  const tool = (icon, title, action, danger) =>
    h("button", { type: "button", title, class: danger ? "danger" : null, onclick: action }, [symbol(icon, 20)]);

  bar.append(tool("reply", "Ответить", () => addReply(message)));
  if (message.mine) {
    bar.append(tool("edit", "Изменить", () => startEdit(message)));
    bar.append(tool("delete", "Удалить (Shift — без вопроса)", (event) => removeMessage(message, event.shiftKey), true));
  }
  bar.append(
    tool("more_vert", "Ещё", (event) => {
      node.classList.add("toolbar-open");
      openMessageMenu(event, message, () => node.classList.remove("toolbar-open"));
    }),
  );
  return bar;
}

function failedHint(message) {
  return h("div", { class: "edit-hint" }, [
    "Не отправлено. ",
    h("button", { type: "button", text: "Повторить", onclick: () => retrySend(message) }),
    " · ",
    h("button", {
      type: "button",
      text: "Убрать",
      onclick: () => {
        state.messages = state.messages.filter((item) => item !== message);
        renderMessages();
      },
    }),
  ]);
}

// ─────────────────────────── правка и удаление ───────────────────────────

function startEdit(message) {
  if (!message.mine || message.pending) return;
  state.editing = message.id;
  renderMessages();
  const box = messagesEl.querySelector(".edit-box textarea");
  if (box) {
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }
}

function stopEdit() {
  if (!state.editing) return;
  state.editing = null;
  renderMessages();
  focusInput();
}

function editBox(message) {
  const area = h("textarea", { rows: "1", maxlength: "2000" });
  area.value = emojiIdsToNames(message.content || "");
  autosize(area);
  area.addEventListener("input", () => autosize(area));
  area.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      stopEdit();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      saveEdit(message, area.value);
    }
  });
  return h("div", { class: "edit-box" }, [
    area,
    h("div", { class: "edit-hint" }, [
      "Esc — ",
      h("button", { type: "button", text: "отмена", onclick: stopEdit }),
      " · Enter — ",
      h("button", { type: "button", text: "сохранить", onclick: () => saveEdit(message, area.value) }),
    ]),
  ]);
}

async function saveEdit(message, value) {
  const content = emojiNamesToIds(value.trim());
  if (!content) {
    removeMessage(message, false);
    return;
  }
  if (content === message.content) {
    stopEdit();
    return;
  }
  try {
    const updated = await call("edit_message", { channelId: message.channel, messageId: message.id, content });
    replaceMessage(markMine([updated])[0]);
    state.editing = null;
    renderMessages();
    focusInput();
  } catch (error) {
    toast("Не удалось изменить: " + describe(error), "error");
  }
}

async function removeMessage(message, skipConfirm) {
  if (!skipConfirm && !window.confirm("Удалить это сообщение?")) return;
  try {
    await call("delete_message", { channelId: message.channel, messageId: message.id });
    state.messages = state.messages.filter((item) => item.id !== message.id);
    if (state.editing === message.id) state.editing = null;
    renderMessages();
  } catch (error) {
    toast("Не удалось удалить: " + describe(error), "error");
  }
}

function replaceMessage(message) {
  const index = state.messages.findIndex((item) => item.id === message.id);
  if (index >= 0) state.messages[index] = message;
  return index >= 0;
}

// ─────────────────────────── поле ввода ───────────────────────────

const drafts = new Map(); // id канала → недописанный текст

function placeholderFor(channel) {
  if (channel.kind === "notes") return "Сохранить в заметки";
  if (channel.kind === "dm") return "Сообщение для " + channel.name;
  if (channel.kind === "group") return "Сообщение в " + channel.name;
  return "Сообщение в #" + channel.name;
}

function renderComposer() {
  const channel = currentChannel();
  const box = el("message-box");
  el("composition").classList.toggle("hidden", !channel);
  if (!channel) return;
  box.classList.remove("hidden");
  inputEl.placeholder = placeholderFor(channel);
  autosize(inputEl);
  renderReplies();
}

function autosize(area) {
  area.style.height = "auto";
  area.style.height = area.scrollHeight + "px";
}

function focusInput() {
  if (!state.editing && currentChannel()) inputEl.focus({ preventScroll: true });
}

function addReply(message) {
  if (message.pending || message.system) return;
  if (state.replies.some((reply) => reply.message.id === message.id)) return;
  if (state.replies.length >= MAX_REPLIES) {
    toast("Можно ответить сразу не больше чем на пять сообщений");
    return;
  }
  // как в оригинале: упоминание включено, кроме ответа самому себе
  state.replies.push({ message, mention: !message.mine });
  renderReplies();
  focusInput();
}

function renderReplies() {
  const box = el("replies");
  box.textContent = "";
  for (const reply of state.replies) {
    const name = h("span", { class: "username", text: reply.message.author });
    const preview = h("div", { class: "reply-preview" }, [
      h("span", { class: "reply-preview-to", text: "Ответ на" }),
      h("span", { class: "reply-preview-message" }, [
        avatar({ url: reply.message.avatar, name: reply.message.author, size: 16 }),
        name,
        h("span", { class: "reply-text", text: plainPreview(reply.message) }),
      ]),
    ]);
    if (!reply.message.mine) {
      preview.append(
        h(
          "button",
          {
            type: "button",
            class: "reply-mention" + (reply.mention ? "" : " off"),
            title: "Упоминать автора",
            onclick: () => {
              reply.mention = !reply.mention;
              renderReplies();
            },
          },
          [symbol("alternate_email", 16), reply.mention ? "Вкл" : "Выкл"],
        ),
      );
    }
    preview.append(
      h(
        "button",
        {
          type: "button",
          class: "reply-dismiss",
          title: "Не отвечать",
          onclick: () => {
            state.replies = state.replies.filter((item) => item !== reply);
            renderReplies();
          },
        },
        [symbol("cancel", 16)],
      ),
    );
    box.append(preview);
  }
}

let pendingCounter = 0;

async function submit() {
  const channel = currentChannel();
  const content = emojiNamesToIds(inputEl.value.trim());
  if (!channel || !content) return;
  if (content.length > 2000) {
    toast("Сообщение длиннее 2000 символов", "error");
    return;
  }

  const replies = state.replies.map((reply) => ({ id: reply.message.id, mention: reply.mention }));
  inputEl.value = "";
  drafts.delete(channel.id);
  autosize(inputEl);
  state.replies = [];
  renderReplies();
  toggleEmojiPicker(false);

  // сообщение сразу появляется в ленте и подтверждается ответом сервера
  const pending = {
    id: "pending:" + ++pendingCounter,
    pending: true,
    mine: true,
    channel: channel.id,
    author_id: state.me ? state.me.id : "",
    author: myName(),
    avatar: state.me ? state.me.avatar : null,
    content,
    segments: [],
    emoji: {},
    timestamp: new Date().toISOString(),
    replies: replies.map((reply) => reply.id),
    replyIntents: replies,
    mentions: [],
    attachments: [],
    embeds: [],
  };
  state.messages.push(pending);
  state.stickToBottom = true;
  renderMessages({ toBottom: true });
  await deliver(pending);
}

async function deliver(pending) {
  try {
    const sent = await call("send_message", {
      channelId: pending.channel,
      content: pending.content,
      replies: pending.replyIntents.length ? pending.replyIntents : null,
    });
    const index = state.messages.indexOf(pending);
    if (state.channelId !== pending.channel || index < 0) return;
    markMine([sent]);
    // то же сообщение могло уже прийти через шлюз
    if (state.messages.some((item) => item.id === sent.id)) state.messages.splice(index, 1);
    else state.messages[index] = sent;
    renderMessages();
    ackChannel(sent.channel, sent.id);
  } catch (error) {
    pending.failed = true;
    if (state.channelId === pending.channel) renderMessages();
    toast("Не отправлено: " + describe(error), "error");
  }
}

function retrySend(message) {
  message.failed = false;
  renderMessages();
  deliver(message);
}

function onComposerKey(event) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
    return;
  }
  if (event.key === "Escape") {
    if (!el("emoji-picker").classList.contains("hidden")) toggleEmojiPicker(false);
    else if (state.replies.length) {
      state.replies = [];
      renderReplies();
    }
    return;
  }
  // как в оригинале: стрелка вверх в пустом поле правит своё последнее сообщение
  if (event.key === "ArrowUp" && !inputEl.value) {
    const last = [...state.messages].reverse().find((item) => item.mine && !item.pending && !item.system);
    if (last) {
      event.preventDefault();
      startEdit(last);
    }
  }
}

// ─────────────────────────── кто печатает ───────────────────────────

function setTyping(channelId, userId, active) {
  if (state.me && userId === state.me.id) return;
  let users = state.typing.get(channelId);
  if (!users) {
    users = new Map();
    state.typing.set(channelId, users);
  }
  clearTimeout(users.get(userId));
  if (active) users.set(userId, setTimeout(() => setTyping(channelId, userId, false), 10000));
  else users.delete(userId);
  if (channelId === state.channelId) renderTyping();
}

function renderTyping() {
  const node = el("typing");
  const users = [...(state.typing.get(state.channelId) || new Map()).keys()];
  node.classList.toggle("hidden", !users.length);
  if (!users.length) return;
  const names = users.slice(0, 3).map(userName);
  node.textContent =
    users.length === 1
      ? `${names[0]} печатает…`
      : users.length <= 3
        ? `${names.join(", ")} печатают…`
        : "Несколько человек печатают…";
}

// ─────────────────────────── участники ───────────────────────────

const membersCache = new Map(); // id сервера → участники

async function loadMembers(serverId) {
  renderMembers();
  if (serverId === null) return;
  // присутствие участников приходит только по подписке; ядро само решает, пора ли её продлить
  call("subscribe_server", { serverId }).catch((error) => console.warn("подписка на сервер:", error));
  if (membersCache.has(serverId)) return;
  membersCache.set(serverId, null);
  try {
    membersCache.set(serverId, (await call("server_members", { serverId })) || []);
  } catch (error) {
    membersCache.set(serverId, []);
    console.warn("не удалось получить участников:", error);
  }
  if (state.serverId === serverId) {
    renderMembers();
    renderTyping();
  }
}

/** Группы как в MemberSidebar.tsx: роли с hoist, «В сети», «Не в сети». */
function renderMembers() {
  const panel = el("members");
  const visible = state.serverId !== null && state.showMembers && currentChannel();
  panel.classList.toggle("hidden", !visible);
  if (!visible) return;
  panel.textContent = "";

  const members = membersCache.get(state.serverId);
  if (!members) {
    panel.append(h("div", { class: "member-title", text: "Загрузка участников…" }));
    return;
  }

  const groups = new Map();
  const online = [];
  const offline = [];
  for (const member of members) {
    if (member.presence === "Offline" || !member.online) offline.push(member);
    else if (member.hoist) {
      if (!groups.has(member.hoist.id)) groups.set(member.hoist.id, { role: member.hoist, list: [] });
      groups.get(member.hoist.id).list.push(member);
    } else online.push(member);
  }
  const onlineCount = members.length - offline.length;
  panel.append(
    h("div", { class: "member-title" }, [h("span", { class: "connection-dot" }), `${onlineCount} в сети`]),
  );

  const byName = (a, b) => a.name.localeCompare(b.name);
  const sections = [...groups.values()]
    .sort((a, b) => a.role.rank - b.role.rank)
    .map((group) => [group.role.name, group.list]);
  sections.push(["В сети", online], ["Не в сети", offline]);

  for (const [title, list] of sections) {
    if (!list.length) continue;
    panel.append(h("div", { class: "member-group", text: `${title} – ${list.length}` }));
    for (const member of list.sort(byName)) panel.append(memberRow(member));
  }
}

function memberRow(member) {
  const name = h("span", { class: "menu-button-name", text: member.name });
  paintName(name, member.colour);
  const row = h(
    "button",
    {
      class: "menu-button " + (member.presence === "Offline" ? "muted" : "active"),
      type: "button",
      title: member.username,
    },
    [
      h("span", { class: "menu-button-icon" }, [
        avatar({ url: member.avatar, name: member.name, presence: member.presence || "Offline" }),
      ]),
      h("span", { class: "menu-button-text" }, [
        name,
        member.status ? h("span", { class: "menu-button-status", text: member.status }) : null,
      ]),
    ],
  );
  row.onclick = (event) => openUserCard(event, member.id);
  row.oncontextmenu = (event) => openUserMenu(event, member);
  return row;
}

function toggleMembers() {
  state.showMembers = !state.showMembers;
  writeSetting("members", state.showMembers);
  renderHeader();
  renderMembers();
}

// ─────────────────────────── эмодзи серверов и панель ───────────────────────────

const serverEmoji = new Map(); // id сервера → [{ id, name, url, animated }]
const customEmojiIndex = new Map(); // id эмодзи → { name, server }

async function loadServerEmoji(serverId) {
  if (serverId === null || serverEmoji.has(serverId)) return serverEmoji.get(serverId) || [];
  serverEmoji.set(serverId, []);
  try {
    const list = (await call("server_emojis", { serverId })) || [];
    serverEmoji.set(serverId, list);
    for (const emoji of list) customEmojiIndex.set(emoji.id, { name: emoji.name, server: serverId });
    return list;
  } catch (error) {
    console.warn("не удалось получить эмодзи сервера:", error);
    return [];
  }
}

/**
 * Найти эмодзи по имени: сначала на открытом сервере, затем на остальных.
 * В поле ввода эмодзи видны как `:имя:`, а в сообщение уходят как `:id:` —
 * именно так их понимают все клиенты Stoat.
 */
function emojiByName(name) {
  const lower = name.toLowerCase();
  const order = [state.serverId, ...serverEmoji.keys()].filter((id) => id !== null);
  for (const serverId of order) {
    const found = (serverEmoji.get(serverId) || []).find((emoji) => emoji.name.toLowerCase() === lower);
    if (found) return found;
  }
  return null;
}

function emojiNamesToIds(text) {
  return text.replace(/:([A-Za-z0-9_]{1,32}):/g, (whole, name) => {
    if (/^[0-9A-Z]{26}$/.test(name)) return whole;
    const found = emojiByName(name);
    return found ? `:${found.id}:` : whole;
  });
}

function emojiIdsToNames(text) {
  return text.replace(CUSTOM_EMOJI_RE, (whole, id) => {
    const known = customEmojiIndex.get(id);
    return known ? `:${known.name}:` : whole;
  });
}

let emojiFilter = "";
let emojiActiveServer = null;

function unicodeEmojis() {
  if (unicodeEmojis.cache) return unicodeEmojis.cache;
  unicodeEmojis.cache = Object.keys(window.EMOJI_MAP || {})
    .map((code) => {
      try {
        return { code, text: code.split("-").map((part) => String.fromCodePoint(parseInt(part, 16))).join("") };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return unicodeEmojis.cache;
}

function renderEmojiPicker() {
  const list = el("emoji-list");
  const rail = el("emoji-servers");
  list.textContent = "";
  rail.textContent = "";

  const servers = (state.workspace ? state.workspace.servers : []).filter(
    (server) => (serverEmoji.get(server.id) || []).length,
  );
  const needle = emojiFilter.trim().toLowerCase();

  if (needle) {
    const found = [];
    for (const server of servers) {
      for (const emoji of serverEmoji.get(server.id)) {
        if (emoji.name.toLowerCase().includes(needle)) found.push({ kind: "server", emoji, server });
      }
    }
    for (const emoji of unicodeEmojis()) {
      if (emoji.code.includes(needle) || emoji.text === needle) found.push({ kind: "unicode", emoji });
    }
    if (!found.length) {
      list.append(h("div", { class: "emoji-note", text: "Ничего не найдено" }));
      renderEmojiPreview(null);
      return;
    }
    list.append(h("div", { class: "emoji-section", text: "Результаты" }));
    for (const item of found.slice(0, 300)) list.append(emojiButton(item));
    renderEmojiPreview(found[0]);
    return;
  }

  for (const server of servers) {
    const button = h("button", {
      type: "button",
      class: "emoji-server" + (server.id === (emojiActiveServer || state.serverId) ? " active" : ""),
      title: server.name,
      text: initials(server.name),
    });
    if (server.icon) {
      mediaUrl(server.icon).then((data) => data && button.replaceChildren(h("img", { src: data, alt: "" })));
    }
    button.onclick = () => {
      emojiActiveServer = server.id;
      for (const node of rail.children) node.classList.toggle("active", node === button);
      const head = list.querySelector(`[data-server="${server.id}"]`);
      const box = el("emoji-scroll");
      if (head) box.scrollTop = head.offsetTop - list.offsetTop;
    };
    rail.append(button);

    list.append(h("div", { class: "emoji-section", text: server.name, dataset: { server: server.id } }));
    for (const emoji of serverEmoji.get(server.id)) list.append(emojiButton({ kind: "server", emoji, server }));
  }

  list.append(h("div", { class: "emoji-section", text: "Эмодзи" }));
  for (const emoji of unicodeEmojis()) list.append(emojiButton({ kind: "unicode", emoji }));
  renderEmojiPreview(
    servers.length
      ? { kind: "server", emoji: serverEmoji.get(servers[0].id)[0], server: servers[0] }
      : { kind: "unicode", emoji: unicodeEmojis()[0] },
  );
}

function emojiVisual(item) {
  if (item.kind === "server") {
    return item.emoji.url ? image(item.emoji.url, { class: "emoji", alt: item.emoji.name }) : document.createTextNode("?");
  }
  const slot = h("span", { text: item.emoji.text });
  spriteUrl(item.emoji.code).then((data) => {
    if (data) slot.replaceWith(h("img", { class: "emoji", src: data, alt: item.emoji.text }));
  });
  return slot;
}

function emojiButton(item) {
  const title = item.kind === "server" ? ":" + item.emoji.name + ":" : item.emoji.text;
  const button = h("button", { type: "button", class: "emoji-item", title }, [emojiVisual(item)]);
  button.onclick = () => insertText(item.kind === "server" ? `:${item.emoji.name}:` : item.emoji.text);
  button.onmouseenter = () => renderEmojiPreview(item);
  return button;
}

function renderEmojiPreview(item) {
  const img = el("emoji-preview-img");
  img.textContent = "";
  if (!item || !item.emoji) {
    el("emoji-preview-name").textContent = "";
    el("emoji-preview-from").textContent = "";
    return;
  }
  img.append(emojiVisual(item));
  el("emoji-preview-name").textContent = item.kind === "server" ? ":" + item.emoji.name + ":" : item.emoji.text;
  el("emoji-preview-from").textContent = item.kind === "server" ? "с сервера " + item.server.name : "юникод";
}

/** Вставить текст на месте курсора. */
function insertText(token) {
  const start = inputEl.selectionStart ?? inputEl.value.length;
  const end = inputEl.selectionEnd ?? inputEl.value.length;
  const before = inputEl.value.slice(0, start);
  const glue = before && !/\s$/.test(before) ? " " : "";
  inputEl.value = before + glue + token + inputEl.value.slice(end);
  const caret = (before + glue + token).length;
  inputEl.setSelectionRange(caret, caret);
  autosize(inputEl);
  inputEl.focus();
}

function toggleEmojiPicker(force) {
  const picker = el("emoji-picker");
  const open = force ?? picker.classList.contains("hidden");
  picker.classList.toggle("hidden", !open);
  el("btn-emoji").classList.toggle("active", open);
  if (!open) return;
  el("emoji-search").value = "";
  emojiFilter = "";
  emojiActiveServer = null;
  renderEmojiPicker();
  el("emoji-search").focus();
  const ids = (state.workspace ? state.workspace.servers : []).map((server) => server.id);
  Promise.all(ids.map(loadServerEmoji)).then(() => {
    if (!picker.classList.contains("hidden")) renderEmojiPicker();
  });
}

// ─────────────────────────── меню ───────────────────────────

let menuClosed = null;

function closeMenus() {
  el("ctx-menu").classList.add("hidden");
  el("account-menu").classList.add("hidden");
  closeUserCard();
  if (menuClosed) {
    menuClosed();
    menuClosed = null;
  }
}

/** Контекстное меню у курсора, не вылезая за край окна. */
function openContextMenu(event, items, onClose) {
  event.preventDefault();
  event.stopPropagation();
  closeMenus();
  menuClosed = onClose || null;
  const menu = el("ctx-menu");
  menu.textContent = "";
  for (const item of items) {
    if (!item) continue;
    if (item.divider) {
      menu.append(h("div", { class: "menu-divider" }));
      continue;
    }
    menu.append(
      h(
        "button",
        {
          type: "button",
          class: "menu-item" + (item.danger ? " danger" : ""),
          role: "menuitem",
          onclick: async (clickEvent) => {
            closeMenus();
            try {
              await item.action(clickEvent);
            } catch (error) {
              toast(describe(error), "error");
            }
          },
        },
        [item.icon ? symbol(item.icon, 20) : null, item.label],
      ),
    );
  }
  menu.classList.remove("hidden");
  const box = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - box.width - 8);
  const y = Math.min(event.clientY, window.innerHeight - box.height - 8);
  menu.style.left = Math.max(8, x) + "px";
  menu.style.top = Math.max(8, y) + "px";
}

async function messageLink(message) {
  try {
    return await call("message_link", {
      server: state.serverId,
      channel: message.channel || state.channelId,
      message: message.id,
    });
  } catch {
    return `https://stoat.chat/channel/${message.channel || state.channelId}/${message.id}`;
  }
}

function openMessageMenu(event, message, onClose) {
  if (message.pending) return;
  openContextMenu(
    event,
    [
      !message.system && { icon: "reply", label: "Ответить", action: () => addReply(message) },
      message.mine && !message.system && { icon: "edit", label: "Изменить", action: () => startEdit(message) },
      message.content && { icon: "content_copy", label: "Копировать текст", action: () => copyText(message.content) },
      {
        icon: "link",
        label: "Копировать ссылку",
        action: async () => {
          await copyText(await messageLink(message));
          toast("Ссылка скопирована");
        },
      },
      { icon: "fingerprint", label: "Копировать ID", action: () => copyText(message.id) },
      message.mine && { divider: true },
      message.mine && {
        icon: "delete",
        label: "Удалить",
        danger: true,
        action: (clickEvent) => removeMessage(message, clickEvent.shiftKey),
      },
    ],
    onClose,
  );
}

/** Контекстное меню пользователя (UserContextMenu.tsx). */
function openUserMenu(event, user, serverId = state.serverId) {
  const me = Boolean(state.me && state.me.id === user.id);
  const relate = (kind) => async () => {
    await call("set_relationship", { userId: user.id, action: kind });
    toast(relationshipToast(kind, kind === "add" ? "Outgoing" : ""));
  };
  const canWrite = Boolean(currentChannel()) && !el("message-box").classList.contains("hidden");
  openContextMenu(event, [
    { icon: "person", label: "Профиль", action: () => openProfileModal(user.id, serverId) },
    !me && { icon: "chat", label: "Написать сообщение", action: () => openDirectMessage(user.id) },
    canWrite && {
      icon: "alternate_email",
      label: "Упомянуть",
      action: () => insertText(`<@${user.id}>`),
    },
    { divider: true },
    !me &&
      user.relationship === "Friend" && {
        icon: "person_remove",
        label: "Удалить из друзей",
        danger: true,
        action: relate("remove"),
      },
    !me &&
      user.relationship !== "Blocked" && {
        icon: "block",
        label: "Заблокировать",
        danger: true,
        action: relate("block"),
      },
    !me && user.relationship === "Blocked" && { icon: "block", label: "Разблокировать", action: relate("unblock") },
    !me && { divider: true },
    { icon: "content_copy", label: "Копировать имя", action: () => copyText(user.username || user.name) },
    { icon: "fingerprint", label: "Копировать ID", action: () => copyText(user.id) },
  ]);
}

function openChannelMenu(event, channel) {
  openContextMenu(event, [
    channel.unread &&
      channel.last_message_id && {
        icon: "mark_chat_read",
        label: "Отметить прочитанным",
        action: () => ackChannel(channel.id, channel.last_message_id),
      },
    { icon: "content_copy", label: "Копировать название", action: () => copyText(channel.name) },
    { icon: "fingerprint", label: "Копировать ID", action: () => copyText(channel.id) },
  ]);
}

function openServerMenu(event, server) {
  const unread = server.categories
    .flatMap((category) => category.channels)
    .filter((channel) => channel.unread && channel.last_message_id);
  openContextMenu(event, [
    unread.length && {
      icon: "mark_chat_read",
      label: "Отметить прочитанным",
      action: () => unread.forEach((channel) => ackChannel(channel.id, channel.last_message_id)),
    },
    { icon: "content_copy", label: "Копировать название", action: () => copyText(server.name) },
    { icon: "fingerprint", label: "Копировать ID", action: () => copyText(server.id) },
  ]);
}

async function logout() {
  try {
    await call("logout");
  } catch {
    /* локально выходим в любом случае */
  }
  location.replace("login.html");
}

// ─────────────────────────── данные и события ───────────────────────────

let workspaceTask = null;
let workspaceAgain = false;

/** Обновить дерево серверов; одновременно идёт не больше одного запроса. */
async function refreshWorkspace({ reloadChannel = false } = {}) {
  if (workspaceTask) {
    workspaceAgain = true;
    return workspaceTask;
  }
  workspaceTask = (async () => {
    const ws = await call("workspace");
    state.workspace = ws;
    state.me = ws.me;
    markMine(state.messages);

    const keep = state.channelId ? findChannel(state.channelId) : null;
    if (keep) {
      state.serverId = keep.server ? keep.server.id : null;
      renderRail();
      renderSidebar();
      renderHeader();
      if (reloadChannel) await openChannel(keep.channel, { reload: true });
    } else if (ws.last_channel && findChannel(ws.last_channel)) {
      const found = findChannel(ws.last_channel);
      state.serverId = found.server ? found.server.id : null;
      await openChannel(found.channel);
    } else {
      selectServer(ws.servers.length ? ws.servers[0].id : null);
    }
  })();
  try {
    await workspaceTask;
  } finally {
    workspaceTask = null;
    if (workspaceAgain) {
      workspaceAgain = false;
      refreshWorkspace();
    }
  }
}

let refreshTimer = null;
function scheduleWorkspaceRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshWorkspace().catch((error) => console.warn(error)), 400);
}

/** Сообщение (новое или изменённое) от ядра — уже в том же виде, что история. */
function onMessage(message) {
  if (!message || !message.id) return;
  markMine([message]);
  if (message.channel !== state.channelId) {
    if (!message.edited) noteIncoming(message);
    return;
  }
  if (replaceMessage(message)) {
    renderMessages();
    return;
  }
  const near = distanceFromBottom() < 120;
  state.messages.push(message);
  // своё сообщение, отправленное с другого устройства, или ответ сервера ещё в пути
  const pending = state.messages.find(
    (item) => item.pending && !item.failed && item.content === message.content && message.mine,
  );
  if (pending) state.messages.splice(state.messages.indexOf(pending), 1);
  state.stickToBottom = state.stickToBottom || near;
  setTyping(message.channel, message.author_id, false);
  noteIncoming(message);
  renderMessages();
  ackVisible();
}

function onGateway(payload) {
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return;
  }
  // события ядра сериализуются с тегом `type`, поля лежат рядом
  switch (event.type) {
    case "Authenticated":
      setConnection("warn", "авторизация…");
      break;
    case "Ready":
      setConnection("ok", "подключено");
      membersCache.clear();
      refreshWorkspace({ reloadChannel: true }).catch((error) => toast(describe(error), "error"));
      break;
    case "Logout":
      setConnection("err", "сессия завершена");
      toast("Сессия завершена, войдите заново", "error");
      break;
    case "Error": {
      const kind = event.kind || "";
      if (["InvalidSession", "SessionExpired"].includes(kind)) {
        setConnection("err", "сессия завершена");
        toast("Сессия завершена, войдите заново", "error");
      } else {
        console.warn("шлюз:", event);
      }
      break;
    }
    case "MessageDelete":
      if (event.channel === state.channelId) {
        const before = state.messages.length;
        state.messages = state.messages.filter((item) => item.id !== event.id);
        if (state.messages.length !== before) renderMessages();
      }
      break;
    case "ChannelAck": {
      const found = findChannel(event.id);
      if (found && (!found.channel.last_message_id || event.message_id >= found.channel.last_message_id)) {
        found.channel.unread = false;
        found.channel.mentions = 0;
        if (found.server) recountServer(found.server);
        renderRail();
        renderSidebar();
      }
      break;
    }
    case "ChannelStartTyping":
      setTyping(event.id, event.user, true);
      break;
    case "ChannelStopTyping":
      setTyping(event.id, event.user, false);
      break;
    case "UserUpdate":
      applyPresence(event);
      break;
    case "ChannelCreate":
    case "ChannelUpdate":
    case "ChannelDelete":
    case "ServerCreate":
    case "ServerUpdate":
    case "ServerDelete":
    case "ServerMemberJoin":
    case "ServerMemberLeave":
      if (event.type.startsWith("ServerMember")) membersCache.delete(event.id);
      scheduleWorkspaceRefresh();
      break;
    case "ServerMemberUpdate": {
      // ник или роли поменялись: список участников соберётся заново
      const serverId = event.id && event.id.server;
      if (serverId && membersCache.has(serverId)) {
        membersCache.delete(serverId);
        if (state.serverId === serverId) loadMembers(serverId);
      }
      break;
    }
    default:
      break;
  }
}

/** Присутствие и статус меняются без перезагрузки дерева. */
function applyPresence(event) {
  const data = event.data || {};
  const online = typeof data.online === "boolean" ? data.online : event.online;
  const status = data.status;
  const clear = event.clear || [];
  const patch = (target) => {
    if (typeof online === "boolean") target.online = online;
    const presence = status && status.presence;
    if (!target.online) target.presence = "Offline";
    else if (presence) target.presence = presence === "Invisible" ? "Offline" : presence;
    else if (typeof online === "boolean") target.presence = target.presence === "Offline" ? "Online" : target.presence;
    if (status && "text" in status) target.status = status.text || null;
    if (clear.includes("StatusText")) target.status = null;
  };

  let changed = false;
  for (const members of membersCache.values()) {
    const member = (members || []).find((item) => item.id === event.id);
    if (member) {
      patch(member);
      changed = true;
    }
  }
  const ws = state.workspace;
  for (const dm of ws ? ws.dms : []) {
    if (dm.recipient !== event.id) continue;
    const view = { online: dm.presence !== "Offline", presence: dm.presence, status: dm.description };
    patch(view);
    dm.presence = view.presence;
    dm.description = view.status;
    changed = true;
  }
  if (state.me && state.me.id === event.id) {
    // себе показываем выбранное присутствие (и «невидимку»), а не то, что видят другие
    if (status && status.presence) state.me.presence = status.presence;
    if (clear.includes("StatusPresence")) state.me.presence = "Online";
    if (status && "text" in status) state.me.status = status.text || null;
    if (clear.includes("StatusText")) state.me.status = null;
    changed = true;
  }
  if (changed) {
    renderMembers();
    renderSidebar();
    renderRail();
  }
}

// ─────────────────────────── запуск ───────────────────────────

function bindUi() {
  setIcon(el("btn-emoji"), "mood", 24);
  setIcon(el("btn-send"), "send", 24);
  setIcon(el("btn-members"), "group", 24);

  messagesEl.addEventListener("scroll", () => {
    state.stickToBottom = distanceFromBottom() < 40;
    if (messagesEl.scrollTop < 400) loadOlder();
    if (state.stickToBottom) ackVisible();
  });

  inputEl.addEventListener("keydown", onComposerKey);
  inputEl.addEventListener("input", () => {
    autosize(inputEl);
    if (state.channelId) drafts.set(state.channelId, inputEl.value);
  });
  el("btn-send").onclick = submit;
  el("btn-emoji").onclick = (event) => {
    event.stopPropagation();
    toggleEmojiPicker();
  };
  el("btn-members").onclick = toggleMembers;
  el("emoji-search").addEventListener("input", (event) => {
    emojiFilter = event.target.value;
    renderEmojiPicker();
  });
  el("emoji-picker").addEventListener("click", (event) => event.stopPropagation());
  el("account-menu").addEventListener("click", (event) => event.stopPropagation());
  el("user-card").addEventListener("click", (event) => event.stopPropagation());
  el("modal").addEventListener("click", closeModal);

  document.addEventListener("click", () => {
    closeMenus();
    toggleEmojiPicker(false);
  });
  document.addEventListener("contextmenu", (event) => {
    // своё меню уже открыто обработчиком элемента; на пустом месте — закрываем
    if (!event.defaultPrevented) closeMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (modalOpen()) closeModal();
    else closeMenus();
  });
  window.addEventListener("resize", closeMenus);
  window.addEventListener("focus", ackVisible);
}

async function boot() {
  if (!invoke) {
    document.body.replaceChildren(
      h("div", { class: "messages-state" }, [
        h("h2", { text: "Нет связи с ядром приложения" }),
        h("div", { text: "Это ошибка сборки, а не ваших данных." }),
      ]),
    );
    return;
  }
  bindUi();
  closeChannel();

  try {
    const session = await call("session_state");
    if (!session.logged_in) {
      location.replace("login.html");
      return;
    }
  } catch {
    location.replace("login.html");
    return;
  }

  if (listen) {
    await listen("stoat:gateway", (event) => onGateway(event.payload));
    await listen("stoat:message", (event) => {
      try {
        onMessage(JSON.parse(event.payload));
      } catch (error) {
        console.warn("плохое событие сообщения:", error);
      }
    });
  }

  setConnection("warn", "подключаюсь…");
  try {
    await call("connect_gateway");
  } catch (error) {
    setConnection("err", "нет соединения");
    toast("Не удалось подключиться: " + describe(error), "error");
  }

  try {
    await refreshWorkspace();
  } catch (error) {
    showState(symbol("info", 32), "Не удалось получить данные", describe(error));
  }
}

boot();
