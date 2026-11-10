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
  mediaInFlight: new Set(),
  workspace: null,
  serverId: null,      // null = личные сообщения
  channelId: null,
  messages: [],        // сообщения открытого канала
  collapsed: new Set(),
  sending: false,
  editing: null,
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
async function mediaUrl(url) {
  if (!url) return null;
  if (state.media.has(url)) return state.media.get(url);
  if (state.mediaInFlight.has(url)) return null;
  state.mediaInFlight.add(url);
  try {
    const data = await call("fetch_media", { url });
    state.media.set(url, data);
    return data;
  } catch (error) {
    console.warn("не удалось загрузить файл:", url, error);
    state.media.set(url, null);
    return null;
  } finally {
    state.mediaInFlight.delete(url);
  }
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
function textNode(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
    const link = document.createElement("a");
    link.href = match[0];
    link.textContent = match[0];
    link.target = "_blank";
    link.rel = "noreferrer";
    frag.appendChild(link);
    last = match.index + match[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
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
  if (channel.icon) {
    mediaUrl(channel.icon).then((data) => {
      if (!data) return;
      const img = document.createElement("img");
      img.className = "channel-icon";
      img.alt = "";
      img.src = data;
      hash.textContent = "";
      hash.appendChild(img);
    });
  }

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
    state.messages = history.messages || [];
    renderMessages(true);
  } catch (error) {
    showEmpty("Не удалось загрузить историю", describe(error));
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
  if (!grouped) avatarBox.appendChild(avatarEl(message.avatar, message.author, 40));
  row.appendChild(avatarBox);

  const body = document.createElement("div");
  body.className = "msg-body";

  if (!grouped) {
    const head = document.createElement("div");
    head.className = "msg-head";
    const author = document.createElement("span");
    author.className = "msg-author";
    author.textContent = message.author;
    author.style.color = message.mine ? "var(--accent)" : "";
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
  text.appendChild(textNode(message.content || ""));
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
        state.messages[index] = { ...state.messages[index], ...updated, mine: true };
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
        state.messages.push(sent);
        renderMessages(true);
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

  if (type === "Message") {
    const channel = source.channel;
    if (channel !== state.channelId) return;

    // сообщение пришло целиком — конвертируем в тот же вид, что отдаёт ядро
    const message = {
      id: source._id || source.id,
      channel,
      author_id: source.author,
      author: (source.user && (source.user.display_name || source.user.username)) || "неизвестный",
      avatar: source.user && source.user.avatar
        ? `${state.workspace?.cdn || ""}/${source.user.avatar.tag}/${source.user.avatar._id}`
        : null,
      content: source.content || "",
      timestamp: new Date((source.timestamp || 0) * 1000).toISOString(),
      edited: false,
      system: Boolean(source.system),
      attachments: [],
      mine: Boolean(state.me && source.author === state.me.id),
    };

    if (state.messages.some((item) => item.id === message.id)) return;
    const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 160;
    state.messages.push(message);
    renderMessages(nearBottom);
    return;
  }

  if (type === "MessageUpdate") {
    const index = state.messages.findIndex((item) => item.id === source.id);
    if (index >= 0 && source.data && typeof source.data.content === "string") {
      state.messages[index].content = source.data.content;
      state.messages[index].edited = true;
      renderMessages();
    }
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
