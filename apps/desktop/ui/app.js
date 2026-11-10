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

// ── спрайты эмодзи в комплекте (twemoji), как в официальном клиенте
const spriteFiles = new Map();   // номер файла → массив строк
const spriteWaiters = new Map(); // номер файла → обещание загрузки

function spriteEntry(codepoint) {
  const map = window.EMOJI_MAP;
  if (!map) return null;
  return map[codepoint] || null;
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
  const svg = spriteFiles.get(file)[line];
  if (!svg) return null;
  // картинку собираем прямо в памяти: сеть не нужна
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
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

  // сначала комплект в приложении — он работает и без интернета
  spriteUrl(codepoint).then((data) => {
    if (!data) return;
    emojiCache.set(codepoint, data);
    if (!slot.isConnected) return;
    slot.replaceChildren(lazyImage(data, text, "emoji-img"));
  });

  call("fetch_emoji", { codepoint, pack: emojiPack })
    .then((data) => {
      // «не нашлось» не запоминаем навсегда: набор картинок мог ещё не
      // определиться, иначе один промах ломал эмодзи до перезапуска
      if (!data) return;
      emojiCache.set(codepoint, data);
      if (!slot.isConnected) return;
      slot.replaceChildren(lazyImage(data, text, "emoji-img"));
    })
    .catch(() => {});
  return slot;
}

// ── 2. эмодзи сервера: приходят как `:имя:` и рисуются картинкой
const serverEmojiCache = new Map();   // "сервер/имя" → адрес картинки
const serverEmojiData = new Map();    // id сервера → список для выбора
const SERVER_EMOJI_RE = /:([A-Za-z][A-Za-z0-9_]{1,31}):/;

// Карта из сообщения: имена, которые ядро нашло в тексте.
function serverEmojiUrl(name, map) {
  return (map && map[name]) || null;
}

// Подставить адреса в карту сообщения из уже загруженного списка сервера.
function fillServerEmoji(message) {
  if (!message.emoji) return message.emoji;
  const serverId = state.serverId;
  if (serverId === null) return message.emoji;
  const list = serverEmojiData.get(serverId);
  if (!list) return message.emoji;
  for (const name of Object.keys(message.emoji)) {
    if (message.emoji[name]) continue;
    const found = list.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (found) message.emoji[name] = found.url || "";
  }
  return message.emoji;
}

// Загрузить список эмодзи текущего сервера (один запрос на сервер).
async function loadServerEmoji(serverId) {
  if (serverId === null || serverEmojiData.has(serverId)) return;
  serverEmojiData.set(serverId, []);
  try {
    const list = await call("server_emojis", { serverId });
    serverEmojiData.set(serverId, list || []);
    renderEmojiPicker();
    // догружаем картинки в уже показанные сообщения
    renderMessages();
  } catch (error) {
    console.warn("не удалось получить эмодзи сервера:", error);
  }
}

// Иконка канала в Stoat — обычная картинка-файл (`icon`), поэтому её
// скачивает ядро и отдаёт готовой, как аватар.
function channelIconNode(channel, target) {
  if (!channel.icon) return false;
  mediaUrl(channel.icon).then((data) => {
    if (!data) return;
    const img = document.createElement("img");
    img.className = "channel-icon";
    img.alt = "";
    img.src = data;
    target.replaceChildren(img);
  });
  return true;
}

// Текст с эмодзи и ссылками. `map` — эмодзи сервера из сообщения.
function richText(text, map) {
  const frag = document.createDocumentFragment();
  let rest = text;

  while (rest.length) {
    URL_RE.lastIndex = 0;
    const linkMatch = URL_RE.exec(rest);
    EMOJI_RE.lastIndex = 0;
    const emojiMatch = EMOJI_RE.exec(rest);
    const serverMatch = SERVER_EMOJI_RE.exec(rest);

    let serverHit = null;
    if (serverMatch) {
      const name = serverMatch[1];
      const url = serverEmojiUrl(name, map);
      // без картинки `:имя:` остаётся текстом, как в браузерном клиенте
      if (url) serverHit = { index: serverMatch.index, name, url };
    }

    const positions = [
      linkMatch ? linkMatch.index : Infinity,
      emojiMatch ? emojiMatch.index : Infinity,
      serverHit ? serverHit.index : Infinity,
    ];
    const nearest = Math.min(...positions);
    if (nearest === Infinity) {
      frag.appendChild(document.createTextNode(rest));
      break;
    }

    if (nearest > 0) frag.appendChild(document.createTextNode(rest.slice(0, nearest)));

    if (serverHit && nearest === serverHit.index) {
      frag.appendChild(serverEmojiNode(serverHit.url, serverHit.name));
      rest = rest.slice(serverHit.index + serverHit.name.length + 2);
      continue;
    }
    if (linkMatch && nearest === linkMatch.index) {
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
      rest = rest.slice(nearest + linkMatch[0].length);
      continue;
    }
    frag.appendChild(emojiNode(emojiMatch[0]));
    rest = rest.slice(nearest + emojiMatch[0].length);
  }
  return frag;
}

// Эмодзи сервера картинкой; если файл не скачался — остаётся текст `:имя:`.
function serverEmojiNode(url, name) {
  const slot = document.createElement("span");
  slot.className = "emoji server-emoji";
  slot.title = ":" + name + ":";
  slot.textContent = ":" + name + ":";
  mediaUrl(url).then((data) => {
    if (!data || !slot.isConnected) return;
    const img = document.createElement("img");
    img.className = "emoji-img";
    img.alt = ":" + name + ":";
    img.src = data;
    slot.replaceChildren(img);
  });
  return slot;
}

// Оформление сообщения по узлам от ядра (жирный, код, ссылка, спойлер).
function segmentsNode(message) {
  const map = message.emoji || null;
  const wrap = document.createDocumentFragment();
  const parts = message.segments && message.segments.length
    ? message.segments
    : [{ kind: "text", text: message.content || "" }];

  for (const part of parts) {
    if (part.kind === "text") {
      wrap.appendChild(richText(part.text, map));
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
      node.appendChild(richText(part.text, map));
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
    button.oncontextmenu = (event) => {
      event.preventDefault();
      openServerMenu(event, server);
    };
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
  button.oncontextmenu = (event) => {
    event.preventDefault();
    openChannelMenu(event, channel);
  };
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
  sendBtn.disabled = false; // без этого сообщение нельзя было отправить вообще
  inputEl.placeholder = "Написать в #" + channel.name;
  inputEl.focus();

  toggleEmojiPicker(false);
  if (state.serverId !== null) loadServerEmoji(state.serverId);
  loadMembers(state.serverId);

  messagesEl.textContent = "";
  const loading = document.createElement("div");
  loading.className = "empty";
  loading.innerHTML = '<div class="spinner"></div>';
  messagesEl.appendChild(loading);

  try {
    const history = await call("channel_history", { channelId: channel.id, limit: 50 });
    if (state.channelId !== channel.id) return; // пользователь уже ушёл в другой канал
    state.messages = markMine(history.messages || []).map((m) => {
      fillServerEmoji(m);
      return m;
    });
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

  // правый клик — меню как в официальном клиенте
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMessageMenu(event, message);
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
  fillServerEmoji(message);
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
    membersCache.clear();
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


// ───────────────────── выбор эмодзи сервера у строки ввода ─────────────────

let emojiFilter = "";
let emojiHover = null;

// Эмодзи всех серверов, доступных пользователю: id сервера → список.
const serverEmojiAll = new Map();

// ── данные для панели ───────────────────────────────────────────────────────

// Все юникод-эмодзи из комплекта, по коду: для панели «Все эмодзи».
function unicodeEmojis() {
  if (unicodeEmojis.cache) return unicodeEmojis.cache;
  const map = window.EMOJI_MAP || {};
  const list = Object.keys(map).map((code) => ({
    code,
    kind: "unicode",
    name: code,
    text: codeToSymbol(code),
  }));
  unicodeEmojis.cache = list;
  return list;
}

function codeToSymbol(code) {
  try {
    return code
      .split("-")
      .map((part) => String.fromCodePoint(parseInt(part, 16)))
      .join("");
  } catch {
    return "";
  }
}

// Загрузить эмодзи сервера (для панели и для `:id:` в сообщениях).
async function loadServerEmoji(serverId) {
  if (serverId === null || serverEmojiAll.has(serverId)) return serverEmojiAll.get(serverId);
  const task = call("server_emojis", { serverId })
    .then((list) => {
      serverEmojiAll.set(serverId, list || []);
      serverEmojiData.set(serverId, list || []);
      return list || [];
    })
    .catch((error) => {
      console.warn("не удалось получить эмодзи сервера:", error);
      serverEmojiAll.set(serverId, []);
      return [];
    });
  serverEmojiAll.set(serverId, []);
  return task;
}

// ── отрисовка панели ────────────────────────────────────────────────────────

function renderEmojiPicker() {
  const list = el("emoji-list");
  const rail = el("emoji-servers");
  if (!list || !rail) return;

  list.textContent = "";
  rail.textContent = "";

  const needle = emojiFilter.trim().toLowerCase();
  const servers = (state.workspace?.servers || []).filter(
    (server) => (serverEmojiAll.get(server.id) || []).length > 0,
  );
  const currentId = state.serverId;

  if (needle) {
    // поиск сразу по всем серверам и по юникоду, как в оригинале
    const found = [];
    for (const server of servers) {
      for (const emoji of serverEmojiAll.get(server.id) || []) {
        if (emoji.name.toLowerCase().includes(needle)) {
          found.push({ kind: "server", emoji, server });
        }
      }
    }
    for (const emoji of unicodeEmojis()) {
      if (emoji.code.includes(needle) || emoji.text.includes(needle)) {
        found.push({ kind: "unicode", emoji });
      }
    }
    if (!found.length) {
      list.appendChild(note("Ничего не найдено"));
      renderEmojiPreview(null);
      return;
    }
    list.appendChild(sectionTitle("Результаты поиска"));
    for (const item of found.slice(0, 240)) list.appendChild(emojiButton(item));
    renderEmojiPreview(found[0]);
    return;
  }

  // рельс серверов слева — как в официальном клиенте
  for (const server of servers) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "emoji-server" + (server.id === currentId ? " active" : "");
    button.title = server.name;
    const mark = document.createElement("span");
    mark.textContent = server.initial || server.name.charAt(0).toUpperCase();
    if (server.icon) {
      mediaUrl(server.icon).then((data) => {
        if (!data) return;
        const img = document.createElement("img");
        img.alt = server.name;
        img.src = data;
        button.replaceChildren(img);
      });
    }
    button.appendChild(mark);
    button.onclick = (event) => {
      event.stopPropagation();
      el("emoji-list").querySelector(`[data-server="${server.id}"]`)?.scrollIntoView({ block: "start" });
    };
    rail.appendChild(button);
  }

  const first = state.workspace?.servers?.find((server) => (serverEmojiAll.get(server.id) || []).length);
  let any = false;
  for (const server of servers) {
    const head = sectionTitle(server.name);
    head.dataset.server = server.id;
    list.appendChild(head);
    for (const emoji of serverEmojiAll.get(server.id) || []) {
      list.appendChild(emojiButton({ kind: "server", emoji, server }));
    }
    any = true;
  }

  list.appendChild(sectionTitle("Все эмодзи"));
  for (const emoji of unicodeEmojis()) {
    list.appendChild(emojiButton({ kind: "unicode", emoji }));
  }

  const fallback = servers.length
    ? { kind: "server", emoji: serverEmojiAll.get(servers[0].id)[0], server: servers[0] }
    : { kind: "unicode", emoji: unicodeEmojis()[0] };
  renderEmojiPreview(first ? fallback : fallback);
  if (!any) {
    // серверных эмодзи нет — это нормально, показываем хотя бы юникод
  }
}

function sectionTitle(text) {
  const node = document.createElement("div");
  node.className = "emoji-section";
  node.textContent = text;
  return node;
}

function emojiButton(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "emoji-item";
  if (item.kind === "server") {
    button.title = ":" + item.emoji.name + ":";
    button.dataset.name = item.emoji.name;
    if (item.emoji.url) {
      mediaUrl(item.emoji.url).then((data) => {
        if (!data) return;
        const img = document.createElement("img");
        img.className = "emoji-img";
        img.alt = ":" + item.emoji.name + ":";
        img.src = data;
        button.appendChild(img);
      });
    } else {
      button.textContent = ":" + item.emoji.name + ":";
    }
    button.onclick = () => insertEmoji(":" + item.emoji.name + ":");
  } else {
    button.title = item.emoji.text;
    const symbol = document.createElement("span");
    symbol.className = "emoji-symbol";
    symbol.textContent = item.emoji.text;
    button.appendChild(symbol);
    spriteUrl(item.emoji.code).then((data) => {
      if (!data) return;
      const img = document.createElement("img");
      img.className = "emoji-img";
      img.alt = item.emoji.text;
      img.src = data;
      button.replaceChildren(img);
    });
    button.onclick = () => insertEmoji(item.emoji.text);
  }
  button.onmouseenter = () => renderEmojiPreview(item);
  return button;
}

// Нижняя строка: что за эмодзи и откуда он — как в оригинале.
function renderEmojiPreview(item) {
  const img = el("emoji-preview-img");
  const name = el("emoji-preview-name");
  const from = el("emoji-preview-from");
  if (!img) return;
  img.textContent = "";
  if (!item) {
    name.textContent = "";
    from.textContent = "";
    return;
  }
  if (item.kind === "server") {
    name.textContent = ":" + item.emoji.name + ":";
    from.textContent = item.server ? "с сервера " + item.server.name : "";
    if (item.emoji.url) {
      mediaUrl(item.emoji.url).then((data) => {
        if (!data) return;
        const node = document.createElement("img");
        node.className = "emoji-img";
        node.src = data;
        img.replaceChildren(node);
      });
    }
  } else {
    name.textContent = item.emoji.text;
    from.textContent = "юникод";
    const symbol = document.createElement("span");
    symbol.textContent = item.emoji.text;
    img.appendChild(symbol);
    spriteUrl(item.emoji.code).then((data) => {
      if (!data) return;
      const node = document.createElement("img");
      node.className = "emoji-img";
      node.src = data;
      img.replaceChildren(node);
    });
  }
}

function note(text) {
  const node = document.createElement("div");
  node.className = "emoji-note";
  node.textContent = text;
  return node;
}

// Вставить текст на месте курсора.
function insertEmoji(token) {
  const start = inputEl.selectionStart ?? inputEl.value.length;
  const end = inputEl.selectionEnd ?? inputEl.value.length;
  const before = inputEl.value.slice(0, start);
  const after = inputEl.value.slice(end);
  const glue = before && !/\s$/.test(before) ? " " : "";
  inputEl.value = before + glue + token + after;
  const caret = (before + glue + token).length;
  inputEl.setSelectionRange(caret, caret);
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
  renderEmojiPicker();
  el("emoji-search").focus();
  // эмодзи серверов догружаем по одному и перерисовываем панель
  const ids = (state.workspace?.servers || []).map((server) => server.id);
  for (const id of ids) {
    loadServerEmoji(id).then(() => renderEmojiPicker());
  }
  if (state.serverId !== null) loadServerEmoji(state.serverId);
}

// ── список участников справа ────────────────────────────────────────────────

const membersCache = new Map(); // id сервера → участники

async function loadMembers(serverId) {
  if (serverId === null) {
    el("members").classList.add("hidden");
    return;
  }
  const panel = el("members");
  panel.classList.remove("hidden");
  const list = el("members-list");

  if (!membersCache.has(serverId)) {
    list.textContent = "";
    list.appendChild(note("Загружаю участников…"));
    try {
      const members = await call("server_members", { serverId });
      membersCache.set(serverId, members || []);
    } catch (error) {
      membersCache.set(serverId, []);
      console.warn("не удалось получить участников:", error);
    }
  }
  if (state.serverId !== serverId) return;
  renderMembers();
}

function renderMembers() {
  const list = el("members-list");
  if (!list) return;
  list.textContent = "";
  const serverId = state.serverId;
  if (serverId === null) {
    el("members").classList.add("hidden");
    return;
  }
  const members = membersCache.get(serverId) || [];
  el("members").classList.remove("hidden");
  el("members-count").textContent = members.length ? String(members.length) : "";

  if (!members.length) {
    list.appendChild(note("Участники не загрузились"));
    return;
  }

  const online = members.filter((member) => member.online);
  const offline = members.filter((member) => !member.online);

  if (online.length) list.appendChild(sectionTitle(`В сети — ${online.length}`));
  for (const member of online) list.appendChild(memberRow(member));
  if (offline.length) list.appendChild(sectionTitle(`Не в сети — ${offline.length}`));
  for (const member of offline) list.appendChild(memberRow(member));
}

function memberRow(member) {
  const row = document.createElement("div");
  row.className = "member" + (member.online ? "" : " offline");
  row.dataset.id = member.id;
  row.title = member.roles.length
    ? `${member.username}\n${member.roles.join(", ")}`
    : member.username;

  const avatar = avatarEl(member.avatar, member.name, 32);
  avatar.classList.add("member-avatar");
  row.appendChild(avatar);

  const text = document.createElement("div");
  text.className = "member-text";
  const name = document.createElement("div");
  name.className = "member-name";
  name.textContent = member.name;
  if (member.colour) name.style.color = colourCss(member.colour);
  text.appendChild(name);
  row.appendChild(text);

  row.oncontextmenu = (event) => {
    event.preventDefault();
    openUserMenu(event, member);
  };
  row.onclick = () => {
    el("input").focus();
    insertEmoji(member.username);
  };
  return row;
}


// ───────────────────────── контекстные меню (ПКМ) ──────────────────────────

const ctxMenu = () => el("ctx-menu");

function closeContextMenu() {
  ctxMenu().classList.add("hidden");
  ctxMenu().textContent = "";
}

// Показать меню рядом с курсором, не вылезая за край окна.
function openContextMenu(event, items) {
  const menu = ctxMenu();
  menu.textContent = "";
  for (const item of items) {
    if (item.separator) {
      const line = document.createElement("div");
      line.className = "ctx-sep";
      menu.appendChild(line);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ctx-item" + (item.danger ? " danger" : "");
    button.textContent = item.label;
    button.onclick = async () => {
      closeContextMenu();
      try {
        await item.action();
      } catch (error) {
        toast(describe(error), "err");
      }
    };
    menu.appendChild(button);
  }

  menu.classList.remove("hidden");
  const { innerWidth, innerHeight } = window;
  const box = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, innerWidth - box.width - 8);
  const y = Math.min(event.clientY, innerHeight - box.height - 8);
  menu.style.left = Math.max(8, x) + "px";
  menu.style.top = Math.max(8, y) + "px";
}

// Меню сообщения — как в официальном клиенте.
function openMessageMenu(event, message) {
  const link = () => call("message_link", {
    server: state.serverId,
    channel: message.channel || state.channelId,
    message: message.id,
  });

  openContextMenu(event, [
    { label: "Ответить", action: () => { inputEl.value = "> " + message.content.split("\n")[0].slice(0, 80) + "\n"; inputEl.focus(); } },
    { label: "Копировать текст", action: () => copyText(message.content) },
    { label: "Копировать ссылку на сообщение", action: async () => { await copyText(await link()); toast("Ссылка скопирована"); } },
    { label: "Копировать id сообщения", action: () => copyText(message.id) },
    { separator: true },
    ...(message.mine
      ? [
          { label: "Изменить", action: () => startEdit(message) },
          { label: "Удалить", danger: true, action: () => removeMessage(message) },
        ]
      : []),
    { label: "Пожаловаться", action: () => toast("Жалоба отправляется через браузерный клиент") },
  ]);
}

// Меню участника.
function openUserMenu(event, member) {
  openContextMenu(event, [
    { label: member.name, action: () => copyText(member.username) },
    { separator: true },
    { label: "Скопировать имя", action: () => copyText(member.username) },
    { label: "Скопировать id", action: () => copyText(member.id) },
    { label: "Упомянуть", action: () => { insertEmoji(`<@${member.id}>`); } },
    { label: "Написать в личные", action: () => toast("Личные сообщения появятся в следующей сборке") },
  ]);
}

// Меню канала.
function openChannelMenu(event, channel) {
  openContextMenu(event, [
    { label: "Отметить как прочитанное", action: () => toast("Скоро") },
    { label: "Копировать название", action: () => copyText(channel.name) },
    { label: "Копировать id", action: () => copyText(channel.id) },
    { separator: true },
    { label: "Свернуть категорию", action: () => toast("Скоро") },
  ]);
}

// Меню сервера в рельсе.
function openServerMenu(event, server) {
  openContextMenu(event, [
    { label: "Копировать название", action: () => copyText(server.name) },
    { label: "Копировать id", action: () => copyText(server.id) },
    { separator: true },
    { label: "Настройки сервера", action: () => toast("Скоро") },
  ]);
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
    // догружаем только когда лента действительно прокручивается и мы у верха
    const scrollable = messagesEl.scrollHeight > messagesEl.clientHeight + 400;
    if (scrollable && messagesEl.scrollTop < 240) loadOlder();
  });

  sendBtn.onclick = submit;
  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
    if (event.key === "Escape") {
      stopEdit();
      toggleEmojiPicker(false);
    }
  });

  el("btn-emoji").onclick = (event) => {
    event.stopPropagation();
    toggleEmojiPicker();
  };
  el("emoji-search").addEventListener("input", (event) => {
    emojiFilter = event.target.value;
    renderEmojiPicker();
  });
  el("emoji-picker").addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => toggleEmojiPicker(false));
  document.addEventListener("click", () => closeContextMenu());
  document.addEventListener("contextmenu", (event) => {
    // клик мимо меню закрывает его, но своё меню открывается как обычно
    if (!ctxMenu().contains(event.target)) closeContextMenu();
  });
  window.addEventListener("resize", () => closeContextMenu());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeContextMenu();
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
