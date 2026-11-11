// Интерфейс клиента по образцу официального Stoat (for-web).
// Всё состояние приходит из Rust, здесь только отрисовка и ввод.
"use strict";

const bridge = window.__TAURI__;
const invoke = bridge && bridge.core && bridge.core.invoke;
const listen = bridge && bridge.event && bridge.event.listen;
const convertFileSrc = bridge && bridge.core && bridge.core.convertFileSrc;

const ICONS = window.STOAT_ICONS || {};
const MD_ICONS = window.STOAT_MD_ICONS || {};
const SVG_NS = "http://www.w3.org/2000/svg";
const el = (id) => document.getElementById(id);

const messagesEl = el("messages");
const inputEl = el("input");

/** Сколько сообщений просить за раз (как браузерный клиент). */
const PAGE_SIZE = 50;
const NEARBY_LIMIT = 50; // страница вокруг сообщения при переходе к нему
const DISPLAY_LIMIT = 150; // столько сообщений держит лента при чтении истории
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
  ackHeld: null, // канал, помеченный непрочитанным: не читать его автоматически
  replies: [], // [{ message, mention }]
  editing: null, // id сообщения, которое правится на месте
  stickToBottom: true,
  showMembers: readSetting("members", true),
  collapsed: new Set(readSetting("collapsed", [])),
  typing: new Map(), // id канала → Map(id пользователя → таймер)
  page: null, // раздел вместо канала: "home" | "friends" | "discover"
  atEnd: true, // лента доходит до последнего сообщения (не «прыжок» в историю)
  loadingNewer: false,
  side: { state: "default" }, // правая панель: участники | поиск | закреплённые
  sidebarShown: readSetting("sidebar", true), // список каналов (PRIMARY_SIDEBAR)
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

/**
 * Иконка по имени: Material Symbols (как <Symbol> в официальном клиенте),
 * с приставкой `md:` — Material Icons (ими там нарисованы меню и кнопки),
 * с приставкой `bx:` — Boxicons.
 */
function symbol(name, size = 20) {
  const material = name.startsWith("md:")
    ? MD_ICONS[name.slice(3)]
    : name.startsWith("bx:")
      ? (window.STOAT_BRANDS || {})[name.slice(3)]
      : null;
  const node = svg("svg", { viewBox: material ? "0 0 24 24" : "0 -960 960 960", class: "symbol", "aria-hidden": "true" });
  node.style.setProperty("--symbol-size", size + "px");
  for (const d of material || [ICONS[name] || ""]) node.append(svg("path", { d }));
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
  AlreadyPinned: /* i18n */ "This message is already pinned.",
  CannotReportYourself: /* i18n */ "You cannot report yourself.",
  NoEffect: /* i18n */ "That action had no effect.",
  NoReasonProvided: /* i18n */ "Select a reason, and for «Other» describe the problem",
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
  if (sameDay(date, now)) return calendarFormat(/* i18n */ "[Today at] LT", date);
  if (sameDay(date, yesterday)) return calendarFormat(/* i18n */ "[Yesterday at] LT", date);
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
function avatar({ url, name, size = 32, presence = null, badge = null, shape = "circle" }) {
  const node = svg("svg", { viewBox: "0 0 32 32", width: size, height: size, class: "avatar" + (shape === "circle" ? "" : " " + shape) });
  const mask =
    shape === "rounded-square"
      ? "mask-rounded"
      : presence && badge
        ? "mask-status-badge"
        : presence
          ? "mask-status"
          : badge
            ? "mask-badge"
            : "mask-avatar";
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
// Разметка рисуется в markdown.js (тот же конвейер, что в браузерном клиенте).

function customEmojiUrl(id) {
  const cdn = state.workspace && state.workspace.cdn;
  return cdn ? `${cdn.replace(/\/$/, "")}/emojis/${id}` : null;
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
    // в «Заметках» можно всё (GrantAllSafe)
    permissions: 2 ** 52 - 1,
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
  const members = membersCache.get(memberKey()) || [];
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

/**
 * Отметки, которые этот клиент сам отправил на сервер. Сервер присылает их
 * обратно (`ChannelAck`) с задержкой, когда отметка здесь уже ушла дальше;
 * свою отметку назад не двигаем — назад её двигает только другой клиент.
 */
const ownAcks = {
  sent: new Map(), // "канал:сообщение" → когда отправлено
  note(channelId, messageId) {
    const now = Date.now();
    for (const [key, at] of this.sent) if (now - at > 60_000) this.sent.delete(key);
    this.sent.set(channelId + ":" + messageId, now);
  },
  /** Своя отметка: забыть её и сказать, что событие можно пропустить. */
  take(channelId, messageId) {
    return this.sent.delete(channelId + ":" + messageId);
  },
};

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
      ownAcks.note(channelId, messageId);
      call("ack_channel", { channelId, messageId }).catch((error) =>
        console.warn("не удалось отметить канал прочитанным:", error),
      );
    }, 500),
  );
}

/** Прочитать открытый канал, если пользователь действительно видит его конец. */
function ackVisible() {
  const channel = currentChannel();
  if (!channel || !document.hasFocus() || !state.stickToBottom || !state.atEnd) return;
  // помечен непрочитанным вручную: ждём, пока пользователь сам вернётся к концу
  if (state.ackHeld === channel.id) return;
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
    selected: state.serverId === null && state.page !== "discover",
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

  // «Найти новые серверы» — только на официальном инстансе (isStoat)
  const explore = railEntry({
    selected: state.page === "discover",
    title: t("Find new servers to join"),
    content: symbol("md:filled:explore", 24),
    onclick: () => openDiscover(),
  });
  explore.button.classList.add("home");
  explore.entry.classList.add("hidden");
  rail.append(explore.entry);
  officialInstance().then((official) => explore.entry.classList.toggle("hidden", !official));

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
    // в именах каналов бывают эмодзи (TextWithEmoji)
    h("span", { class: "menu-button-name" }, emojiText(name)),
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
  const names = { text: "grid_3x3", voice: "headset_mic", dm: "alternate_email", group: "group", notes: "note_stack" };
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
    renderHomeSidebar(header, list);
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

/**
 * «Беседы» (HomeSidebar.tsx): домашняя страница, друзья, заметки и личные
 * сообщения с группами.
 */
function renderHomeSidebar(header, list) {
  const ws = state.workspace;
  header.className = "sidebar-header home";
  header.append(h("span", { class: "sidebar-header-title", text: t("Conversations") }));

  const pending = pendingRequests();
  list.append(
    menuButton({
      icon: symbol("home", 22),
      name: t("Home"),
      attention: state.page === "home" ? "selected" : "",
      onclick: () => openHomePage("home"),
    }),
    h("div", { class: "home-gap" }),
    menuButton({
      icon: symbol("group", 22),
      name: t("Friends"),
      attention: state.page === "friends" ? "selected" : "",
      trailing: pending ? h("span", { class: "pending-badge", text: `${pending} requests` }) : null,
      onclick: () => openHomePage("friends"),
    }),
    h("div", { class: "home-gap" }),
  );
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

  const add = h("a", { class: "category-action", role: "button", tabindex: "0" }, [symbol("add", 20)]);
  add.onclick = () => createGroupModal();
  attachTooltip(add, t("Create a new group"), "right");
  list.append(h("div", { class: "home-category" }, [h("span", { text: "Direct Messages" }), add]));

  for (const dm of ws.dms) {
    const group = dm.kind === "group";
    const count = (dm.recipients || []).length;
    const icon = group
      ? avatar({ url: dm.icon, name: dm.name, size: 32, shape: "rounded-square" })
      : avatar({ url: dm.icon, name: dm.name, size: 32, presence: dm.presence || "Offline" });
    // statusMessage(): у собеседника в сети — свой текст, иначе только «Фокус»
    const online = dm.presence && dm.presence !== "Offline";
    const status = group
      ? `${count} ${count > 1 ? "Members" : "Member"}`
      : online
        ? dm.description || (dm.presence === "Focus" ? t("Focus") : null)
        : null;
    list.append(
      menuButton({
        icon,
        name: dm.name,
        status,
        attention: attentionOf(dm),
        trailing: unreadMarker(dm),
        onclick: () => openChannel(dm),
        oncontextmenu: (event) =>
          dm.kind === "dm" && dm.recipient
            ? openUserMenu(event, { id: dm.recipient, name: dm.name, relationship: relationshipOf(dm.recipient) }, null)
            : openChannelMenu(event, dm),
      }),
    );
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
function openServerInfo(server) {
  closeMenus();
  const body = h("div", { class: "server-description" });
  if (server.description) {
    body.append(renderMarkdown(server.description, { serverId: server.id }));
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
  closeMenus();
  if (serverId === null) {
    openHome();
    return;
  }
  state.serverId = serverId;
  leavePage();
  renderRail();
  renderSidebar();
  if (!state.workspace) return;

  const target = landingChannel(serverId);
  if (target) openChannel(target);
  else closeChannel();
}

/** Кнопка «Домой»: последнее место в «Беседах» (getLastHomePath). */
function openHome() {
  const last = readSetting("homePath", "home");
  const found = state.workspace && last !== "home" && last !== "friends" ? findChannel(last) : null;
  if (found && !found.server) openChannel(found.channel);
  else openHomePage(last === "friends" ? "friends" : "home");
}

/** Уйти со страницы раздела к каналу. */
function leavePage() {
  if (!state.page) return;
  state.page = null;
  renderPage();
}

// ─────────────────────────── шапка канала ───────────────────────────

function renderHeader() {
  const channel = currentChannel();
  const icon = el("chat-icon");
  const title = el("chat-title");
  const sub = el("chat-sub");
  const actions = el("chat-actions");
  icon.textContent = "";
  title.textContent = "";
  title.onclick = null;
  title.classList.remove("clickable");
  sub.textContent = "";
  sub.onclick = null;
  actions.textContent = "";
  el("chat-divider").classList.add("hidden");
  el("sidebar-chevron").replaceChildren(symbol(state.sidebarShown ? "bx:chevron-left" : "bx:chevron-right", 20));
  // у «Обзора» своей шапки нет: встроенная страница занимает всё место
  el("channel-header").classList.toggle("hidden", state.page === "discover");

  // шапки разделов «Бесед» (Home.tsx, Friends.tsx, Discover.tsx)
  if (state.page === "home") {
    icon.append(symbol("md:filled:home", 24));
    title.textContent = t("Home");
    return;
  }
  if (state.page === "friends") {
    icon.append(symbol("group", 24));
    title.textContent = t("Friends");
    return;
  }
  if (state.page === "discover") {
    icon.append(symbol("md:filled:explore", 24));
    title.textContent = t("Discover");
    return;
  }
  if (!channel) {
    title.textContent = "Arachnid Client";
    return;
  }

  // ChannelHeader.tsx: у текстовых каналов и групп — значок getChannelIcon
  if (channel.kind === "dm") {
    icon.append(symbol("alternate_email", 24));
    title.textContent = channel.name;
    title.append(h("span", { class: "header-presence presence-" + String(channel.presence || "Offline").toLowerCase() }));
  } else if (channel.kind === "notes") {
    icon.append(symbol("note_stack", 24));
    title.textContent = t("Saved Notes");
  } else {
    icon.append(symbol(channel.kind === "voice" ? "headset_mic" : "grid_3x3", 24));
    title.append(...emojiText(channel.name));
    title.classList.add("clickable");
    title.onclick = () => openChannelInfo(channel);
    const description = (channel.description || "").split("\n")[0];
    if (description) {
      el("chat-divider").classList.remove("hidden");
      sub.append(...emojiText(description));
      sub.onclick = () => openChannelInfo(channel);
      attachTooltip(sub, t("Click to show full description"), "bottom");
    }
  }

  const button = (iconNode, tooltip, onclick, active = false) => {
    const node = h("button", { class: "icon-button" + (active ? " active" : ""), type: "button" }, [iconNode]);
    node.onclick = onclick;
    attachTooltip(node, tooltip, "bottom");
    actions.append(node);
    return node;
  };

  const found = findChannel(channel.id);
  const server = found && found.server;
  if ((channel.kind === "group" || server) && canManageChannel(channel, server)) {
    button(symbol("md:settings", 24), t("Channel Settings"), () => editChannelModal(channel));
  }
  if (channel.kind === "group") {
    button(symbol("md:person_add", 24), t("Add friends to group"), () => addMembersToGroupModal(channel));
  }
  button(symbol("keep_header", 24), t("View pinned messages"), () =>
    setSide(state.side.state === "pins" ? { state: "default" } : { state: "pins" }),
  state.side.state === "pins");
  if (hasMemberSidebar(channel)) {
    button(symbol("md:group", 24), t("View members"), () => {
      if (state.side.state === "default") toggleMembers();
      else {
        state.showMembers = true;
        writeSetting("members", true);
        setSide({ state: "default" });
      }
    }, state.side.state === "default" && state.showMembers);
  }

  // поиск: строка уходит в запрос при подтверждении (onChange), пустая — закрывает
  const search = h("input", {
    class: "header-search",
    type: "search",
    placeholder: t("Search messages..."),
    autocomplete: "off",
    spellcheck: "false",
  });
  search.value = state.side.state === "search" ? state.side.query : "";
  search.addEventListener("change", () => {
    const query = search.value.trim();
    setSide(query ? { state: "search", query, sort: state.side.sort || "Latest" } : { state: "default" });
  });
  actions.append(search);
}

/** Есть ли у канала список участников (canIHasSidebar): не у ЛС и заметок. */
function hasMemberSidebar(channel) {
  return channel.kind !== "dm" && channel.kind !== "notes";
}

/** Право на «Настройки канала» (orPermission ManageChannel, ManagePermissions). */
function canManageChannel(channel, server) {
  if (hasBit(channel.permissions, PERM.MANAGE_CHANNEL) || hasBit(channel.permissions, PERM.MANAGE_PERMISSIONS)) return true;
  return Boolean(server) && (serverAllows(server, PERM.MANAGE_CHANNEL) || serverAllows(server, PERM.MANAGE_PERMISSIONS));
}

/** Сведения о канале (ChannelInfo.tsx): «#имя» и полное описание. */
function openChannelInfo(channel) {
  openModal({
    title: `#${channel.name}`,
    body: h("div", { class: "channel-info" }, [renderMarkdown(channel.description || "", { serverId: state.serverId })]),
    actions: [{ label: t("Close"), primary: true, onclick: closeModal }],
  });
}

/** Свернуть или развернуть список каналов (LAYOUT_SECTIONS.PRIMARY_SIDEBAR). */
function toggleSidebar() {
  state.sidebarShown = !state.sidebarShown;
  writeSetting("sidebar", state.sidebarShown);
  applySidebar();
  renderHeader();
}

function applySidebar() {
  el("sidebar").classList.toggle("hidden", !state.sidebarShown || state.page === "discover");
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
  // в «Беседах» без канала — домашняя страница (пока данных нет — пустая лента)
  if (state.serverId === null && state.workspace) {
    openHomePage("home");
    return;
  }
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
  if (!state.channelId || !state.atEnd) return;
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
  if (!reload && !state.page && state.channelId === channel.id && state.messages.length) return;
  const token = ++openToken;
  rememberHistory();

  const found = findChannel(channel.id);
  if (found && found.server) {
    state.serverId = found.server.id;
    writeSetting("last." + found.server.id, channel.id);
  } else if (found) {
    state.serverId = null;
    // кнопка «Домой» вернёт в эту беседу (getLastHomePath)
    writeSetting("homePath", channel.id);
  }
  leavePage();
  applySidebar();

  if (state.channelId !== channel.id) {
    // узлы прошлого канала не нужны: в кэше истории остаются только данные
    messageNodes = new WeakMap();
    state.replies = [];
    state.editing = null;
    inputEl.value = drafts.get(channel.id) || "";
    state.side = { state: "default" };
  }
  state.atEnd = true;
  state.channelId = channel.id;
  state.ackHeld = null;
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
  renderSide();

  // история важнее всего: запрос уходит первым, участники и эмодзи — следом
  const latest = fetchLatest(channel.id);
  if (cached) {
    renderMessages({ toBottom: true });
    focusInput();
  } else {
    showState(h("div", { class: "spinner" }));
  }
  loadMembers(memberKey());
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

/** Подгрузить сообщения новее показанных (после перехода в историю). */
async function loadNewer() {
  if (state.atEnd || state.loadingNewer || !state.messages.length) return;
  const newest = state.messages.filter((item) => !item.pending).at(-1);
  if (!newest) return;
  const channelId = state.channelId;
  state.loadingNewer = true;
  try {
    const page = await call("channel_history", { channelId, after: newest.id, limit: PAGE_SIZE });
    if (state.channelId !== channelId) return;
    const newer = markMine(page.messages || []).filter((message) => !state.messages.some((item) => item.id === message.id));
    if (!page.has_more) state.atEnd = true;
    state.messages = state.messages.concat(newer);
    if (state.messages.length > DISPLAY_LIMIT) {
      state.messages = state.messages.slice(-DISPLAY_LIMIT);
      state.reachedStart = false;
    }
    renderMessages({ keepTop: true });
  } catch (error) {
    console.warn("не удалось подгрузить новые сообщения:", error);
  } finally {
    state.loadingNewer = false;
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
  if (state.channelId !== info.channel || state.page) await openChannel(found.channel);
  if (highlightMessage(info.message)) return;

  // сообщения нет в загруженном куске — страница вокруг него (nearby, как Messages.tsx)
  const channelId = info.channel;
  try {
    const page = await call("channel_history", { channelId, nearby: info.message, limit: NEARBY_LIMIT });
    if (state.channelId !== channelId) return;
    const list = markMine(page.messages || []);
    if (!list.some((item) => item.id === info.message)) {
      toast(t("The message was not found in the history"), "error");
      return;
    }
    rememberHistory();
    const latest = found.channel.last_message_id;
    state.messages = list;
    state.reachedStart = false;
    state.atEnd = Boolean(latest && list.some((item) => item.id === latest));
    state.stickToBottom = false;
    renderMessages();
    highlightMessage(info.message);
  } catch (error) {
    toast(describe(error), "error");
  }
}

/** Прокрутить к сообщению и подсветить его; false — его нет в ленте. */
function highlightMessage(messageId) {
  const node = messagesEl.querySelector(`.message[data-id="${messageId}"]`);
  if (!node) return false;
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.classList.add("flash");
  setTimeout(() => node.classList.remove("flash"), 1600);
  return true;
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
function renderMessages({ toBottom = false, keepTop = false } = {}) {
  const keep = distanceFromBottom();
  // подгрузка новых снизу (и срез сверху) не должна сдвигать читаемое
  const anchor = keepTop ? topVisibleMessage() : null;
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
  dropStaleTooltip();
  const anchorNode = anchor ? messagesEl.querySelector(`.message[data-id="${anchor.id}"]`) : null;
  if (anchorNode) messagesEl.scrollTop = anchorNode.offsetTop - anchor.offset;
  else if (toBottom || (state.stickToBottom && state.atEnd)) messagesEl.scrollTop = messagesEl.scrollHeight;
  else messagesEl.scrollTop = messagesEl.scrollHeight - messagesEl.clientHeight - keep;
  renderBars();
}

/** Первое видимое сообщение и его отступ от верха ленты. */
function topVisibleMessage() {
  for (const node of messagesEl.querySelectorAll(".message[data-id]")) {
    if (node.offsetTop + node.offsetHeight > messagesEl.scrollTop) {
      return { id: node.dataset.id, offset: node.offsetTop - messagesEl.scrollTop };
    }
  }
  return null;
}

// ─────────────────────────── плашки над лентой (bars/*.tsx) ───────────────────────────

/** «Новые сообщения с …» сверху и «Просмотр старых сообщений» снизу. */
function renderBars() {
  const top = el("new-messages");
  const bottom = el("jump-bottom");
  top.replaceChildren();
  bottom.replaceChildren();
  if (state.page || !state.channelId) return;

  if (state.lastRead) {
    const since = ulidDate(state.lastRead);
    const close = h("span", { class: "floating-close" }, [symbol("md:filled:close", 16)]);
    close.onclick = (event) => {
      event.stopPropagation();
      state.lastRead = null;
      renderMessages();
    };
    const bar = h("div", { class: "floating-indicator top", role: "button" }, [
      h("span", { class: "floating-grow", text: t("New messages since {0}", [since ? I18N.relative(since) : ""]) }),
      h("span", { text: t("Jump to the beginning") }),
      close,
    ]);
    const target = state.lastRead;
    bar.onclick = () => jumpToMessage({ channel: state.channelId, message: target });
    top.append(bar);
  }

  if (!state.atEnd) {
    const bar = h("div", { class: "floating-indicator bottom", role: "button" }, [
      h("span", { class: "floating-grow", text: t("Viewing older messages") }),
      h("span", { text: t("Jump to present") }),
      symbol("md:filled:arrow_forward", 16),
    ]);
    bar.onclick = () => jumpToPresent();
    bottom.append(bar);
  }
}

/** Время из ULID (первые 10 символов — миллисекунды в Crockford base32). */
function ulidDate(id) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = 0;
  for (const char of String(id).slice(0, 10).toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) return null;
    time = time * 32 + value;
  }
  return new Date(time);
}

/** Вернуться к последним сообщениям после «прыжка» в историю. */
function jumpToPresent() {
  const channel = currentChannel();
  if (!channel) return Promise.resolve();
  if (state.atEnd) {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
    return Promise.resolve();
  }
  // кусок истории вокруг старого сообщения в кэш канала не попадает
  state.messages = [];
  state.atEnd = true;
  return openChannel(channel, { reload: true });
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
  // ники и цвета в упоминаниях тоже могли измениться
  forgetMentionUsers();
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

/**
 * Узел сообщения. `preview` — показ внутри окна (удаление, жалоба): без
 * панели действий и контекстного меню, как `isLink="hide"` в оригинале.
 */
function messageNode(message, tail, { preview = false } = {}) {
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
    for (const replyId of message.replies || []) node.append(replyLine(replyId, message));
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
    // одна GIF-ссылка без текста — показывается только сама картинка (isOnlyGIF)
    if (message.content && !isOnlyGif(message)) {
      const serverId = (findChannel(message.channel) || {}).server?.id || null;
      content.append(h("div", { class: "message-text" }, [renderMarkdown(message.content, { serverId })]));
    }
    if (tail && message.edited && !compact) content.append(h("span", { class: "edited", text: t("(edited)") }));
  }

  const live = !preview && !message.pending;
  if (message.attachments && message.attachments.length) {
    content.append(attachmentsNode(message.attachments, live ? message : null));
  }
  if (message.embeds && message.embeds.length) {
    content.append(h("div", { class: "embeds" }, message.embeds.map(embedNode)));
  }
  const reactions = reactionsNode(message, live);
  if (reactions) content.append(reactions);
  if (message.failed) content.append(failedHint(message));

  node.append(h("div", { class: "message-row" }, [info, content]));
  if (!live) return node;
  node.append(messageToolbar(message, node));

  node.addEventListener("contextmenu", (event) => {
    // ссылка под курсором добавляет в меню «Скопировать ссылку» (anchors.tsx)
    const anchor = event.target.closest("a[href]");
    openMessageMenu(event, message, { link: anchor ? anchor.href : null, anchor: node });
  });
  return node;
}

/** Адрес в тексте (RE_URL из Message.tsx). */
const RE_URL = /[(http(s)?)://(www.)?a-zA-Z0-9@:%._+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_+.~#?&//=]*)/;

/** Сообщение — одна ссылка на GIF: текст не показывается, только встраивание. */
function isOnlyGif(message) {
  const embeds = message.embeds || [];
  return embeds.length === 1 && Boolean(embeds[0].gif) && !(message.content || "").replace(RE_URL, "");
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

  // участники — плашками упоминаний (UserMention), сообщение — ссылкой (RenderAnchor)
  const serverId = (channelId && findChannel(channelId)?.server?.id) || null;
  const mention = (person) =>
    person.id
      ? markdownUserMention(person.id, serverId)
      : h("span", { class: "md-mention invalid", text: person.name || t("Unknown User") });
  const target = event.message_id && channelId
    ? markdownAnchor(channelLink({ id: channelId }) + "/" + event.message_id, serverId)
    : mention(second);
  return I18N.rich(msgid, values, {
    0: mention(first),
    1: event.kind === "channel_renamed" ? (text) => h("strong", { text }) : target,
  });
}

/** Отношение с пользователем: `Friend`, `Blocked`, … или null. */
function relationshipOf(userId) {
  const list = (state.workspace && state.workspace.relationships) || [];
  const entry = list.find((item) => item.user.id === userId);
  return entry ? entry.relationship : null;
}

/** Ответ над сообщением (MessageReply.tsx). */
function replyLine(replyId, message) {
  const target = state.messages.find((item) => item.id === replyId) || null;
  const mention = Boolean(target && (message.mentions || []).includes(target.author_id));
  const node = messageReply(target, { mention });
  node.onclick = () => jumpToMessage({ channel: state.channelId, message: replyId });
  return node;
}

/**
 * Строка «на что ответ»: аватар, ник (с «@», если автор упомянут) и
 * начало текста упрощённой разметкой. `noDecorations` — без уголка слева
 * (превью над полем ввода).
 */
function messageReply(target, { mention = false, noDecorations = false } = {}) {
  const node = h("div", { class: "reply-line" + (noDecorations ? " plain" : "") });
  if (target && relationshipOf(target.author_id) === "Blocked") {
    node.append(t("Blocked User"));
    return node;
  }
  if (!target) {
    node.append(t("Message not loaded, click to jump"));
    return node;
  }
  const name = h("span", { class: "username", text: (mention ? "@" : "") + target.author });
  paintName(name, target.colour);
  const user = h("span", { class: "reply-user" }, [avatar({ url: target.avatar, name: target.author, size: 14 }), name]);
  user.onclick = (event) => openUserCard(event, target.author_id);
  user.oncontextmenu = (event) => openUserMenu(event, { id: target.author_id, name: target.author });

  const link = h("span", { class: "reply-link" });
  const files = target.attachments || [];
  if (files.length) {
    link.append(
      h("em", { class: "reply-attachments" }, [
        symbol("bx:solid-file", 16),
        files.length > 1 ? t("Sent multiple attachments") : t("Sent an attachment"),
      ]),
    );
  }
  if (target.content) {
    const serverId = (findChannel(target.channel) || {}).server?.id || null;
    link.append(h("span", { class: "reply-content" }, [replyMarkdown(target.content, serverId)]));
  }
  node.append(user, link);
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

/** Меню по правому щелчку на файле или встраивании (`file` в MessageContextMenu). */
function fileMenu(node, file, message = null) {
  node.addEventListener("contextmenu", (event) => {
    const anchor = message ? node.closest(".message") : null;
    openContextMenu(event, messageMenuItems({ message, file, anchor }));
  });
}

/** Файл вложения для меню: адрес превью, оригинал и имя (класс File в stoat.js). */
function attachmentFile(file) {
  return { url: file.url, original: file.original || file.url, name: file.name };
}

/** Вложения; `message` — сообщение в ленте (для меню), у образца в окне его нет. */
function attachmentsNode(files, message = null) {
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
          file: attachmentFile(file),
        });
      if (message) fileMenu(img, attachmentFile(file), message);
      box.append(spoilerWrap(sizedContent(file.width, file.height, img), file));
    } else if (file.kind === "video" && file.url) {
      const video = h("video", { class: "attachment-media", controls: true, playsinline: true, preload: "metadata" });
      video.src = mediaSrc(file.original || file.url);
      if (message) fileMenu(video, attachmentFile(file), message);
      box.append(spoilerWrap(sizedContent(file.width, file.height, video), file));
    } else if (file.kind === "audio" && file.url) {
      const audio = h("audio", { controls: true, preload: "metadata" });
      audio.src = mediaSrc(file.original || file.url);
      if (message) fileMenu(audio, attachmentFile(file), message);
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
  fileMenu(img, { url: embed.image });
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
  fileMenu(video, { url: embed.video });
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
  if (embed.description) box.append(h("div", { class: "embed-text" }, [renderMarkdown(embed.description, { serverId: state.serverId })]));
  if (embed.image) {
    const src = embedMediaUrl(embed.image, false);
    const img = image(src, { class: "embed-media", loading: "lazy" });
    if (embed.width && embed.height) img.style.aspectRatio = `${embed.width} / ${embed.height}`;
    img.onclick = () => openImageViewer({ src, width: embed.width, height: embed.height, link: embed.url });
    fileMenu(img, { url: embed.image });
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
function openImageViewer({
  src,
  name = null,
  size = 0,
  width = null,
  height = null,
  gif = false,
  download = null,
  link = null,
  file = null,
}) {
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
  // у файла вложения — то же меню, что в ленте, но без пунктов сообщения
  if (file) fileMenu(media, file);

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
/**
 * Панель действий при наведении (MessageToolbar.tsx): ответить,
 * отреагировать, редактировать, удалить (Shift — без вопроса) и «Ещё».
 */
function messageToolbar(message, node) {
  const bar = h("div", { class: "message-toolbar" });
  const can = (bit) => canInChannel(message.channel, bit);
  const tool = (icon, label, action) => {
    const button = h("button", { type: "button", class: "tool", "aria-label": label }, [symbol(icon, 20)]);
    button.onclick = (event) => {
      event.stopPropagation();
      action(event, button);
    };
    return button;
  };

  if (can(MESSAGE_PERM.SendMessage)) bar.append(tool("md:reply", t("Reply"), () => addReply(message)));
  if (can(MESSAGE_PERM.React)) {
    bar.append(tool("md:emoji_emotions", t("React"), (event, button) => openReactionPicker(event, message, button)));
  }
  if (message.mine) bar.append(tool("md:edit", t("Edit message"), () => startEdit(message)));
  if (message.mine || can(MESSAGE_PERM.ManageMessages)) {
    bar.append(tool("md:delete", t("Delete message"), (event) => removeMessage(message, event.shiftKey)));
  }
  bar.append(tool("md:more_vert", t("More"), (event) => openMessageMenu(event, message, { anchor: node })));
  return bar;
}

// ─────────────────────────── реакции (Reactions.tsx) ───────────────────────────

const ULID_RE = /^[0-9A-Z]{26}$/;

/** Эмодзи реакции: свой (id) — картинкой с CDN, юникод — из набора. */
function reactionEmoji(emoji, message) {
  if (ULID_RE.test(emoji)) return customEmojiNode(emoji, (message.emoji || {})[emoji] || customEmojiUrl(emoji));
  return unicodeEmojiNode(emoji);
}

/**
 * Реакции под сообщением: сначала обязательные (`interactions.reactions`,
 * их ставит бот), через черту — остальные, в конце «+» (виден при
 * наведении на список). Нажатие на реакцию ставит или снимает свою.
 * `live` — сообщение в ленте, а не образец в окне.
 */
function reactionsNode(message, live) {
  const users = new Map((message.reactions || []).map((reaction) => [reaction.emoji, reaction.users]));
  const required = [...new Set((message.interactions && message.interactions.reactions) || [])];
  const optional = [...users.keys()].filter((emoji) => !required.includes(emoji));
  if (!required.length && !optional.length) return null;

  const me = state.me ? state.me.id : null;
  const chip = (emoji) => {
    const who = users.get(emoji) || [];
    const active = Boolean(me && who.includes(me));
    const button = h("button", { type: "button", class: "reaction" + (active ? " active" : "") }, [
      reactionEmoji(emoji, message),
      h("span", { class: "reaction-count", text: String(who.length) }),
    ]);
    attachTooltip(button, () =>
      h("div", { class: "reaction-tooltip" }, [
        h("span", { class: "reaction-tooltip-emoji" }, [reactionEmoji(emoji, message)]),
        h("span", { class: "reaction-people", text: reactionPeople(who) }),
      ]),
    );
    button.setAttribute("aria-label", reactionPeople(who));
    if (live) button.onclick = () => toggleReaction(message, emoji, active);
    return button;
  };

  const list = h("div", { class: "reactions" });
  for (const emoji of required) list.append(chip(emoji));
  if (required.length && optional.length) list.append(h("div", { class: "reaction-divider" }));
  for (const emoji of optional) list.append(chip(emoji));
  if (live) {
    const add = h("button", { type: "button", class: "reaction add", "aria-label": t("React") }, [symbol("md:add", 24)]);
    add.onclick = (event) => openReactionPicker(event, message, add);
    list.append(add);
  }
  return list;
}

/**
 * Кто отреагировал — так же, как в оригинале: два имени и «ещё N»
 * (N считается от трёх, а не от двух — как в for-web).
 */
function reactionPeople(ids) {
  const usernames = ids
    .slice(0, 2)
    .map((id) => userName(id))
    .join(", ");
  const unknown = Math.max(0, ids.length - 3);
  if (unknown) {
    if (usernames) return t("{usernames} and {unknown} others reacted", { usernames, unknown });
    if (unknown === 1) return t("1 person reacted");
    return t("{unknown} reacted", { unknown });
  }
  return t("{usernames} reacted", { usernames });
}

async function toggleReaction(message, emoji, active) {
  try {
    if (active) await call("unreact_message", { channelId: message.channel, messageId: message.id, emoji, removeAll: false });
    else await call("react_message", { channelId: message.channel, messageId: message.id, emoji });
  } catch (error) {
    toast(describe(error), "error");
  }
}

/**
 * Панель эмодзи для реакции: над кнопкой, с которой её открыли, или над
 * сообщением (из меню). Выбранный эмодзи сразу ставится реакцией, панель
 * остаётся открытой — как в оригинале.
 */
function openReactionPicker(event, message, anchor) {
  event.stopPropagation();
  const target =
    anchor && anchor.isConnected ? anchor : messagesEl.querySelector(`.message[data-id="${CSS.escape(message.id)}"]`);
  toggleEmojiPicker(undefined, {
    anchor: target,
    onPick: (emoji) =>
      call("react_message", { channelId: message.channel, messageId: message.id, emoji }).catch((error) =>
        toast(describe(error), "error"),
      ),
  });
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
  // DeleteMessage.tsx: вопрос и само сообщение, как оно выглядит в ленте
  dialogModal({
    title: t("Delete message"),
    body: h("div", { class: "dialog-stack" }, [
      h("p", { class: "dialog-text", text: t("Are you sure you want to delete this?") }),
      messagePreview(message),
    ]),
    confirm: t("Delete"),
    run,
  });
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
  if (message.pending) return;
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
    const preview = h("div", { class: "reply-preview" }, [
      h("span", { class: "reply-preview-to", text: t("Replying to") }),
      messageReply(reply.message, { noDecorations: true }),
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
  // отправка из куска истории возвращает к последним сообщениям (onMessageSend)
  if (!state.atEnd) await jumpToPresent();

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

const membersCache = new Map(); // id сервера или группы → участники

/** Сколько списков участников держится в памяти интерфейса. */
const MEMBERS_KEEP = 6;

/** Чьи участники сейчас нужны: открытого сервера или открытой группы. */
function memberKey() {
  if (state.serverId !== null) return state.serverId;
  const channel = currentChannel();
  return channel && channel.kind === "group" ? channel.id : null;
}

async function loadMembers(key) {
  renderMembers();
  if (key === null) return;
  const isServer = Boolean(serverById(key));
  // присутствие участников сервера приходит только по подписке; ядро само решает, пора ли её продлить
  if (isServer) call("subscribe_server", { serverId: key }).catch((error) => console.warn("подписка на сервер:", error));
  if (membersCache.has(key)) {
    // свежий список — в конец очереди на выгрузку
    const list = membersCache.get(key);
    membersCache.delete(key);
    membersCache.set(key, list);
    return;
  }
  membersCache.set(key, null);
  while (membersCache.size > MEMBERS_KEEP) membersCache.delete(membersCache.keys().next().value);
  try {
    const list = isServer ? await call("server_members", { serverId: key }) : await call("group_members", { channelId: key });
    membersCache.set(key, list || []);
  } catch (error) {
    membersCache.set(key, []);
    console.warn("не удалось получить участников:", error);
  }
  if (memberKey() === key) {
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
  const channel = currentChannel();
  const visible = Boolean(channel && !state.page && state.side.state === "default" && state.showMembers && hasMemberSidebar(channel));
  panel.classList.toggle("hidden", !visible);
  if (!visible) {
    memberView = null;
    panel.textContent = "";
    memberRowCache.clear();
    return;
  }

  const key = memberKey();
  const members = membersCache.get(key);
  if (!members) {
    memberView = null;
    panel.replaceChildren(h("div", { class: "member-title", text: t("Loading members…") }));
    return;
  }
  if (channel.kind === "group") {
    renderGroupMembers(panel, channel, members);
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

  showMemberWindow(panel, key, items, top, [h("span", { class: "connection-dot" }), t("{0} online", [onlineCount])]);
}

/** Участники группы (GroupMemberSidebar): «N members» и все получатели по имени. */
function renderGroupMembers(panel, channel, members) {
  const items = [];
  let top = 0;
  for (const member of members) {
    items.push({ kind: "member", member, top, height: MEMBER_ROW_HEIGHT });
    top += MEMBER_ROW_HEIGHT;
  }
  const count = (channel.recipients || []).length || members.length;
  showMemberWindow(panel, channel.id, items, top, [t("{0} members", [count])]);
}

/** Заголовок и окно строк; прокрутка сохраняется, пока список тот же. */
function showMemberWindow(panel, key, items, height, title) {
  const same = memberView && memberView.key === key;
  const scroll = same ? panel.scrollTop : 0;
  const list = h("div", { class: "member-list", style: { height: `${height}px` } });
  panel.replaceChildren(h("div", { class: "member-title" }, title), list);
  panel.scrollTop = scroll;
  if (!same) memberRowCache.clear();
  memberView = { key, list, items };
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

// ─────────────────────────── поиск и закреплённые (TextSearchSidebar.tsx) ───────────────────────────

/** Состояние правой панели: `default` (участники), `search` или `pins`. */
function setSide(side) {
  state.side = side;
  renderHeader();
  renderMembers();
  renderSide();
}

let sideToken = 0;

function renderSide() {
  const panel = el("side-panel");
  const side = state.side;
  const channel = currentChannel();
  const shown = Boolean(channel && !state.page && side.state !== "default");
  panel.classList.toggle("hidden", !shown);
  if (!shown) {
    sideToken += 1;
    panel.replaceChildren();
    return;
  }

  const token = ++sideToken;
  const results = h("div", { class: "side-results" }, [h("div", { class: "spinner" })]);
  const parts = [h("div", { class: "side-title", text: side.state === "search" ? t("Search Results") : t("Pinned Messages") })];
  if (side.state === "search") {
    // порядок выдачи: «По релевантности», «Сначала новые», «Сначала старые»
    const sort = side.sort || "Latest";
    const group = h("div", { class: "button-group" });
    for (const [value, label] of [
      ["Relevance", t("Relevance")],
      ["Latest", t("Latest")],
      ["Oldest", t("Oldest")],
    ]) {
      const button = h("button", { class: "group-button" + (sort === value ? " active" : ""), type: "button", text: label });
      button.onclick = () => setSide({ ...side, sort: value });
      group.append(button);
    }
    parts.push(group);
  }
  panel.replaceChildren(...parts, results);

  const request =
    side.state === "search"
      ? { channelId: channel.id, query: side.query, sort: side.sort || "Latest" }
      : { channelId: channel.id, pinned: true };
  call("search_messages", request)
    .then((found) => {
      if (token !== sideToken) return;
      results.replaceChildren(
        ...markMine(found.messages || []).map((message) => {
          const link = h("a", { class: "side-result", href: "#" }, [messageNode(message, false, { preview: true })]);
          link.onclick = (event) => {
            event.preventDefault();
            jumpToMessage({ channel: message.channel, message: message.id });
          };
          return link;
        }),
      );
    })
    .catch((error) => {
      if (token !== sideToken) return;
      results.replaceChildren(h("div", { class: "side-error", text: describe(error) }));
    });
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
  button.onclick = () => {
    // для реакции нужен id своего эмодзи или сам символ, для текста — `:имя:`
    if (emojiTarget && emojiTarget.onPick) emojiTarget.onPick(item.kind === "server" ? item.emoji.id : item.emoji.text);
    else insertText(item.kind === "server" ? `:${item.emoji.name}:` : item.emoji.text);
  };
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

/** Для чего открыта панель эмодзи: `null` — поле ввода, иначе { anchor, onPick }. */
let emojiTarget = null;

/**
 * Открыть или закрыть панель эмодзи. Без `target` — для поля ввода (над
 * ним), с `target` — плавающей над `target.anchor` (top-end, отступ 5),
 * и выбор уходит в `target.onPick`. Повторное открытие с того же места
 * закрывает панель.
 */
function toggleEmojiPicker(force, target = null) {
  const picker = el("emoji-picker");
  const hidden = picker.classList.contains("hidden");
  const same = !hidden && (emojiTarget ? emojiTarget.anchor : null) === (target ? target.anchor : null);
  const open = force ?? (hidden || !same);
  picker.classList.toggle("hidden", !open);
  el("btn-emoji").classList.toggle("active", open && !target);
  if (!open) {
    // закрытая панель не держит тысячи кнопок и картинок
    if (emojiObserver) emojiObserver.disconnect();
    el("emoji-list").textContent = "";
    el("emoji-servers").textContent = "";
    emojiTarget = null;
    dockEmojiPicker(picker);
    return;
  }
  emojiTarget = target;
  if (target && target.anchor) {
    // плавающая панель живёт в body, чтобы её не обрезала лента
    picker.classList.add("floating");
    document.body.append(picker);
    placeFloating(picker, target.anchor.getBoundingClientRect(), "top-end");
  } else {
    dockEmojiPicker(picker);
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

/** Вернуть панель на место над полем ввода. */
function dockEmojiPicker(picker) {
  picker.classList.remove("floating");
  picker.style.left = "";
  picker.style.top = "";
  const home = el("composition");
  if (picker.parentElement !== home) home.append(picker);
}

// ─────────────────────────── меню ───────────────────────────

let menuClosed = null;
let closeSubmenu = null;

function closeMenus() {
  el("ctx-menu").classList.add("hidden");
  el("account-menu").classList.add("hidden");
  if (closeSubmenu) closeSubmenu();
  hideTooltip();
  closeUserCard();
  if (menuClosed) {
    menuClosed();
    menuClosed = null;
  }
}

function menusOpen() {
  return ["ctx-menu", "account-menu", "user-card"].some((id) => !el(id).classList.contains("hidden"));
}

/**
 * Поставить плавающий элемент у прямоугольника `rect`, как floating-ui в
 * оригинале: `placement` — сторона и выравнивание («top», «top-end»,
 * «right-start»), `gap` — отступ (offset), у края окна сторона меняется на
 * противоположную (flip), а вдоль стороны элемент сдвигается в окно (shift).
 */
function placeFloating(node, rect, placement, gap = 5) {
  node.style.left = "0px";
  node.style.top = "0px";
  const box = node.getBoundingClientRect();
  const width = window.innerWidth;
  const height = window.innerHeight;
  let [side, align] = placement.split("-");
  const flip = { top: "bottom", bottom: "top", left: "right", right: "left" };
  const fits = (where) =>
    where === "top"
      ? rect.top - gap - box.height >= 0
      : where === "bottom"
        ? rect.bottom + gap + box.height <= height
        : where === "left"
          ? rect.left - gap - box.width >= 0
          : rect.right + gap + box.width <= width;
  if (!fits(side) && fits(flip[side])) side = flip[side];

  let x;
  let y;
  if (side === "top" || side === "bottom") {
    y = side === "top" ? rect.top - gap - box.height : rect.bottom + gap;
    x = align === "start" ? rect.left : align === "end" ? rect.right - box.width : rect.left + (rect.width - box.width) / 2;
    x = Math.min(Math.max(0, x), Math.max(0, width - box.width));
  } else {
    x = side === "left" ? rect.left - gap - box.width : rect.right + gap;
    y = align === "start" ? rect.top : align === "end" ? rect.bottom - box.height : rect.top + (rect.height - box.height) / 2;
    y = Math.min(Math.max(0, y), Math.max(0, height - box.height));
  }
  node.style.left = Math.round(x) + "px";
  node.style.top = Math.round(y) + "px";
  return side;
}

/** Точка курсора как прямоугольник нулевого размера (виртуальный якорь меню). */
function pointRect(x, y) {
  return { left: x, right: x, top: y, bottom: y, width: 0, height: 0 };
}

// ─────────────────────────── подсказки (Tooltip.tsx) ───────────────────────────

let tooltip = null; // { node, anchor }

/** Подсказка над элементом при наведении; `content` — текст, узел или функция. */
function attachTooltip(anchor, content, placement = "top") {
  anchor.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "touch") showTooltip(anchor, content, placement);
  });
  anchor.addEventListener("pointerleave", hideTooltip);
  anchor.setAttribute("aria-label", typeof content === "string" ? content : anchor.getAttribute("aria-label") || "");
}

function showTooltip(anchor, content, placement) {
  hideTooltip();
  const body = typeof content === "function" ? content() : content;
  const node = h("div", { class: "tooltip", role: "tooltip" });
  node.append(body instanceof Node ? body : document.createTextNode(String(body)));
  document.body.append(node);
  placeFloating(node, anchor.getBoundingClientRect(), placement);
  tooltip = { node, anchor };
}

function hideTooltip() {
  if (!tooltip) return;
  tooltip.node.remove();
  tooltip = null;
}

/** Якорь подсказки пропал со страницы (лента перерисовалась) — убрать и её. */
function dropStaleTooltip() {
  if (tooltip && !tooltip.anchor.isConnected) hideTooltip();
}

// ─────────────────────────── контекстное меню (ContextMenu.tsx) ───────────────────────────

/**
 * Пункт меню. `item`: `icon` (значок 16 px), `label` или `node`, `danger`
 * (красный, «destructive»), `selected`, `action(event)`; `submenu` — список
 * пунктов, который открывается справа при наведении (ContextMenuSubMenu).
 */
function menuItemNode(item) {
  const content = item.node
    ? [item.node]
    : [item.icon ? symbol(item.icon, 16) : null, h("span", { class: "menu-item-label", text: item.label })];
  if (item.submenu) content.push(symbol("md:chevron_right", 20));
  const button = h(
    "button",
    {
      type: "button",
      class: "menu-item" + (item.danger ? " danger" : "") + (item.selected ? " selected" : ""),
      role: item.selected === undefined ? "menuitem" : "menuitemradio",
      "aria-checked": item.selected === undefined ? null : String(item.selected),
      "aria-haspopup": item.submenu ? "menu" : null,
    },
    content,
  );
  button.onclick = async (event) => {
    if (item.submenu && !item.action) {
      // без своего действия пункт только раскрывает вложенное меню
      event.stopPropagation();
      return;
    }
    closeMenus();
    try {
      await item.action(event);
    } catch (error) {
      toast(describe(error), "error");
    }
  };
  if (item.submenu) bindSubmenu(button, item.submenu);
  return button;
}

function fillMenu(menu, items) {
  menu.textContent = "";
  for (const item of items) {
    if (!item) continue;
    menu.append(item.divider ? h("div", { class: "menu-divider" }) : menuItemNode(item));
  }
}

/**
 * Вложенное меню: открывается при наведении на пункт, справа от него
 * (right-start, отступ 5), и закрывается, когда курсор уходит и с пункта,
 * и с самого меню.
 */
function bindSubmenu(button, items) {
  const open = () => {
    if (button.classList.contains("selected")) return;
    if (closeSubmenu) closeSubmenu();
    const menu = h("div", { class: "menu context-menu submenu", role: "menu" });
    fillMenu(menu, items);
    document.body.append(menu);
    const anchor = button.getBoundingClientRect();
    const side = placeFloating(menu, anchor, "right-start");
    // мостик через зазор между пунктом и меню, чтобы курсор не «терял» меню по пути
    const top = anchor.top - menu.getBoundingClientRect().top;
    menu.append(
      h("div", {
        class: "submenu-bridge",
        style: { top: top + "px", height: anchor.height + "px", [side === "left" ? "right" : "left"]: "-5px" },
      }),
    );
    button.classList.add("selected");
    const leave = (event) => {
      const next = event.relatedTarget;
      if (next && (menu.contains(next) || button.contains(next))) return;
      close();
    };
    const close = () => {
      menu.remove();
      button.classList.remove("selected");
      button.removeEventListener("mouseleave", leave);
      if (closeSubmenu === close) closeSubmenu = null;
    };
    menu.addEventListener("mouseleave", leave);
    button.addEventListener("mouseleave", leave);
    closeSubmenu = close;
  };
  button.addEventListener("mouseenter", open);
}

/**
 * Контекстное меню у курсора: справа от точки с отступом `offset` (как
 * floating-ui в оригинале), у края окна — слева от неё.
 */
function openContextMenu(event, items, onClose, { offset = 5 } = {}) {
  event.preventDefault();
  event.stopPropagation();
  closeMenus();
  menuClosed = onClose || null;
  const menu = el("ctx-menu");
  fillMenu(menu, items);
  menu.classList.remove("hidden");
  placeFloating(menu, pointRect(event.clientX, event.clientY), "right-start", offset);
}

async function messageLink(message) {
  const found = findChannel(message.channel);
  const server = found && found.server ? found.server.id : null;
  try {
    return await call("message_link", { server, channel: message.channel, message: message.id });
  } catch {
    return `https://stoat.chat${server ? `/server/${server}` : ""}/channel/${message.channel}/${message.id}`;
  }
}

// ─────────────────────────── действия с сообщением ───────────────────────────

/** Биты прав для сообщений (`Permission` в API). */
const MESSAGE_PERM = {
  SendMessage: 2 ** 22,
  ManageMessages: 2 ** 23,
  React: 2 ** 29,
};

/** Есть ли у меня право в канале сообщения (`channel.havePermission`). */
function canInChannel(channelId, bit) {
  const found = findChannel(channelId);
  return Boolean(found && hasBit(found.channel.permissions, bit));
}

function isDirectMessage(channelId) {
  const found = findChannel(channelId);
  return Boolean(found && found.channel.kind === "dm");
}

/**
 * Пункты меню сообщения в порядке MessageContextMenu.tsx. `file` — файл
 * или встраивание под курсором, `link` — ссылка под курсором; без
 * `message` (картинка встраивания, просмотрщик) остаются только они.
 */
function messageMenuItems({ message = null, file = null, link = null, anchor = null }) {
  const items = [];
  if (file) {
    items.push(
      { icon: "md:open_in_new", label: t("Open file"), action: () => openExternal(file.url) },
      { icon: "md:link", label: t("Copy link to file"), action: () => copyText(file.url) },
    );
    if (file.original) {
      items.push(
        { icon: "md:download", label: t("Save file"), action: () => downloadFile(file.original, file.name) },
        { icon: "md:content_copy", label: t("Copy file"), action: () => copyFile(file.original) },
      );
    }
    if (link || message) items.push({ divider: true });
  }
  if (link) {
    items.push({ icon: "md:link", label: t("Copy link"), action: () => copyText(link) }, { divider: true });
  }
  if (!message) return items;

  const channel = message.channel;
  const can = (bit) => canInChannel(channel, bit);
  const manage = can(MESSAGE_PERM.ManageMessages);
  const reactions = message.reactions || [];
  items.push(
    can(MESSAGE_PERM.SendMessage) && { icon: "md:reply", label: t("Reply"), action: () => addReply(message) },
    { icon: "md:mark_chat_unread", label: t("Mark as unread"), action: () => markUnread(message) },
    { icon: "md:content_copy", label: t("Copy text"), action: () => copyText(message.content || "") },
    { divider: true },
    can(MESSAGE_PERM.React) && {
      icon: "md:emoji_emotions",
      label: t("React"),
      action: (event) => openReactionPicker(event, message, anchor),
    },
    message.mine &&
      can(MESSAGE_PERM.SendMessage) && { icon: "md:edit", label: t("Edit message"), action: () => startEdit(message) },
    (isDirectMessage(channel) || manage) && {
      icon: "md:pin_invoke",
      label: message.pinned ? t("Unpin message") : t("Pin message"),
      action: (event) => pinMessage(message, event.shiftKey),
    },
    reactions.length > 0 &&
      manage && {
        icon: "md:delete_sweep",
        label: t("Remove reaction"),
        danger: true,
        // нажатие на сам пункт снимает все реакции, как в оригинале
        action: () => clearReactions(message),
        submenu: reactions.map((reaction) => ({
          node: reactionEmoji(reaction.emoji, message),
          action: () => call("unreact_message", { channelId: channel, messageId: message.id, emoji: reaction.emoji, removeAll: true }),
        })),
      },
    reactions.length > 0 &&
      manage && {
        icon: "sentiment_content",
        label: t("Remove all reactions"),
        danger: true,
        action: () => clearReactions(message),
      },
    (message.mine || manage) && {
      icon: "md:delete",
      label: t("Delete message"),
      danger: true,
      action: (event) => removeMessage(message, event.shiftKey),
    },
    !message.mine &&
      !message.system && { icon: "md:report", label: t("Report message"), danger: true, action: () => reportMessage(message) },
    { divider: true },
    getOption("advanced:admin_panel") && {
      icon: "md:shield",
      label: t("Admin Panel"),
      action: () => openExternal(`https://admin.stoatinternal.com/panel/inspect/message/${message.id}`),
    },
    {
      icon: "md:share",
      label: t("Copy message link"),
      action: async () => copyText(await messageLink(message)),
    },
    getOption("advanced:copy_id") && { icon: "md:badge", label: t("Copy message ID"), action: () => copyText(message.id) },
  );
  return items;
}

/** Контекстное меню сообщения (MessageContextMenu.tsx); при правке его нет. */
function openMessageMenu(event, message, extra = {}) {
  if (message && (message.pending || state.editing === message.id)) return;
  openContextMenu(event, messageMenuItems({ message, ...extra }));
}

/** Закрепить или открепить; с Shift — без вопроса (PinMessage.tsx). */
async function pinMessage(message, skipConfirm) {
  const pinned = !message.pinned;
  const run = () => call("pin_message", { channelId: message.channel, messageId: message.id, pinned });
  if (skipConfirm) {
    await run();
    return;
  }
  dialogModal({
    title: message.pinned ? t("Unpin message") : t("Pin message"),
    body: h("p", {
      class: "dialog-text",
      text: message.pinned ? t("Are you sure you want to unpin this message?") : t("Are you sure you want to pin this message?"),
    }),
    confirm: message.pinned ? t("Unpin") : t("Pin"),
    run,
  });
}

function clearReactions(message) {
  return call("clear_reactions", { channelId: message.channel, messageId: message.id });
}

/**
 * «Пометить как непрочитанное» (`message.ack(true, false, true)`): отметка
 * прочитанного встаёт на это сообщение и сразу уходит на сервер, а
 * следующее автоматическое прочтение пропускается — иначе канал, который
 * открыт и прокручен вниз, тут же снова стал бы прочитанным.
 */
async function markUnread(message) {
  const channelId = message.channel;
  clearTimeout(ackTimers.get(channelId));
  ackTimers.delete(channelId);
  ownAcks.note(channelId, message.id);
  await call("mark_unread", { channelId, messageId: message.id });
  const found = findChannel(channelId);
  if (found) {
    found.channel.last_read = message.id;
    found.channel.unread = Boolean(found.channel.last_message_id && found.channel.last_message_id > message.id);
    if (found.server) recountServer(found.server);
    renderRail();
    renderSidebar();
  }
  if (state.channelId === channelId) {
    state.ackHeld = channelId;
    state.lastRead = message.id;
    renderMessages();
  }
}

/** Пожаловаться на сообщение (ReportContent.tsx). */
function reportMessage(message) {
  const reasons = [
    ["Illegal", /* i18n */ "Content breaks one or more laws"],
    ["IllegalGoods", /* i18n */ "Drugs or illegal goods"],
    ["IllegalExtortion", /* i18n */ "Extortion or blackmail"],
    ["IllegalPornography", /* i18n */ "Revenge or underage pornography"],
    ["IllegalHacking", /* i18n */ "Illegal hacking or cracking"],
    ["ExtremeViolence", /* i18n */ "Extreme violence, gore or animal cruelty"],
    ["PromotesHarm", /* i18n */ "Promotes harm"],
    ["UnsolicitedSpam", /* i18n */ "Unsolicited advertising or spam"],
    ["Raid", /* i18n */ "Raid or spam attack"],
    ["SpamAbuse", /* i18n */ "Spam or similar platform abuse"],
    ["ScamsFraud", /* i18n */ "Scams or fraud"],
    ["Malware", /* i18n */ "Malware or phishing"],
    ["Harassment", /* i18n */ "Harassment or cyberbullying"],
    ["NoneSpecified", /* i18n */ "Other"],
  ];
  const select = h("select", { class: "text-field" }, [
    h("option", { value: "", text: t("Please select a reason") }),
    ...reasons.map(([value, label]) => h("option", { value, text: t(label) })),
  ]);
  const detail = h("input", { class: "text-field", type: "text", maxlength: 1000, autocomplete: "off" });

  const box = dialogModal({
    title: t("Tell us what's wrong with this message"),
    body: h("div", { class: "form-stack" }, [
      h("div", { class: "report-preview" }, [messagePreview(message)]),
      labelled(t("Reason for report"), select),
      labelled(t("Give us some detail"), detail),
    ]),
    confirm: t("Report"),
    run: async () => {
      const reason = select.value;
      if (!reason || (reason === "NoneSpecified" && !detail.value.trim())) {
        throw { kind: "NoReasonProvided" };
      }
      await call("report_content", { kind: "Message", id: message.id, reason, detail: detail.value, messageId: null });
    },
  });
  // пока причина не выбрана, отправлять нечего (Form2.canSubmit)
  const submit = box.querySelector(".modal-actions .button:last-child");
  const sync = () => (submit.disabled = !select.value);
  select.addEventListener("change", sync);
  sync();
}

/**
 * Окно в духе Dialog.tsx: заголовок, содержимое и текстовые кнопки
 * «Отменить» и действие. Окно закрывается, когда действие выполнено;
 * пока оно идёт, кнопки неактивны.
 */
function dialogModal({ title, body, confirm, run }) {
  const box = openModal({
    title,
    body,
    actions: [
      { label: t("Cancel"), onclick: closeModal },
      {
        label: confirm,
        onclick: async () => {
          const buttons = [...box.querySelectorAll(".modal-actions .button")];
          buttons.forEach((button) => (button.disabled = true));
          try {
            await run();
            closeModal();
          } catch (error) {
            buttons.forEach((button) => (button.disabled = false));
            toast(describe(error), "error");
          }
        },
      },
    ],
  });
  box.classList.add("dialog");
  return box;
}

/** Сообщение как в ленте, без панели действий и меню (`isLink="hide"`). */
function messagePreview(message) {
  return h("div", { class: "message-preview" }, [messageNode(message, false, { preview: true })]);
}

/** Скачать файл и положить его в буфер обмена (`copyFile` в оригинале). */
async function copyFile(url) {
  const response = await fetch(mediaSrc(url));
  if (!response.ok) throw new Error(t("Failed to download file: {0}.", [response.statusText]));
  const blob = await response.blob();
  const supports = (type) =>
    typeof ClipboardItem.supports === "function" ? ClipboardItem.supports(type) : ["image/png", "text/plain", "text/html"].includes(type);
  const write = async (data, type) => {
    if (!data) throw new Error(t("Can't write nothing to the clipboard"));
    await navigator.clipboard.write([new ClipboardItem({ [type || data.type]: data })]);
    toast(t("Copied file to clipboard"));
  };
  if (supports(blob.type)) return write(blob);
  if (!blob.type.startsWith("image/")) return write(blob, `web ${blob.type}`);
  // картинку, которую буфер не принимает как есть, переводим в PNG
  const source = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = source;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    await write(png, "image/png");
  } finally {
    URL.revokeObjectURL(source);
  }
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
  return server ? `${markdownOrigin}/server/${server}/channel/${channel.id}` : `${markdownOrigin}/channel/${channel.id}`;
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
    const before = currentChannel();
    state.workspace = ws;
    // от прав зависят кнопки панели действий у готовых узлов сообщений
    const after = currentChannel();
    if (before && after && before.permissions !== after.permissions) invalidateMessageNodes();
    state.me = ws.me;
    markMine(state.messages);
    loadEmojiIndex();

    const keep = state.channelId ? findChannel(state.channelId) : null;
    if (state.page) {
      // открыт раздел «Бесед»: друзья и кнопки страницы зависят от данных
      renderRail();
      renderSidebar();
      renderHeader();
      if (state.page !== "discover") renderPage();
    } else if (keep) {
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
      // некуда вернуться — домашняя страница, как маршрут /app по умолчанию
      openHome();
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
  if (!state.atEnd) {
    // лента показывает кусок истории: новое догрузится по пути вниз
    setTyping(message.channel, message.author_id, false);
    noteIncoming(message);
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

/**
 * Сообщение изменилось: правка, реакция, закрепление. Подменяется на месте —
 * канал от этого не становится непрочитанным, а лента не прыгает вниз.
 */
function onMessageUpdate(message) {
  if (!message || !message.id) return;
  markMine([message]);
  // в сохранённой истории канала — только замена: старое сообщение не дописывается в конец
  const cached = historyCache.get(message.channel);
  if (cached) {
    const at = cached.messages.findIndex((item) => item.id === message.id);
    if (at >= 0) cached.messages[at] = message;
  }
  if (message.channel !== state.channelId) return;
  // недоотправленное своё сообщение не трогаем: его заменит ответ сервера
  const index = state.messages.findIndex((item) => item.id === message.id && !item.pending);
  if (index < 0) return;
  state.messages[index] = message;
  renderMessages();
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
      // своё же прочтение, вернувшееся с сервера, уже учтено
      if (ownAcks.take(event.id, event.message_id)) break;
      const found = findChannel(event.id);
      if (!found) break;
      const channel = found.channel;
      const back = Boolean(channel.last_read && event.message_id < channel.last_read);
      channel.last_read = event.message_id;
      channel.unread = Boolean(channel.last_message_id && channel.last_message_id > event.message_id);
      if (!channel.unread) channel.mentions = 0;
      if (found.server) recountServer(found.server);
      renderRail();
      renderSidebar();
      // помечено непрочитанным в другом клиенте — разделитель «новое» на место
      if (back && state.channelId === channel.id) {
        state.ackHeld = channel.id;
        state.lastRead = event.message_id;
        renderMessages();
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
      // ник или аватар в упоминаниях
      if (event.data && (event.data.username || event.data.display_name || event.data.avatar)) invalidateMessageNodes();
      break;
    case "UserRelationship":
      // заявки в друзья и блокировки: «Друзья», бейдж и меню пользователя
      scheduleWorkspaceRefresh();
      break;
    case "ChannelGroupJoin":
    case "ChannelGroupLeave":
    case "ServerRoleUpdate":
    case "ServerRoleDelete":
      // число участников группы, роли в упоминаниях
      if (event.type.startsWith("ServerRole")) invalidateMessageNodes();
      else {
        membersCache.delete(event.id);
        if (memberKey() === event.id) loadMembers(event.id);
      }
      scheduleWorkspaceRefresh();
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
      forgetMentionUsers();
      if (serverId && membersCache.has(serverId)) {
        membersCache.delete(serverId);
        if (memberKey() === serverId) loadMembers(serverId);
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
      if (serverId === memberKey()) scheduleRender(renderMembers);
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
  // друзья: список «В сети» на странице «Друзья»
  for (const entry of ws ? ws.relationships || [] : []) {
    if (entry.user.id !== event.id) continue;
    const view = { online: entry.user.presence !== "Offline", presence: entry.user.presence, status: entry.user.status };
    patch(view);
    entry.user.presence = view.presence;
    entry.user.status = view.status;
    if (state.page === "friends") scheduleRender(renderPage);
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
  el("btn-sidebar").onclick = toggleSidebar;
  attachTooltip(el("btn-sidebar"), t("Toggle main sidebar"), "bottom");
  applySidebar();

  messagesEl.addEventListener("scroll", () => {
    const wasAtEnd = state.stickToBottom;
    state.stickToBottom = distanceFromBottom() < 40;
    // ушли от конца ленты — при возвращении канал прочитается
    if (wasAtEnd && !state.stickToBottom) state.ackHeld = null;
    if (messagesEl.scrollTop < 400) loadOlder();
    if (!state.atEnd && distanceFromBottom() < 400) loadNewer();
    if (state.stickToBottom && state.atEnd) {
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
    else if (!el("emoji-picker").classList.contains("hidden")) toggleEmojiPicker(false);
    else if (settingsOpen()) closeSettings();
    // KeybindAction.CLOSE_SIDEBAR: поиск и закреплённые закрываются по Escape
    else if (state.side.state !== "default") setSide({ state: "default" });
  });
  window.addEventListener("resize", closeMenus);
  window.addEventListener("focus", () => {
    // вернулись в окно — канал снова читается, как в оригинале по onFocus
    state.ackHeld = null;
    ackVisible();
  });
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
    if (key === "appearance:compact_mode" || key === "appearance:unicode_emoji") {
      invalidateMessageNodes();
      renderMessages();
    }
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
    await listen("stoat:message-update", (event) => {
      try {
        onMessageUpdate(JSON.parse(event.payload));
      } catch (error) {
        console.warn("плохое событие правки сообщения:", error);
      }
    });
  }

  // свои ссылки (каналы, приглашения) распознаются по адресу веб-клиента инстанса
  instanceInfo()
    .then((info) => setMarkdownOrigin(webOrigin(info)))
    .catch(() => {});

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
  invalidateMessageNodes();
  renderMessages();
  if (settingsOpen()) renderSettings();
}

boot();
