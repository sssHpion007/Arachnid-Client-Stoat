// Интерфейс клиента по образцу официального Stoat (for-web).
// Всё состояние приходит из Rust, здесь только отрисовка и ввод.
"use strict";

const bridge = window.__TAURI__;
const invoke = bridge && bridge.core && bridge.core.invoke;
const listen = bridge && bridge.event && bridge.event.listen;
const convertFileSrc = bridge && bridge.core && bridge.core.convertFileSrc;

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
  for (const child of [].concat(children).flat(Infinity)) {
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

/** Понятные описания частых ошибок API (msgid, переводятся при показе). */
const KNOWN_ERRORS = {
  RateLimited: /* i18n */ "too many requests — please wait a moment",
  rate_limited: /* i18n */ "too many requests — please wait a moment",
  MissingPermission: /* i18n */ "you do not have permission to do this",
  NotFound: /* i18n */ "not found (it may have been deleted)",
  EmptyMessage: /* i18n */ "empty message",
  PayloadTooLarge: /* i18n */ "the message is too long",
  TooManyReplies: /* i18n */ "too many replies in one message",
  Unauthorized: /* i18n */ "the session has expired — log in again",
  unauthorized: /* i18n */ "log in to your account first",
  InvalidSession: /* i18n */ "the session has expired — log in again",
};

function describe(error) {
  if (!error) return t("unknown error");
  const text = String(error.message || error.kind || error);
  for (const [code, human] of Object.entries(KNOWN_ERRORS)) {
    if (error.kind === code || text.includes(code)) return t(human);
  }
  if (/network|сетев|connect/i.test(text)) return t("no connection to the server");
  return text;
}

/** Открыть ссылку в браузере системы (плагин shell). */
function openExternal(url) {
  const shell = window.__TAURI__ && window.__TAURI__.shell;
  if (shell && shell.open) return shell.open(url);
  window.open(url, "_blank", "noreferrer");
  return Promise.resolve();
}

async function call(cmd, args = {}) {
  if (!invoke) throw new Error(t("the Tauri bridge is unavailable"));
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
  const units = [t("B"), t("KB"), t("MB"), t("GB")];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${I18N.number(Number(value.toFixed(value < 10 && unit > 0 ? 1 : 0)))} ${units[unit]}`;
}

// ─────────────────────────── время ───────────────────────────

function parseTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Время по формату из «Языка» (HH:mm или h:mm A). */
function clockText(date) {
  return I18N.time(date);
}

/** Дата для разделителя (формат «LL» в оригинале). */
function dateText(date) {
  return I18N.longDate(date);
}

/** Формат календаря dayjs: текст в [скобках] как есть, LT — время. */
function calendarFormat(format, date) {
  return t(format).replace(/\[([^\]]*)\]|LT/g, (match, text) => (text !== undefined ? text : clockText(date)));
}

/** Время в шапке сообщения: «Сегодня в 12:30», «Вчера в …», иначе дата. */
function calendarText(date) {
  if (!date) return "";
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  // «[Today at] LT» и «[Yesterday at] LT» — форматы dayjs из каталогов for-web
  if (sameDay(date, now)) return calendarFormat("[Today at] LT", date);
  if (sameDay(date, yesterday)) return calendarFormat("[Yesterday at] LT", date);
  return I18N.date(date) + " " + clockText(date);
}

// ─────────────────────────── файлы ───────────────────────────

// WebView2 не грузит сторонние файлы на встроенных страницах, поэтому все
// картинки, видео и аудио идут через протокол ядра `media:` (media.rs):
// Rust скачивает файл общим клиентом, держит мелкие в памяти и понимает
// Range — видео перематывается без скачивания целиком.
function mediaSrc(url) {
  if (!url) return null;
  if (url.startsWith("data:") || !convertFileSrc) return url;
  return convertFileSrc(url, "media");
}

/** То же, что mediaSrc, в виде обещания — для мест, где адрес нужен позже. */
function mediaUrl(url) {
  return Promise.resolve(mediaSrc(url));
}

/** Сторонний файл из встраивания — через прокси January, как в браузере. */
function proxiedUrl(url) {
  const proxy = state.workspace && state.workspace.proxy;
  if (!url || !proxy) return url;
  return `${proxy.replace(/\/$/, "")}/proxy?url=${encodeURIComponent(url)}`;
}

/** <img> с файлом через ядро. */
function image(url, props = {}) {
  const img = h("img", { alt: "", draggable: "false", decoding: "async", ...props });
  img.addEventListener("load", keepBottom, { once: true });
  img.addEventListener("error", () => img.classList.add("broken"), { once: true });
  img.src = mediaSrc(url) || "";
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

  if (url) {
    // буквы остаются, пока картинка не загрузится (или если её нет)
    const picture = svg("image", { x: 0, y: 0, width: 32, height: 32, preserveAspectRatio: "xMidYMid slice" });
    picture.addEventListener("load", () => letters.remove(), { once: true });
    picture.addEventListener("error", () => picture.remove(), { once: true });
    picture.setAttribute("href", mediaSrc(url));
    group.append(picture);
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

/** Встроенный набор картинок — Twemoji; остальные наборы берутся со статики Stoat. */
const BUNDLED_EMOJI_PACK = "twemoji";

async function unicodeEmojiUrl(text, pack = getOption("appearance:unicode_emoji")) {
  const codepoint = emojiCodepoint(text);
  if (!codepoint) return null;
  const key = pack + ":" + codepoint;
  const cached = unicodeCache.get(key);
  if (cached) return cached === "none" ? null : cached;
  let data = null;
  if (pack !== BUNDLED_EMOJI_PACK) data = await call("fetch_emoji", { codepoint, pack }).catch(() => null);
  if (!data) data = await spriteUrl(codepoint);
  if (!data && pack === BUNDLED_EMOJI_PACK) data = await call("fetch_emoji", { codepoint, pack }).catch(() => null);
  unicodeCache.set(key, data || "none");
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
    const button = h("button", { class: "message-link", type: "button", title: t("Jump to message") }, [
      symbol("chevron_right", 16),
      known ? known.channel.name : t("message"),
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
  if (message.attachments && message.attachments.length) return t("Sent an attachment");
  if (message.embeds && message.embeds.length) return t("Embed");
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
    name: t("Saved Notes"),
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
  return t("Unknown User");
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
    notifyIncoming(message, channel, server);
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
    title: t("Home"),
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
    // пока курсор над сервером, его канал уже грузится
    entry.button.addEventListener("pointerenter", () => prefetchHistory(landingChannel(server.id)));
    rail.append(entry.entry);
  }

  const add = railEntry({
    title: t("Create or join a server"),
    content: symbol("add", 24),
    onclick: () => addServerModal(),
  });
  add.button.classList.add("home");
  rail.append(add.entry);

  // настройки — внизу рельса и всегда на виду (ServerList.tsx)
  const bottom = el("rail-bottom");
  if (bottom) {
    const gear = railEntry({
      title: t("Settings"),
      content: symbol("settings_fill", 24),
      onclick: () => openUserSettings(),
    });
    gear.button.classList.add("home");
    gear.button.id = "btn-settings";
    bottom.replaceChildren(gear.entry);
  }
}

// ─────────────────────────── боковая панель ───────────────────────────

function menuButton({ icon, name, status, attention, onclick, oncontextmenu, onpointerenter, trailing }) {
  const text = h("span", { class: "menu-button-text" }, [
    h("span", { class: "menu-button-name", text: name }),
    status ? h("span", { class: "menu-button-status", text: status }) : null,
  ]);
  const button = h(
    "button",
    { class: "menu-button" + (attention ? " " + attention : ""), type: "button", title: name, onclick, oncontextmenu },
    [h("span", { class: "menu-button-icon" }, [icon]), text, trailing || null],
  );
  if (onpointerenter) button.addEventListener("pointerenter", onpointerenter);
  return button;
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

  header.style.backgroundImage = "";
  header.oncontextmenu = null;
  list.oncontextmenu = null;

  if (state.serverId === null) {
    header.className = "sidebar-header";
    header.append(h("span", { class: "sidebar-header-title", text: t("Conversations") }));

    if (ws.notes) {
      const notes = notesChannel();
      list.append(
        menuButton({
          icon: symbol("note_stack", 22),
          name: t("Saved Notes"),
          attention: attentionOf(notes),
          onclick: () => openChannel(notes),
        }),
      );
    }

    list.append(categoryLabel(t("Direct Messages"), null));
    if (!ws.dms.length) list.append(h("div", { class: "sidebar-note", text: t("No conversations yet") }));
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
  renderServerHeader(header, server);
  // меню пустого места списка (ServerSidebarContextMenu.tsx)
  list.oncontextmenu = (event) => {
    if (event.target.closest(".menu-button, .category")) return;
    openSidebarMenu(event, server);
  };

  if (!server.categories.length) {
    list.append(h("div", { class: "sidebar-note", text: t("No channels available") }));
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
          onpointerenter: () => prefetchHistory(channel),
        }),
      );
    }
  }
}

/** Права, с которыми открываются настройки сервера (как в оригинале). */
function canOpenServerSettings(server) {
  return [PERM.MANAGE_SERVER, PERM.MANAGE_CUSTOMISATION, PERM.MANAGE_ROLE, PERM.MANAGE_PERMISSIONS].some((bit) =>
    serverAllows(server, bit),
  );
}

/**
 * Шапка сервера (ServerSidebar.tsx): баннер фоном, значок официального или
 * проверенного сервера, имя (открывает сведения о сервере) и шестерёнка
 * настроек для тех, кому они доступны.
 */
function renderServerHeader(header, server) {
  const banner = Boolean(server.banner);
  header.className = "sidebar-header server" + (banner ? " image" : "");
  if (banner) header.style.backgroundImage = `url("${mediaSrc(server.banner)}")`;

  const badge = server.flags
    ? h("span", { class: "server-badge", title: server.flags === 1 ? t("Official Server") : t("Verified Server") }, [
        symbol(server.flags === 1 ? "check_circle_fill" : "check_circle", 14),
      ])
    : null;
  const name = h("button", { class: "server-name", type: "button", title: t("Server Info"), text: server.name });
  name.onclick = () => openServerInfo(server);
  const gear = canOpenServerSettings(server)
    ? h("button", { class: "icon-button server-gear", type: "button", title: t("Open server settings") }, [
        symbol("settings_fill", 22),
      ])
    : null;
  if (gear) gear.onclick = () => openServerSettings(server.id).catch((error) => toast(describe(error), "error"));

  header.append(h("div", { class: "server-info" }, [badge, name, gear]));
  header.oncontextmenu = (event) => openServerMenu(event, server);
}

/** Сведения о сервере (ServerInfo.tsx): описание и действия. */
async function openServerInfo(server) {
  closeMenus();
  const body = h("div", { class: "server-description" });
  if (server.description) {
    try {
      const rich = await call("rich_text", { text: server.description });
      body.append(segmentsNode({ segments: rich.segments, content: server.description, emoji: rich.emoji }));
    } catch {
      body.append(richText(server.description));
    }
  } else {
    body.append(h("span", { class: "settings-hint", text: t("This server has no description.") }));
  }
  const actions = [];
  if (canOpenServerSettings(server)) {
    actions.push({
      label: t("Settings"),
      onclick: () => openServerSettings(server.id).catch((error) => toast(describe(error), "error")),
    });
  }
  actions.push({ label: t("Edit Identity"), onclick: () => serverIdentityModal(server).catch((error) => toast(describe(error), "error")) });
  actions.push({ label: t("Close"), primary: true, onclick: closeModal });
  openModal({ title: server.name, body, actions });
}

/** Меню пустого места в списке каналов. */
function openSidebarMenu(event, server) {
  openContextMenu(event, [
    serverAllows(server, PERM.MANAGE_CHANNEL) && {
      icon: "add",
      label: t("Create channel"),
      action: () => createChannelModal(server.id),
    },
    canOpenServerSettings(server) && {
      icon: "settings",
      label: t("Open server settings"),
      action: () => openServerSettings(server.id),
    },
    { icon: "info", label: t("Server Info"), action: () => openServerInfo(server) },
  ]);
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
  if (!state.workspace) return;

  const target = landingChannel(serverId);
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

/** Состояние соединения: точка в шапке канала и полоса рамки окна (Titlebar.tsx). */
function setConnection(kind, text, retry = null) {
  el("conn").className = "connection " + kind;
  el("conn-text").textContent = text;
  if (window.setTitlebarConnection) {
    window.setTitlebarConnection({ ok: "connected", warn: "connecting", err: "disconnected" }[kind] || "disconnected", retry);
  }
}

/** Переподключиться к шлюзу по ссылке «(переподключиться)». */
async function reconnectGateway() {
  setConnection("warn", t("connecting…"));
  try {
    await call("connect_gateway");
  } catch (error) {
    setConnection("err", t("no connection"), reconnectGateway);
    toast(t("Could not connect: {0}", [describe(error)]), "error");
  }
}

// ─────────────────────────── канал ───────────────────────────

function closeChannel() {
  rememberHistory();
  state.channelId = null;
  state.messages = [];
  state.replies = [];
  state.editing = null;
  renderHeader();
  renderComposer();
  renderMembers();
  showState(null, t("Select a channel"), t("Servers are on the left, conversations are under the home icon."));
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

// ─────────────────────────── кэш истории ───────────────────────────
// Как в официальном клиенте (stoat.js держит сообщения в коллекции): канал,
// в котором уже были, открывается мгновенно из памяти, а свежая страница
// подтягивается фоном и сливается с тем, что показано.

const HISTORY_LIMIT = 12; // каналов в памяти
const HISTORY_KEEP = 100; // последних сообщений каждого из них
const historyCache = new Map(); // id канала → { messages, reachedStart }
const historyInFlight = new Map(); // id канала → Promise<страница>

function rememberHistory() {
  if (!state.channelId) return;
  const all = state.messages.filter((item) => !item.pending);
  if (!all.length) return;
  const messages = all.slice(-HISTORY_KEEP);
  historyCache.delete(state.channelId);
  historyCache.set(state.channelId, { messages, reachedStart: state.reachedStart && messages.length === all.length });
  while (historyCache.size > HISTORY_LIMIT) historyCache.delete(historyCache.keys().next().value);
}

/** Последняя страница канала; повторные запросы ждут уже идущий. */
function fetchLatest(channelId) {
  const running = historyInFlight.get(channelId);
  if (running) return running;
  const task = call("channel_history", { channelId, limit: PAGE_SIZE }).finally(() =>
    historyInFlight.delete(channelId),
  );
  historyInFlight.set(channelId, task);
  return task;
}

/** Подгрузить канал заранее (наведение на сервер), чтобы открыть его сразу. */
function prefetchHistory(channel) {
  if (!channel || channel.kind === "voice" || historyCache.has(channel.id) || channel.id === state.channelId) return;
  fetchLatest(channel.id)
    .then((page) => {
      if (historyCache.has(channel.id) || channel.id === state.channelId) return;
      const messages = markMine(page.messages || []);
      historyCache.set(channel.id, {
        messages,
        reachedStart: page.has_more === false || messages.length < PAGE_SIZE,
      });
    })
    .catch(() => {});
}

/** Свежая страница поверх кэша: старые сообщения сохраняются, новые заменяются. */
function mergeLatest(cached, fresh) {
  if (!fresh.length) return [];
  const oldest = fresh[0].id;
  return cached.filter((item) => item.id < oldest).concat(fresh);
}

/** Канал, который откроется при выборе сервера (последний или первый текстовый). */
function landingChannel(serverId) {
  const ws = state.workspace;
  if (!ws) return null;
  if (serverId === null) return ws.dms[0] || (ws.notes ? notesChannel() : null);
  const server = serverById(serverId);
  const remembered = readSetting("last." + serverId, null);
  const channels = server ? server.categories.flatMap((category) => category.channels) : [];
  return (
    channels.find((channel) => channel.id === remembered) ||
    channels.find((channel) => channel.kind === "text") ||
    channels[0] ||
    null
  );
}

async function openChannel(channel, { reload = false } = {}) {
  if (!channel) return;
  if (!reload && state.channelId === channel.id && state.messages.length) return;
  const token = ++openToken;
  rememberHistory();

  const found = findChannel(channel.id);
  if (found && found.server) {
    state.serverId = found.server.id;
    writeSetting("last." + found.server.id, channel.id);
  } else if (found) {
    state.serverId = null;
  }

  if (state.channelId !== channel.id) {
    // узлы прошлого канала не нужны: в кэше истории остаются только данные
    messageNodes = new WeakMap();
    state.replies = [];
    state.editing = null;
    inputEl.value = drafts.get(channel.id) || "";
  }
  state.channelId = channel.id;
  state.lastRead = channel.unread ? channel.last_read || null : null;
  const cached = historyCache.get(channel.id);
  state.messages = cached ? cached.messages.slice() : [];
  state.reachedStart = cached ? cached.reachedStart : false;
  state.stickToBottom = true;
  closeMenus();
  toggleEmojiPicker(false);
  renderRail();
  renderSidebar();
  renderHeader();
  renderComposer();
  renderTyping();

  // история важнее всего: запрос уходит первым, участники и эмодзи — следом
  const latest = fetchLatest(channel.id);
  if (cached) {
    renderMessages({ toBottom: true });
    focusInput();
  } else {
    showState(h("div", { class: "spinner" }));
  }
  loadMembers(state.serverId);
  if (state.serverId !== null) loadServerEmoji(state.serverId);

  try {
    const history = await latest;
    if (token !== openToken) return; // пользователь уже ушёл в другой канал
    const fresh = markMine(history.messages || []);
    const pending = state.messages.filter((item) => item.pending);
    const near = !cached || distanceFromBottom() < 120;
    if (cached && fresh.length >= PAGE_SIZE && !cached.messages.some((item) => item.id >= fresh[0].id)) {
      // пока нас не было, пришло больше страницы — старый кусок уже не стыкуется
      state.messages = fresh;
      state.reachedStart = false;
    } else if (cached) {
      state.messages = mergeLatest(state.messages.filter((item) => !item.pending), fresh);
      if (fresh.length < PAGE_SIZE) state.reachedStart = true;
    } else {
      state.messages = fresh;
      state.reachedStart = history.has_more === false || fresh.length < PAGE_SIZE;
    }
    state.messages = state.messages.concat(pending);
    state.stickToBottom = state.stickToBottom || near;
    renderMessages({ toBottom: near });
    ackVisible();
    if (!cached) focusInput();
  } catch (error) {
    if (token !== openToken) return;
    if (cached) toast(t("Could not refresh the history: {0}", [describe(error)]), "error");
    else showState(symbol("info", 32), t("Could not load the history"), describe(error));
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

/** Сообщение из закрытого канала: кэш истории остаётся актуальным. */
function updateCachedHistory(message) {
  const cached = historyCache.get(message.channel);
  if (!cached) return;
  const index = cached.messages.findIndex((item) => item.id === message.id);
  if (index >= 0) cached.messages[index] = message;
  else if (!message.edited) {
    cached.messages.push(message);
    if (cached.messages.length > HISTORY_KEEP) {
      cached.messages.splice(0, cached.messages.length - HISTORY_KEEP);
      cached.reachedStart = false;
    }
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
    toast(t("The channel is unavailable — link copied"));
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
  toast(t("The message was not found in the history"), "error");
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

    frag.append(cachedMessageNode(message, Boolean(tail)));
  });

  messagesEl.replaceChildren(frag);
  watchAutoplay(messagesEl);
  if (toBottom || state.stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  else messagesEl.scrollTop = messagesEl.scrollHeight - messagesEl.clientHeight - keep;
}

function conversationStart(channel) {
  const title = channel.kind === "text" || channel.kind === "voice" ? "#" + channel.name : channel.name;
  const text =
    channel.kind === "notes"
      ? t("This is the start of your notes.")
      : t("This is the start of your conversation.");
  return h("div", { class: "conversation-start" }, [h("h1", { text: title }), h("p", { text })]);
}

function divider(dateLabel, unread) {
  return h("div", { class: "divider" + (unread ? " unread" : "") }, [
    unread ? h("span", { class: "new", text: t("NEW") }) : null,
    dateLabel ? h("time", { text: dateLabel }) : null,
  ]);
}

// Готовые узлы сообщений: лента перерисовывается на каждое событие, и без
// повторного использования каждый раз заново создавались все картинки и
// видео. Ключ учитывает всё, от чего зависит вид сообщения; WeakMap
// отпускает узел вместе с сообщением.
let messageNodes = new WeakMap(); // сообщение → { key, node }; сбрасывается при смене канала
let messageEpoch = 0; // растёт, когда меняется общее для всех (эмодзи, участники)

function invalidateMessageNodes() {
  messageEpoch += 1;
}

function cachedMessageNode(message, tail) {
  const key = [messageEpoch, tail, state.editing === message.id, message.pending, message.failed, message.mine].join("|");
  const cached = messageNodes.get(message);
  if (cached && cached.key === key) return cached.node;
  const node = messageNode(message, tail);
  messageNodes.set(message, { key, node });
  return node;
}

// GIF и видео-GIF крутятся только на экране: за его краем декодер и кадры
// в памяти не нужны.
const autoplayObserver =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) entry.target.play().catch(() => {});
            else entry.target.pause();
          }
        },
        { rootMargin: "200px 0px" },
      )
    : null;

function watchAutoplay(root) {
  if (!autoplayObserver) {
    for (const video of root.querySelectorAll("video[data-autoplay]")) video.autoplay = true;
    return;
  }
  autoplayObserver.disconnect();
  for (const video of root.querySelectorAll("video[data-autoplay]")) autoplayObserver.observe(video);
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

  // компактный режим (Container.tsx): без аватаров, «время ник» слева от текста
  const compact = Boolean(getOption("appearance:compact_mode")) && !message.system;
  if (compact) {
    tail = true;
    classes.push("compact");
    node.className = classes.join(" ");
  }
  const info = h("div", { class: "message-info" });
  const event = message.system ? message.system_event : null;
  const inServer = Boolean(event && (findChannel(message.channel) || {}).server);
  if (message.system) {
    const { icon, danger } = event ? systemIcon(event, inServer) : { icon: "info_fill" };
    info.append(h("span", { class: "system-icon" + (danger ? " danger" : "") }, [symbol(icon, 16)]));
  } else if (compact) {
    const name = h("span", { class: "username", text: message.author, title: message.username || message.author });
    paintName(name, message.colour);
    name.onclick = (clickEvent) => openUserCard(clickEvent, message.author_id);
    name.oncontextmenu = (menuEvent) => openUserMenu(menuEvent, { id: message.author_id, name: message.author });
    info.append(
      h("span", { class: "compact-info" }, [
        h("time", { text: clockText(date), title: date ? date.toLocaleString(I18N.tag()) : "" }),
        name,
        message.edited ? symbol("edit", 16) : null,
      ]),
    );
  } else if (tail) {
    info.append(h("time", { text: message.edited ? t("(ed.)") : clockText(date), title: date ? date.toLocaleString() : "" }));
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
      message.edited ? h("span", { class: "edited", text: t("(edited)") }) : null,
    ]);
    content.append(head);
  }

  if (state.editing === message.id) {
    content.append(editBox(message));
  } else if (event && event.kind !== "text") {
    content.append(h("div", { class: "message-text system-text" }, systemEventText(event, { server: inServer, channelId: message.channel })));
  } else {
    const text = h("div", { class: "message-text" + (isJumbo(message.content) ? " jumbo" : "") });
    text.append(segmentsNode(message));
    if (text.textContent || text.childElementCount) content.append(text);
    if (tail && message.edited && !compact) content.append(h("span", { class: "edited", text: t("(edited)") }));
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

/** Значок системного сообщения (SystemMessageIcon.tsx); `danger` — красный. */
function systemIcon(event, inServer) {
  switch (event.kind) {
    case "user_added":
      return { icon: "add" };
    case "user_left":
      return inServer ? { icon: "arrow_back", danger: true } : { icon: "remove", danger: true };
    case "user_remove":
      return { icon: "close" };
    case "user_kicked":
      return { icon: "cancel", danger: true };
    case "user_banned":
      return { icon: "gpp_bad", danger: true };
    case "user_joined":
      return { icon: "arrow_forward" };
    case "channel_renamed":
      return { icon: "sell" };
    case "channel_description_changed":
      return { icon: "notes" };
    case "channel_icon_changed":
      return { icon: "image" };
    case "channel_ownership_changed":
      return { icon: "key" };
    case "message_pinned":
    case "message_unpinned":
      return { icon: "keep" };
    case "call_started":
      return { icon: "call" };
    default:
      return { icon: "info_fill" };
  }
}

/** msgid системного сообщения (SystemMessage.tsx): <0/> — участник, <1/> — второй участник или ссылка. */
function systemMessageId(event, inServer) {
  switch (event.kind) {
    case "user_added":
      return /* i18n */ "<0/> has been added by <1/>";
    case "user_remove":
      return /* i18n */ "<0/> has been removed by <1/>";
    case "user_kicked":
      return /* i18n */ "<0/> has been kicked from the server";
    case "user_banned":
      return /* i18n */ "<0/> has been banned from the server";
    case "user_joined":
      return /* i18n */ "<0/> joined the server";
    case "user_left":
      return inServer ? "<0/> left the server" : "<0/> left the group";
    case "channel_renamed":
      return /* i18n */ "<0/> updated the group name to <1>{0}</1>";
    case "channel_description_changed":
      return /* i18n */ "<0/> updated the group description";
    case "channel_icon_changed":
      return /* i18n */ "<0/> updated the group icon ";
    case "channel_ownership_changed":
      return /* i18n */ "<0/> transferred group ownership to <1/>";
    case "message_pinned":
      return /* i18n */ "<0/> pinned <1/>";
    case "message_unpinned":
      return /* i18n */ "<0/> unpinned <1/>";
    case "call_started":
      return /* i18n */ "<0/> started a call";
    default:
      return null;
  }
}

/**
 * Текст системного сообщения на языке интерфейса. `plain` — строкой (для
 * уведомлений), иначе — узлами с упоминаниями и ссылкой на сообщение.
 */
function systemEventText(event, { plain = false, server = false, channelId = null } = {}) {
  const msgid = systemMessageId(event, server);
  if (!msgid) return plain ? event.text || "" : [event.text || ""];
  // в «X добавлен Y» первым идёт участник, в остальных — тот, кто сделал
  const first = ["channel_renamed", "channel_description_changed", "channel_icon_changed", "channel_ownership_changed", "message_pinned", "message_unpinned", "call_started"].includes(event.kind)
    ? { name: event.by, id: event.by_id }
    : { name: event.user, id: event.user_id };
  const second = event.kind === "channel_ownership_changed" ? { name: event.user, id: event.user_id } : { name: event.by, id: event.by_id };
  const values = [event.text || ""];

  if (plain) {
    const link = event.message_id ? t("message") : "";
    return t(msgid, values)
      .replace(/<0\/>/g, first.name || "")
      .replace(/<1\/>/g, event.message_id ? link : second.name || "")
      .replace(/<1>([\s\S]*?)<\/1>/g, "$1")
      .trim();
  }

  const mention = (person) => {
    const node = h("span", { class: "mention", text: person.name || t("Unknown User") });
    if (person.id) node.onclick = (clickEvent) => openUserCard(clickEvent, person.id);
    return node;
  };
  const target = event.message_id && channelId
    ? linkNode(channelLink({ id: channelId }) + "/" + event.message_id, null)
    : mention(second);
  return I18N.rich(msgid, values, {
    0: mention(first),
    1: event.kind === "channel_renamed" ? (text) => h("strong", { text }) : target,
  });
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
    node.append(h("span", { class: "reply-text missing", text: t("Message not loaded") }));
    node.onclick = () => jumpToMessage({ channel: state.channelId, message: replyId });
  }
  return node;
}

// ─────────────────────────── вложения (Attachment.tsx) ───────────────────────────

const MEDIA_MIN_W = 160;
const MEDIA_MIN_H = 120;
const MEDIA_MAX = 420;

/**
 * Рамка под картинку или видео (SizedContent.tsx): мелкое растягивается до
 * 160×120, крупное ужимается до 420 по большей стороне. Размер известен
 * заранее, поэтому лента не прыгает, пока файл грузится.
 */
function sizedContent(width, height, child) {
  let w = width || MEDIA_MAX;
  let hgt = height || Math.round((MEDIA_MAX * 9) / 16);
  if (w < MEDIA_MIN_W) {
    hgt *= MEDIA_MIN_W / w;
    w = MEDIA_MIN_W;
  }
  if (hgt < MEDIA_MIN_H) {
    w *= MEDIA_MIN_H / hgt;
    hgt = MEDIA_MIN_H;
  }
  if (w > MEDIA_MAX) {
    hgt /= w / MEDIA_MAX;
    w = MEDIA_MAX;
  }
  if (hgt > MEDIA_MAX) {
    w /= hgt / MEDIA_MAX;
    hgt = MEDIA_MAX;
  }
  return h("div", { class: "sized-content", style: { width: `${w}px`, aspectRatio: `${w} / ${hgt}` } }, [child]);
}

/** Спойлер: файл с именем `spoiler_…` скрыт, пока по нему не щёлкнут. */
function spoilerWrap(node, file) {
  if (!file.name || !file.name.toLowerCase().startsWith("spoiler_")) return node;
  node.classList.add("spoiler");
  const cover = h("button", { class: "spoiler-cover", type: "button", text: t("Spoiler") });
  cover.onclick = (event) => {
    event.stopPropagation();
    node.classList.remove("spoiler");
    cover.remove();
  };
  node.append(cover);
  return node;
}

const FILE_ICONS = { image: "image", video: "movie", audio: "headphones", text: "article" };

/** Строка «значок, имя, размер, скачать» (FileInfo.tsx). */
function fileInfo(file) {
  const target = file.original || file.url;
  const download = target
    ? h("button", { class: "icon-button", type: "button", title: t("Download") }, [symbol("download", 20)])
    : null;
  if (download) download.onclick = () => downloadFile(target, file.name);
  return h("div", { class: "file-info" }, [
    symbol(FILE_ICONS[file.kind] || "description", 24),
    h("span", { class: "file-text" }, [
      h("span", { class: "file-name", text: file.name }),
      file.size ? h("span", { class: "file-size", text: humanSize(file.size) }) : null,
    ]),
    download,
  ]);
}

/** Сохранить файл в «Загрузки»: webview сам не скачивает файлы протокола media:. */
async function downloadFile(url, filename) {
  try {
    const path = await call("download_file", { url, filename: filename || "file" });
    toast(t("Saved: {0}", [path]));
  } catch (error) {
    toast(describe(error), "error");
  }
}

function attachmentsNode(files) {
  const box = h("div", { class: "attachments" });
  for (const file of files) {
    if (file.kind === "image" && file.url) {
      // превью CDN пережимает в статичную картинку — анимацию берём из оригинала
      const animated = file.content_type === "image/gif";
      const img = image(animated ? file.original || file.url : file.url, {
        class: "attachment-media",
        alt: file.name,
        title: file.name,
        loading: "lazy",
      });
      img.onclick = () =>
        openImageViewer({
          src: file.original || file.url,
          name: file.name,
          size: file.size,
          width: file.width,
          height: file.height,
          download: file.original || file.url,
        });
      box.append(spoilerWrap(sizedContent(file.width, file.height, img), file));
    } else if (file.kind === "video" && file.url) {
      const video = h("video", { class: "attachment-media", controls: true, playsinline: true, preload: "metadata" });
      video.src = mediaSrc(file.original || file.url);
      box.append(spoilerWrap(sizedContent(file.width, file.height, video), file));
    } else if (file.kind === "audio" && file.url) {
      const audio = h("audio", { controls: true, preload: "metadata" });
      audio.src = mediaSrc(file.original || file.url);
      box.append(h("div", { class: "attachment-card" }, [fileInfo(file), audio]));
    } else {
      box.append(h("div", { class: "attachment-card shrink" }, [fileInfo(file)]));
    }
  }
  return box;
}

// ─────────────────────────── встраивания (Embed.tsx) ───────────────────────────

/** Ссылка на GIF-сервис отдаётся как есть, прочее — через прокси January. */
function embedMediaUrl(url, gif) {
  return gif ? url : proxiedUrl(url);
}

function embedImage(embed, link) {
  const src = embedMediaUrl(embed.image, embed.gif);
  const img = image(src, { class: "attachment-media", loading: "lazy" });
  img.onclick = () =>
    openImageViewer({ src, width: embed.width, height: embed.height, link: link || embed.url || embed.image });
  return sizedContent(embed.width, embed.height, img);
}

function embedVideo(embed) {
  const src = embedMediaUrl(embed.video, embed.gif);
  const video = h("video", { class: "attachment-media", playsinline: true });
  if (embed.gif) {
    // GIF-видео ведёт себя как картинка: само крутится, звук выключен
    video.loop = true;
    video.muted = true;
    video.dataset.autoplay = "";
    video.onclick = () =>
      openImageViewer({ src, width: embed.width, height: embed.height, gif: true, link: embed.url || embed.video });
  } else {
    video.controls = true;
    video.preload = "metadata";
  }
  video.src = mediaSrc(src);
  return sizedContent(embed.width, embed.height, video);
}

function embedNode(embed) {
  if (embed.kind === "image" && embed.image) return embedImage(embed);
  if (embed.video && (embed.kind === "video" || embed.gif)) return embedVideo(embed);
  if (embed.gif && embed.image) return embedImage(embed);

  const box = h("div", { class: "embed" });
  if (embed.colour) box.style.borderInlineStartColor = embed.colour;
  if (embed.site || embed.icon) {
    box.append(
      h("span", { class: "embed-site" }, [
        embed.icon ? image(embedMediaUrl(embed.icon, false), { class: "embed-icon", loading: "lazy" }) : null,
        embed.site ? h("span", { text: embed.site }) : null,
      ]),
    );
  }
  if (embed.title) {
    box.append(
      embed.url
        ? h("a", { class: "embed-title", href: embed.url, target: "_blank", rel: "noreferrer", text: embed.title })
        : h("span", { class: "embed-title", text: embed.title }),
    );
  }
  if (embed.description) box.append(h("div", { class: "embed-text" }, [richText(embed.description)]));
  if (embed.image) {
    const src = embedMediaUrl(embed.image, false);
    const img = image(src, { class: "embed-media", loading: "lazy" });
    if (embed.width && embed.height) img.style.aspectRatio = `${embed.width} / ${embed.height}`;
    img.onclick = () => openImageViewer({ src, width: embed.width, height: embed.height, link: embed.url });
    box.append(img);
  }
  return box;
}

// ─────────────────────────── просмотр картинок (ImageViewer.tsx) ───────────────────────────

const VIEWER_MIN = 0.1;
const VIEWER_MAX = 5;
let viewerClose = null;

function viewerOpen() {
  return Boolean(viewerClose);
}

function closeImageViewer() {
  if (viewerClose) viewerClose();
}

/**
 * Полноэкранный просмотр: затемнение, сверху имя и размер файла, кнопки
 * масштаба, скачивания или открытия в браузере и закрытия. Колесо мыши
 * меняет масштаб, перетаскивание двигает картинку; щелчок мимо и Esc
 * закрывают окно.
 */
function openImageViewer({ src, name = null, size = 0, width = null, height = null, gif = false, download = null, link = null }) {
  closeImageViewer();
  closeMenus();

  const media = gif
    ? h("video", { class: "viewer-media", playsinline: true })
    : h("img", { class: "viewer-media", alt: name || "", draggable: "false" });
  if (gif) {
    media.loop = true;
    media.muted = true;
    media.autoplay = true;
  }
  media.src = mediaSrc(src);
  if (width && height) media.style.aspectRatio = `${width} / ${height}`;

  let scale = 1;
  let x = 0;
  let y = 0;
  const apply = () => {
    media.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };
  const zoom = (next) => {
    scale = Math.min(VIEWER_MAX, Math.max(VIEWER_MIN, next));
    apply();
  };

  const button = (icon, title, action) => {
    const node = h("button", { class: "icon-button", type: "button", title }, [symbol(icon, 22)]);
    node.onclick = (event) => {
      event.stopPropagation();
      action();
    };
    return node;
  };

  const info = name
    ? h("div", { class: "viewer-card" }, [
        h("div", { class: "viewer-info" }, [
          h("span", { class: "viewer-title", text: name }),
          size ? h("span", { class: "viewer-size", text: humanSize(size) }) : null,
        ]),
      ])
    : h("div");
  const actions = h("div", { class: "viewer-card" }, [
    button("zoom_out", t("Zoom out"), () => zoom(scale / 1.3)),
    button("zoom_in", t("Zoom in"), () => zoom(scale * 1.3)),
    download ? button("download", t("Download"), () => downloadFile(download, name)) : null,
    !download && link
      ? h("a", { class: "icon-button", href: link, target: "_blank", rel: "noreferrer", title: t("Open in browser") }, [
          symbol("open_in_new", 22),
        ])
      : null,
    button("close", t("Close"), () => closeImageViewer()),
  ]);
  for (const card of [info, actions]) card.addEventListener("click", (event) => event.stopPropagation());

  const scrim = h("div", { class: "viewer-scrim", id: "image-viewer", role: "dialog", "aria-modal": "true" }, [
    h("div", { class: "viewer-bar" }, [info, actions]),
    h("div", { class: "viewer-stage" }, [media]),
  ]);
  scrim.onclick = () => closeImageViewer();

  // перетаскивание
  let drag = null;
  media.addEventListener("click", (event) => event.stopPropagation());
  media.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { id: event.pointerId, startX: event.clientX - x, startY: event.clientY - y };
    media.setPointerCapture(event.pointerId);
    media.classList.add("dragging");
  });
  media.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    x = event.clientX - drag.startX;
    y = event.clientY - drag.startY;
    apply();
  });
  const release = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    media.classList.remove("dragging");
  };
  media.addEventListener("pointerup", release);
  media.addEventListener("pointercancel", release);
  media.addEventListener("dblclick", () => {
    scale = 1;
    x = 0;
    y = 0;
    apply();
  });
  scrim.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      zoom(scale - event.deltaY / 1000);
    },
    { passive: false },
  );

  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeImageViewer();
  };
  document.addEventListener("keydown", onKey, true);

  viewerClose = () => {
    viewerClose = null;
    document.removeEventListener("keydown", onKey, true);
    if (gif) media.pause();
    scrim.classList.remove("open");
    setTimeout(() => scrim.remove(), 200);
  };

  document.body.append(scrim);
  requestAnimationFrame(() => scrim.classList.add("open"));
}

/** Панель действий при наведении (MessageToolbar.tsx). */
function messageToolbar(message, node) {
  const bar = h("div", { class: "message-toolbar" });
  const tool = (icon, title, action, danger) =>
    h("button", { type: "button", title, class: danger ? "danger" : null, onclick: action }, [symbol(icon, 20)]);

  bar.append(tool("reply", t("Reply"), () => addReply(message)));
  if (message.mine) {
    bar.append(tool("edit", t("Edit message"), () => startEdit(message)));
    bar.append(tool("delete", t("Delete (Shift — without asking)"), (event) => removeMessage(message, event.shiftKey), true));
  }
  bar.append(
    tool("more_vert", t("More"), (event) => {
      node.classList.add("toolbar-open");
      openMessageMenu(event, message, () => node.classList.remove("toolbar-open"));
    }),
  );
  return bar;
}

function failedHint(message) {
  return h("div", { class: "edit-hint" }, [
    t("Failed to send") + ". ",
    h("button", { type: "button", text: t("Retry sending"), onclick: () => retrySend(message) }),
    " · ",
    h("button", {
      type: "button",
      text: t("Cancel message"),
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
      ...I18N.rich("escape to <0>cancel</0> • enter to <1>save</1>", null, {
        0: (text) => h("button", { type: "button", text, onclick: stopEdit }),
        1: (text) => h("button", { type: "button", text, onclick: () => saveEdit(message, area.value) }),
      }),
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
    toast(t("Could not edit: {0}", [describe(error)]), "error");
  }
}

/** Удалить сообщение; без Shift — после подтверждения (DeleteMessage.tsx). */
async function removeMessage(message, skipConfirm) {
  const run = async () => {
    await call("delete_message", { channelId: message.channel, messageId: message.id });
    state.messages = state.messages.filter((item) => item.id !== message.id);
    if (state.editing === message.id) state.editing = null;
    renderMessages();
  };
  if (skipConfirm) {
    try {
      await run();
    } catch (error) {
      toast(t("Could not delete: {0}", [describe(error)]), "error");
    }
    return;
  }
  confirmModal({ title: t("Delete message"), text: t("Are you sure you want to delete this?"), confirm: t("Delete"), run });
}

function replaceMessage(message) {
  const index = state.messages.findIndex((item) => item.id === message.id);
  if (index >= 0) state.messages[index] = message;
  return index >= 0;
}

// ─────────────────────────── поле ввода ───────────────────────────

const drafts = new Map(); // id канала → недописанный текст

function placeholderFor(channel) {
  if (channel.kind === "notes") return t("Save to your notes");
  return t("Message {0}", [channel.name]);
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
    toast(t("You can reply to at most five messages at once"));
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
      h("span", { class: "reply-preview-to", text: t("Replying to") }),
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
            title: t("Mention the author"),
            onclick: () => {
              reply.mention = !reply.mention;
              renderReplies();
            },
          },
          [symbol("alternate_email", 16), reply.mention ? t("On") : t("Off")],
        ),
      );
    }
    preview.append(
      h(
        "button",
        {
          type: "button",
          class: "reply-dismiss",
          title: t("Cancel reply"),
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
    toast(t("The message is longer than 2000 characters"), "error");
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
    toast(t("Failed to send") + ": " + describe(error), "error");
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
      ? t("{0} is typing…", [names[0]])
      : users.length <= 3
        ? t("{0} and {1} are typing…", [names.slice(0, -1).join(", "), names[names.length - 1]])
        : t("Several people are typing…");
}

// ─────────────────────────── участники ───────────────────────────

const membersCache = new Map(); // id сервера → участники

/** Сколько серверов держат список участников в памяти интерфейса. */
const MEMBERS_KEEP = 6;

async function loadMembers(serverId) {
  renderMembers();
  if (serverId === null) return;
  // присутствие участников приходит только по подписке; ядро само решает, пора ли её продлить
  call("subscribe_server", { serverId }).catch((error) => console.warn("подписка на сервер:", error));
  if (membersCache.has(serverId)) {
    // свежий сервер — в конец очереди на выгрузку
    const list = membersCache.get(serverId);
    membersCache.delete(serverId);
    membersCache.set(serverId, list);
    return;
  }
  membersCache.set(serverId, null);
  while (membersCache.size > MEMBERS_KEEP) membersCache.delete(membersCache.keys().next().value);
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
// Список участников рисуется окном (как VirtualContainer в оригинале): на
// странице только видимые строки. Раньше строились все — на большом сервере
// это тысячи аватаров, и каждое событие присутствия собирало их заново.
const MEMBER_ROW_HEIGHT = 42;
const MEMBER_GROUP_HEIGHT = 48;
const MEMBER_OVERSCAN = 8; // строк сверху и снизу про запас
const memberRowCache = new Map(); // id участника → { key, node }
let memberView = null; // { list, items, height }
let memberFrame = 0;

function renderMembers() {
  const panel = el("members");
  const visible = state.serverId !== null && state.showMembers && currentChannel();
  panel.classList.toggle("hidden", !visible);
  if (!visible) {
    memberView = null;
    panel.textContent = "";
    memberRowCache.clear();
    return;
  }

  const members = membersCache.get(state.serverId);
  if (!members) {
    memberView = null;
    panel.replaceChildren(h("div", { class: "member-title", text: t("Loading members…") }));
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

  const byName = (a, b) => a.name.localeCompare(b.name);
  const sections = [...groups.values()]
    .sort((a, b) => a.role.rank - b.role.rank)
    .map((group) => [group.role.name, group.list]);
  sections.push([t("Online"), online], [t("Offline"), offline]);

  // плоский список с заранее известными высотами строк
  const items = [];
  let top = 0;
  for (const [title, list] of sections) {
    if (!list.length) continue;
    items.push({ kind: "group", title: `${title} – ${list.length}`, top, height: MEMBER_GROUP_HEIGHT });
    top += MEMBER_GROUP_HEIGHT;
    for (const member of list.sort(byName)) {
      items.push({ kind: "member", member, top, height: MEMBER_ROW_HEIGHT });
      top += MEMBER_ROW_HEIGHT;
    }
  }

  const sameServer = memberView && memberView.serverId === state.serverId;
  const scroll = sameServer ? panel.scrollTop : 0;
  const list = h("div", { class: "member-list", style: { height: `${top}px` } });
  panel.replaceChildren(
    h("div", { class: "member-title" }, [h("span", { class: "connection-dot" }), t("{0} online", [onlineCount])]),
    list,
  );
  panel.scrollTop = scroll;
  if (!sameServer) memberRowCache.clear();
  memberView = { serverId: state.serverId, list, items };
  paintMemberWindow();
}

/** Первая строка, нижний край которой ниже `offset` (двоичный поиск). */
function firstMemberItem(items, offset) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (items[middle].top + items[middle].height <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Дорисовать строки, попавшие в видимую часть списка. */
function paintMemberWindow() {
  memberFrame = 0;
  if (!memberView) return;
  const panel = el("members");
  const { list, items } = memberView;
  const viewport = panel.clientHeight || 800;
  const offset = panel.scrollTop - list.offsetTop;
  const reserve = MEMBER_OVERSCAN * MEMBER_ROW_HEIGHT;
  const from = firstMemberItem(items, offset - reserve);
  const nodes = [];
  const shown = new Set();
  for (let index = from; index < items.length && items[index].top < offset + viewport + reserve; index += 1) {
    const item = items[index];
    const node = item.kind === "group" ? h("div", { class: "member-group", text: item.title }) : memberRowNode(item.member);
    if (item.kind === "member") shown.add(item.member.id);
    node.style.transform = `translateY(${item.top}px)`;
    nodes.push(node);
  }
  list.replaceChildren(...nodes);
  // строки, ушедшие из окна, не держим
  for (const id of memberRowCache.keys()) if (!shown.has(id)) memberRowCache.delete(id);
}

/** Строка участника; неизменная строка берётся готовой, чтобы аватар не грузился снова. */
function memberRowNode(member) {
  const key = [member.name, member.colour, member.avatar, member.presence, member.online, member.status].join("\u0001");
  const cached = memberRowCache.get(member.id);
  if (cached && cached.key === key) return cached.node;
  const node = memberRow(member);
  memberRowCache.set(member.id, { key, node });
  return node;
}

function scheduleMemberWindow() {
  if (!memberFrame) memberFrame = requestAnimationFrame(paintMemberWindow);
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

/**
 * Эмодзи всех серверов сразу — из `Ready` и событий шлюза (`emoji_index`).
 * Так `:имя:` и картинки с чужих серверов видны с первого открытия канала,
 * а не после того, как побываешь на сервере-владельце.
 */
async function loadEmojiIndex() {
  let index;
  try {
    index = (await call("emoji_index")) || {};
  } catch (error) {
    console.warn("не удалось получить эмодзи:", error);
    return;
  }
  const known = Object.keys(index);
  if (!known.length && !serverEmoji.size) return; // `Ready` ещё не пришёл
  const servers = state.workspace ? state.workspace.servers.map((server) => server.id) : [];
  for (const serverId of new Set([...servers, ...known])) {
    const list = index[serverId] || [];
    serverEmoji.set(serverId, list);
    for (const emoji of list) customEmojiIndex.set(emoji.id, { name: emoji.name, server: serverId });
  }
  invalidateMessageNodes();
  if (state.messages.length) renderMessages();
  if (!el("emoji-picker").classList.contains("hidden")) renderEmojiPicker();
}

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
  if (emojiObserver) emojiObserver.disconnect();
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
      list.append(h("div", { class: "emoji-note", text: t("No results") }));
      renderEmojiPreview(null);
      return;
    }
    list.append(h("div", { class: "emoji-section", text: t("Results") }));
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

  list.append(h("div", { class: "emoji-section", text: t("Emojis") }));
  for (const emoji of unicodeEmojis()) list.append(emojiButton({ kind: "unicode", emoji }));
  renderEmojiPreview(
    servers.length
      ? { kind: "server", emoji: serverEmoji.get(servers[0].id)[0], server: servers[0] }
      : { kind: "unicode", emoji: unicodeEmojis()[0] },
  );
}

// В панели тысячи эмодзи; картинка грузится, только когда кнопка видна.
const emojiObserver =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            emojiObserver.unobserve(entry.target);
            fillEmojiSlot(entry.target);
          }
        },
        { root: el("emoji-scroll"), rootMargin: "120px 0px" },
      )
    : null;
const emojiSlotItems = new WeakMap(); // заготовка → эмодзи

function fillEmojiSlot(slot) {
  const item = emojiSlotItems.get(slot);
  if (!item || !slot.isConnected) return;
  if (item.kind === "server") {
    if (item.emoji.url) slot.replaceWith(image(item.emoji.url, { class: "emoji", alt: item.emoji.name }));
    return;
  }
  spriteUrl(item.emoji.code).then((data) => {
    if (data && slot.isConnected) slot.replaceWith(h("img", { class: "emoji", src: data, alt: item.emoji.text }));
  });
}

function emojiVisual(item, lazy = false) {
  const slot = h("span", { class: "emoji-slot", text: item.kind === "server" ? "" : item.emoji.text });
  emojiSlotItems.set(slot, item);
  if (lazy && emojiObserver) emojiObserver.observe(slot);
  else queueMicrotask(() => fillEmojiSlot(slot)); // когда заготовка уже на странице
  return slot;
}

function emojiButton(item) {
  const title = item.kind === "server" ? ":" + item.emoji.name + ":" : item.emoji.text;
  const button = h("button", { type: "button", class: "emoji-item", title }, [emojiVisual(item, true)]);
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
  el("emoji-preview-from").textContent = item.kind === "server" ? t("from {0}", [item.server.name]) : t("Unicode");
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
  if (!open) {
    // закрытая панель не держит тысячи кнопок и картинок
    if (emojiObserver) emojiObserver.disconnect();
    el("emoji-list").textContent = "";
    el("emoji-servers").textContent = "";
    return;
  }
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

function menusOpen() {
  return ["ctx-menu", "account-menu", "user-card"].some((id) => !el(id).classList.contains("hidden"));
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
          class: "menu-item" + (item.danger ? " danger" : "") + (item.selected ? " selected" : ""),
          role: item.selected === undefined ? "menuitem" : "menuitemradio",
          "aria-checked": item.selected === undefined ? null : String(item.selected),
          onclick: async (clickEvent) => {
            closeMenus();
            try {
              await item.action(clickEvent);
            } catch (error) {
              toast(describe(error), "error");
            }
          },
        },
        item.node ? [item.node] : [item.icon ? symbol(item.icon, 20) : null, item.label],
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
      !message.system && { icon: "reply", label: t("Reply"), action: () => addReply(message) },
      message.mine && !message.system && { icon: "edit", label: t("Edit message"), action: () => startEdit(message) },
      message.content && { icon: "content_copy", label: t("Copy text"), action: () => copyText(message.content) },
      {
        icon: "link",
        label: t("Copy message link"),
        action: async () => {
          await copyText(await messageLink(message));
          toast(t("Link copied"));
        },
      },
      message.mine && { divider: true },
      message.mine && {
        icon: "delete",
        label: t("Delete message"),
        danger: true,
        action: (clickEvent) => removeMessage(message, clickEvent.shiftKey),
      },
      ...developerItems("message", message.id, t("Copy message ID")),
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
    { icon: "person", label: t("Profile"), action: () => openProfileModal(user.id, serverId) },
    !me && { icon: "chat", label: t("Message"), action: () => openDirectMessage(user.id) },
    canWrite && {
      icon: "alternate_email",
      label: t("Mention"),
      action: () => insertText(`<@${user.id}>`),
    },
    { divider: true },
    !me &&
      user.relationship === "Friend" && {
        icon: "person_remove",
        label: t("Remove friend"),
        danger: true,
        action: relate("remove"),
      },
    !me &&
      user.relationship !== "Blocked" && {
        icon: "block",
        label: t("Block user"),
        danger: true,
        action: relate("block"),
      },
    !me && user.relationship === "Blocked" && { icon: "block", label: t("Unblock user"), action: relate("unblock") },
    !me && { divider: true },
    { icon: "content_copy", label: t("Copy username"), action: () => copyText(user.username || user.name) },
    ...developerItems("user", user.id, t("Copy user ID")),
  ]);
}

function openChannelMenu(event, channel) {
  openContextMenu(event, [
    channel.unread &&
      channel.last_message_id && {
        icon: "mark_chat_read",
        label: t("Mark as read"),
        action: () => ackChannel(channel.id, channel.last_message_id),
      },
    ...channelAdminItems(channel),
    { icon: "content_copy", label: t("Copy name"), action: () => copyText(channel.name) },
    { icon: "link", label: t("Copy link"), action: () => copyText(channelLink(channel)) },
    ...developerItems("channel", channel.id, t("Copy channel ID")),
  ]);
}

/**
 * Пункты для разработчиков в конце меню (настройки «Расширенные»):
 * «Панель администратора» и «Скопировать ID».
 */
function developerItems(kind, id, copyLabel) {
  const items = [];
  if (getOption("advanced:admin_panel")) {
    items.push({
      icon: "admin_panel_settings",
      label: t("Admin Panel"),
      action: () => openExternal(`https://admin.stoatinternal.com/panel/inspect/${kind}/${id}`),
    });
  }
  if (getOption("advanced:copy_id")) items.push({ icon: "fingerprint", label: copyLabel, action: () => copyText(id) });
  return items.length ? [{ divider: true }, ...items] : [];
}

/** Ссылка на канал в веб-клиенте. */
function channelLink(channel) {
  const found = findChannel(channel.id);
  const server = found && found.server && found.server.id;
  return server ? `https://stoat.chat/server/${server}/channel/${channel.id}` : `https://stoat.chat/channel/${channel.id}`;
}

/** Права на сервере канала (у личных каналов — пусто). */
function serverAllows(server, bit) {
  return Boolean(server) && (server.owner || hasBit(server.permissions, bit));
}

function channelAdminItems(channel) {
  const found = findChannel(channel.id);
  const server = found && found.server && found.server.id ? serverById(found.server.id) : null;
  if (!server) return [];
  const items = [];
  if (serverAllows(server, PERM.INVITE)) {
    items.push({ icon: "person_add", label: t("Create invite"), action: () => showInvite(channel.id) });
  }
  if (serverAllows(server, PERM.MANAGE_CHANNEL)) {
    items.push(
      { icon: "edit", label: t("Open channel settings"), action: () => editChannelModal(channel) },
      { icon: "delete", label: t("Delete channel"), danger: true, action: () => deleteChannelModal(channel) },
    );
  }
  return items.length ? [...items, { divider: true }] : [];
}

function openServerMenu(event, server) {
  const unread = server.categories
    .flatMap((category) => category.channels)
    .filter((channel) => channel.unread && channel.last_message_id);
  openContextMenu(event, [
    unread.length && {
      icon: "mark_chat_read",
      label: t("Mark as read"),
      action: () => unread.forEach((channel) => ackChannel(channel.id, channel.last_message_id)),
    },
    { divider: true },
    firstInviteChannel(server) && {
      icon: "person_add",
      label: t("Create invite"),
      action: () => showInvite(firstInviteChannel(server).id),
    },
    serverAllows(server, PERM.MANAGE_CHANNEL) && {
      icon: "add",
      label: t("Create channel"),
      action: () => createChannelModal(server.id),
    },
    { icon: "edit", label: t("Edit your identity"), action: () => serverIdentityModal(server) },
    canOpenServerSettings(server) && { icon: "settings", label: t("Open server settings"), action: () => openServerSettings(server.id) },
    { divider: true },
    { icon: "content_copy", label: t("Copy name"), action: () => copyText(server.name) },
    { divider: true },
    {
      icon: server.owner ? "delete" : "logout",
      label: server.owner ? t("Delete Server") : t("Leave server"),
      danger: true,
      action: () => confirmLeaveServer(server),
    },
    ...developerItems("server", server.id, t("Copy server ID")),
  ]);
}

/** Канал для приглашения: открытый, иначе первый текстовый. */
function firstInviteChannel(server) {
  if (!serverAllows(server, PERM.INVITE)) return null;
  const channels = server.categories.flatMap((category) => category.channels).filter((channel) => !channel.voice);
  return channels.find((channel) => channel.id === state.channelId) || channels[0] || null;
}

async function logout() {
  try {
    await call("logout");
  } catch {
    /* локально выходим в любом случае */
  }
  // сессия завершена на сервере — запомненный токен больше не годится
  try {
    localStorage.removeItem("stoat.session.token");
    localStorage.removeItem("stoat.session.id");
  } catch {
    /* хранилище недоступно */
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
    loadEmojiIndex();

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
    updateCachedHistory(message);
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
  trimLive();
  setTyping(message.channel, message.author_id, false);
  noteIncoming(message);
  renderMessages();
  ackVisible();
}

/** Сколько сообщений держит лента, пока читаешь внизу (старые догружаются при прокрутке). */
const LIVE_KEEP = 150;

/** Срезать начало ленты, если читатель внизу, а сообщений накопилось много. */
function trimLive() {
  if (!state.stickToBottom || state.messages.length <= LIVE_KEEP + PAGE_SIZE) return false;
  state.messages = state.messages.slice(-LIVE_KEEP);
  state.reachedStart = false;
  return true;
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
      setConnection("warn", t("authorising…"));
      break;
    case "Ready":
      setConnection("ok", t("connected"));
      membersCache.clear();
      refreshWorkspace({ reloadChannel: true }).catch((error) => toast(describe(error), "error"));
      break;
    case "Logout":
      setConnection("err", t("session ended"));
      toast(t("The session has ended, please log in again"), "error");
      break;
    case "Error": {
      const kind = event.kind || "";
      if (["InvalidSession", "SessionExpired"].includes(kind)) {
        setConnection("err", t("session ended"));
        toast(t("The session has ended, please log in again"), "error");
      } else {
        console.warn("шлюз:", event);
      }
      break;
    }
    case "MessageDelete":
      if (historyCache.has(event.channel)) {
        const cached = historyCache.get(event.channel);
        cached.messages = cached.messages.filter((item) => item.id !== event.id);
      }
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
    case "EmojiCreate":
    case "EmojiDelete":
      loadEmojiIndex();
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

  // перерисовывается только то, что задето, и не чаще раза за кадр
  for (const [serverId, members] of membersCache) {
    const member = (members || []).find((item) => item.id === event.id);
    if (member) {
      patch(member);
      if (serverId === state.serverId) scheduleRender(renderMembers);
    }
  }
  const ws = state.workspace;
  for (const dm of ws ? ws.dms : []) {
    if (dm.recipient !== event.id) continue;
    const view = { online: dm.presence !== "Offline", presence: dm.presence, status: dm.description };
    patch(view);
    dm.presence = view.presence;
    dm.description = view.status;
    if (state.serverId === null) scheduleRender(renderSidebar);
    if (dm.unread) scheduleRender(renderRail);
  }
  if (state.me && state.me.id === event.id) {
    // себе показываем выбранное присутствие (и «невидимку»), а не то, что видят другие
    if (status && status.presence) state.me.presence = status.presence;
    if (clear.includes("StatusPresence")) state.me.presence = "Online";
    if (status && "text" in status) state.me.status = status.text || null;
    if (clear.includes("StatusText")) state.me.status = null;
    scheduleRender(renderRail);
  }
}

// События шлюза приходят пачками; перерисовки собираются и выполняются раз за кадр.
const renderQueue = new Set();
let renderFrame = 0;

function scheduleRender(render) {
  renderQueue.add(render);
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    const jobs = [...renderQueue];
    renderQueue.clear();
    for (const job of jobs) job();
  });
}

// ─────────────────────────── запуск ───────────────────────────

function bindUi() {
  setIcon(el("btn-emoji"), "mood", 24);
  setIcon(el("btn-send"), "send", 24);
  setIcon(el("btn-members"), "group", 24);

  messagesEl.addEventListener("scroll", () => {
    state.stickToBottom = distanceFromBottom() < 40;
    if (messagesEl.scrollTop < 400) loadOlder();
    if (state.stickToBottom) {
      ackVisible();
      // вернулись вниз после долгого чтения истории — старое снимаем со страницы
      if (trimLive()) renderMessages({ toBottom: true });
    }
  });
  el("members").addEventListener("scroll", scheduleMemberWindow, { passive: true });
  window.addEventListener("resize", scheduleMemberWindow);

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
    else if (menusOpen()) closeMenus();
    else if (settingsOpen()) closeSettings();
  });
  window.addEventListener("resize", closeMenus);
  window.addEventListener("focus", ackVisible);
}

async function boot() {
  if (!invoke) {
    document.body.replaceChildren(
      h("div", { class: "messages-state" }, [
        h("h2", { text: t("No connection to the application core") }),
        h("div", { text: t("This is a build error, not a problem with your data.") }),
      ]),
    );
    return;
  }
  await I18N.ready;
  syncTrayLabels();
  window.addEventListener("arachnid-locale", relocalize);
  window.addEventListener("arachnid-options", (event) => {
    const key = event.detail && event.detail.key;
    if (key === "appearance:compact_mode" || key === "appearance:unicode_emoji") renderMessages();
  });
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

  await reconnectGateway();

  try {
    await refreshWorkspace();
  } catch (error) {
    showState(symbol("info", 32), t("Could not load data"), describe(error));
  }
}

/** Пункты меню трея на языке интерфейса (как в Stoat for Desktop). */
function syncTrayLabels() {
  call("set_tray_labels", {
    labels: { version: t("Version"), show: t("Show App"), hide: t("Hide App"), quit: t("Quit App") },
  }).catch((error) => console.warn("меню трея:", error));
}

/** Язык сменился: перерисовать всё, что построено из строк интерфейса. */
function relocalize() {
  syncTrayLabels();
  renderRail();
  renderSidebar();
  renderHeader();
  renderComposer();
  renderReplies();
  renderTyping();
  renderMembers();
  renderMessages();
  if (settingsOpen()) renderSettings();
}

boot();
