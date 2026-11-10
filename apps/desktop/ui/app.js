// Интерфейс клиента: рельс серверов, список каналов, чат.
// Всё состояние приходит из Rust, здесь только отрисовка.

const bridge = window.__TAURI__;
const invoke = bridge && bridge.core && bridge.core.invoke;
const listen = bridge && bridge.event && bridge.event.listen;

const el = (id) => document.getElementById(id);
const railList = el("rail-list");
const channelsEl = el("channels");
const messagesEl = el("messages");
const inputEl = el("input");
const sendBtn = el("btn-send");

const state = {
  me: null,
  media: new Map(),      // адрес → data-URL (что уже скачал Rust)
  mediaInFlight: new Map(),  // адрес → обещание загрузки
  workspace: null,
  serverId: null,      // null = личные сообщения
  channelId: null,
  messages: [],        // сообщения открытого канала
  collapsed: new Set(),
  sending: false,
  editing: null,
  loadingOlder: false,
  reachedStart: false,
};

// ─────────────────────────── мелкие помощники ──────────────────────────────

function initial(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}

function avatarEl(url, name, size) {
  const node = document.createElement("div");
  node.className = "avatar";
  if (size) {
    node.style.width = node.style.height = node.style.flexBasis = size + "px";
  }
  node.textContent = initial(name);
  if (url) {
    mediaUrl(url).then((data) => {
      if (!data) return;
      const img = document.createElement("img");
      img.alt = "";
      img.onerror = () => img.remove();
      img.src = data;
      node.textContent = "";
      node.appendChild(img);
    });
  }
  return node;
}

// WebView2 не грузит сторонние картинки на встроенных страницах, поэтому
// файлы скачивает Rust и отдаёт готовые data-URL.
function mediaUrl(url) {
  if (!url) return Promise.resolve(null);
  if (state.media.has(url)) return Promise.resolve(state.media.get(url));
  // Раньше второй запрос того же файла возвращал null, и аватар навсегда
  // оставался буквой. Теперь все ждут одну и ту же загрузку.
  const running = state.mediaInFlight.get(url);
  if (running) return running;

  const task = call("fetch_media", { url })
    .then((data) => {
      state.media.set(url, data || null);
      return data || null;
    })
    .catch((error) => {
      console.warn("не удалось загрузить файл:", url, error);
      state.media.set(url, null);
      return null;
    })
    .finally(() => {
      state.mediaInFlight.delete(url);
    });

  state.mediaInFlight.set(url, task);
  return task;
}

// Подставить картинку, когда она загрузится.
function lazyImage(url, alt, className) {
  const img = document.createElement("img");
  if (className) img.className = className;
  img.alt = alt || "";
  img.loading = "lazy";
  mediaUrl(url).then((data) => {
    if (data) img.src = data;
  });
  return img;
}

function fillAvatar(node, data, name) {
  if (!node.isConnected && !node.childElementCount && !data) return;
  const img = document.createElement("img");
  img.alt = "";
  img.onerror = () => img.remove();
  img.src = data;
  node.textContent = "";
  node.title = name || "";
  node.appendChild(img);
}

let toastTimer = null;
function toast(text, kind = "") {
  const node = el("toast");
  node.textContent = text;
  node.className = "toast " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add("hidden"), 3200);
}

function setConn(kind, text) {
  const node = el("conn");
  node.className = "conn " + kind;
  el("conn-text").textContent = text;
}

function timeText(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayText(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const yesterday = new Date(today.getTime() - 86400000);
  if (same(date, today)) return "Сегодня";
  if (same(date, yesterday)) return "Вчера";
  return date.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
}

// Ссылки в тексте делаем кликабельными, остальное — как есть (без innerHTML).
const URL_RE = /(https?:\/\/[^\s<]+)/g;

// Эмодзи ищем по коду символа и грузим картинку из статики Stoat,
// как это делает браузерный клиент (пути к файлам там же).
const EMOJI_RE = /(\p{Extended_Pictographic}(?:\u200D\p{Extended_Pictographic}|\uFE0F|\u{1F3FB}-\u{1F3FF})*)/gu;
const emojiCache = new Map();
let emojiPack = null;

// Набор эмодзи (twemoji или noto) ядро определяет само; запоминаем,
// чтобы не спрашивать его для каждой картинки.
function noteEmojiPack(pack) {
  if (pack && pack !== emojiPack) emojiPack = pack;
}

function emojiCodepoint(text) {
  const points = [];
  for (const symbol of text) {
    const code = symbol.codePointAt(0);
    // модификаторы и склейки в имя файла не входят
    if (code === 0xfe0f || (code >= 0x1f3fb && code <= 0x1f3ff)) continue;
    points.push(code.toString(16));
  }
  return points.join("-");
}

function emojiNode(text) {
  const slot = document.createElement("span");
  slot.className = "emoji";
  slot.textContent = text;
  const codepoint = emojiCodepoint(text);
  if (!codepoint) return slot;

  const cached = emojiCache.get(codepoint);
  if (cached) {
    if (cached !== "none") slot.replaceChildren(lazyImage(cached, text, "emoji-img"));
    return slot;
  }

  call("fetch_emoji", { codepoint, pack: emojiPack })
    .then((data) => {
      emojiCache.set(codepoint, data || "none");
      if (!data) return;
      const img = lazyImage(data, text, "emoji-img");
      slot.replaceChildren(img);
    })
    .catch(() => {
      emojiCache.set(codepoint, "none");
    });
  return slot;
}

// Иконка канала в Stoat — это эмодзи, а не «#».
function channelIconNode(channel, target) {
  const emoji = channel.emoji;
  if (!emoji) return false;
  const slot = document.createElement("span");
  slot.className = "emoji channel-emoji";
  slot.textContent = "💬";
  target.replaceChildren(slot);
  call("fetch_emoji", { codepoint: emoji, pack: emojiPack })
    .then((data) => {
      if (!data) throw new Error("нет картинки");
      slot.replaceChildren(lazyImage(data, channel.name, "emoji-img"));
    })
    .catch(() => {
      // если картинка недоступна — показываем сам эмодзи символом
      slot.textContent = emojiSymbol(emoji);
    });
  return true;
}

// `1f600` → сама пиктограмма, чтобы иконка не исчезала без интернета.
function emojiSymbol(codepoint) {
  try {
    return codepoint
      .split("-")
      .map((part) => String.fromCodePoint(parseInt(part, 16)))
      .join("");
  } catch {
    return "#";
  }
}

// Текст с эмодзи и ссылками.
function richText(text) {
  const frag = document.createDocumentFragment();
  let rest = text;

  while (rest.length) {
    // ссылка
    URL_RE.lastIndex = 0;
    const linkMatch = URL_RE.exec(rest);
    // эмодзи
    EMOJI_RE.lastIndex = 0;
    const emojiMatch = EMOJI_RE.exec(rest);

    const linkAt = linkMatch ? linkMatch.index : Infinity;
    const emojiAt = emojiMatch ? emojiMatch.index : Infinity;

    if (linkAt === Infinity && emojiAt === Infinity) {
      frag.appendChild(document.createTextNode(rest));
      break;
    }

    if (linkAt <= emojiAt) {
      if (linkAt > 0) frag.appendChild(document.createTextNode(rest.slice(0, linkAt)));
      const info = messageLinkInfo(linkMatch[0]);
      if (info) {
        frag.appendChild(messageLinkNode(info, linkMatch[0]));
      } else {
        const link = document.createElement("a");
        link.href = linkMatch[0];
        link.textContent = linkMatch[0];
        link.target = "_blank";
        link.rel = "noreferrer";
        frag.appendChild(link);
      }
      rest = rest.slice(linkAt + linkMatch[0].length);
    } else {
      if (emojiAt > 0) frag.appendChild(document.createTextNode(rest.slice(0, emojiAt)));
      frag.appendChild(emojiNode(emojiMatch[0]));
      rest = rest.slice(emojiAt + emojiMatch[0].length);
    }
  }
  return frag;
}

// Оформление сообщения по узлам от ядра (жирный, код, ссылка, спойлер).
function segmentsNode(message) {
  const wrap = document.createDocumentFragment();
  const parts = message.segments && message.segments.length
    ? message.segments
    : [{ kind: "text", text: message.content || "" }];

  for (const part of parts) {
    if (part.kind === "text") {
      wrap.appendChild(richText(part.text));
      continue;
    }
    if (part.kind === "link") {
      const href = part.href || part.text;
      const info = messageLinkInfo(href);
      if (info) {
        wrap.appendChild(messageLinkNode(info, href));
        continue;
      }
      const link = document.createElement("a");
      link.href = href;
      link.textContent = part.text;
      link.target = "_blank";
      link.rel = "noreferrer";
      wrap.appendChild(link);
      continue;
    }
    const node = document.createElement(part.kind === "codeblock" ? "pre" : "span");
    node.className = "md-" + part.kind;
    if (part.kind === "codeblock") {
      node.textContent = part.text;
    } else {
      node.appendChild(richText(part.text));
    }
    wrap.appendChild(node);
  }
  return wrap;
}

// Цвет ника приходит строкой вида `#ff0000` или `hsl(0, 100%, 50%)`,
// а может прийти и числом 0xff0000 — приводим к CSS.
function colourCss(value) {
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    return "#" + Number(text).toString(16).padStart(6, "0").slice(-6);
  }
  return text;
}

// Карточка встраивания: превью сайта или прямая картинка по ссылке.
function embedNode(embed) {
  const box = document.createElement("div");
  box.className = "embed embed-" + (embed.kind || "website");

  // картинка идёт сверху и растягивается по ширине карточки
  if (embed.image) {
    const img = lazyImage(embed.image, embed.title || "");
    img.className = "embed-image";
    if (embed.width && embed.height) {
      img.style.aspectRatio = embed.width + " / " + embed.height;
    }
    box.appendChild(img);
    // прямая картинка — без лишней рамки и подложки
    if (embed.kind === "image") {
      box.classList.add("embed-bare");
      return box;
    }
  }

  const head = document.createElement("div");
  head.className = "embed-head";
  if (embed.site) {
    const site = document.createElement("span");
    site.className = "embed-site";
    site.textContent = embed.site;
    head.appendChild(site);
  }
  if (embed.title) {
    const title = document.createElement("a");
    title.className = "embed-title";
    title.textContent = embed.title;
    title.href = embed.url || "#";
    title.target = "_blank";
    title.rel = "noreferrer";
    head.appendChild(title);
  }
  if (head.childElementCount) box.appendChild(head);

  if (embed.description) {
    const text = document.createElement("div");
    text.className = "embed-text";
    text.appendChild(richText(embed.description));
    box.appendChild(text);
  }
  return box;
}

// Ссылка на сообщение внутри текста: у Stoat она выглядит кнопкой
// с названием канала, а не голым адресом.
const MESSAGE_LINK_RE = /^https?:\/\/(?:stoat\.chat|rvlt\.gg)\/(server\/[^/\s]+\/)?channel\/([^/\s]+)\/([^/\s?#]+)/i;

function messageLinkInfo(href) {
  const match = MESSAGE_LINK_RE.exec(href || "");
  if (!match) return null;
  return { server: match[1] ? match[1].split("/")[1] : null, channel: match[2], message: match[3] };
}

function messageLinkNode(info, fallbackHref) {
  const button = document.createElement("button");
  button.className = "msg-link";
  button.type = "button";
  button.appendChild(jumpIcon());

  const label = channelLabel(info.channel);
  const name = document.createElement("span");
  name.className = "msg-link-name";
  name.textContent = label;
  button.appendChild(name);

  button.title = "Перейти к сообщению";
  button.onclick = () => jumpToMessage(info).catch((error) => toast(describe(error), "error"));
  return button;
}

// Значок «стрелка в сообщение», как в веб-клиенте.
function jumpIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "msg-link-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute(
    "d",
    "M3 2.5a.5.5 0 0 1 .8-.4l4 3.5a.5.5 0 0 1 0 .8l-4 3.5a.5.5 0 0 1-.8-.4v-7Z"
  );
  svg.appendChild(path);
  return svg;
}

function channelName(channelId) {
  const ws = state.workspace;
  if (!ws) return null;
  for (const server of ws.servers) {
    for (const category of server.categories) {
      const found = category.channels.find((item) => item.id === channelId);
      if (found) return found.name;
    }
  }
  const dm = ws.dms.find((item) => item.id === channelId);
  return dm ? dm.name : null;
}

function channelLabel(channelId) {
  return channelName(channelId) || "сообщение";
}

// Перейти к сообщению: открыть канал, найти его в ленте и подсветить.
async function jumpToMessage(info) {
  const channel = findChannel(info.channel);
  if (!channel) {
    await copyText(`https://stoat.chat/channel/${info.channel}/${info.message}`);
    toast("Канал недоступен — ссылка скопирована");
    return;
  }
  if (state.channelId !== info.channel) await openChannel(channel);
  await focusMessage(info.message);
}

function findChannel(channelId) {
  const ws = state.workspace;
  if (!ws) return null;
  for (const server of ws.servers) {
    for (const category of server.categories) {
      const found = category.channels.find((item) => item.id === channelId);
      if (found) return { ...found, serverId: server.id };
    }
  }
  return ws.dms.find((item) => item.id === channelId) || null;
}

// Ищем сообщение в ленте; если его ещё нет — догружаем историю вверх.
async function focusMessage(messageId, depth = 0) {
  const hit = messagesEl.querySelector(`.msg[data-id="${messageId}"]`);
  if (hit) {
    hit.classList.add("flash");
    hit.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => hit.classList.remove("flash"), 1600);
    return;
  }
  if (depth >= 8 || state.reachedStart) {
    toast("Сообщение не найдено в загруженной истории", "error");
    return;
  }
  await loadOlder();
  await focusMessage(messageId, depth + 1);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // запасной путь, если буфер обмена недоступен
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
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

// ─────────────────────────── рельс серверов ────────────────────────────────

function renderRail() {
  const ws = state.workspace;
  railList.textContent = "";
  if (!ws) return;

  const home = document.createElement("button");
  home.className = "rail-btn home" + (state.serverId === null ? " active" : "");
  home.title = "Личные сообщения";
  home.innerHTML = '<span class="marker"></span>';
  home.appendChild(document.createTextNode("✉"));
  home.onclick = () => selectServer(null);
  railList.appendChild(home);

  if (ws.servers.length) {
    const sep = document.createElement("div");
    sep.className = "rail-sep";
    railList.appendChild(sep);
  }

  for (const server of ws.servers) {
    const button = document.createElement("button");
    button.className = "rail-btn" + (state.serverId === server.id ? " active" : "");
    button.title = server.name;
    button.innerHTML = '<span class="marker"></span>';
    button.appendChild(document.createTextNode(server.initial));
    if (server.icon) {
      mediaUrl(server.icon).then((data) => {
        if (!data) return;
        const img = document.createElement("img");
        img.alt = "";
        img.onerror = () => img.remove();
        img.src = data;
        button.textContent = "";
        button.appendChild(img);
      });
    }
    button.onclick = () => selectServer(server.id);
    railList.appendChild(button);
  }
}

// ─────────────────────────── список каналов ────────────────────────────────

function renderChannels() {
  const ws = state.workspace;
  channelsEl.textContent = "";
  if (!ws) return;

  if (state.serverId === null) {
    el("server-name").textContent = "Личные сообщения";
    if (!ws.dms.length) {
      const note = document.createElement("div");
      note.className = "category-label";
      note.textContent = "пока нет переписок";
      channelsEl.appendChild(note);
      return;
    }
    for (const dm of ws.dms) {
      channelsEl.appendChild(channelButton(dm));
    }
    return;
  }

  const server = ws.servers.find((item) => item.id === state.serverId);
  if (!server) {
    el("server-name").textContent = "Сервер";
    return;
  }
  el("server-name").textContent = server.name;

  if (!server.categories.length) {
    const note = document.createElement("div");
    note.className = "category-label";
    note.textContent = "нет доступных каналов";
    channelsEl.appendChild(note);
    return;
  }

  for (const category of server.categories) {
    const key = server.id + "/" + category.id;
    const collapsed = state.collapsed.has(key);

    const label = document.createElement("div");
    label.className = "category-label" + (collapsed ? " collapsed" : "");
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "▼";
    label.appendChild(caret);
    label.appendChild(document.createTextNode(category.title));
    label.onclick = () => {
      if (collapsed) state.collapsed.delete(key);
      else state.collapsed.add(key);
      renderChannels();
    };
    channelsEl.appendChild(label);

    if (collapsed) continue;
    for (const channel of category.channels) {
      channelsEl.appendChild(channelButton(channel));
    }
  }
}

function channelButton(channel) {
  const button = document.createElement("button");
  button.className = "channel" + (state.channelId === channel.id ? " active" : "");
  button.title = channel.name;

  const hash = document.createElement("span");
  hash.className = "hash";
  const symbol = channel.kind === "voice" ? "🔊" : channel.kind === "dm" ? "@" : "#";
  hash.textContent = symbol;
  button.appendChild(hash);

  // У канала может быть своя иконка-эмодзи: рисуем её вместо «#».
  channelIconNode(channel, hash);

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = channel.name;
  button.appendChild(name);

  button.onclick = () => openChannel(channel);
  return button;
}

function selectServer(serverId) {
  state.serverId = serverId;
  renderRail();
  renderChannels();

  const ws = state.workspace;
  if (!ws) return;
  let first = null;
  if (serverId === null) {
    first = ws.dms[0] || null;
  } else {
    const server = ws.servers.find((item) => item.id === serverId);
    first = server && server.categories.length ? server.categories[0].channels[0] : null;
  }
  if (first) openChannel(first);
  else closeChannel();
}

// ─────────────────────────── чат ───────────────────────────────────────────

function closeChannel() {
  state.channelId = null;
  state.messages = [];
  el("chat-title").textContent = "Выберите канал";
  el("chat-sub").textContent = "";
  el("chat-hash").textContent = "#";
  inputEl.value = "";
  inputEl.disabled = true;
  inputEl.placeholder = "Выберите канал";
  sendBtn.disabled = true;
  messagesEl.textContent = "";
  showEmpty("Выберите канал слева", "Список серверов и каналов — слева");
}

function showEmpty(title, text) {
  messagesEl.textContent = "";
  const box = document.createElement("div");
  box.className = "empty";
  const icon = document.createElement("div");
  icon.className = "empty-icon";
  icon.textContent = "💬";
  const head = document.createElement("div");
  head.className = "empty-title";
  head.textContent = title;
  const sub = document.createElement("div");
  sub.className = "empty-text";
  sub.textContent = text || "";
  box.append(icon, head, sub);
  messagesEl.appendChild(box);
}

async function openChannel(channel) {
  if (!channel) return;
  state.channelId = channel.id;
  state.messages = [];
  state.editing = null;
  renderChannels();

  el("chat-title").textContent = channel.name;
  el("chat-sub").textContent = channel.description || "";
  el("chat-hash").textContent = channel.kind === "voice" ? "🔊" : channel.kind === "dm" ? "@" : "#";
  channelIconNode(channel, el("chat-hash"));
  inputEl.disabled = false;
  inputEl.placeholder = "Написать в #" + channel.name;
  inputEl.focus();

  messagesEl.textContent = "";
  const loading = document.createElement("div");
  loading.className = "empty";
  loading.innerHTML = '<div class="spinner"></div>';
  messagesEl.appendChild(loading);

  try {
    const history = await call("channel_history", { channelId: channel.id, limit: 50 });
    if (state.channelId !== channel.id) return; // пользователь уже ушёл в другой канал
    state.messages = markMine(history.messages || []);
    state.reachedStart = history.has_more === false || !state.messages.length;
    renderMessages(true);
    resolveAvatars();
  } catch (error) {
    showEmpty("Не удалось загрузить историю", describe(error));
  }
}

// Старые сообщения подгружаются при прокрутке вверх, как в веб-клиенте.
async function loadOlder() {
  if (state.loadingOlder || state.reachedStart) return;
  const oldest = state.messages[0];
  if (!oldest) return;
  const channelId = state.channelId;
  state.loadingOlder = true;
  const before = el("messages").scrollHeight;
  try {
    const page = await call("channel_history", {
      channelId,
      before: oldest.id,
      limit: 50,
    });
    if (state.channelId !== channelId) return;
    const older = markMine(page.messages || []);
    if (!older.length) {
      state.reachedStart = true;
      return;
    }
    if (page.has_more === false) state.reachedStart = true;
    // запоминаем, где был верх, чтобы лента не прыгнула
    const anchor = messagesEl.firstChild;
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
    state.messages = older.concat(state.messages);
    renderMessages(false);
    if (anchor) {
      const shift = anchor.getBoundingClientRect().top - anchorTop;
      messagesEl.scrollTop += shift;
    } else {
      messagesEl.scrollTop = messagesEl.scrollHeight - before;
    }
  } catch (error) {
    console.warn("не удалось подгрузить старые сообщения:", error);
    state.reachedStart = true;
  } finally {
    state.loadingOlder = false;
  }
}

// Ядро не знает, кто «я», поэтому свою пометку ставим здесь.
function markMine(list) {
  for (const message of list) {
    if (message) message.mine = Boolean(state.me && message.author_id === state.me.id);
  }
  return list;
}

// Дозапрос профилей: в сообщении часто нет файла аватара, только автор.
// Делаем это один раз на автора и параллельно, иначе лента «моргает» буквами.
function resolveAvatars() {
  const seen = new Set();
  const nodes = messagesEl.querySelectorAll(".msg-avatar [data-author]");
  for (const node of nodes) {
    const authorId = node.dataset.author;
    if (!authorId || seen.has(authorId)) continue;
    seen.add(authorId);
    const key = "avatar:" + authorId;
    const name = node.dataset.name || "?";
    const apply = (data) => {
      if (data) fillAvatar(node, data, name);
    };
    if (state.media.has(key)) {
      const known = state.media.get(key);
      if (known) mediaUrl(known).then(apply);
      continue;
    }
    call("user_avatar", { userId: authorId })
      .then((url) => {
        state.media.set(key, url || null);
        if (!url) return null;
        return mediaUrl(url);
      })
      .then((data) => {
        if (data) apply(data);
      })
      .catch(() => state.media.set(key, null));
  }
}

function renderMessages(scrollToEnd = false) {
  const messages = state.messages;
  messagesEl.textContent = "";

  if (!messages.length) {
    showEmpty("Здесь пока нет сообщений", "Напишите первым — поле ввода внизу");
    return;
  }

  let previous = null;
  for (const message of messages) {
    const sameDay = previous && dayText(previous.timestamp) === dayText(message.timestamp);
    if (!sameDay) {
      const sep = document.createElement("div");
      sep.className = "day-sep";
      sep.textContent = dayText(message.timestamp);
      messagesEl.appendChild(sep);
      previous = null;
    }

    // группировка: тот же автор и меньше 5 минут — прячем аватар и имя
    const close = previous
      && previous.author_id === message.author_id
      && !message.system
      && new Date(message.timestamp) - new Date(previous.timestamp) < 5 * 60 * 1000;

    messagesEl.appendChild(messageNode(message, close));
    previous = message;
  }

  if (scrollToEnd) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function messageNode(message, grouped) {
  const row = document.createElement("div");
  row.className = "msg" + (grouped ? " grouped" : "") + (message.system ? " system" : "");
  row.dataset.id = message.id;

  const avatarBox = document.createElement("div");
  avatarBox.className = "msg-avatar";
  if (!grouped) {
    const node = avatarEl(message.avatar, message.author, 40);
    node.dataset.author = message.author_id;
    node.dataset.name = message.author;
    node.title = message.author;
    avatarBox.appendChild(node);
  }
  row.appendChild(avatarBox);

  const body = document.createElement("div");
  body.className = "msg-body";

  if (!grouped) {
    const head = document.createElement("div");
    head.className = "msg-head";
    const author = document.createElement("span");
    author.className = "msg-author";
    author.textContent = message.author;
    author.title = message.author_id;
    author.style.color = message.colour
      ? colourCss(message.colour)
      : message.mine ? "var(--accent)" : "";
    const time = document.createElement("span");
    time.className = "msg-time";
    time.textContent = timeText(message.timestamp);
    time.title = new Date(message.timestamp).toLocaleString();
    head.append(author, time);
    if (message.edited) {
      const edited = document.createElement("span");
      edited.className = "msg-edited";
      edited.textContent = "(изменено)";
      head.appendChild(edited);
    }
    body.appendChild(head);
  }

  const text = document.createElement("div");
  text.className = "msg-text";
  text.appendChild(segmentsNode(message));
  body.appendChild(text);

  if (message.attachments && message.attachments.length) {
    const box = document.createElement("div");
    box.className = "attachments";
    for (const file of message.attachments) {
      if (file.kind === "image" && file.url) {
        const img = lazyImage(file.url, file.name);
        img.title = file.name;
        box.appendChild(img);
      } else {
        const link = document.createElement(file.url ? "a" : "div");
        link.className = "attachment-file";
        if (file.url) {
          link.href = file.url;
          link.target = "_blank";
          link.rel = "noreferrer";
        }
        link.textContent = `📎 ${file.name} ${humanSize(file.size)}`;
        box.appendChild(link);
      }
    }
    body.appendChild(box);
  }

  if (message.embeds && message.embeds.length) {
    const box = document.createElement("div");
    box.className = "embeds";
    for (const embed of message.embeds) box.appendChild(embedNode(embed));
    body.appendChild(box);
  }

  // ссылка на сообщение: копируется по правому клику, как в браузере
  row.title = "Правый клик — скопировать ссылку на сообщение";
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    copyMessageLink(message);
  });

  // действия: изменить и удалить можно только свои
  if (message.mine) {
    const tools = document.createElement("div");
    tools.className = "msg-tools";

    const edit = document.createElement("button");
    edit.textContent = "✎";
    edit.title = "Изменить";
    edit.onclick = () => startEdit(message);
    tools.appendChild(edit);

    const remove = document.createElement("button");
    remove.textContent = "🗑";
    remove.title = "Удалить";
    remove.onclick = () => removeMessage(message);
    tools.appendChild(remove);

    row.appendChild(tools);
  }

  row.appendChild(body);
  return row;
}

// Адрес сообщения собирает ядро (там же, где ссылки для плагинов),
// интерфейс только копирует его в буфер обмена.
async function copyMessageLink(message) {
  let link;
  try {
    link = await call("message_link", {
      server: state.serverId,
      channel: message.channel || state.channelId,
      message: message.id,
    });
  } catch {
    link = `https://stoat.chat/channel/${message.channel || state.channelId}/${message.id}`;
  }
  await copyText(link);
  toast("Ссылка на сообщение скопирована");
}

function startEdit(message) {
  if (!state.channelId) return;
  state.editing = message.id;
  inputEl.value = message.content || "";
  inputEl.placeholder = "Изменить сообщение — Esc отменит";
  el("composer-hint").textContent = "Режим изменения: Enter — сохранить, Esc — отмена";
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
}

function stopEdit() {
  state.editing = null;
  inputEl.value = "";
  el("composer-hint").textContent = "";
  const channel = currentChannel();
  inputEl.placeholder = channel ? "Написать в #" + channel.name : "Выберите канал";
}

async function removeMessage(message) {
  try {
    await call("delete_message", { channelId: message.channel, messageId: message.id });
    state.messages = state.messages.filter((item) => item.id !== message.id);
    renderMessages();
    toast("Сообщение удалено", "ok");
  } catch (error) {
    toast("Не удалось удалить: " + describe(error), "err");
  }
}

function currentChannel() {
  const ws = state.workspace;
  if (!ws || !state.channelId) return null;
  for (const dm of ws.dms) if (dm.id === state.channelId) return dm;
  for (const server of ws.servers) {
    for (const category of server.categories) {
      for (const channel of category.channels) {
        if (channel.id === state.channelId) return channel;
      }
    }
  }
  return null;
}

// ─────────────────────────── отправка ──────────────────────────────────────

async function submit() {
  const value = inputEl.value.trim();
  if (!value || !state.channelId || state.sending) return;

  if (state.editing) {
    const id = state.editing;
    try {
      const updated = await call("edit_message", {
        channelId: state.channelId, messageId: id, content: value,
      });
      const index = state.messages.findIndex((item) => item.id === id);
      if (index >= 0) {
        state.messages[index] = markMine([{ ...state.messages[index], ...updated }])[0];
      }
      stopEdit();
      renderMessages();
    } catch (error) {
      toast("Не удалось изменить: " + describe(error), "err");
    }
    return;
  }

  const channelId = state.channelId;
  state.sending = true;
  sendBtn.disabled = true;
  inputEl.value = "";

  try {
    const sent = await call("send_message", { channelId, content: value });
    if (state.channelId === channelId && sent) {
      // не дублируем: то же сообщение могло уже прийти через gateway
      if (!state.messages.some((item) => item.id === sent.id)) {
        state.messages.push(markMine([sent])[0]);
        renderMessages(true);
        resolveAvatars();
      }
    }
  } catch (error) {
    inputEl.value = value; // возвращаем текст, чтобы не потерялся
    toast("Не отправлено: " + describe(error), "err");
  } finally {
    state.sending = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

// ─────────────────────────── ошибки ────────────────────────────────────────

const KNOWN_CODES = [
  "InvalidCredentials", "AccountDisabled", "EmailNotVerified", "Banned",
  "RateLimited", "Unauthorized", "MissingPermission", "NotFound",
  "TooManyMessages", "EmptyMessage", "PayloadTooLarge", "NotOwner",
];

function describe(error) {
  const text = String((error && (error.message || error.kind || error)) || "");
  for (const code of KNOWN_CODES) {
    if (!text.includes(code)) continue;
    if (code === "RateLimited") return "слишком часто — подождите немного";
    if (code === "MissingPermission") return "нет прав на это действие";
    if (code === "NotFound") return "не найдено (возможно, удалено)";
    if (code === "EmptyMessage") return "пустое сообщение";
    if (code === "PayloadTooLarge") return "слишком длинное сообщение";
    if (code === "Unauthorized") return "сессия истекла — войдите заново";
    return code;
  }
  if (text.includes("network") || text.includes("сетевая")) return "нет связи с сервером";
  return text || "неизвестная ошибка";
}

// ─────────────────────────── связь с ядром ────────────────────────────────

async function call(cmd, args = {}) {
  if (!invoke) throw new Error("нет моста Tauri");
  return await invoke(cmd, args);
}

async function loadWorkspace() {
  const ws = await call("workspace");
  state.workspace = ws;
  state.me = ws.me;

  if (ws.me) {
    el("me-name").textContent = ws.me.display_name || `${ws.me.username}#${ws.me.discriminator}`;
    el("menu-name").textContent = el("me-name").textContent;
    el("menu-id").textContent = `${ws.me.username}#${ws.me.discriminator}`;
    el("me-avatar").textContent = initial(el("me-name").textContent);
  }

  renderRail();
  renderChannels();

  // открываем канал: прошлый выбор или первый доступный
  const keep = state.channelId && currentChannel();
  if (keep) {
    openChannel(keep);
  } else if (ws.last_channel) {
    state.serverId = serverOfChannel(ws.last_channel);
    renderRail();
    renderChannels();
    const channel = currentChannel();
    if (channel) openChannel(channel);
    else closeChannel();
  } else if (ws.servers.length) {
    selectServer(ws.servers[0].id);
  } else {
    selectServer(null);
  }
}

function serverOfChannel(channelId) {
  const ws = state.workspace;
  if (!ws) return null;
  for (const dm of ws.dms) if (dm.id === channelId) return null;
  for (const server of ws.servers) {
    for (const category of server.categories) {
      for (const channel of category.channels) {
        if (channel.id === channelId) return server.id;
      }
    }
  }
  return null;
}

// ─────────────────────────── события gateway ──────────────────────────────

// Вставить пришедшее сообщение в открытую ленту.
function addIncoming(message) {
  if (!message || !message.id) return;
  if (message.channel && message.channel !== state.channelId) return;
  const index = state.messages.findIndex((item) => item.id === message.id);
  if (index >= 0) {
    // пришло обновление того же сообщения (правка текста или эмбедов)
    state.messages[index] = message;
    renderMessages();
    resolveAvatars();
    return;
  }
  markMine([message]);
  const nearBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 160;
  state.messages.push(message);
  renderMessages(nearBottom);
  resolveAvatars();
}

async function onGateway(payload) {
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return;
  }
  const type = event.type || event.Type;
  const source = event.data || event.Data || {};

  if (type === "Ready") {
    setConn("ok", "подключено");
    await loadWorkspace();
    return;
  }
  if (type === "Authenticated") {
    setConn("warn", "авторизация…");
    return;
  }
  if (type === "Error") {
    setConn("err", "ошибка подключения");
    toast("Gateway: " + (source.type || "ошибка"), "err");
    return;
  }

  // ядро присылает уже собранное сообщение (с вебхуком, цветом и эмбедами)
  if (type === "MessageView") {
    addIncoming(source);
    return;
  }

  if (type === "Message") {
    if (source.channel !== state.channelId) return;
    // старый путь на случай, если пришло сырое событие
    addIncoming(source);
    return;
  }

  if (type === "MessageUpdate") {
    // содержимое приедет отдельным событием `stoat:message` из ядра
    return;
  }

  if (type === "MessageDelete") {
    const before = state.messages.length;
    state.messages = state.messages.filter((item) => item.id !== source.id);
    if (state.messages.length !== before) renderMessages();
  }
}

// ─────────────────────────── меню аккаунта ────────────────────────────────

function toggleAccountMenu(event) {
  event.stopPropagation();
  el("account-menu").classList.toggle("hidden");
}

async function logout() {
  try {
    await call("logout");
  } catch { /* локально всё равно выходим */ }
  try { localStorage.removeItem("stoat.session.token"); } catch { /* нет доступа */ }
  location.replace("login.html");
}

function switchAccount() {
  // выходим только из локальной сессии, чтобы ввести другой аккаунт
  location.replace("login.html");
}

// ─────────────────────────── запуск ───────────────────────────────────────

async function boot() {
  if (!invoke) {
    document.body.innerHTML =
      '<div style="display:grid;place-items:center;height:100vh;font-family:system-ui;color:#e8eaf0;text-align:center">' +
      "<div><h2>Нет связи с ядром приложения</h2>" +
      "<p style='color:#8b93a3'>Это ошибка сборки, а не ваших данных.</p></div></div>";
    return;
  }

  messagesEl.addEventListener("scroll", () => {
    if (messagesEl.scrollTop < 240) loadOlder();
  });

  sendBtn.onclick = submit;
  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
    if (event.key === "Escape") stopEdit();
  });

  el("btn-logout").onclick = logout;
  el("menu-logout").onclick = logout;
  el("menu-switch").onclick = switchAccount;
  el("rail-me").onclick = toggleAccountMenu;
  el("btn-refresh").onclick = async () => {
    toast("Обновляю…");
    await loadWorkspace();
  };
  document.addEventListener("click", (event) => {
    const menu = el("account-menu");
    if (!menu.classList.contains("hidden") && !menu.contains(event.target)) {
      menu.classList.add("hidden");
    }
  });

  // сессия есть?
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

  if (listen) await listen("stoat:gateway", (event) => onGateway(event.payload));
  if (listen) {
    await listen("stoat:message", (event) => {
      try {
        addIncoming(JSON.parse(event.payload));
      } catch (error) {
        console.warn("плохое событие сообщения:", error);
      }
    });
  }

  setConn("warn", "подключаюсь…");
  try {
    await call("connect_gateway");
    setConn("ok", "подключено");
  } catch (error) {
    setConn("err", "нет соединения");
    toast("Не удалось подключиться: " + describe(error), "err");
  }

  try {
    await loadWorkspace();
  } catch (error) {
    showEmpty("Не удалось получить данные", describe(error));
    toast("Ошибка: " + describe(error), "err");
  }
}

boot();
