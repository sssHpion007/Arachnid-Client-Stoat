// Настройки пользователя и сервера — по образцу браузерного клиента Stoat
// (components/app/interface/settings): слева список разделов, справа
// содержимое шириной до 740px и кнопка закрытия.
//
// Подключается до app.js и пользуется его помощниками только во время вызова.

"use strict";

/** Биты прав API (revolt_permissions::ChannelPermission). */
const PERMISSIONS = [
  { bit: 1 << 1, title: "Управлять сервером", hint: "Название, описание, значок, баннер и системные сообщения" },
  { bit: 1 << 0, title: "Управлять каналами", hint: "Создавать, изменять и удалять каналы" },
  { bit: 1 << 2, title: "Управлять правами", hint: "Менять права в каналах" },
  { bit: 1 << 3, title: "Управлять ролями", hint: "Создавать и менять роли ниже своей" },
  { bit: 1 << 4, title: "Управлять оформлением", hint: "Добавлять и удалять эмодзи" },
  { bit: 1 << 6, title: "Исключать участников" },
  { bit: 1 << 7, title: "Банить участников" },
  { bit: 1 << 8, title: "Выдавать тайм-аут" },
  { bit: 1 << 9, title: "Выдавать роли", hint: "Роли ниже своей" },
  { bit: 1 << 10, title: "Менять свой ник" },
  { bit: 1 << 11, title: "Менять чужие ники" },
  { bit: 1 << 12, title: "Менять свой аватар на сервере" },
  { bit: 1 << 13, title: "Удалять аватары участников" },
  { bit: 1 << 20, title: "Видеть канал" },
  { bit: 1 << 21, title: "Читать историю сообщений" },
  { bit: 1 << 22, title: "Отправлять сообщения" },
  { bit: 1 << 23, title: "Управлять сообщениями", hint: "Удалять и закреплять чужие сообщения" },
  { bit: 1 << 24, title: "Управлять вебхуками" },
  { bit: 1 << 25, title: "Приглашать" },
  { bit: 1 << 26, title: "Встраивать ссылки" },
  { bit: 1 << 27, title: "Загружать файлы" },
  { bit: 1 << 28, title: "Маскарад", hint: "Менять имя и аватар у своих сообщений" },
  { bit: 1 << 29, title: "Реакции" },
  { bit: 2 ** 37, title: "Упоминать всех" },
  { bit: 2 ** 38, title: "Упоминать роли" },
  { bit: 2 ** 39, title: "Обходить медленный режим" },
  { bit: 2 ** 41, title: "Чужие эмодзи" },
  { bit: 2 ** 30, title: "Подключаться к голосу" },
  { bit: 2 ** 31, title: "Говорить" },
  { bit: 2 ** 32, title: "Видео" },
  { bit: 2 ** 33, title: "Заглушать участников" },
  { bit: 2 ** 34, title: "Отключать звук участникам" },
  { bit: 2 ** 35, title: "Перемещать участников" },
  { bit: 2 ** 36, title: "Слушать" },
  { bit: 2 ** 40, title: "Журнал аудита" },
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
  token: 0,
};

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

function userPages() {
  return [
    {
      title: "Пользовательские настройки",
      entries: [
        { id: "account", icon: "account_circle", title: "Мой аккаунт", render: renderAccountPage },
        { id: "profile", icon: "person", title: "Профиль", render: renderProfilePage },
        { id: "sessions", icon: "fingerprint", title: "Сессии", render: renderSessionsPage },
      ],
    },
    {
      title: "Клиент",
      entries: [
        { id: "appearance", icon: "image", title: "Внешний вид", render: renderAppearancePage },
        { id: "desktop", icon: "settings", title: "Приложение", render: renderDesktopPage },
      ],
    },
    {
      entries: [{ id: "logout", icon: "logout", title: "Выйти", danger: true, action: logout }],
    },
  ];
}

function serverPages() {
  const server = settings.server;
  const can = (bit) => server.is_owner || hasBit(server.permissions, bit);
  return [
    {
      title: server.name,
      entries: [{ id: "overview", icon: "info", title: "Обзор", hidden: !can(PERM.MANAGE_SERVER), render: renderOverviewPage }],
    },
    {
      title: "Оформление",
      entries: [
        { id: "emojis", icon: "mood", title: "Эмодзи", hidden: !can(PERM.MANAGE_CUSTOMISATION), render: renderEmojiPage },
      ],
    },
    {
      title: "Участники",
      entries: [
        {
          id: "members",
          icon: "group",
          title: "Участники",
          hidden: !(can(PERM.KICK) || can(PERM.BAN) || can(PERM.ASSIGN_ROLES) || can(PERM.MANAGE_NICKNAMES)),
          render: renderMembersPage,
        },
        { id: "roles", icon: "badge", title: "Роли", hidden: !can(PERM.MANAGE_ROLE), render: renderRolesPage },
        { id: "invites", icon: "link", title: "Приглашения", hidden: !can(PERM.MANAGE_SERVER), render: renderInvitesPage },
        { id: "bans", icon: "block", title: "Баны", hidden: !can(PERM.BAN), render: renderBansPage },
      ],
    },
    {
      entries: [
        server.is_owner
          ? { id: "delete", icon: "delete", title: "Удалить сервер", danger: true, action: () => confirmLeaveServer(server) }
          : { id: "leave", icon: "logout", title: "Выйти с сервера", danger: true, action: () => confirmLeaveServer(server) },
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

function renderSettings() {
  const root = el("settings");
  const groups = currentPages();
  const token = ++settings.token;

  const nav = h("nav", { class: "settings-nav" });
  for (const group of groups) {
    const visible = group.entries.filter((entry) => !entry.hidden);
    if (!visible.length) continue;
    const column = h("div", { class: "settings-group" });
    if (group.title) column.append(h("span", { class: "settings-category", text: group.title }));
    for (const entry of visible) {
      const button = h(
        "button",
        {
          type: "button",
          class: "settings-entry" + (entry.danger ? " danger" : ""),
          "aria-selected": String(settings.page === entry.id),
        },
        [symbol(entry.icon, 20), h("span", { class: "settings-entry-title", text: entry.title })],
      );
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
      column.append(button);
    }
    nav.append(column);
  }

  const entry = groups.flatMap((group) => group.entries).find((item) => item.id === settings.page);
  const column = h("div", { class: "settings-column" });
  if (entry) column.append(h("h1", { class: "settings-title", text: entry.title }));
  const close = h("button", { type: "button", class: "icon-button tonal settings-close", title: "Закрыть (Esc)" }, [
    symbol("close", 24),
  ]);
  close.onclick = closeSettings;

  root.replaceChildren(
    h("div", { class: "settings-sidebar" }, [nav]),
    h("div", { class: "settings-content" }, [
      h("div", { class: "settings-inner" }, [column]),
      h("div", { class: "settings-rail" }, [close]),
    ]),
  );
  root.classList.remove("hidden");

  if (entry && entry.render) {
    Promise.resolve(entry.render(column, () => token === settings.token)).catch((error) => {
      if (token === settings.token) column.append(notice(describe(error), "error"));
    });
  }
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
function formModal({ title, text = null, fields, confirm, danger = false, submit }) {
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
      ...fields.map((field, index) => labelled(field.label, inputs[index], field.hint)),
    ]),
    actions: [
      { label: "Отмена", onclick: closeModal },
      { label: confirm, primary: true, onclick: run },
    ],
  });
  if (danger) box.querySelector(".button.filled").classList.add("danger");
  if (inputs[0]) inputs[0].focus();
}

/** Простое подтверждение. */
function confirmModal({ title, text, confirm, danger = true, run }) {
  const box = openModal({
    title,
    body: h("p", { class: "settings-hint", text }),
    actions: [
      { label: "Отмена", onclick: closeModal },
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
    "Загрузить",
    async () => {
      const file = await pickFile();
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) throw new Error("Файл больше 20 МБ");
      choice.file = file;
      choice.removed = false;
      show(file.preview);
      onchange && onchange(choice);
    },
    { kind: "tonal", icon: "attach_file" },
  );
  const remove = actionButton(
    "Убрать",
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

// ─────────────────────────── мой аккаунт ───────────────────────────

async function renderAccountPage(column, alive) {
  const account = await call("account_info");
  if (!alive()) return;
  const me = state.me;
  const masked = account.email.replace(/^(.).*(@.*)$/, (_, first, domain) => first + "•••••" + domain);
  const email = h("span", { class: "settings-row-value", text: masked });
  const reveal = h("button", { type: "button", class: "link-button", text: "Показать" });
  reveal.onclick = () => {
    const shown = email.textContent === account.email;
    email.textContent = shown ? masked : account.email;
    reveal.textContent = shown ? "Показать" : "Скрыть";
  };

  const card = h("div", { class: "account-summary" }, [
    avatar({ url: me.avatar, name: myName(), size: 64, presence: me.presence }),
    h("div", { class: "account-text" }, [
      h("span", { class: "account-summary-name", text: myName() }),
      h("span", { class: "account-id", text: `${account.username}#${account.discriminator}` }),
    ]),
    h("span", { class: "spacer" }),
    actionButton("Изменить профиль", () => {
      settings.page = "profile";
      renderSettings();
    }, { kind: "tonal", icon: "edit" }),
  ]);

  const row = (icon, title, value, button) =>
    h("div", { class: "settings-row" }, [
      symbol(icon, 24),
      h("span", { class: "settings-row-text" }, [h("span", { class: "settings-row-title", text: title }), value]),
      button,
    ]);

  put(column,
    card,
    section("Учётные данные", [
      row(
        "alternate_email",
        "Имя пользователя",
        h("span", { class: "settings-row-value", text: `${account.username}#${account.discriminator}` }),
        actionButton("Изменить", () =>
          formModal({
            title: "Изменить имя пользователя",
            fields: [
              { label: "Имя пользователя", value: account.username, maxlength: 32 },
              { label: "Текущий пароль", type: "password" },
            ],
            confirm: "Сохранить",
            submit: async (username, password) => {
              applyOwnUser(await call("change_username", { username, password }));
              toast("Имя пользователя изменено");
              renderSettings();
            },
          }),
          { kind: "tonal" },
        ),
      ),
      row(
        "mail",
        "Почта",
        h("span", { class: "settings-row-value-line" }, [email, reveal]),
        actionButton("Изменить", () =>
          formModal({
            title: "Изменить почту",
            text: "На новый адрес придёт письмо: почта сменится после подтверждения.",
            fields: [
              { label: "Новая почта", type: "email" },
              { label: "Текущий пароль", type: "password" },
            ],
            confirm: "Отправить письмо",
            submit: async (newEmail, currentPassword) => {
              await call("change_email", { email: newEmail, currentPassword });
              toast("Письмо для подтверждения отправлено");
            },
          }),
          { kind: "tonal" },
        ),
      ),
      row(
        "key",
        "Пароль",
        h("span", { class: "settings-row-value", text: "•••••••••" }),
        actionButton("Изменить", () =>
          formModal({
            title: "Изменить пароль",
            fields: [
              { label: "Текущий пароль", type: "password" },
              { label: "Новый пароль", type: "password" },
              { label: "Новый пароль ещё раз", type: "password" },
            ],
            confirm: "Сохранить",
            submit: async (currentPassword, password, repeat) => {
              if (password !== repeat) throw new Error("Пароли не совпадают");
              await call("change_password", { password, currentPassword });
              toast("Пароль изменён");
            },
          }),
          { kind: "tonal" },
        ),
      ),
    ]),
  );
}

// ─────────────────────────── профиль ───────────────────────────

async function renderProfilePage(column, alive) {
  const profile = await call("user_profile", { userId: state.me.id, serverId: null });
  if (!alive()) return;

  const displayName = textInput({ value: profile.display_name || "", placeholder: profile.username, maxlength: 32 });
  const pronouns = textInput({ value: profile.pronouns || "", placeholder: "например, он/его", maxlength: 24 });
  const bio = h("textarea", { class: "text-field multiline", rows: 6, maxlength: 2000, placeholder: "Расскажите о себе" });
  bio.value = profile.bio || "";
  const counter = h("span", { class: "field-counter" });
  const count = () => (counter.textContent = `${bio.value.length}/2000`);
  count();
  bio.addEventListener("input", count);

  const avatarPicker = imagePicker({ label: "Аватар", url: state.me.avatar, round: true, tag: "avatars" });
  const backgroundPicker = imagePicker({ label: "Фон профиля", url: profile.background, wide: true, tag: "backgrounds" });

  const save = actionButton("Сохранить", async () => {
    const remove = [];
    let avatarId = null;
    let backgroundId = null;
    if (avatarPicker.state.file) avatarId = await uploadPicked(avatarPicker.state.file, "avatars");
    else if (avatarPicker.state.removed) remove.push("Avatar");
    if (backgroundPicker.state.file) backgroundId = await uploadPicked(backgroundPicker.state.file, "backgrounds");
    else if (backgroundPicker.state.removed) remove.push("ProfileBackground");

    const view = await call("edit_profile", {
      displayName: displayName.value,
      pronouns: pronouns.value,
      bio: bio.value,
      avatar: avatarId,
      background: backgroundId,
      remove,
    });
    applyOwnUser(view);
    toast("Профиль сохранён");
    renderSettings();
  }, { icon: "check" });

  put(column,
    section("Как вас видят", [
      h("div", { class: "form-grid" }, [
        avatarPicker.node,
        backgroundPicker.node,
        labelled("Отображаемое имя", displayName, "Пустое — будет видно имя пользователя"),
        labelled("Местоимения", pronouns),
      ]),
    ]),
    section("Обо мне", [h("div", { class: "field" }, [bio, counter])], "Поддерживается разметка: **жирный**, *курсив*, `код`, ||спойлер||"),
    h("div", { class: "settings-actions" }, [
      actionButton("Предпросмотр", () => openProfileModal(state.me.id, null), { kind: "text", icon: "person" }),
      save,
    ]),
  );
}

// ─────────────────────────── сессии ───────────────────────────

async function renderSessionsPage(column, alive) {
  const list = await call("sessions");
  if (!alive()) return;
  const current = list.filter((session) => session.current);
  const others = list.filter((session) => !session.current);

  const row = (session) =>
    h("div", { class: "settings-row" }, [
      symbol(session.current ? "check" : "fingerprint", 24),
      h("span", { class: "settings-row-text" }, [
        h("span", { class: "settings-row-title", text: session.name || "Без названия" }),
        h("span", { class: "settings-hint", text: session.created_at ? "Вход: " + longDate(session.created_at) : session.id }),
      ]),
      actionButton(
        session.current ? "Выйти" : "Завершить",
        () =>
          confirmModal({
            title: session.current ? "Выйти на этом устройстве?" : "Завершить сессию?",
            text: session.current
              ? "Это текущая сессия: клиент выйдет из аккаунта."
              : `Сессия «${session.name}» будет завершена, на том устройстве придётся войти заново.`,
            confirm: session.current ? "Выйти" : "Завершить",
            run: async () => {
              if (session.current) return logout();
              await call("revoke_session", { sessionId: session.id });
              toast("Сессия завершена");
              renderSettings();
            },
          }),
        { kind: "tonal", danger: true },
      ),
    ]);

  if (current.length) column.append(section("Текущая сессия", current.map(row)));
  put(column,
    section(
      `Другие сессии – ${others.length}`,
      [
        others.length
          ? null
          : h("p", { class: "settings-hint", text: "Других активных сессий нет." }),
        ...others.map(row),
        others.length
          ? h("div", { class: "settings-actions" }, [
              actionButton(
                "Завершить все остальные",
                () =>
                  confirmModal({
                    title: "Завершить все остальные сессии?",
                    text: "На всех других устройствах придётся войти заново.",
                    confirm: "Завершить",
                    run: async () => {
                      await call("revoke_other_sessions");
                      toast("Остальные сессии завершены");
                      renderSettings();
                    },
                  }),
                { kind: "tonal", danger: true, icon: "logout" },
              ),
            ])
          : null,
      ],
      current.length ? null : "Текущая сессия отмечается после входа по паролю или при восстановлении запомненной.",
    ),
  );
}

// ─────────────────────────── внешний вид ───────────────────────────

function renderAppearancePage(column) {
  const appearance = readAppearance();
  const update = (patch) => {
    Object.assign(appearance, patch);
    writeSetting("appearance", appearance);
    applyAppearance(appearance);
  };

  const slider = (min, max, value, unit, onchange) => {
    const input = h("input", { type: "range", class: "slider", min, max, step: 1, value });
    const label = h("span", { class: "slider-value", text: value + unit });
    input.oninput = () => {
      label.textContent = input.value + unit;
      onchange(Number(input.value));
    };
    return h("div", { class: "slider-row" }, [input, label]);
  };

  put(column,
    section("Тема", [
      choiceRow(
        [
          { id: "light", label: "Светлая" },
          { id: "dark", label: "Тёмная" },
          { id: "system", label: "Как в системе" },
        ],
        appearance.theme,
        (theme) => update({ theme }),
      ),
    ]),
    section("Сообщения", [
      labelled("Размер текста", slider(12, 20, appearance.messageSize, " px", (messageSize) => update({ messageSize }))),
      labelled("Отступ между группами", slider(0, 24, appearance.groupSpacing, " px", (groupSpacing) => update({ groupSpacing }))),
    ]),
    section("Поле ввода", [
      toggleRow("Кнопка отправки", "Показывать кнопку рядом с полем ввода", appearance.sendButton, (sendButton) =>
        update({ sendButton }),
      ),
    ]),
    h("div", { class: "settings-actions" }, [
      actionButton("Сбросить", () => {
        writeSetting("appearance", APPEARANCE_DEFAULTS);
        applyAppearance(readAppearance());
        renderSettings();
      }, { kind: "text" }),
    ]),
  );
}

const APPEARANCE_DEFAULTS = { theme: "system", messageSize: 14, groupSpacing: 12, sendButton: true };

function readAppearance() {
  return Object.assign({}, APPEARANCE_DEFAULTS, readSetting("appearance", {}));
}

/** Применить тему и размеры (вызывается и при запуске). */
function applyAppearance(appearance = readAppearance()) {
  const root = document.documentElement;
  if (window.ArachnidTheme) window.ArachnidTheme.set(appearance.theme);
  root.style.setProperty("--message-size", appearance.messageSize + "px");
  root.style.setProperty("--message-group-spacing", appearance.groupSpacing + "px");
  root.classList.toggle("no-send-button", !appearance.sendButton);
}

// ─────────────────────────── приложение ───────────────────────────

async function renderDesktopPage(column, alive) {
  const [dir, version] = await Promise.all([
    call("data_dir").catch(() => ""),
    window.__TAURI__ && window.__TAURI__.app ? window.__TAURI__.app.getVersion().catch(() => "") : "",
  ]);
  if (!alive()) return;
  put(column,
    section("О программе", [
      h("div", { class: "settings-row" }, [
        symbol("info", 24),
        h("span", { class: "settings-row-text" }, [
          h("span", { class: "settings-row-title", text: "Arachnid Client" + (version ? " " + version : "") }),
          h("span", { class: "settings-hint", text: "Клиент Stoat на Tauri и Rust" }),
        ]),
      ]),
      dir
        ? h("div", { class: "settings-row" }, [
            symbol("description", 24),
            h("span", { class: "settings-row-text" }, [
              h("span", { class: "settings-row-title", text: "Данные приложения" }),
              h("span", { class: "settings-hint selectable", text: dir }),
            ]),
            actionButton("Копировать", () => copyText(dir), { kind: "text", icon: "content_copy" }),
          ])
        : null,
    ]),
  );
}

// ─────────────────────────── сервер: обзор ───────────────────────────

function renderOverviewPage(column) {
  const server = settings.server;
  const name = textInput({ value: server.name, maxlength: 32 });
  const description = h("textarea", { class: "text-field multiline", rows: 4, maxlength: 1024, placeholder: "О чём этот сервер" });
  description.value = server.description || "";
  const icon = imagePicker({ label: "Значок", url: server.icon, round: true, tag: "icons" });
  const banner = imagePicker({ label: "Баннер", url: server.banner, wide: true, tag: "banners" });

  const select = (value) => {
    const node = h("select", { class: "text-field" }, [
      h("option", { value: "", text: "Не отправлять" }),
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

  const save = actionButton("Сохранить", async () => {
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
    toast("Сервер сохранён");
    scheduleWorkspaceRefresh();
    renderSettings();
  }, { icon: "check" });

  put(column,
    section("Сервер", [
      h("div", { class: "form-grid" }, [icon.node, banner.node]),
      labelled("Название", name),
      labelled("Описание", description),
    ]),
    section("Системные сообщения", [
      h("div", { class: "form-grid" }, [
        labelled("Участник вступил", system.user_joined),
        labelled("Участник вышел", system.user_left),
        labelled("Участника исключили", system.user_kicked),
        labelled("Участника забанили", system.user_banned),
      ]),
    ]),
    h("div", { class: "settings-actions" }, [save]),
  );
}

// ─────────────────────────── сервер: эмодзи ───────────────────────────

async function renderEmojiPage(column, alive) {
  const serverId = settings.serverId;
  const list = await call("server_emojis", { serverId });
  if (!alive()) return;

  const name = textInput({ placeholder: "имя_эмодзи", maxlength: 32 });
  let picked = null;
  const preview = h("div", { class: "image-preview emoji empty" });
  const choose = actionButton("Выбрать картинку", async () => {
    picked = await pickFile("image/png,image/jpeg,image/gif,image/webp");
    if (!picked) return;
    preview.style.backgroundImage = `url("${picked.preview}")`;
    preview.classList.remove("empty");
    if (!name.value) name.value = picked.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
  }, { kind: "tonal", icon: "attach_file" });
  const add = actionButton("Добавить", async () => {
    if (!picked) throw new Error("Сначала выберите картинку");
    if (picked.size > 500 * 1024) throw new Error("Эмодзи должен быть не больше 500 КБ");
    const fileId = await uploadPicked(picked, "emojis");
    await call("create_emoji", { serverId, name: name.value, fileId });
    serverEmoji.delete(serverId);
    toast("Эмодзи добавлен");
    renderSettings();
  }, { icon: "add" });

  const grid = h("div", { class: "emoji-admin-grid" });
  for (const emoji of list) {
    const remove = actionButton("", () =>
      confirmModal({
        title: "Удалить эмодзи?",
        text: `:${emoji.name}: пропадёт из всех сообщений сервера.`,
        confirm: "Удалить",
        run: async () => {
          await call("delete_emoji", { serverId, emojiId: emoji.id });
          serverEmoji.delete(serverId);
          renderSettings();
        },
      }),
    { kind: "text", icon: "delete" });
    remove.title = "Удалить";
    grid.append(
      h("div", { class: "emoji-admin-item" }, [
        emoji.url ? image(emoji.url, { class: "emoji-admin-image", alt: emoji.name }) : null,
        h("span", { class: "emoji-admin-name", text: ":" + emoji.name + ":" }),
        remove,
      ]),
    );
  }

  put(column,
    section("Новый эмодзи", [
      h("div", { class: "emoji-upload" }, [preview, h("div", { class: "form-stack grow" }, [labelled("Имя", name), h("div", { class: "image-actions" }, [choose, add])])]),
    ], "PNG, JPEG, GIF или WebP до 500 КБ. Имя — латиница, цифры и «_»."),
    section(`Эмодзи – ${list.length}`, [list.length ? grid : h("p", { class: "settings-hint", text: "Своих эмодзи пока нет." })]),
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

  const search = textInput({ placeholder: `Поиск среди ${list.length} участников` });
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
      can(PERM.MANAGE_NICKNAMES) || isMe ? labelled("Ник на сервере", nickname) : null,
      server.roles.length ? labelled("Роли", roleBoxes) : null,
      h("div", { class: "settings-actions" }, [
        !isMe && can(PERM.KICK)
          ? actionButton("Исключить", () =>
              confirmModal({
                title: `Исключить ${member.name}?`,
                text: "Участник сможет вернуться по приглашению.",
                confirm: "Исключить",
                run: async () => {
                  await call("kick_member", { serverId, userId: member.id });
                  toast("Участник исключён");
                  renderSettings();
                },
              }),
            { kind: "text", danger: true })
          : null,
        !isMe && can(PERM.BAN)
          ? actionButton("Забанить", () =>
              formModal({
                title: `Забанить ${member.name}?`,
                fields: [{ label: "Причина (необязательно)", maxlength: 1024 }],
                confirm: "Забанить",
                danger: true,
                submit: async (reason) => {
                  await call("ban_member", { serverId, userId: member.id, reason });
                  toast("Участник забанен");
                  renderSettings();
                },
              }),
            { kind: "text", danger: true })
          : null,
        h("span", { class: "spacer" }),
        actionButton("Сохранить", async () => {
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
          toast("Участник сохранён");
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
    if (shown.length > 200) body.append(h("p", { class: "settings-hint", text: `Показаны первые 200 из ${shown.length}. Уточните поиск.` }));
    if (!shown.length) body.append(h("p", { class: "settings-hint", text: "Никого не нашлось." }));
  };
  search.addEventListener("input", draw);
  draw();
  put(column,
    editableRoles.length || can(PERM.KICK) || can(PERM.BAN) ? null : notice("У вас нет прав менять участников."),
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
  roleList.append(entry("default", "Все", null, true));

  const newName = textInput({ placeholder: "Новая роль", maxlength: 32 });
  const create = actionButton("Создать", async () => {
    const before = new Set(server.roles.map((role) => role.id));
    settings.server = await call("create_role", { serverId, name: newName.value });
    const created = settings.server.roles.find((role) => !before.has(role.id));
    if (created) settings.role = created.id;
    renderSettings();
  }, { kind: "tonal", icon: "add" });

  const editorBox = h("div", { class: "role-editor" });
  if (selected === "default") {
    put(editorBox,
      h("p", { class: "settings-hint", text: "Права роли «Все» есть у каждого участника сервера." }),
      permissionList(server.default_permissions, null, false, async (allow) => {
        settings.server = await call("set_permissions", { serverId, roleId: null, allow, deny: null });
        toast("Права сохранены");
      }),
    );
  } else {
    const role = server.roles.find((item) => item.id === selected);
    const editable = role.rank > server.top_rank;
    const name = textInput({ value: role.name, maxlength: 32 });
    const colourText = textInput({ value: role.colour || "", placeholder: "#5470ec или CSS-градиент", maxlength: 128 });
    const colourPicker = h("input", { type: "color", class: "colour-picker", value: /^#[0-9a-f]{6}$/i.test(role.colour || "") ? role.colour : "#5470ec" });
    colourPicker.oninput = () => (colourText.value = colourPicker.value);
    const hoist = h("input", { type: "checkbox", class: "switch" });
    hoist.checked = role.hoist;
    if (!editable) [name, colourText, colourPicker, hoist].forEach((node) => (node.disabled = true));

    put(editorBox,
      editable ? null : notice("Эта роль не ниже вашей — менять её нельзя."),
      labelled("Название", name),
      labelled("Цвет", h("div", { class: "colour-row" }, [colourPicker, colourText]), "Пустое поле — без цвета"),
      h("label", { class: "settings-row" }, [
        h("span", { class: "settings-row-text" }, [
          h("span", { class: "settings-row-title", text: "Показывать отдельно" }),
          h("span", { class: "settings-hint", text: "Участники с этой ролью — отдельной группой в списке" }),
        ]),
        hoist,
      ]),
      editable
        ? h("div", { class: "settings-actions" }, [
            actionButton("Удалить роль", () =>
              confirmModal({
                title: `Удалить роль «${role.name}»?`,
                text: "Роль пропадёт у всех участников.",
                confirm: "Удалить",
                run: async () => {
                  settings.server = await call("delete_role", { serverId, roleId: role.id });
                  settings.role = null;
                  renderSettings();
                },
              }),
            { kind: "text", danger: true, icon: "delete" }),
            h("span", { class: "spacer" }),
            actionButton("Сохранить", async () => {
              settings.server = await call("edit_role", {
                serverId,
                roleId: role.id,
                name: name.value !== role.name ? name.value : null,
                colour: colourText.value.trim() !== (role.colour || "") ? colourText.value : null,
                hoist: hoist.checked !== role.hoist ? hoist.checked : null,
              });
              membersCache.delete(serverId);
              scheduleWorkspaceRefresh();
              toast("Роль сохранена");
              renderSettings();
            }, { icon: "check" }),
          ])
        : null,
      h("h2", { class: "settings-section-title", text: "Права" }),
      permissionList(role.allow, role.deny, !editable, async (allow, deny) => {
        settings.server = await call("set_permissions", { serverId, roleId: role.id, allow, deny });
        toast("Права сохранены");
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
    const value = hasBit(allowMask, permission.bit) ? "allow" : hasBit(denyMask, permission.bit) ? "deny" : "unset";
    let control;
    if (triState) {
      control = h("div", { class: "tri-state" });
      for (const option of [
        { id: "deny", icon: "close", title: "Запретить" },
        { id: "unset", icon: "remove", title: "Не задано" },
        { id: "allow", icon: "check", title: "Разрешить" },
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
          h("span", { class: "settings-row-title", text: permission.title }),
          permission.hint ? h("span", { class: "settings-hint", text: permission.hint }) : null,
        ]),
        control,
      ]),
    );
  }
  const saveBar = h("div", { class: "settings-actions sticky hidden" }, [
    h("span", { class: "settings-hint", text: "Есть несохранённые права" }),
    h("span", { class: "spacer" }),
    actionButton("Сохранить права", async () => {
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
          text: "#" + invite.channel + (invite.creator ? " · создал " + (invite.creator.display_name || invite.creator.username) : ""),
        }),
      ]),
      actionButton("", () => copyText(inviteLink(invite.code)).then(() => toast("Ссылка скопирована")), { kind: "text", icon: "content_copy" }),
      actionButton("", async () => {
        await call("delete_invite", { code: invite.code });
        toast("Приглашение удалено");
        renderSettings();
      }, { kind: "text", icon: "delete", danger: true }),
    ]),
  );
  put(column,
    section(`Приглашения – ${list.length}`, list.length ? rows : [h("p", { class: "settings-hint", text: "Активных приглашений нет. Создать приглашение можно в меню сервера или канала." })]),
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
        h("span", { class: "settings-hint", text: ban.reason ? "Причина: " + ban.reason : "Причина не указана" }),
      ]),
      actionButton("Разбанить", async () => {
        await call("unban_member", { serverId, userId: ban.id });
        toast("Бан снят");
        renderSettings();
      }, { kind: "tonal" }),
    ]),
  );
  column.append(section(`Баны – ${list.length}`, list.length ? rows : [h("p", { class: "settings-hint", text: "Никто не забанен." })]));
}

// ─────────────────────────── действия с сервером ───────────────────────────

function confirmLeaveServer(server) {
  const owner = server.is_owner || server.owner;
  confirmModal({
    title: owner ? `Удалить сервер «${server.name}»?` : `Выйти с сервера «${server.name}»?`,
    text: owner
      ? "Сервер, его каналы и сообщения будут удалены навсегда."
      : "Вернуться можно будет только по приглашению.",
    confirm: owner ? "Удалить" : "Выйти",
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
    title: "Пригласить друзей",
    body: h("div", { class: "form-stack" }, [
      h("p", { class: "settings-hint", text: "Отправьте эту ссылку — по ней можно вступить на сервер." }),
      field,
    ]),
    actions: [
      { label: "Закрыть", onclick: closeModal },
      { label: "Копировать", primary: true, onclick: () => copyText(link).then(() => toast("Ссылка скопирована")) },
    ],
  });
  field.select();
}

function createChannelModal(serverId) {
  let kind = "Text";
  const name = textInput({ placeholder: "новый-канал", maxlength: 32 });
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
    title: "Создать канал",
    body: h("div", { class: "form-stack" }, [
      choiceRow(
        [
          { id: "Text", label: "Текстовый" },
          { id: "Voice", label: "Голосовой" },
        ],
        kind,
        (value) => (kind = value),
      ),
      labelled("Название", name),
    ]),
    actions: [
      { label: "Отмена", onclick: closeModal },
      { label: "Создать", primary: true, onclick: run },
    ],
  });
  name.focus();
}

function editChannelModal(channel) {
  formModal({
    title: "Изменить канал",
    fields: [
      { label: "Название", value: channel.name, maxlength: 32 },
      { label: "Описание", value: channel.description || "", maxlength: 1024, multiline: true },
    ],
    confirm: "Сохранить",
    submit: async (name, description) => {
      await call("edit_channel", {
        channelId: channel.id,
        name: name !== channel.name ? name : null,
        description: description !== (channel.description || "") ? description : null,
      });
      scheduleWorkspaceRefresh();
      toast("Канал сохранён");
    },
  });
}

function deleteChannelModal(channel) {
  confirmModal({
    title: `Удалить канал #${channel.name}?`,
    text: "Все сообщения канала будут удалены навсегда.",
    confirm: "Удалить",
    run: async () => {
      await call("delete_channel", { channelId: channel.id });
      if (state.channelId === channel.id) closeChannel();
      scheduleWorkspaceRefresh();
    },
  });
}

/** «Добавить сервер»: создать свой или вступить по приглашению. */
function addServerModal() {
  const name = textInput({ placeholder: "Мой сервер", maxlength: 32 });
  const code = textInput({ placeholder: "https://stoat.chat/invite/… или код" });
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
            h("span", { class: "settings-row-title", text: info.server_name || info.channel_name || "Приглашение" }),
            h("span", {
              class: "settings-hint",
              text: [info.member_count ? `${info.member_count} участников` : null, info.user_name ? "приглашает " + info.user_name : null]
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
    title: "Добавить сервер",
    body: h("div", { class: "form-stack" }, [
      section("Вступить по приглашению", [
        code,
        preview,
        h("div", { class: "settings-actions" }, [
          actionButton("Вступить", async () => go(await call("join_invite", { code: code.value })), { icon: "group_add" }),
        ]),
      ]),
      section("Создать свой", [
        name,
        h("div", { class: "settings-actions" }, [
          actionButton("Создать", async () => go(await call("create_server", { name: name.value })), { kind: "tonal", icon: "add" }),
        ]),
      ]),
    ]),
    actions: [{ label: "Закрыть", onclick: closeModal }],
  });
  code.focus();
}
