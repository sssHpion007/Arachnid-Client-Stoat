// Отрисовка Markdown так же, как в официальном клиенте (components/markdown).
//
// Разбор делает тот же конвейер unified, что и в for-web (vendor/markdown.js,
// собран из scripts/markdown): он отдаёт дерево hast, а здесь оно
// превращается в DOM. Набор тегов, классов и атрибутов — белый список:
// всё, чего нет в списке, отбрасывается (как `components` в index.tsx).
//
// Подключается до app.js и пользуется его помощниками во время отрисовки.

"use strict";

/** Режимы: `full` — сообщения и описания, `simple` — строка ответа (replyComponents). */
const MD_TAGS = new Set([
  "p", "em", "strong", "del", "h1", "h2", "h3", "h4", "h5", "h6",
  "pre", "code", "li", "ul", "ol", "blockquote", "table", "thead", "tbody",
  "tr", "th", "td", "br", "span", "a", "time", "sup", "sub",
]);
/** Теги, которые в оригинале заменены на `Null`. */
const MD_NULL = new Set(["img", "video", "figure", "picture", "source", "audio", "script", "style", "input"]);
/** В упрощённом режиме блоки разворачиваются в своё содержимое (replyComponents). */
const MD_UNWRAP_SIMPLE = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "td", "th", "ul", "ol", "tr", "thead", "tbody"]);
const MD_NULL_SIMPLE = new Set(["pre", "table", "img", "video"]);

/** Узлы SVG, из которых KaTeX рисует корни и стрелки. */
const MD_SVG = new Set(["svg", "path", "line", "rect", "g"]);
const MD_SVG_ATTRS = new Set(["width", "height", "viewBox", "preserveAspectRatio", "d", "x1", "x2", "y1", "y2", "x", "y", "strokeWidth"]);

/** Разрешённые классы: подсветка кода и вёрстка KaTeX. */
const MD_CLASS_RE = /^(?:hljs(?:-[\w-]+)?|language-[\w+#.-]+|katex[\w-]*|[a-z]+[\w-]*)$/;
/** Стиль разрешён только внутри формулы — KaTeX им задаёт высоты и отступы. */
const MD_STYLE_RE = /^[\w\s.:;%#(),+\-/'"!]*$/;

const MD_ID = "[0-9A-HJKMNP-TV-Z]{26}";
const RE_INVITE_PATH = new RegExp("^(?:/i/[^/]+)?/invite/(\\w+)/?$");
const RE_SERVER_PATH = new RegExp(`^(?:/i/[^/]+)?/server/(${MD_ID})/?$`);
const RE_CHANNEL_PATH = new RegExp(`^(?:/i/[^/]+)?(?:/server/(${MD_ID}))?/channel/(${MD_ID})(?:/(${MD_ID}))?/?$`);
/** Пути, которые веб-клиент открывает у себя (inAppScope). */
const RE_APP_SCOPE = /\/(i|app|home|pwa|dev|invite|bot|friends|server|channel)\/?/;

/** Адрес веб-клиента текущего инстанса (instance.origin). */
let markdownOrigin = "https://stoat.chat";

function setMarkdownOrigin(origin) {
  if (origin) markdownOrigin = origin.replace(/\/$/, "");
}

/** Адреса, которые считаются своими (anchors.tsx, inAppScope). */
function inAppScope(url) {
  return (
    [markdownOrigin, "https://stoat.chat", "https://beta.stoat.chat", "https://old.stoat.chat", "https://revolt.chat", "https://app.revolt.chat"].includes(url.origin) &&
    RE_APP_SCOPE.test(url.pathname)
  );
}

// ─────────────────────────── пользователи в упоминаниях ───────────────────────────

const mentionUsers = new Map(); // "сервер:id" → { id, name, avatar, colour } | null
const mentionWaiters = new Map(); // "сервер:id" → [обратные вызовы]
let mentionQueue = null; // Map(сервер → Set(id)) — запросы одного кадра идут одним вызовом

/** Забыть известных пользователей (сменились ники, роли, участники). */
function forgetMentionUsers() {
  mentionUsers.clear();
}

/** Пользователь для `<@id>`: из кэша ядра, без сетевых запросов (useUser). */
function mentionUser(userId, serverId, done) {
  const key = (serverId || "") + ":" + userId;
  if (mentionUsers.has(key)) {
    done(mentionUsers.get(key));
    return;
  }
  if (!mentionWaiters.has(key)) mentionWaiters.set(key, []);
  mentionWaiters.get(key).push(done);
  if (!mentionQueue) {
    mentionQueue = new Map();
    queueMicrotask(flushMentionQueue);
  }
  if (!mentionQueue.has(serverId || "")) mentionQueue.set(serverId || "", new Set());
  mentionQueue.get(serverId || "").add(userId);
}

function flushMentionQueue() {
  const queue = mentionQueue;
  mentionQueue = null;
  for (const [serverId, ids] of queue) {
    const list = [...ids];
    // ядро отвечает не больше чем о сотне за раз
    for (let start = 0; start < list.length; start += 100) {
      const chunk = list.slice(start, start + 100);
      call("known_users", { ids: chunk, serverId: serverId || null })
        .catch(() => [])
        .then((found) => {
          const byId = new Map((found || []).map((user) => [user.id, user]));
          for (const id of chunk) {
            const key = serverId + ":" + id;
            const user = byId.get(id) || null;
            // неизвестных не запоминаем: они могут появиться с новой историей
            if (user) mentionUsers.set(key, user);
            const waiters = mentionWaiters.get(key) || [];
            mentionWaiters.delete(key);
            for (const done of waiters) done(user);
          }
        });
    }
  }
}

// ─────────────────────────── отрисовка ───────────────────────────

/**
 * Текст Markdown → фрагмент DOM.
 * `mode` — `full` или `simple`; `serverId` — сервер, в котором показан
 * текст (ники и роли в упоминаниях); `disallowBigEmoji` — не увеличивать
 * сообщение из одних эмодзи.
 */
function renderMarkdown(content, { mode = "full", serverId = null, disallowBigEmoji = false } = {}) {
  const frag = document.createDocumentFragment();
  if (!content) return frag;
  let tree;
  try {
    tree = window.StoatMarkdown.parse(content, { mode, origin: markdownOrigin, disallowBigEmoji });
  } catch (error) {
    console.warn("не удалось разобрать Markdown:", error);
    frag.append(content);
    return frag;
  }
  const context = { mode, simple: mode === "simple", serverId, math: false };
  for (const child of tree.children || []) appendMarkdown(frag, child, context);
  return frag;
}

function appendMarkdown(parent, node, context) {
  if (!node) return;
  if (node.type === "text") {
    parent.append(node.value);
    return;
  }
  if (node.type !== "element") return;
  const made = markdownElement(node, context);
  if (made) parent.append(made);
}

function appendChildren(parent, node, context) {
  for (const child of node.children || []) appendMarkdown(parent, child, context);
  return parent;
}

/** Текст узла целиком (для подписи ссылки и проверки «голой» ссылки). */
function markdownText(node) {
  if (!node) return "";
  if (node.type === "text") return node.value;
  return (node.children || []).map(markdownText).join("");
}

function markdownElement(node, context) {
  const tag = node.tagName;
  const props = node.properties || {};

  switch (tag) {
    case "mention":
      return mentionPill(props.mentions || "", context);
    case "timestamp":
      return timestampNode(props.format, Number(props.unix));
    case "customEmoji":
      return markdownCustomEmoji(props.id);
    case "unicodeEmoji":
      return markdownUnicodeEmoji(props.str, props.pack);
    case "spoiler":
      return spoilerNode(node, context);
    case "a":
      return anchorNode(node, context);
    default:
      break;
  }

  if (context.math && MD_SVG.has(tag)) return markdownSvg(node);
  if (MD_NULL.has(tag)) return null;
  if (context.simple && MD_NULL_SIMPLE.has(tag)) return null;
  if (context.simple && MD_UNWRAP_SIMPLE.has(tag)) {
    const frag = document.createDocumentFragment();
    return appendChildren(frag, node, context);
  }
  if (!MD_TAGS.has(tag)) {
    // неизвестный тег — только его текст
    const frag = document.createDocumentFragment();
    return appendChildren(frag, node, context);
  }

  const element = document.createElement(tag);
  const classes = [].concat(props.className || []).filter((name) => typeof name === "string" && MD_CLASS_RE.test(name));
  const isMath = classes.some((name) => name === "katex" || name === "katex-display");
  const inner = isMath && !context.math ? { ...context, math: true } : context;

  if ((tag === "span" || tag === "code") && classes.length) element.className = classes.join(" ");
  if (inner.math && tag === "span" && typeof props.style === "string" && MD_STYLE_RE.test(props.style)) {
    element.setAttribute("style", props.style);
  }
  if (inner.math && props.ariaHidden) element.setAttribute("aria-hidden", "true");
  if (tag === "ol" && props.start) element.style.setProperty("--start-number", String(parseInt(props.start, 10) - 1));
  if (tag === "td" || tag === "th") {
    if (props.align) element.style.textAlign = String(props.align);
  }
  if (tag === "p" && props.emojiSize) element.classList.add("emoji-" + props.emojiSize);
  if (tag === "pre") element.className = "md-codeblock";
  if (isMath && !context.math) element.classList.add("math");

  return appendChildren(element, node, inner);
}

function markdownSvg(node) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", node.tagName);
  for (const [key, value] of Object.entries(node.properties || {})) {
    if (!MD_SVG_ATTRS.has(key)) continue;
    element.setAttribute(key === "strokeWidth" ? "stroke-width" : key, String(value));
  }
  for (const child of node.children || []) {
    if (child.type === "element" && MD_SVG.has(child.tagName)) element.append(markdownSvg(child));
  }
  return element;
}

// ─────────────────────────── упоминания (mentions.tsx) ───────────────────────────

function mentionShell(valid = true) {
  return h("span", { class: "md-mention" + (valid ? "" : " invalid") });
}

function mentionPill(mentions, context) {
  if (mentions === "everyone" || mentions === "online") {
    return h("span", { class: "md-mention" }, [symbol("alternate_email", 16), mentions]);
  }
  if (mentions.startsWith("role:")) return roleMention(mentions.slice(5), context);
  if (mentions.startsWith("user:")) return userMention(mentions.slice(5), context);
  return h("span", { text: "Invalid Mention Element" });
}

function userMention(userId, context) {
  const pill = mentionShell();
  const fill = (user) => {
    if (!user) {
      pill.className = "md-mention invalid";
      pill.replaceChildren(t("Unknown User"));
      return;
    }
    const name = h("span", { text: user.name });
    paintName(name, user.colour);
    pill.replaceChildren(avatar({ url: user.avatar, name: user.name, size: 16 }), name);
    if (context.simple) return;
    pill.classList.add("link");
    pill.onclick = (event) => openUserCard(event, user.id, context.serverId);
    pill.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openUserMenu(event, { id: user.id, name: user.name }, context.serverId);
    };
  };
  // свои данные известны сразу
  if (state.me && state.me.id === userId && !context.serverId) {
    fill({ id: userId, name: myName(), avatar: state.me.avatar, colour: null });
  } else {
    mentionUser(userId, context.serverId, fill);
  }
  return pill;
}

function roleMention(roleId, context) {
  const server = serverById(context.serverId);
  const role = server && (server.roles || []).find((item) => item.id === roleId);
  if (!role) return h("span", { class: "md-mention invalid", text: t("Unknown Role") });
  const dot = h("span", { class: "md-role-dot" });
  dot.style.background = role.colour || "var(--md-sys-color-outline-variant)";
  const name = h("span", { text: role.name });
  paintName(name, role.colour);
  return h("span", { class: "md-mention" }, [dot, name]);
}

// ─────────────────────────── метки времени (timestamps.tsx) ───────────────────────────

const pad2 = (value) => String(value).padStart(2, "0");

/** Части даты на языке интерфейса: день недели и месяц словами. */
function dateWords(date) {
  const words = {};
  try {
    const parts = new Intl.DateTimeFormat(I18N.tag(), { weekday: "long", day: "numeric", month: "long" }).formatToParts(date);
    for (const part of parts) words[part.type] = part.value;
  } catch {
    /* язык без данных Intl — останутся числа */
  }
  return { month: words.month || pad2(date.getMonth() + 1), weekday: words.weekday || "" };
}

/** Форматы dayjs из оригинала: hh — часы 1–12 с нулём. */
function timestampText(format, date) {
  const hh = pad2(date.getHours() % 12 || 12);
  const mm = pad2(date.getMinutes());
  const { month, weekday } = dateWords(date);
  const day = `${pad2(date.getDate())} ${month} ${date.getFullYear()}`;
  switch (format) {
    case "t":
      return `${hh}:${mm}`;
    case "T":
      return `${hh}:${mm}:${pad2(date.getSeconds())}`;
    case "R":
      return I18N.relative(date);
    case "D":
      return day;
    case "F":
      return `${weekday}, ${day} ${hh}:${mm}`;
    default:
      return `${day} ${hh}:${mm}`;
  }
}

const relativeTimes = new Set(); // <time> с форматом R: обновляются раз в минуту

function timestampNode(format, unix) {
  const date = new Date(unix * 1000);
  if (Number.isNaN(date.getTime())) return h("span", { text: `<t:${unix}>` });
  const node = h("time", { class: "md-time", text: timestampText(format, date) });
  // dayjs toString() — дата по UTC
  attachTooltip(node, date.toUTCString());
  if (format === "R") {
    node.dataset.unix = String(unix);
    relativeTimes.add(node);
  }
  return node;
}

setInterval(() => {
  for (const node of relativeTimes) {
    if (!node.isConnected) {
      relativeTimes.delete(node);
      continue;
    }
    node.textContent = I18N.relative(new Date(Number(node.dataset.unix) * 1000));
  }
}, 60_000);

// ─────────────────────────── эмодзи (customEmoji.tsx, unicodeEmoji.tsx) ───────────────────────────

let anyEmojiPattern = null;

/**
 * Текст с эмодзи без остальной разметки (TextWithEmoji.tsx): имена каналов,
 * описание в шапке. Возвращает массив строк и узлов.
 */
function emojiText(content) {
  if (!content) return [];
  if (!anyEmojiPattern) {
    anyEmojiPattern = new RegExp(StoatMarkdown.RE_CUSTOM_EMOJI.source + "|" + StoatMarkdown.RE_UNICODE_EMOJI.source, "g");
  }
  const out = [];
  let last = 0;
  anyEmojiPattern.lastIndex = 0;
  let match;
  while ((match = anyEmojiPattern.exec(content))) {
    if (match.index > last) out.push(content.slice(last, match.index));
    last = match.index + match[0].length;
    out.push(match[0].length === 28 ? markdownCustomEmoji(match[1]) : markdownUnicodeEmoji(match[0], null));
    if (!match[0].length) anyEmojiPattern.lastIndex += 1;
  }
  if (last < content.length) out.push(content.slice(last));
  return out;
}

function markdownUnicodeEmoji(text, pack) {
  const slot = h("span", { class: "emoji", text });
  unicodeEmojiUrl(text, pack || undefined).then((data) => {
    if (data) slot.replaceWith(h("img", { class: "emoji", alt: text, src: data, draggable: "false", loading: "lazy" }));
  });
  return slot;
}

function markdownCustomEmoji(id) {
  const known = customEmojiIndex.get(id);
  const label = ":" + (known ? known.name : id) + ":";
  const url = customEmojiUrl(id);
  if (!url) return document.createTextNode(label);
  const img = h("img", { class: "emoji", alt: label, draggable: "false", loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(document.createTextNode(label)), { once: true });
  img.src = mediaSrc(url);
  // подсказка: крупное эмодзи, имя и сервер, откуда оно (RenderCustomEmoji)
  attachTooltip(img, () => emojiTooltip(id, url));
  const from = known && known.server ? serverById(known.server) : null;
  img.setAttribute("aria-label", known ? `${label} from ${from ? from.name : t("Private Server")}` : label);
  return img;
}

function emojiTooltip(id, url) {
  const known = customEmojiIndex.get(id);
  const big = h("img", { class: "emoji", alt: "", draggable: "false" });
  big.src = mediaSrc(url);
  const column = h("span", { class: "emoji-tooltip-text" });
  if (known) {
    const server = known.server ? serverById(known.server) : null;
    column.append(
      h("span", { text: ":" + known.name + ":" }),
      h("span", { class: "emoji-tooltip-server" }, [
        avatar({ url: server ? server.icon : null, name: server ? server.name : "?", size: 14 }),
        server ? server.name : t("Private Server"),
      ]),
    );
  } else {
    column.append(t("Unknown emote"));
  }
  return h("span", { class: "emoji-tooltip" }, [h("span", { class: "emoji-tooltip-big" }, [big]), column]);
}

// ─────────────────────────── спойлер (spoiler.tsx) ───────────────────────────

function spoilerNode(node, context) {
  const element = h("span", { class: "md-spoiler" });
  appendChildren(element, node, context);
  if (context.simple) return element;
  element.addEventListener("click", (event) => {
    if (element.classList.contains("shown")) return;
    event.preventDefault();
    event.stopPropagation();
    element.classList.add("shown");
  });
  return element;
}

// ─────────────────────────── ссылки (anchors.tsx) ───────────────────────────

/** Обычная ссылка; `onOpen` вызывается вместо перехода браузера. */
function linkElement(node, context, href, onOpen, className = "md-link") {
  if (context.simple) {
    const span = h("span", { class: className });
    return appendChildren(span, node, context);
  }
  const anchor = h("a", { class: className, href, title: (node.properties || {}).title || href });
  appendChildren(anchor, node, context);
  const open = (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    onOpen(anchor);
  };
  anchor.addEventListener("click", open);
  anchor.addEventListener("auxclick", open);
  return anchor;
}

function anchorNode(node, context) {
  const href = (node.properties || {}).href;
  const children = () => appendChildren(h("span"), node, context);
  if (!href) return children();

  let url;
  try {
    url = new URL(href);
  } catch {
    return children();
  }
  if (!["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) return children();

  // короткие ссылки приглашений и «Обзора»
  if (url.origin === "https://rvlt.gg" || url.origin === "https://stt.gg") {
    if (/^\/[\w\d]+$/.test(url.pathname)) url = new URL("/invite" + url.pathname, markdownOrigin);
    else if (url.pathname.startsWith("/discover")) url = new URL(url.pathname, markdownOrigin);
  }

  if (inAppScope(url)) return internalAnchor(node, context, href, url);

  return linkElement(node, context, href, (anchor) => openLink(url, anchor.innerText));
}

/** Внешняя ссылка: доверенный адрес открывается сразу, иначе — предупреждение. */
function openLink(url, display) {
  const parsed = typeof url === "string" ? new URL(url) : url;
  if (linkTrusted(parsed)) openExternal(parsed.toString());
  else linkWarningModal(parsed, display);
}

function linkTrusted(url) {
  const saved = (readSetting("linkSafety", { savedOrigins: [] }) || {}).savedOrigins || [];
  return url.origin !== "null" && saved.includes(url.origin);
}

function trustLink(url) {
  if (url.origin === "null") return;
  const saved = (readSetting("linkSafety", { savedOrigins: [] }) || {}).savedOrigins || [];
  if (!saved.includes(url.origin)) writeSetting("linkSafety", { savedOrigins: [...saved, url.origin] });
}

/** «Внешние ссылки могут быть опасны!» (LinkWarning.tsx). */
function linkWarningModal(url, display) {
  const dest = url.toString();
  let scrutiny = 0;
  if (dest !== display) {
    try {
      scrutiny = new URL(display).toString() === dest ? 1 : 2;
    } catch {
      scrutiny = 1;
    }
  }
  let confirmed = false;
  let box = null;
  const underline = (text) => h("span", { class: "link-warning-url", text });
  const body = h("div", { class: "form-stack" }, [
    h("span", {}, [t("Are you sure you want to go to "), underline(dest), "?"]),
  ]);
  const actions = [
    { label: t("Close"), onclick: closeModal },
    {
      label: t("Continue"),
      primary: true,
      disabled: scrutiny === 2,
      onclick: () => {
        if (scrutiny === 2 && !confirmed) return;
        closeModal();
        openExternal(dest);
        if (confirmed && scrutiny === 0) trustLink(url);
      },
    },
  ];
  if (scrutiny === 0) {
    const row = checkboxRow("", false, (value) => (confirmed = value));
    row.lastChild.replaceChildren(t("Don't ask me again for "), underline(url.origin));
    body.append(row);
  } else if (scrutiny === 1) {
    body.append(h("span", { text: t('You clicked on "{0}"', [display]) }));
  } else {
    const row = checkboxRow(t("I understand the consequences"), false, (value) => {
      confirmed = value;
      const button = box && box.querySelector(".modal-actions .button.filled");
      if (button) button.disabled = !value;
    });
    body.append(
      h("span", { class: "link-warning-scrutinise" }, [
        h("span", {}, I18N.rich("<0>Be careful!</0><1/>This is not the same as the link that was displayed:", null, {
          0: (text) => h("strong", { text }),
          1: h("br"),
        })),
        underline(display),
        row,
      ]),
    );
  }
  box = openModal({ title: t("External links can be dangerous!"), body, actions });
}

/** Ссылка на сам клиент: канал, сервер, приглашение или другой раздел. */
function internalAnchor(node, context, href, url) {
  const path = url.pathname;
  const host = url.hostname;
  let instanceHost = "stoat.chat";
  try {
    instanceHost = new URL(markdownOrigin).hostname;
  } catch {
    /* остаётся адрес по умолчанию */
  }
  const remote = host !== instanceHost;
  const disabled = context.simple;

  const channelMatch = RE_CHANNEL_PATH.exec(path);
  if (channelMatch) {
    const [, , channelId, messageId] = channelMatch;
    const found = findChannel(channelId);
    if (!remote && !found) {
      return h("span", { class: "md-internal" }, [symbol("tag", 16), t("Private Channel")]);
    }
    const parts = [
      symbol(remote ? "tag" : found && found.channel.kind === "voice" ? "headset_mic" : "tag", 16),
      remote ? t("Remote Channel") : found.channel.name,
      messageId ? symbol("md:chevron_right", 14) : null,
      messageId ? symbol("md:chat", 14) : null,
    ];
    return internalPill(parts, disabled, href, () => {
      if (remote) openExternal(href);
      else if (messageId) jumpToMessage({ server: found.server ? found.server.id : null, channel: channelId, message: messageId });
      else openChannel(found.channel);
    });
  }

  const serverMatch = RE_SERVER_PATH.exec(path);
  if (serverMatch) {
    const server = serverById(serverMatch[1]);
    if (!remote && !server) {
      return h("span", { class: "md-internal" }, [symbol("md:people", 14), t("Unknown Server")]);
    }
    const parts = remote
      ? [symbol("md:people", 14), t("Remote Server")]
      : [avatar({ url: server.icon, name: server.name, size: 16 }), server.name];
    return internalPill(parts, disabled, href, () => (remote ? openExternal(href) : selectServer(server.id)));
  }

  const inviteMatch = RE_INVITE_PATH.exec(path);
  // приглашение карточкой — только если в тексте просто ссылка
  if (inviteMatch && !disabled && markdownText(node) === href) return inviteCard(inviteMatch[1], href);

  return linkElement(node, context, href, () => openInAppPath(url));
}

function internalPill(parts, disabled, href, onOpen) {
  if (disabled) return h("span", { class: "md-internal" }, parts);
  const anchor = h("a", { class: "md-internal", href }, parts);
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen();
  });
  return anchor;
}

/** Путь веб-клиента, открытый ссылкой внутри приложения (navigate). */
function openInAppPath(url) {
  const path = url.pathname;
  const invite = RE_INVITE_PATH.exec(path);
  if (invite) return openInviteModal(invite[1]);
  if (/^\/friends\/?$/.test(path)) return openHomePage("friends");
  if (/^\/(?:app|home)?\/?$/.test(path)) return openHomePage("home");
  if (/^\/discover/.test(path)) return openDiscover(path.replace(/^\/discover/, "") || "/");
  if (/^\/bot\/(\w+)/.test(path)) return addBotModal(/^\/bot\/(\w+)/.exec(path)[1]);
  return openExternal(url.toString());
}

// ─────────────────────────── приглашение (Invite.tsx) ───────────────────────────

const inviteRequests = new Map(); // код → Promise<приглашение>

function fetchInvite(code) {
  if (!inviteRequests.has(code)) {
    inviteRequests.set(
      code,
      call("preview_invite", { code }).catch((error) => {
        inviteRequests.delete(code);
        throw error;
      }),
    );
  }
  return inviteRequests.get(code);
}

function inviteCard(code, href) {
  const card = h("span", { class: "invite-card" }, [h("span", { class: "spinner small" })]);
  fetchInvite(code)
    .then((info) => {
      const name = info.server_name || info.channel_name || "";
      const joined = Boolean(info.server_id && serverById(info.server_id));
      const button = h("button", { class: "button filled", type: "button", text: joined ? t("Joined") : t("Join") });
      button.disabled = joined;
      button.onclick = async (event) => {
        event.stopPropagation();
        button.disabled = true;
        try {
          const target = await call("join_invite", { code });
          await refreshWorkspace();
          if (serverById(target)) selectServer(target);
        } catch (error) {
          button.disabled = false;
          toast(describe(error), "error");
        }
      };
      card.replaceChildren(
        avatar({ url: info.icon, name, size: 42 }),
        h("span", { class: "invite-card-text" }, [
          h("span", { class: "invite-card-name", text: name }),
          h("span", { class: "invite-card-count", text: t("{0} members", [I18N.number(info.member_count || 0)]) }),
        ]),
        button,
      );
    })
    // недействительное приглашение остаётся текстом ссылки
    .catch(() => card.replaceWith(h("span", { class: "md-link", text: href })));
  return card;
}

/** Окно приглашения (Invite modal): «Вступить» или «Открыть», если уже там. */
async function openInviteModal(code) {
  let info;
  try {
    info = await fetchInvite(code);
  } catch (error) {
    toast(describe(error), "error");
    return;
  }
  const name = info.server_name || info.channel_name || "";
  const joined = Boolean(info.server_id && serverById(info.server_id));
  openModal({
    title: h("span", { class: "invite-modal-title" }, [avatar({ url: info.icon, name, size: 32 }), name]),
    body: h("div", {}, joined
      ? [t("You're already part of this server.")]
      : I18N.rich("You've been invited to join this server.<0/>Would you like to join?", null, { 0: h("br") })),
    actions: [
      { label: t("Cancel"), onclick: closeModal },
      {
        label: joined ? t("Open") : t("Join"),
        primary: true,
        onclick: async () => {
          try {
            const target = joined ? info.server_id : await call("join_invite", { code });
            closeModal();
            // окно могли открыть из настроек (Stoat Lounge на странице «Отзывы»)
            if (settings.kind) closeSettings();
            await refreshWorkspace();
            if (serverById(target)) selectServer(target);
          } catch (error) {
            toast(describe(error), "error");
          }
        },
      },
    ],
  });
}

// ─────────────────────────── строка ответа (MessageReply.tsx) ───────────────────────────

/** Обрезать текст, не разрезая `:id:` своего эмодзи (truncateKeepingEmoji). */
function truncateKeepingEmoji(content, length) {
  const re = /:[0-9A-HJKMNP-TV-Z]{26}:/g;
  let match;
  while ((match = re.exec(content))) {
    if (match.index < length && match.index + match[0].length > length) return content.slice(0, match.index + match[0].length);
    if (match.index >= length) break;
  }
  return content.slice(0, length);
}

/** Текст ответа: не длиннее 128 знаков, в одну строку, упрощённая разметка. */
function replyMarkdown(content, serverId) {
  let text = content;
  if (text.length > 128) text = truncateKeepingEmoji(text, 128) + "...";
  return renderMarkdown(text.replace(/\n/g, " "), { mode: "simple", serverId });
}

// ─────────────────────────── для системных сообщений (SystemMessage.tsx) ───────────────────────────

/** Ссылка, как `<RenderAnchor href>` без текста: канал или сообщение плашкой. */
function markdownAnchor(href, serverId = null) {
  const node = { type: "element", tagName: "a", properties: { href }, children: [] };
  return anchorNode(node, { mode: "full", simple: false, serverId, math: false });
}

/** Упоминание пользователя, как `<UserMention>`. */
function markdownUserMention(userId, serverId = null) {
  return userMention(userId, { mode: "full", simple: false, serverId, math: false });
}
