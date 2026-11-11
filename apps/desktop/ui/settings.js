// Настройки пользователя и сервера — по образцу браузерного клиента Stoat
// (components/app/interface/settings): слева список разделов, справа
// содержимое шириной до 740px и кнопка закрытия.
//
// Подключается до app.js и пользуется его помощниками только во время вызова.

"use strict";

/**
 * Права в редакторе роли сервера — тот же список, что в браузерном клиенте
 * (ChannelPermissionsEditor.tsx, описания для контекста «Server»).
 */
const PERMISSIONS = [
  { heading: /* i18n */ "Admin", bit: 1 << 0, title: /* i18n */ "Manage Channel", hint: /* i18n */ "Edit and delete channel" },
  { bit: 1 << 1, title: /* i18n */ "Manage Server", hint: /* i18n */ "Edit the server's information and settings" },
  { bit: 1 << 2, title: /* i18n */ "Manage Permissions", hint: /* i18n */ "Edit any permissions on the server" },
  { bit: 1 << 3, title: /* i18n */ "Manage Roles", hint: /* i18n */ "Create and edit server roles" },
  { bit: 1 << 4, title: /* i18n */ "Manage Customisation", hint: /* i18n */ "Create server emoji" },
  { heading: /* i18n */ "Members", bit: 1 << 6, title: /* i18n */ "Kick Members", hint: /* i18n */ "Kick lower-ranking members from the server" },
  { bit: 1 << 7, title: /* i18n */ "Ban Members", hint: /* i18n */ "Ban lower-ranking members from the server" },
  { bit: 1 << 8, title: /* i18n */ "Timeout Members", hint: /* i18n */ "Temporarily prevent lower-ranking members from interacting" },
  { bit: 1 << 9, title: /* i18n */ "Assign Roles", hint: /* i18n */ "Assign lower-ranked roles to lower-ranking members" },
  { bit: 1 << 10, title: /* i18n */ "Change Nickname", hint: /* i18n */ "Change own nickname" },
  { bit: 1 << 11, title: /* i18n */ "Manage Nicknames", hint: /* i18n */ "Change other members' nicknames" },
  { bit: 1 << 12, title: /* i18n */ "Change Avatar", hint: /* i18n */ "Change own avatar" },
  { bit: 1 << 13, title: /* i18n */ "Remove Avatars", hint: /* i18n */ "Remove other members' avatars" },
  { heading: /* i18n */ "Channels", bit: 1 << 20, title: /* i18n */ "View Channel", hint: /* i18n */ "Able to access channels on this server" },
  { bit: 1 << 21, title: /* i18n */ "Read Message History", hint: /* i18n */ "Read past messages sent in channels" },
  { bit: 1 << 22, title: /* i18n */ "Send Messages", hint: /* i18n */ "Send messages in channels" },
  { bit: 1 << 23, title: /* i18n */ "Manage Messages", hint: /* i18n */ "Delete and pin messages sent by other members" },
  { bit: 1 << 24, title: /* i18n */ "Manage Webhooks", hint: /* i18n */ "Create and edit webhooks" },
  { bit: 1 << 25, title: /* i18n */ "Invite Others", hint: /* i18n */ "Create invites for others to use" },
  { heading: /* i18n */ "Messaging", bit: 1 << 26, title: /* i18n */ "Send Embeds", hint: /* i18n */ "Send embedded content such as link embeds or custom embeds" },
  { bit: 1 << 27, title: /* i18n */ "Upload Files", hint: /* i18n */ "Send attachments to chat" },
  { bit: 1 << 28, title: /* i18n */ "Masquerade", hint: /* i18n */ "Allow members to change name and avatar per-message" },
  { bit: 1 << 29, title: /* i18n */ "React", hint: /* i18n */ "React to messages with emoji" },
  { bit: 2 ** 39, title: /* i18n */ "Bypass Slowmode", hint: /* i18n */ "Bypasses slowmode in channels" },
  { heading: /* i18n */ "Voice", bit: 2 ** 30, title: /* i18n */ "Connect", hint: /* i18n */ "Connect to voice channel" },
  { bit: 2 ** 31, title: /* i18n */ "Speak", hint: /* i18n */ "Able to speak in voice call" },
  { bit: 2 ** 32, title: /* i18n */ "Video", hint: /* i18n */ "Share camera or screen in voice call" },
  { bit: 2 ** 33, title: /* i18n */ "Mute Members", hint: /* i18n */ "Mute lower-ranking members in voice call" },
  { bit: 2 ** 34, title: /* i18n */ "Deafen Members", hint: /* i18n */ "Deafen lower-ranking members in voice call" },
  { bit: 2 ** 35, title: /* i18n */ "Move Members", hint: /* i18n */ "Move members between voice channels" },
  { bit: 2 ** 36, title: /* i18n */ "Listen", hint: /* i18n */ "Hear other people and see their video" },
  { heading: /* i18n */ "Mentions", bit: 2 ** 37, title: /* i18n */ "Mention Everyone", hint: /* i18n */ "Mention everyone and online members inside the server" },
  { bit: 2 ** 38, title: /* i18n */ "Mention Roles", hint: /* i18n */ "Mention specific roles" },
];

const PERM = {
  MANAGE_CHANNEL: 1 << 0,
  MANAGE_SERVER: 1 << 1,
  MANAGE_PERMISSIONS: 1 << 2,
  MANAGE_ROLE: 1 << 3,
  MANAGE_CUSTOMISATION: 1 << 4,
  KICK: 1 << 6,
  BAN: 1 << 7,
  ASSIGN_ROLES: 1 << 9,
  MANAGE_NICKNAMES: 1 << 11,
  INVITE: 1 << 25,
};

/** Бит есть в маске. Маски шире 32 бит, поэтому без побитовых операций JS. */
function hasBit(mask, bit) {
  return Math.floor(Number(mask || 0) / bit) % 2 === 1;
}

function setBit(mask, bit, on) {
  const has = hasBit(mask, bit);
  if (on && !has) return Number(mask || 0) + bit;
  if (!on && has) return Number(mask || 0) - bit;
  return Number(mask || 0);
}

// ─────────────────────────── каркас ───────────────────────────

const settings = {
  kind: null, // "user" | "server"
  serverId: null,
  page: null,
  server: null, // настройки сервера с ядра
  about: null, // версия и ссылки на правила (команда about)
  instance: null, // сводка по инстансу: есть ли видео (instance_info)
  token: 0,
};

/** Ссылки браузерного клиента (UserSettings.tsx, Feedback.tsx). */
const LINKS = {
  source: "https://github.com/sssHpion007/Arachnid-Client-Stoat",
  donate: "https://ko-fi.com/stoatchat",
  suggestions: "https://github.com/orgs/stoatchat/discussions/categories/feature-suggestions",
  feedback: "https://github.com/orgs/stoatchat/discussions/categories/feedback",
  bugs: "https://github.com/stoatchat/for-web/issues?q=is%3Aissue%20state%3Aopen%20type%3ABug",
};

/** Официальный сервер Stoat Lounge и приглашение в него. */
const LOUNGE_ID = "01F7ZSBSFHQ8TA81725KQCSDDP";
const LOUNGE_INVITE = "Testers";

function settingsOpen() {
  return !el("settings").classList.contains("hidden");
}

function closeSettings() {
  el("settings").classList.add("hidden");
  el("settings").textContent = "";
  settings.kind = null;
  settings.server = null;
}

/** Настройки пользователя. */
function openUserSettings(page = "account") {
  closeMenus();
  closeModal();
  settings.kind = "user";
  settings.serverId = null;
  settings.page = page;
  renderSettings();
  if (!settings.instance) {
    instanceInfo()
      .then((info) => {
        settings.instance = info;
        // без видео раздел называется просто «Голос»
        if (!info.video && settings.kind === "user") renderSettings();
      })
      .catch(() => {});
  }
}

/** Настройки сервера. */
async function openServerSettings(serverId, page = null) {
  closeMenus();
  closeModal();
  settings.kind = "server";
  settings.serverId = serverId;
  settings.server = await call("server_settings", { serverId });
  settings.page = page || firstServerPage();
  renderSettings();
}

/**
 * Разделы настроек пользователя в порядке браузерного клиента
 * (UserSettings.tsx). «Мой аккаунт» открывается карточкой над списком,
 * поэтому скрыт.
 */
function userPages() {
  // «Голос и видео» или просто «Голос», если инстанс не поддерживает видео
  const video = !settings.instance || settings.instance.video;
  return [
    {
      title: t("User Settings"),
      entries: [
        { id: "account", title: t("My Account"), hidden: true, hideTitle: true, render: renderAccountPage },
        { id: "profile", icon: "account_circle", title: t("Profile"), render: renderProfilePage },
        { id: "sessions", icon: "verified_user", title: t("Sessions"), render: renderSessionsPage },
      ],
    },
    {
      title: "Stoat",
      entries: [
        { id: "bots", icon: "smart_toy", title: t("My Bots"), render: renderBotsPage },
        { id: "feedback", icon: "rate_review", title: t("Feedback"), render: renderFeedbackPage },
      ],
    },
    {
      title: t("Client Settings"),
      entries: [
        { id: "voice", icon: "mic", title: video ? t("Voice & Video") : t("Voice"), render: renderVoicePage },
        { id: "appearance", icon: "palette", title: t("Appearance"), render: renderAppearancePage },
        { id: "notifications", icon: "notifications", title: t("Notifications"), render: renderNotificationsPage },
        { id: "language", icon: "language", title: t("Language"), render: renderLanguagePage },
        { id: "native", icon: "desktop_windows", title: t("Desktop"), render: renderDesktopPage },
      ],
    },
    {
      entries: [
        { id: "changelog", icon: "campaign", title: t("What's New"), action: openChangelog },
        { id: "source", icon: "memory", title: t("Source Code"), href: LINKS.source },
        { id: "advanced", icon: "science", title: t("Advanced"), render: renderAdvancedPage },
        { id: "donate", icon: "coffee", title: t("Donate"), href: LINKS.donate },
        { id: "logout", icon: "logout", title: t("Log Out"), danger: true, action: logout },
      ],
    },
  ];
}

/**
 * Вложенные страницы (Breadcrumbs): «bots/<id>» — страница бота внутри
 * «Моих ботов». Возвращает заголовок и отрисовку для полного пути.
 */
function nestedPage(path) {
  const [root, id] = path.split("/");
  if (root === "bots" && id) {
    return { title: botTitles.get(id) || "", render: (column, alive) => renderBotPage(column, alive, id) };
  }
  return null;
}

function serverPages() {
  const server = settings.server;
  const can = (bit) => server.is_owner || hasBit(server.permissions, bit);
  return [
    {
      title: server.name,
      entries: [{ id: "overview", icon: "info", title: t("Overview"), hidden: !can(PERM.MANAGE_SERVER), render: renderOverviewPage }],
    },
    {
      title: t("Customisation"),
      entries: [
        { id: "emojis", icon: "mood", title: t("Emojis"), hidden: !can(PERM.MANAGE_CUSTOMISATION), render: renderEmojiPage },
      ],
    },
    {
      title: t("Members"),
      entries: [
        {
          id: "members",
          icon: "group",
          title: t("Members"),
          hidden: !(can(PERM.KICK) || can(PERM.BAN) || can(PERM.ASSIGN_ROLES) || can(PERM.MANAGE_NICKNAMES)),
          render: renderMembersPage,
        },
        { id: "roles", icon: "badge", title: t("Roles"), hidden: !can(PERM.MANAGE_ROLE), render: renderRolesPage },
        { id: "invites", icon: "link", title: t("Invites"), hidden: !can(PERM.MANAGE_SERVER), render: renderInvitesPage },
        { id: "bans", icon: "block", title: t("Bans"), hidden: !can(PERM.BAN), render: renderBansPage },
      ],
    },
    {
      entries: [
        server.is_owner
          ? { id: "delete", icon: "delete", title: t("Delete Server"), danger: true, action: () => confirmLeaveServer(server) }
          : { id: "leave", icon: "logout", title: t("Leave server"), danger: true, action: () => confirmLeaveServer(server) },
      ],
    },
  ];
}

function firstServerPage() {
  for (const group of serverPages()) {
    const entry = group.entries.find((item) => !item.hidden && item.render);
    if (entry) return entry.id;
  }
  return null;
}

function currentPages() {
  return settings.kind === "server" ? serverPages() : userPages();
}

/** Пункт списка разделов: страница, действие или внешняя ссылка. */
function sidebarEntry(entry) {
  const content = [symbol(entry.icon, 20), h("span", { class: "settings-entry-title", text: entry.title })];
  const kind = "settings-entry" + (entry.danger ? " danger" : "");
  if (entry.href) {
    // ссылки с target=_blank открывает в браузере плагин shell
    return h("a", { class: kind, href: entry.href, target: "_blank", rel: "noreferrer" }, content);
  }
  const selected = settings.page === entry.id || settings.page.startsWith(entry.id + "/");
  const button = h("button", { type: "button", class: kind, "aria-selected": String(selected) }, content);
  button.onclick = async () => {
    if (entry.action) {
      try {
        await entry.action();
      } catch (error) {
        toast(describe(error), "error");
      }
      return;
    }
    settings.page = entry.id;
    renderSettings();
  };
  return button;
}

/** Карточка «Мой аккаунт» над списком разделов (_AccountCard.tsx). */
function accountCard() {
  const me = state.me;
  const button = h(
    "button",
    { type: "button", class: "settings-entry settings-account", "aria-selected": String(settings.page === "account") },
    [
      avatar({ url: me.avatar, name: myName(), size: 36 }),
      h("span", { class: "settings-account-text" }, [
        h("span", { class: "settings-account-name", text: myName() }),
        h("span", { text: t("My Account") }),
      ]),
    ],
  );
  button.onclick = () => {
    settings.page = "account";
    renderSettings();
  };
  return button;
}

/** Подвал списка: версия клиента и правила инстанса. */
function sidebarFooter() {
  const footer = h("div", { class: "settings-footer" });
  const fill = (about) => {
    const legal = about.legal || {};
    const links = [
      [legal.terms_of_service, t("Terms")],
      [legal.privacy_policy, t("Privacy")],
      [legal.guidelines, t("Guidelines")],
    ].filter(([href]) => href);
    put(footer,
      h("span", { class: "settings-footer-line" }, [
        h("span", { class: "settings-footer-label", text: t("Version:") + " " }),
        h("span", { class: "selectable-all", text: about.version }),
      ]),
      h("span", { class: "settings-footer-line small" }, [
        ["Tauri " + about.tauri, about.webview ? "WebView " + about.webview : null].filter(Boolean).join(", "),
      ]),
      links.length
        ? h(
            "span",
            { class: "settings-footer-line settings-legal" },
            links.map(([href, title]) => h("a", { href, target: "_blank", rel: "noreferrer", text: title })),
          )
        : null,
    );
  };
  if (settings.about) fill(settings.about);
  else
    call("about")
      .then((about) => {
        settings.about = about;
        fill(about);
      })
      .catch(() => {});
  return footer;
}

function renderSettings() {
  const root = el("settings");
  const groups = currentPages();
  const token = ++settings.token;
  const user = settings.kind === "user";

  const nav = h("nav", { class: "settings-nav" });
  if (user) nav.append(h("div", { class: "settings-group" }, [accountCard()]));
  for (const group of groups) {
    const visible = group.entries.filter((entry) => !entry.hidden);
    if (!visible.length) continue;
    const column = h("div", { class: "settings-group" });
    if (group.title) column.append(h("span", { class: "settings-category", text: group.title }));
    for (const entry of visible) column.append(sidebarEntry(entry));
    nav.append(column);
  }
  if (user) nav.append(sidebarFooter());

  const entries = groups.flatMap((group) => group.entries);
  const segments = settings.page.split("/");
  const entry = entries.find((item) => item.id === segments[0]);
  const nested = segments.length > 1 ? nestedPage(settings.page) : null;
  const column = h("div", { class: "settings-column" });
  if (entry && !entry.hideTitle) column.append(settingsTitle(segments, entry, nested));
  const close = h("button", { type: "button", class: "icon-button tonal settings-close", title: t("Close") }, [symbol("close", 24)]);
  close.onclick = closeSettings;

  root.replaceChildren(
    h("div", { class: "settings-sidebar" }, [nav]),
    h("div", { class: "settings-content" }, [
      h("div", { class: "settings-inner" }, [column]),
      h("div", { class: "settings-rail" }, [close, h("span", { class: "settings-rail-hint", text: "ESC" })]),
    ]),
  );
  root.classList.remove("hidden");

  const render = nested ? nested.render : entry && entry.render;
  if (render) {
    Promise.resolve(render(column, () => token === settings.token)).catch((error) => {
      if (token === settings.token) column.append(notice(describe(error), "error"));
    });
  }
}

/**
 * Заголовок страницы с «хлебными крошками» (Breadcrumbs.tsx): предыдущие
 * части пути — ссылки, последняя — текущая страница.
 */
function settingsTitle(segments, entry, nested) {
  const title = h("h1", { class: "settings-title settings-crumbs" });
  segments.forEach((_, index) => {
    const last = index === segments.length - 1;
    const text = index === 0 ? entry.title : nested ? nested.title : "";
    if (index) title.append(symbol("chevron_right", 16));
    if (last) {
      title.append(h("span", { class: "settings-crumb-current", text }));
      return;
    }
    const link = h("button", { type: "button", class: "settings-crumb", text });
    link.onclick = () => {
      settings.page = segments.slice(0, index + 1).join("/");
      renderSettings();
    };
    title.append(link);
  });
  return title;
}

// ─────────────────────────── элементы форм ───────────────────────────

/** append без пустых мест: необязательные элементы передаются как null. */
function put(parent, ...nodes) {
  parent.append(...nodes.filter(Boolean));
}

function notice(text, kind = "") {
  return h("div", { class: "settings-notice " + kind, text });
}

function section(title, children, hint = null) {
  return h("section", { class: "settings-section" }, [
    title ? h("h2", { class: "settings-section-title", text: title }) : null,
    hint ? h("p", { class: "settings-hint", text: hint }) : null,
    ...children,
  ]);
}

function textInput({ value = "", placeholder = "", maxlength = null, type = "text" } = {}) {
  return h("input", { class: "text-field", type, value: value || "", placeholder, maxlength, autocomplete: "off" });
}

function labelled(label, control, hint = null) {
  return h("label", { class: "field" }, [
    h("span", { class: "field-label", text: label }),
    control,
    hint ? h("span", { class: "settings-hint", text: hint }) : null,
  ]);
}

function actionButton(label, run, { kind = "filled", icon = null, danger = false } = {}) {
  const button = h("button", { type: "button", class: "button " + kind + (danger ? " danger" : "") + (label ? "" : " icon-only") }, [
    icon ? symbol(icon, 20) : null,
    label ? h("span", { text: label }) : null,
  ]);
  button.onclick = async (event) => {
    event.stopPropagation();
    button.disabled = true;
    try {
      await run(event);
    } catch (error) {
      toast(describe(error), "error");
    } finally {
      button.disabled = false;
    }
  };
  return button;
}

function toggleRow(title, hint, checked, onchange) {
  const input = h("input", { type: "checkbox", class: "switch" });
  input.checked = Boolean(checked);
  input.onchange = () => onchange(input.checked);
  return h("label", { class: "settings-row" }, [
    h("span", { class: "settings-row-text" }, [
      h("span", { class: "settings-row-title", text: title }),
      hint ? h("span", { class: "settings-hint", text: hint }) : null,
    ]),
    input,
  ]);
}

function choiceRow(options, current, onchoose) {
  const row = h("div", { class: "choice-row", role: "radiogroup" });
  for (const option of options) {
    const button = h("button", {
      type: "button",
      class: "choice" + (option.id === current ? " selected" : ""),
      role: "radio",
      "aria-checked": String(option.id === current),
      text: option.label,
    });
    button.onclick = () => {
      row.querySelectorAll(".choice").forEach((node) => {
        node.classList.toggle("selected", node === button);
        node.setAttribute("aria-checked", String(node === button));
      });
      onchoose(option.id);
    };
    row.append(button);
  }
  return row;
}

/** Окно с полями и кнопкой подтверждения; `submit` получает значения полей. */
function formModal({ title, text = null, fields, confirm, cancel = t("Cancel"), danger = false, submit }) {
  const inputs = fields.map((field) => {
    const input = field.multiline
      ? h("textarea", { class: "text-field multiline", rows: 4, maxlength: field.maxlength, placeholder: field.placeholder || "" })
      : textInput(field);
    if (field.multiline) input.value = field.value || "";
    return input;
  });
  const run = async () => {
    try {
      await submit(...inputs.map((input) => input.value));
      closeModal();
    } catch (error) {
      toast(describe(error), "error");
    }
  };
  inputs.forEach((input) =>
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && input.tagName !== "TEXTAREA") {
        event.preventDefault();
        run();
      }
    }),
  );
  const box = openModal({
    title,
    body: h("div", { class: "form-stack" }, [
      text ? h("p", { class: "settings-hint", text }) : null,
      ...fields.map((field, index) => labelled(field.label, fieldControl(field, inputs[index]), field.hint)),
    ]),
    actions: [
      { label: cancel, onclick: closeModal },
      { label: confirm, primary: true, onclick: run },
    ],
  });
  if (danger) box.querySelector(".button.filled").classList.add("danger");
  if (inputs[0]) inputs[0].focus();
}

/** Поле формы со счётчиком символов и подписью справа (`#1234`). */
function fieldControl(field, input) {
  if (!field.counter && !field.suffix) return input;
  const parts = [input];
  if (field.suffix) parts.push(h("span", { class: "field-suffix", text: field.suffix }));
  const row = h("span", { class: "field-row" }, parts);
  if (!field.counter || !field.maxlength) return row;
  const counter = h("span", { class: "field-counter" });
  const count = () => (counter.textContent = `${input.value.length}/${field.maxlength}`);
  input.addEventListener("input", count);
  count();
  return h("span", { class: "field-stack" }, [row, counter]);
}

/** Простое подтверждение. */
function confirmModal({ title, text, confirm, danger = true, run }) {
  const box = openModal({
    title,
    body: h("p", { class: "settings-hint", text }),
    actions: [
      { label: t("Cancel"), onclick: closeModal },
      {
        label: confirm,
        primary: true,
        onclick: async () => {
          try {
            await run();
            closeModal();
          } catch (error) {
            toast(describe(error), "error");
          }
        },
      },
    ],
  });
  if (danger) box.querySelector(".button.filled").classList.add("danger");
}

/** Выбрать файл и прочитать его в base64. */
function pickFile(accept = "image/*") {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept });
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result || "");
        resolve({ name: file.name, type: file.type, size: file.size, data: data.slice(data.indexOf(",") + 1), preview: data });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

async function uploadPicked(file, tag) {
  return call("upload_file", { tag, filename: file.name, contentType: file.type || null, data: file.data });
}

/** Картинка с кнопками «Загрузить» и «Убрать» (аватар, значок, фон, баннер). */
function imagePicker({ label, url, round = false, wide = false, tag, onchange }) {
  const preview = h("div", { class: "image-preview" + (round ? " round" : "") + (wide ? " wide" : "") });
  const show = (data) => {
    preview.style.backgroundImage = data ? `url("${data}")` : "";
    preview.classList.toggle("empty", !data);
  };
  show(null);
  if (url) mediaUrl(url).then((data) => data && show(data));

  const choice = { file: null, removed: false };
  const upload = actionButton(
    t("Upload"),
    async () => {
      const file = await pickFile();
      if (!file) return;
      const limit = await uploadLimit(tag);
      if (file.size > limit) throw new Error(t("The file exceeds the maximum size limit of {0}.", [humanSize(limit)]));
      choice.file = file;
      choice.removed = false;
      show(file.preview);
      onchange && onchange(choice);
    },
    { kind: "tonal", icon: "attach_file" },
  );
  const remove = actionButton(
    t("Remove"),
    async () => {
      choice.file = null;
      choice.removed = true;
      show(null);
      onchange && onchange(choice);
    },
    { kind: "text" },
  );
  const node = h("div", { class: "field" }, [
    h("span", { class: "field-label", text: label }),
    h("div", { class: "image-picker" }, [preview, h("div", { class: "image-actions" }, [upload, remove])]),
  ]);
  return { node, state: choice, tag };
}

// ─────────────────────────── кнопки разделов ───────────────────────────

/** Значки действий справа (CategoryButton.tsx). */
const CATEGORY_ACTIONS = {
  chevron: "chevron_right",
  collapse: "keyboard_arrow_down",
  external: "open_in_new",
  copy: "content_copy",
};

/**
 * Строка-кнопка в стиле CategoryButton: круглый значок, заголовок с
 * описанием и значки действий. `icon: "blank"` оставляет пустое место
 * под значок (вложенные пункты), `href` делает из неё внешнюю ссылку.
 * Кнопкой служит div с ролью button: в описании бывают свои ссылки
 * («Показать»), а кнопки в кнопке HTML не допускает.
 */
function categoryButton({ icon = null, title, description = null, action = null, onclick = null, href = null, disabled = false, danger = false, variant = null }) {
  const interactive = Boolean(onclick || href);
  const kind =
    "cb" + (interactive ? " interactive" : "") + (disabled ? " disabled" : "") + (danger ? " danger" : "") + (variant ? " " + variant : "");
  const node = href
    ? h("a", { class: kind, href, target: "_blank", rel: "noreferrer" })
    : h("div", { class: kind, role: onclick ? "button" : null, tabindex: onclick && !disabled ? "0" : null, "aria-disabled": disabled ? "true" : null });

  if (icon === "blank") node.append(h("span", { class: "cb-icon blank" }));
  else if (icon) node.append(h("span", { class: "cb-icon" }, [typeof icon === "string" ? symbol(icon, 22) : icon]));

  node.append(
    h("span", { class: "cb-content" }, [
      title ? h("span", { class: "cb-title" }, [title]) : null,
      description ? h("span", { class: "cb-description" }, [description]) : null,
    ]),
  );
  for (const item of [].concat(action || [])) {
    // действие — имя значка или готовый элемент (флажок, переключатель)
    node.append(h("span", { class: "cb-action" }, [typeof item === "string" ? symbol(CATEGORY_ACTIONS[item], 18) : item]));
  }

  if (onclick && !href) {
    let busy = false;
    const run = async () => {
      if (disabled || busy) return;
      busy = true;
      try {
        await onclick();
      } catch (error) {
        toast(describe(error), "error");
      } finally {
        busy = false;
      }
    };
    node.addEventListener("click", run);
    node.addEventListener("keydown", (event) => {
      if (event.target !== node || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      run();
    });
  }
  return node;
}

/** Флажок Material 3 (mdui-checkbox) для кнопок разделов. */
function checkboxMark(checked) {
  const box = h("span", { class: "m3-checkbox" + (checked ? " checked" : ""), role: "checkbox", "aria-checked": String(Boolean(checked)) });
  box.append(symbol("check", 16));
  return box;
}

function setCheckboxMark(box, checked) {
  box.classList.toggle("checked", Boolean(checked));
  box.setAttribute("aria-checked", String(Boolean(checked)));
}

/** Переключатель-радио (Radio2.Option). */
function radioMark(checked) {
  return h("span", { class: "m3-radio" + (checked ? " checked" : ""), role: "radio", "aria-checked": String(Boolean(checked)) });
}

/**
 * Кнопка с флажком справа: щелчок по всей строке переключает значение.
 * `get` читает текущее значение, `set` сохраняет новое (может вернуть
 * Promise и фактическое значение, как автозапуск).
 */
function categoryCheckbox({ icon = null, title, description = null, get, set, disabled = false }) {
  const mark = checkboxMark(get());
  return categoryButton({
    icon,
    title,
    description,
    disabled,
    action: mark,
    onclick: async () => {
      const wanted = !get();
      const saved = await set(wanted);
      setCheckboxMark(mark, typeof saved === "boolean" ? saved : wanted);
    },
  });
}

/** Отдельный флажок с подписью (Checkbox с текстом в оригинале). */
function checkboxRow(label, checked, onchange) {
  const mark = checkboxMark(checked);
  const row = h("div", { class: "checkbox-row", role: "button", tabindex: "0" }, [mark, h("span", { text: label })]);
  let value = Boolean(checked);
  const toggle = () => {
    value = !value;
    setCheckboxMark(mark, value);
    onchange(value);
  };
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });
  return row;
}

/**
 * Выпадающий список из кнопок (CategoryButton.Select): в заголовке —
 * выбранный вариант, внутри — варианты с радио. `options` — массив
 * { id, title, shortDesc?, description?, icon? }.
 */
function categorySelect({ icon = null, title, options, value, onUpdate }) {
  let current = options.some((option) => option.id === value) ? value : options.length ? options[0].id : null;
  const summary = (option) => (option ? option.shortDesc || option.description || option.title : null);
  const descriptionSlot = h("span", {});
  const showSummary = () => {
    const option = options.find((item) => item.id === current);
    const text = summary(option);
    descriptionSlot.replaceChildren(...(text === null || text === undefined ? [] : [text]));
  };
  showSummary();

  const rows = options.map((option) => {
    const mark = radioMark(option.id === current);
    const row = categoryButton({
      icon: option.icon || "blank",
      title: option.title || option.shortDesc,
      description: option.title ? option.description || null : null,
      variant: option.id === current ? "tertiary-alt" : "tertiary",
      action: mark,
      onclick: async () => {
        if (option.id === current) return;
        current = option.id;
        rows.forEach(({ node, radio, id }) => {
          node.classList.toggle("tertiary-alt", id === current);
          node.classList.toggle("tertiary", id !== current);
          radio.classList.toggle("checked", id === current);
          radio.setAttribute("aria-checked", String(id === current));
        });
        showSummary();
        await onUpdate(option.id);
      },
    });
    return { node: row, radio: mark, id: option.id };
  });

  const inner = h("div", { class: "cb-collapse-inner" }, rows.map((row) => row.node));
  const node = h("div", { class: "cb-collapse cb-select" });
  const head = categoryButton({
    icon,
    title,
    description: descriptionSlot,
    action: "collapse",
    onclick: () => {
      const open = !node.classList.contains("open");
      node.classList.toggle("open", open);
      inner.style.height = open ? Math.min(inner.scrollHeight, 340) + "px" : "0px";
      if (open && inner.scrollHeight > 340) {
        const selected = rows.find((row) => row.id === current);
        if (selected) inner.scrollTop = selected.node.offsetTop - inner.offsetTop;
      }
    },
  });
  inner.style.height = "0px";
  node.append(head, inner);
  return node;
}

/** Группа кнопок со скруглёнными краями (CategoryButton.Group). */
function categoryGroup(children) {
  return h("div", { class: "cb-group" }, children.filter(Boolean));
}

/** Кнопка, раскрывающая вложенные пункты (CategoryButton.Collapse). */
function categoryCollapse({ icon, title, description = null, children }) {
  const inner = h("div", { class: "cb-collapse-inner" }, children.filter(Boolean));
  const node = h("div", { class: "cb-collapse" });
  const head = categoryButton({
    icon,
    title,
    description,
    action: "collapse",
    onclick: () => {
      const open = !node.classList.contains("open");
      node.classList.toggle("open", open);
      if (open) inner.scrollTop = 0;
      inner.style.height = open ? Math.min(inner.scrollHeight, 340) + "px" : "0px";
    },
  });
  inner.style.height = "0px";
  node.append(head, inner);
  return node;
}

// ─────────────────────────── подтверждение (MFA) ───────────────────────────

/** Способы подтверждения в окне «Подтвердить действие» (MFAFlow.tsx). */
const MFA_METHODS = {
  Password: { icon: "keyboard", title: /* i18n */ "Password", type: "password", autocomplete: "current-password" },
  Totp: { icon: "key", title: /* i18n */ "Authenticator App", type: "text", autocomplete: "one-time-code" },
  Recovery: { icon: "archive", title: /* i18n */ "Recovery Code", type: "text", autocomplete: "off" },
};

/** Пересобрать кнопки открытого окна (окно перестраивается по шагам). */
function modalButtons(box, actions) {
  let bar = box.querySelector(".modal-actions");
  if (!bar) {
    bar = h("div", { class: "modal-actions" });
    box.append(bar);
  }
  const buttons = actions.map((action) =>
    h("button", {
      type: "button",
      class: "button " + (action.primary ? "filled" : "text") + (action.danger ? " danger" : ""),
      text: action.label,
      disabled: Boolean(action.disabled),
      onclick: action.onclick,
    }),
  );
  bar.replaceChildren(...buttons);
  return buttons;
}

/**
 * Окно «Подтвердить действие». `methods` — способы из `mfa_status`,
 * `run(answer)` выполняет действие с ответом пользователя: ядро само
 * обменяет его на тикет. Возвращает результат действия (или `true`, если
 * действие ничего не вернуло) либо `null`, если пользователь передумал.
 * Неверный пароль или код не закрывают окно — можно ввести заново.
 */
function mfaFlow(methods, run) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // единственный способ, кроме кодов восстановления, выбирается сразу
    let selected = methods.find((method) => method !== "Recovery") || null;
    const box = openModal({ title: t("Confirm action"), body: h("div"), onClose: () => finish(null) });
    const body = box.querySelector(".modal-body");

    const render = () => {
      if (!selected) {
        body.replaceChildren(
          h("div", { class: "form-stack" }, [
            h("p", { class: "settings-hint", text: t("Please select a method to authenticate your request.") }),
            categoryGroup(
              methods.map((method) =>
                categoryButton({
                  icon: MFA_METHODS[method].icon,
                  title: t(MFA_METHODS[method].title),
                  action: "chevron",
                  onclick: () => {
                    selected = method;
                    render();
                  },
                }),
              ),
            ),
          ]),
        );
        modalButtons(box, [{ label: t("Cancel"), onclick: closeModal }]);
        return;
      }

      const info = MFA_METHODS[selected];
      const input = textInput({ type: info.type });
      input.setAttribute("autocomplete", info.autocomplete);
      const submit = async () => {
        if (!input.value.trim() || confirm.disabled) return;
        confirm.disabled = true;
        try {
          const result = await run({ method: selected, value: input.value });
          finish(result === undefined || result === null ? true : result);
          closeModal();
        } catch (error) {
          toast(describe(error), "error");
          confirm.disabled = false;
          input.select();
        }
      };
      input.addEventListener("input", () => (confirm.disabled = !input.value.trim()));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      });
      body.replaceChildren(
        h("div", { class: "form-stack" }, [
          h("p", { class: "settings-hint", text: t("Please confirm this action using the selected method.") }),
          labelled(t(info.title), input),
        ]),
      );
      const single = methods.length === 1;
      const [, confirm] = modalButtons(box, [
        {
          label: single ? t("Cancel") : t("Back"),
          onclick: () => {
            if (single) return closeModal();
            selected = null;
            render();
          },
        },
        { label: t("Confirm"), primary: true, disabled: true, onclick: submit },
      ]);
      input.focus();
    };
    render();
  });
}

// ─────────────────────────── мой аккаунт ───────────────────────────

/** Дата и время для подсказок: «12 марта 2024 в 18:05». */
function longDateTime(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return t("{0} at {1}", [I18N.longDate(date), I18N.time(date)]);
}

/**
 * Карточка аккаунта с баннером (account/UserSummary.tsx). Кнопка
 * «Изменить профиль» — только если передан `onedit`; `showBadges` добавляет
 * значки профиля рядом с датой создания.
 */
function userSummary(account, onedit, { showBadges = false } = {}) {
  const box = h("div", { class: "user-summary" });
  if (account.background) {
    const shade = "color-mix(in srgb, var(--md-sys-color-surface-container-low) 70%, transparent)";
    box.style.backgroundImage = `linear-gradient(${shade}, ${shade}), url("${mediaSrc(account.background)}")`;
    box.classList.add("with-banner");
  }
  let edit = null;
  if (onedit) {
    edit = h("button", { type: "button", class: "icon-button filled square", title: t("Edit Profile") }, [symbol("edit", 24)]);
    edit.onclick = onedit;
  }
  box.append(
    h("div", { class: "user-summary-details" }, [
      avatar({ url: account.avatar, name: account.display_name, size: 58 }),
      h("div", { class: "user-summary-names" }, [
        h("span", { class: "user-summary-name", text: account.display_name }),
        h("span", { class: "user-summary-tag", text: `${account.username}#${account.discriminator}` }),
      ]),
      edit,
    ]),
  );
  const badges = [];
  if (account.created_at) {
    badges.push(h("span", { class: "user-summary-badge", title: t("Account created {0}", [longDateTime(account.created_at)]) }, [symbol("cake_fill", 14)]));
  }
  if (showBadges && account.badges) {
    for (const badge of BADGES.filter((item) => account.badges & item.bit)) {
      badges.push(h("span", { class: "user-summary-badge", title: badge.title }, [symbol(badge.icon, 14)]));
    }
  }
  if (badges.length) {
    box.append(h("div", { class: "user-summary-bottom" }, [h("span", { class: "user-summary-pad" }), h("span", { class: "user-summary-badges" }, badges)]));
  }
  return categoryGroup([box]);
}

async function renderAccountPage(column, alive) {
  const [account, mfa] = await Promise.all([call("account_info"), call("mfa_status")]);
  if (!alive()) return;
  put(column,
    userSummary(account, () => {
      settings.page = "profile";
      renderSettings();
    }),
    editAccountGroup(account, mfa),
    multiFactorGroup(account, mfa),
    manageAccountGroup(account, mfa),
  );
}

/** Имя, почта и пароль (EditAccount). */
function editAccountGroup(account, mfa) {
  const masked = "•••••••••••@•••••••••••";
  const email = h("span", { text: masked });
  const reveal = h("a", { class: "link", href: "#", text: t("Reveal") });
  reveal.onclick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      email.textContent = await call("account_email");
      reveal.remove();
    } catch (error) {
      toast(describe(error), "error");
    }
  };

  return categoryGroup([
    categoryButton({
      icon: "alternate_email",
      title: t("Username"),
      description: account.username,
      action: "chevron",
      onclick: () => editUsernameModal(account),
    }),
    categoryButton({
      icon: "mail",
      title: t("Email"),
      description: h("span", { class: "inline-row" }, [email, reveal]),
      action: "chevron",
      onclick: () => editEmailModal(mfa),
    }),
    categoryButton({
      icon: "password",
      title: t("Password"),
      description: "•••••••••",
      action: "chevron",
      onclick: editPasswordModal,
    }),
  ]);
}

function editUsernameModal(account) {
  formModal({
    title: t("Change username"),
    fields: [
      { label: t("Username"), value: account.username, maxlength: 32, counter: true, suffix: "#" + account.discriminator },
      { label: t("Current Password"), type: "password", placeholder: t("Enter your current password...") },
    ],
    cancel: t("Close"),
    confirm: t("Change"),
    submit: async (username, password) => {
      const view = await call("change_username", { username, password });
      applyOwnUser(view);
      if (view.discriminator !== account.discriminator) toast(t("Your discriminator changed to {0}", [view.discriminator]));
      renderSettings();
    },
  });
}

function editEmailModal(mfa) {
  formModal({
    title: t("Change login email"),
    fields: [
      { label: t("Email"), type: "email", placeholder: "someone@example.com" },
      { label: t("Current Password"), type: "password", placeholder: t("Enter your current password...") },
    ],
    cancel: t("Close"),
    confirm: t("Send email"),
    submit: async (email, currentPassword) => {
      // с приложением для аутентификации сервер требует ещё и подтверждение
      const sent = mfa.totp
        ? await mfaFlow(mfa.methods, (answer) => call("change_email", { email, currentPassword, mfa: answer }))
        : await call("change_email", { email, currentPassword, mfa: null }).then(() => true);
      if (sent) toast(t("Check your email for a confirmation link"));
    },
  });
}

function editPasswordModal() {
  formModal({
    title: t("Change login password"),
    fields: [
      { label: t("New Password"), type: "password", placeholder: t("Enter a new password.") },
      { label: t("Current Password"), type: "password", placeholder: t("Enter your current password...") },
    ],
    cancel: t("Close"),
    confirm: t("Change"),
    submit: async (password, currentPassword) => {
      await call("change_password", { password, currentPassword });
      toast(t("Password changed successfully."));
    },
  });
}

/** Коды восстановления и приложение для аутентификации (MultiFactorAuth). */
function multiFactorGroup(account, mfa) {
  const showCodes = async (command) => {
    const codes = await mfaFlow(mfa.methods, (answer) => call(command, { mfa: answer }));
    if (codes) recoveryCodesModal(codes, mfa);
  };

  const setupAuthenticator = async () => {
    const setup = await mfaFlow(mfa.methods, (answer) => call("mfa_totp_secret", { mfa: answer }));
    if (!setup) {
      toast(t("MFA setup canceled."));
      return;
    }
    enableTotpModal(setup);
  };

  const disableAuthenticator = async () => {
    if (await mfaFlow(mfa.methods, (answer) => call("mfa_disable_totp", { mfa: answer }))) renderSettings();
  };

  return categoryGroup([
    categoryCollapse({
      icon: "verified_user",
      title: t("Recovery Codes"),
      description: t("Configure a way to get back into your account in case your 2FA is lost"),
      children: mfa.recovery
        ? [
            categoryButton({
              icon: "blank",
              title: t("View Recovery Codes"),
              description: t("Get active recovery codes"),
              onclick: () => showCodes("mfa_recovery_codes"),
            }),
            categoryButton({
              icon: "blank",
              title: t("Reset Recovery Codes"),
              description: t("Get a new set of recovery codes"),
              onclick: () => showCodes("mfa_generate_recovery_codes"),
            }),
          ]
        : [
            categoryButton({
              icon: "blank",
              title: t("Generate Recovery Codes"),
              description: t("Setup recovery codes"),
              onclick: () => showCodes("mfa_generate_recovery_codes"),
            }),
          ],
    }),
    categoryCollapse({
      icon: "lock",
      title: t("Authenticator App"),
      description: t("Configure one-time password authentication"),
      children: mfa.totp
        ? [
            categoryButton({
              icon: "blank",
              title: t("Remove Authenticator"),
              description: t("Disable one-time password authenticator"),
              onclick: disableAuthenticator,
            }),
          ]
        : [
            categoryButton({
              icon: "blank",
              title: t("Enable Authenticator"),
              description: t("Setup one-time password authenticator"),
              onclick: setupAuthenticator,
            }),
          ],
    }),
  ]);
}

/** Окно со списком кодов (MFARecovery.tsx). */
function recoveryCodesModal(codes, mfa) {
  // невидимые запятые: при копировании коды разделяются, на экране — нет
  const list = h(
    "div",
    { class: "recovery-codes selectable" },
    codes.map((code, index) => h("span", {}, [code, index < codes.length - 1 ? h("i", { text: "," }) : null])),
  );
  openModal({
    title: t("Your recovery codes"),
    body: h("div", { class: "form-stack" }, [h("p", { class: "settings-hint", text: t("Please save these to a safe location.") }), list]),
    actions: [
      {
        label: t("Reset"),
        onclick: async () => {
          const fresh = await mfaFlow(mfa.methods, (answer) => call("mfa_generate_recovery_codes", { mfa: answer }));
          recoveryCodesModal(fresh || codes, Object.assign({}, mfa, { recovery: true }));
        },
      },
      { label: t("Done"), primary: true, onclick: closeModal },
    ],
    onClose: () => {
      // коды могли появиться впервые — у страницы меняются пункты
      if (!mfa.recovery && settingsOpen()) renderSettings();
    },
  });
}

/** QR-код и поле для первого кода (MFAEnableTOTP.tsx). */
function enableTotpModal(setup) {
  const qr = h("div", { class: "totp-qr" });
  const parsed = new DOMParser().parseFromString(setup.qr_svg, "image/svg+xml").documentElement;
  if (parsed && parsed.nodeName.toLowerCase() === "svg") {
    parsed.setAttribute("width", "140");
    parsed.setAttribute("height", "140");
    qr.append(document.importNode(parsed, true));
  }
  const code = textInput({});
  code.setAttribute("autocomplete", "one-time-code");
  let enabled = false;
  const submit = async () => {
    if (!code.value.trim()) return;
    try {
      await call("mfa_enable_totp", { code: code.value });
      enabled = true;
      closeModal();
      renderSettings();
    } catch (error) {
      toast(describe(error), "error");
    }
  };
  code.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });
  openModal({
    title: t("Enable authenticator app"),
    body: h("div", { class: "form-stack" }, [
      h("p", { class: "settings-hint", text: t("Please scan or use the token below in your authenticator app.") }),
      h("div", { class: "totp-setup" }, [qr, h("code", { class: "totp-secret", text: setup.secret })]),
      labelled(t("Enter Code"), code),
    ]),
    actions: [
      { label: t("Cancel"), onclick: closeModal },
      { label: t("Continue"), primary: true, onclick: submit },
    ],
    onClose: () => {
      if (!enabled) toast(t("MFA setup canceled."));
    },
  });
  code.focus();
}

/** Отключение и удаление аккаунта (ManageAccount). */
function manageAccountGroup(account, mfa) {
  const owns = account.owned_servers > 0;
  const finish = async (command) => {
    if (await mfaFlow(mfa.methods, (answer) => call(command, { mfa: answer }))) {
      closeSettings();
      await logout();
    }
  };
  return categoryGroup([
    categoryButton({
      icon: "block",
      danger: true,
      title: t("Disable Account"),
      description:
        t("You won't be able to access your account unless you contact support - however, your data will not be deleted."),
      action: "chevron",
      onclick: () => finish("disable_account"),
    }),
    categoryButton({
      icon: "delete",
      danger: true,
      disabled: owns,
      title: owns ? t("Cannot delete account until servers are deleted or transferred") : t("Delete Account"),
      description:
        t("Your account and all of your data (including your messages and friends list) will be queued for deletion. A confirmation email will be sent - you can cancel this within 7 days by contacting support."),
      action: owns ? null : "chevron",
      onclick: () => finish("delete_account"),
    }),
  ]);
}

// ─────────────────────────── сессии ───────────────────────────

/** «3 дня назад» на языке интерфейса. */
function relativeTime(iso) {
  return iso ? I18N.relative(new Date(iso)) : "";
}

/** Логотип системы по имени сессии (SessionIcon в Sessions.tsx). */
function sessionIcon(name) {
  const text = name || "";
  const brand = /linux/i.test(text)
    ? "linux"
    : /windows/i.test(text)
      ? "windows"
      : /android/i.test(text)
        ? "android"
        : /mac.*os|i(Pad)?os/i.test(text)
          ? "apple"
          : "unknown";
  const node = svg("svg", { viewBox: "0 0 24 24", class: "symbol", "aria-hidden": "true" });
  node.style.setProperty("--symbol-size", "22px");
  for (const d of (window.STOAT_BRANDS || {})[brand] || []) node.append(svg("path", { d }));
  return node;
}

function renameSessionModal(session) {
  formModal({
    title: t("Rename Session"),
    fields: [{ label: t("Name"), value: session.name, placeholder: t("Enter a new name for this session") }],
    cancel: t("Cancel"),
    confirm: t("Rename"),
    submit: async (name) => {
      await call("rename_session", { sessionId: session.id, name });
      renderSettings();
    },
  });
}

async function renderSessionsPage(column, alive) {
  const [list, mfa] = await Promise.all([call("sessions"), call("mfa_status")]);
  if (!alive()) return;
  const current = list.find((session) => session.current) || null;
  // от новых к старым, как в оригинале
  const others = list
    .filter((session) => !session.current)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));

  const signOutOthers = () =>
    confirmModal({
      title: t("Are you sure you want to clear your sessions?"),
      text: t("You cannot undo this action."),
      confirm: t("Accept"),
      run: async () => {
        if (await mfaFlow(mfa.methods, (answer) => call("revoke_other_sessions", { mfa: answer }))) renderSettings();
      },
    });

  put(column,
    categoryGroup([
      current
        ? categoryCollapse({
            icon: sessionIcon(current.name),
            title: t("Current Session"),
            description: current.name,
            children: [categoryButton({ icon: "blank", title: t("Rename"), action: "chevron", onclick: () => renameSessionModal(current) })],
          })
        : null,
      others.length
        ? categoryButton({
            icon: symbol("logout", 24),
            danger: true,
            title: t("Log Out Other Sessions"),
            description: t("Logs you out of all sessions except this device."),
            action: "chevron",
            onclick: signOutOthers,
          })
        : null,
    ]),
    others.length
      ? categoryGroup(
          others.map((session) =>
            categoryCollapse({
              icon: sessionIcon(session.name),
              title: h("span", { class: "capitalise", text: session.name }),
              description: session.created_at ? I18N.rich("Created <0/>", null, [relativeTime(session.created_at)]) : null,
              children: [
                categoryButton({ icon: "blank", title: t("Rename"), action: "chevron", onclick: () => renameSessionModal(session) }),
                categoryButton({
                  icon: "blank",
                  title: t("Log Out"),
                  action: "chevron",
                  onclick: async () => {
                    const done = await mfaFlow(mfa.methods, (answer) => call("revoke_session", { sessionId: session.id, mfa: answer }));
                    if (done) renderSettings();
                  },
                }),
              ],
            }),
          ),
        )
      : null,
  );
}

// ─────────────────────────── обратная связь ───────────────────────────

async function renderFeedbackPage(column, alive) {
  if (!settings.about) settings.about = await call("about");
  if (!alive()) return;
  const inLounge = Boolean(serverById(LOUNGE_ID));
  const official = settings.about.official;
  put(column,
    categoryGroup([
      categoryButton({
        icon: "star",
        title: t("Submit feature suggestion"),
        description: t("Suggest new Stoat features on GitHub discussions."),
        action: "external",
        href: LINKS.suggestions,
      }),
      categoryButton({ icon: "format_list_numbered", title: t("Feedback"), description: t("Submit feedback"), action: "external", href: LINKS.feedback }),
      categoryButton({
        icon: "bug_report",
        title: t("Bug Tracker"),
        description: t("View currently active bug reports here."),
        action: "external",
        href: LINKS.bugs,
      }),
      official
        ? categoryButton({
            icon: "groups_3",
            title: inLounge ? t("Go to the Stoat Lounge") : t("Join the Stoat Lounge"),
            description: t("You can report issues and discuss improvements with us directly here."),
            onclick: async () => {
              if (inLounge) {
                closeSettings();
                selectServer(LOUNGE_ID);
              } else {
                await joinLoungeModal();
              }
            },
          })
        : null,
    ]),
  );
}

/** Приглашение в Stoat Lounge (в оригинале — окно приглашения). */
async function joinLoungeModal() {
  const info = await call("preview_invite", { code: LOUNGE_INVITE });
  const title = info.server_name || "Stoat Lounge";
  openModal({
    title: t("Invite"),
    body: h("div", { class: "invite-preview" }, [
      avatar({ url: info.icon, name: title, size: 48 }),
      h("span", { class: "settings-row-text" }, [
        h("span", { class: "settings-row-title", text: title }),
        info.member_count ? h("span", { class: "settings-hint", text: t("{0} members", [I18N.number(info.member_count)]) }) : null,
      ]),
    ]),
    actions: [
      { label: t("Cancel"), onclick: closeModal },
      {
        label: t("Join"),
        primary: true,
        onclick: async () => {
          try {
            const target = await call("join_invite", { code: LOUNGE_INVITE });
            closeModal();
            closeSettings();
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

// ─────────────────────────── сервер: обзор ───────────────────────────

function renderOverviewPage(column) {
  const server = settings.server;
  const name = textInput({ value: server.name, maxlength: 32 });
  const description = h("textarea", { class: "text-field multiline", rows: 4, maxlength: 1024, placeholder: t("Add a topic...") });
  description.value = server.description || "";
  const icon = imagePicker({ label: t("Server Icon"), url: server.icon, round: true, tag: "icons" });
  const banner = imagePicker({ label: t("Server Banner"), url: server.banner, wide: true, tag: "banners" });

  const select = (value) => {
    const node = h("select", { class: "text-field" }, [
      h("option", { value: "", text: t("Disabled") }),
      ...server.channels.map((channel) => h("option", { value: channel.id, text: "#" + channel.name })),
    ]);
    node.value = value || "";
    return node;
  };
  const system = {
    user_joined: select(server.system_messages.user_joined),
    user_left: select(server.system_messages.user_left),
    user_kicked: select(server.system_messages.user_kicked),
    user_banned: select(server.system_messages.user_banned),
  };

  const save = actionButton(t("Save"), async () => {
    const remove = [];
    let iconId = null;
    let bannerId = null;
    if (icon.state.file) iconId = await uploadPicked(icon.state.file, "icons");
    else if (icon.state.removed) remove.push("Icon");
    if (banner.state.file) bannerId = await uploadPicked(banner.state.file, "banners");
    else if (banner.state.removed) remove.push("Banner");
    const systemMessages = {};
    for (const [key, node] of Object.entries(system)) systemMessages[key] = node.value;
    const anySystem = Object.values(systemMessages).some(Boolean);
    if (!anySystem) remove.push("SystemMessages");

    settings.server = await call("edit_server", {
      serverId: server.id,
      name: name.value,
      description: description.value,
      icon: iconId,
      banner: bannerId,
      systemMessages: anySystem ? systemMessages : null,
      remove,
    });
    toast(t("Saved"));
    scheduleWorkspaceRefresh();
    renderSettings();
  }, { icon: "check" });

  put(column,
    section(t("Server Info"), [
      h("div", { class: "form-grid" }, [icon.node, banner.node]),
      labelled(t("Server Name"), name),
      labelled(t("Server Description"), description),
    ]),
    section(t("System message channels"), [
      h("div", { class: "form-grid" }, [
        labelled(t("User Joined"), system.user_joined),
        labelled(t("User Left"), system.user_left),
        labelled(t("User Kicked"), system.user_kicked),
        labelled(t("User Banned"), system.user_banned),
      ]),
    ]),
    h("div", { class: "settings-actions" }, [save]),
  );
}

// ─────────────────────────── сервер: эмодзи ───────────────────────────

async function renderEmojiPage(column, alive) {
  const serverId = settings.serverId;
  const [list, emojiLimit] = await Promise.all([call("server_emojis", { serverId }), uploadLimit("emojis")]);
  if (!alive()) return;

  const name = textInput({ placeholder: t("emoji_name"), maxlength: 32 });
  let picked = null;
  const preview = h("div", { class: "image-preview emoji empty" });
  const choose = actionButton(t("Select image"), async () => {
    picked = await pickFile("image/png,image/jpeg,image/gif,image/webp");
    if (!picked) return;
    preview.style.backgroundImage = `url("${picked.preview}")`;
    preview.classList.remove("empty");
    if (!name.value) name.value = picked.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
  }, { kind: "tonal", icon: "attach_file" });
  const add = actionButton(t("Add"), async () => {
    if (!picked) throw new Error(t("Select an image first"));
    if (picked.size > emojiLimit) throw new Error(t("The file exceeds the maximum size limit of {0}.", [humanSize(emojiLimit)]));
    const fileId = await uploadPicked(picked, "emojis");
    await call("create_emoji", { serverId, name: name.value, fileId });
    serverEmoji.delete(serverId);
    toast(t("Emoji added"));
    renderSettings();
  }, { icon: "add" });

  const grid = h("div", { class: "emoji-admin-grid" });
  for (const emoji of list) {
    const remove = actionButton("", () =>
      confirmModal({
        title: t("Delete Emoji"),
        text: t("Are you sure you want to delete {0}?", [":" + emoji.name + ":"]),
        confirm: t("Delete"),
        run: async () => {
          await call("delete_emoji", { serverId, emojiId: emoji.id });
          serverEmoji.delete(serverId);
          renderSettings();
        },
      }),
    { kind: "text", icon: "delete" });
    remove.title = t("Delete");
    grid.append(
      h("div", { class: "emoji-admin-item" }, [
        emoji.url ? image(emoji.url, { class: "emoji-admin-image", alt: emoji.name }) : null,
        h("span", { class: "emoji-admin-name", text: ":" + emoji.name + ":" }),
        remove,
      ]),
    );
  }

  put(column,
    section(t("Upload Emoji"), [
      h("div", { class: "emoji-upload" }, [preview, h("div", { class: "form-stack grow" }, [labelled(t("Emoji Name"), name), h("div", { class: "image-actions" }, [choose, add])])]),
    ], t("PNG, JPEG, GIF or WebP up to {0}. The name may contain lowercase Latin letters, digits and underscores.", [humanSize(emojiLimit)])),
    section(`${t("Emojis")} – ${list.length}`, [list.length ? grid : h("p", { class: "settings-hint", text: t("No custom emojis yet.") })]),
  );
}

// ─────────────────────────── сервер: участники ───────────────────────────

async function renderMembersPage(column, alive) {
  const server = settings.server;
  const serverId = server.id;
  const list = await call("server_member_list", { serverId });
  if (!alive()) return;
  const can = (bit) => server.is_owner || hasBit(server.permissions, bit);
  const editableRoles = server.roles.filter((role) => role.rank > server.top_rank);

  const search = textInput({ placeholder: t("Search through {0} members", [I18N.number(list.length)]) });
  const body = h("div", { class: "member-admin-list" });
  let open = null;

  const editor = (member) => {
    const nickname = textInput({ value: member.nickname || "", placeholder: member.name, maxlength: 32 });
    const roles = new Set(member.roles);
    const roleBoxes = h(
      "div",
      { class: "role-checks" },
      server.roles.map((role) => {
        const box = h("input", { type: "checkbox" });
        box.checked = roles.has(role.id);
        box.disabled = !can(PERM.ASSIGN_ROLES) || role.rank <= server.top_rank;
        box.onchange = () => (box.checked ? roles.add(role.id) : roles.delete(role.id));
        return h("label", { class: "role-check" }, [
          box,
          h("span", { class: "role-dot", style: role.colour ? { background: role.colour } : null }),
          h("span", { text: role.name }),
        ]);
      }),
    );
    const isMe = state.me && member.id === state.me.id;
    return h("div", { class: "member-admin-editor" }, [
      can(PERM.MANAGE_NICKNAMES) || isMe ? labelled(t("Nickname"), nickname) : null,
      server.roles.length ? labelled(t("Roles"), roleBoxes) : null,
      h("div", { class: "settings-actions" }, [
        !isMe && can(PERM.KICK)
          ? actionButton(t("Kick"), () =>
              confirmModal({
                title: t("Kick Member"),
                text: t("Are you sure you want to kick {0}?", [member.name]),
                confirm: t("Kick"),
                run: async () => {
                  await call("kick_member", { serverId, userId: member.id });
                  toast(t("Member kicked"));
                  renderSettings();
                },
              }),
            { kind: "text", danger: true })
          : null,
        !isMe && can(PERM.BAN)
          ? actionButton(t("Ban"), () =>
              formModal({
                title: t("Ban Member"),
                text: t("Are you sure you want to ban {0}?", [member.name]),
                fields: [{ label: t("Reason"), maxlength: 1024 }],
                confirm: t("Ban"),
                danger: true,
                submit: async (reason) => {
                  await call("ban_member", { serverId, userId: member.id, reason });
                  toast(t("Member banned"));
                  renderSettings();
                },
              }),
            { kind: "text", danger: true })
          : null,
        h("span", { class: "spacer" }),
        actionButton(t("Save"), async () => {
          const changes = { serverId, userId: member.id, nickname: null, roles: null };
          if (nickname.value.trim() !== (member.nickname || "")) changes.nickname = nickname.value;
          const before = [...member.roles].sort().join();
          const after = [...roles].sort().join();
          if (before !== after) changes.roles = [...roles];
          if (changes.nickname === null && changes.roles === null) return;
          await call("edit_member", changes);
          member.nickname = changes.nickname !== null ? nickname.value.trim() || null : member.nickname;
          if (changes.roles) member.roles = changes.roles;
          membersCache.delete(serverId);
          toast(t("Saved"));
        }, { icon: "check" }),
      ]),
    ]);
  };

  const draw = () => {
    const query = search.value.trim().toLowerCase();
    body.textContent = "";
    const shown = list.filter((member) => !query || member.name.toLowerCase().includes(query) || member.username.toLowerCase().includes(query));
    for (const member of shown.slice(0, 200)) {
      const roleNames = member.roles
        .map((id) => server.roles.find((role) => role.id === id))
        .filter(Boolean)
        .map((role) => role.name)
        .join(", ");
      const row = h("button", { type: "button", class: "member-admin-row" }, [
        avatar({ url: member.avatar, name: member.name, size: 32 }),
        h("span", { class: "settings-row-text" }, [
          h("span", { class: "settings-row-title", text: member.name }),
          h("span", { class: "settings-hint", text: member.username + (roleNames ? " · " + roleNames : "") }),
        ]),
        symbol("keyboard_arrow_down", 20),
      ]);
      const item = h("div", { class: "member-admin-item" + (open === member.id ? " open" : "") }, [row]);
      if (open === member.id) item.append(editor(member));
      row.onclick = () => {
        open = open === member.id ? null : member.id;
        draw();
      };
      body.append(item);
    }
    if (shown.length > 200) body.append(h("p", { class: "settings-hint", text: t("Showing the first 200 of {0}. Refine your search.", [I18N.number(shown.length)]) }));
    if (!shown.length) body.append(h("p", { class: "settings-hint", text: t("No results") }));
  };
  search.addEventListener("input", draw);
  draw();
  put(column,
    editableRoles.length || can(PERM.KICK) || can(PERM.BAN) ? null : notice(t("You don't have permission to manage members.")),
    search,
    body,
  );
}

// ─────────────────────────── сервер: роли ───────────────────────────

function renderRolesPage(column) {
  const server = settings.server;
  const serverId = server.id;
  const selected = settings.role && server.roles.some((role) => role.id === settings.role) ? settings.role : "default";

  const roleList = h("div", { class: "role-list" });
  const pick = (id) => {
    settings.role = id;
    renderSettings();
  };
  const entry = (id, name, colour, editable) => {
    const button = h("button", { type: "button", class: "role-entry" + (id === selected ? " selected" : "") + (editable ? "" : " locked") }, [
      h("span", { class: "role-dot", style: colour ? { background: colour } : null }),
      h("span", { class: "role-entry-name", text: name }),
    ]);
    button.onclick = () => pick(id);
    return button;
  };
  for (const role of server.roles) roleList.append(entry(role.id, role.name, role.colour, role.rank > server.top_rank));
  roleList.append(entry("default", t("Everyone"), null, true));

  const newName = textInput({ placeholder: t("Role Name"), maxlength: 32 });
  const create = actionButton(t("Create Role"), async () => {
    const before = new Set(server.roles.map((role) => role.id));
    settings.server = await call("create_role", { serverId, name: newName.value });
    const created = settings.server.roles.find((role) => !before.has(role.id));
    if (created) settings.role = created.id;
    renderSettings();
  }, { kind: "tonal", icon: "add" });

  const editorBox = h("div", { class: "role-editor" });
  if (selected === "default") {
    put(editorBox,
      h("p", { class: "settings-hint", text: t("Permissions of the Everyone role apply to every member of the server.") }),
      permissionList(server.default_permissions, null, false, async (allow) => {
        settings.server = await call("set_permissions", { serverId, roleId: null, allow, deny: null });
        toast(t("Saved"));
      }),
    );
  } else {
    const role = server.roles.find((item) => item.id === selected);
    const editable = role.rank > server.top_rank;
    const name = textInput({ value: role.name, maxlength: 32 });
    const colourText = textInput({ value: role.colour || "", placeholder: t("#5470ec or a CSS gradient"), maxlength: 128 });
    const colourPicker = h("input", { type: "color", class: "colour-picker", value: /^#[0-9a-f]{6}$/i.test(role.colour || "") ? role.colour : "#5470ec" });
    colourPicker.oninput = () => (colourText.value = colourPicker.value);
    const hoist = h("input", { type: "checkbox", class: "switch" });
    hoist.checked = role.hoist;
    if (!editable) [name, colourText, colourPicker, hoist].forEach((node) => (node.disabled = true));

    put(editorBox,
      editable ? null : notice(t("This role is not below yours, so you can't edit it.")),
      labelled(t("Role Name"), name),
      labelled(t("Role Colour"), h("div", { class: "colour-row" }, [colourPicker, colourText]), t("Leave empty for no colour")),
      h("label", { class: "settings-row" }, [
        h("span", { class: "settings-row-text" }, [
          h("span", { class: "settings-row-title", text: t("Hoist Role") }),
          h("span", { class: "settings-hint", text: t("Display this role above others") }),
        ]),
        hoist,
      ]),
      editable
        ? h("div", { class: "settings-actions" }, [
            actionButton(t("Delete Role"), () =>
              confirmModal({
                title: t("Delete Role"),
                text: t("Are you sure you want to delete {0}?", [role.name]),
                confirm: t("Delete"),
                run: async () => {
                  settings.server = await call("delete_role", { serverId, roleId: role.id });
                  settings.role = null;
                  renderSettings();
                },
              }),
            { kind: "text", danger: true, icon: "delete" }),
            h("span", { class: "spacer" }),
            actionButton(t("Save"), async () => {
              settings.server = await call("edit_role", {
                serverId,
                roleId: role.id,
                name: name.value !== role.name ? name.value : null,
                colour: colourText.value.trim() !== (role.colour || "") ? colourText.value : null,
                hoist: hoist.checked !== role.hoist ? hoist.checked : null,
              });
              membersCache.delete(serverId);
              scheduleWorkspaceRefresh();
              toast(t("Saved"));
              renderSettings();
            }, { icon: "check" }),
          ])
        : null,
      h("h2", { class: "settings-section-title", text: t("Permissions") }),
      permissionList(role.allow, role.deny, !editable, async (allow, deny) => {
        settings.server = await call("set_permissions", { serverId, roleId: role.id, allow, deny });
        toast(t("Saved"));
      }),
    );
  }

  put(column,
    h("div", { class: "roles-layout" }, [
      h("div", { class: "roles-side" }, [roleList, h("div", { class: "colour-row" }, [newName, create])]),
      editorBox,
    ]),
  );
}

/**
 * Список прав. Для роли у каждого права три состояния (как в оригинале):
 * разрешено, не задано, запрещено; для роли «Все» — только вкл/выкл.
 */
function permissionList(allow, deny, locked, save) {
  let allowMask = Number(allow || 0);
  let denyMask = Number(deny || 0);
  const triState = deny !== null;
  const list = h("div", { class: "permission-list" });
  for (const permission of PERMISSIONS) {
    if (permission.heading) list.append(h("div", { class: "settings-heading", text: t(permission.heading) }));
    const value = hasBit(allowMask, permission.bit) ? "allow" : hasBit(denyMask, permission.bit) ? "deny" : "unset";
    let control;
    if (triState) {
      control = h("div", { class: "tri-state" });
      for (const option of [
        { id: "deny", icon: "close", title: t("Deny") },
        { id: "unset", icon: "remove", title: t("Neutral") },
        { id: "allow", icon: "check", title: t("Allow") },
      ]) {
        const button = h("button", {
          type: "button",
          class: "tri " + option.id + (value === option.id ? " selected" : ""),
          title: option.title,
          disabled: locked,
        }, [option.id === "unset" ? h("span", { class: "tri-dash" }) : symbol(option.icon, 18)]);
        button.onclick = () => {
          allowMask = setBit(allowMask, permission.bit, option.id === "allow");
          denyMask = setBit(denyMask, permission.bit, option.id === "deny");
          control.querySelectorAll(".tri").forEach((node) => node.classList.toggle("selected", node === button));
          saveBar.classList.remove("hidden");
        };
        control.append(button);
      }
    } else {
      control = h("input", { type: "checkbox", class: "switch", disabled: locked });
      control.checked = value === "allow";
      control.onchange = () => {
        allowMask = setBit(allowMask, permission.bit, control.checked);
        saveBar.classList.remove("hidden");
      };
    }
    list.append(
      h("div", { class: "settings-row permission" }, [
        h("span", { class: "settings-row-text" }, [
          h("span", { class: "settings-row-title", text: t(permission.title) }),
          h("span", { class: "settings-hint", text: t(permission.hint) }),
        ]),
        control,
      ]),
    );
  }
  const saveBar = h("div", { class: "settings-actions sticky hidden" }, [
    h("span", { class: "settings-hint", text: t("You have unsaved changes") }),
    h("span", { class: "spacer" }),
    actionButton(t("Save"), async () => {
      await save(allowMask, triState ? denyMask : null);
      saveBar.classList.add("hidden");
    }, { icon: "check" }),
  ]);
  return h("div", {}, [list, saveBar]);
}

// ─────────────────────────── сервер: приглашения и баны ───────────────────────────

function inviteLink(code) {
  return "https://stoat.chat/invite/" + code;
}

async function renderInvitesPage(column, alive) {
  const serverId = settings.serverId;
  const list = await call("server_invites", { serverId });
  if (!alive()) return;
  const rows = list.map((invite) =>
    h("div", { class: "settings-row" }, [
      symbol("link", 24),
      h("span", { class: "settings-row-text" }, [
        h("span", { class: "settings-row-title selectable", text: invite.code }),
        h("span", {
          class: "settings-hint",
          text: "#" + invite.channel + (invite.creator ? " · " + t("Inviter") + ": " + (invite.creator.display_name || invite.creator.username) : ""),
        }),
      ]),
      actionButton("", () => copyText(inviteLink(invite.code)).then(() => toast(t("Copied!"))), { kind: "text", icon: "content_copy" }),
      actionButton("", async () => {
        await call("delete_invite", { code: invite.code });
        toast(t("Invite deleted"));
        renderSettings();
      }, { kind: "text", icon: "delete", danger: true }),
    ]),
  );
  put(column,
    section(`${t("Invites")} – ${list.length}`, list.length ? rows : [h("p", { class: "settings-hint", text: t("No active invites. You can create one from the server or channel menu.") })]),
  );
}

async function renderBansPage(column, alive) {
  const serverId = settings.serverId;
  const list = await call("server_bans", { serverId });
  if (!alive()) return;
  const rows = list.map((ban) =>
    h("div", { class: "settings-row" }, [
      avatar({ url: ban.avatar, name: ban.username, size: 32 }),
      h("span", { class: "settings-row-text" }, [
        h("span", { class: "settings-row-title", text: `${ban.username}#${ban.discriminator}` }),
        h("span", { class: "settings-hint", text: ban.reason ? t("Reason") + ": " + ban.reason : t("No reason provided") }),
      ]),
      actionButton(t("Unban"), async () => {
        await call("unban_member", { serverId, userId: ban.id });
        toast(t("Member unbanned"));
        renderSettings();
      }, { kind: "tonal" }),
    ]),
  );
  column.append(section(`${t("Bans")} – ${list.length}`, list.length ? rows : [h("p", { class: "settings-hint", text: t("No one is banned.") })]));
}

// ─────────────────────────── действия с сервером ───────────────────────────

function confirmLeaveServer(server) {
  const owner = server.is_owner || server.owner;
  confirmModal({
    title: owner ? t("Delete {0}?", [server.name]) : t("Leave {0}?", [server.name]),
    text: owner ? t("Once it's deleted, there's no going back.") : t("You won't be able to rejoin unless you are re-invited."),
    confirm: owner ? t("Delete") : t("Leave"),
    run: async () => {
      await call("leave_server", { serverId: server.id });
      if (settingsOpen()) closeSettings();
      if (state.serverId === server.id) selectServer(null);
      scheduleWorkspaceRefresh();
    },
  });
}

/** Создать приглашение и показать ссылку. */
async function showInvite(channelId) {
  const code = await call("create_invite", { channelId });
  const link = inviteLink(code);
  const field = textInput({ value: link });
  field.readOnly = true;
  openModal({
    title: t("Create Invite"),
    body: h("div", { class: "form-stack" }, [
      h("p", { class: "settings-hint", text: t("Share this link to let others join the server.") }),
      field,
    ]),
    actions: [
      { label: t("Close"), onclick: closeModal },
      { label: t("Copy link"), primary: true, onclick: () => copyText(link).then(() => toast(t("Copied!"))) },
    ],
  });
  field.select();
}

function createChannelModal(serverId) {
  let kind = "Text";
  const name = textInput({ placeholder: t("new-channel"), maxlength: 32 });
  const run = async () => {
    try {
      const channelId = await call("create_channel", { serverId, name: name.value, kind });
      closeModal();
      await refreshWorkspace();
      const found = findChannel(channelId);
      if (found) openChannel(found.channel);
    } catch (error) {
      toast(describe(error), "error");
    }
  };
  openModal({
    title: t("Create channel"),
    body: h("div", { class: "form-stack" }, [
      choiceRow(
        [
          { id: "Text", label: t("Text Channel") },
          { id: "Voice", label: t("Voice Channel") },
        ],
        kind,
        (value) => (kind = value),
      ),
      labelled(t("Channel Name"), name),
    ]),
    actions: [
      { label: t("Cancel"), onclick: closeModal },
      { label: t("Create"), primary: true, onclick: run },
    ],
  });
  name.focus();
}

function editChannelModal(channel) {
  formModal({
    title: t("Edit Channel"),
    fields: [
      { label: t("Channel Name"), value: channel.name, maxlength: 32 },
      { label: t("Channel Description"), value: channel.description || "", maxlength: 1024, multiline: true },
    ],
    confirm: t("Save"),
    submit: async (name, description) => {
      await call("edit_channel", {
        channelId: channel.id,
        name: name !== channel.name ? name : null,
        description: description !== (channel.description || "") ? description : null,
      });
      scheduleWorkspaceRefresh();
      toast(t("Saved"));
    },
  });
}

function deleteChannelModal(channel) {
  confirmModal({
    title: t("Delete {0}?", ["#" + channel.name]),
    text: t("Once it's deleted, there's no going back."),
    confirm: t("Delete"),
    run: async () => {
      await call("delete_channel", { channelId: channel.id });
      if (state.channelId === channel.id) closeChannel();
      scheduleWorkspaceRefresh();
    },
  });
}

/** «Добавить сервер»: создать свой или вступить по приглашению. */
function addServerModal() {
  const name = textInput({ placeholder: t("Server Name"), maxlength: 32 });
  const code = textInput({ placeholder: t("Invite code or link") });
  const preview = h("div", { class: "invite-preview hidden" });

  let previewTimer = null;
  code.addEventListener("input", () => {
    clearTimeout(previewTimer);
    preview.classList.add("hidden");
    if (!code.value.trim()) return;
    previewTimer = setTimeout(async () => {
      try {
        const info = await call("preview_invite", { code: code.value });
        preview.replaceChildren(
          avatar({ url: info.icon, name: info.server_name || info.channel_name || "?", size: 48 }),
          h("span", { class: "settings-row-text" }, [
            h("span", { class: "settings-row-title", text: info.server_name || info.channel_name || t("Invite") }),
            h("span", {
              class: "settings-hint",
              text: [info.member_count ? t("{0} members", [I18N.number(info.member_count)]) : null, info.user_name ? t("Inviter") + ": " + info.user_name : null]
                .filter(Boolean)
                .join(" · "),
            }),
          ]),
        );
        preview.classList.remove("hidden");
      } catch {
        /* код ещё недописан или неверен — подсказку просто не показываем */
      }
    }, 400);
  });

  const go = async (serverOrChannel) => {
    closeModal();
    await refreshWorkspace();
    if (serverById(serverOrChannel)) selectServer(serverOrChannel);
    else {
      const found = findChannel(serverOrChannel);
      if (found) openChannel(found.channel);
    }
  };

  openModal({
    title: t("Create or join a server"),
    body: h("div", { class: "form-stack" }, [
      section(t("Join a server"), [
        code,
        preview,
        h("div", { class: "settings-actions" }, [
          actionButton(t("Join"), async () => go(await call("join_invite", { code: code.value })), { icon: "group_add" }),
        ]),
      ]),
      section(t("Create server"), [
        name,
        h("div", { class: "settings-actions" }, [
          actionButton(t("Create"), async () => go(await call("create_server", { name: name.value })), { kind: "tonal", icon: "add" }),
        ]),
      ]),
    ]),
    actions: [{ label: t("Close"), onclick: closeModal }],
  });
  code.focus();
}
