// Настройки: «Профиль» и «Мои боты» (EditProfile.tsx, UserProfileEditor.tsx,
// ServerIdentity.tsx, MyBots.tsx, ViewBot.tsx, Discoverable.tsx и окна
// CreateBot, AddBot, DeleteBot, EditBotUsername, ResetBotToken
// браузерного клиента Stoat).
//
// Подключается после settings.js и пользуется его помощниками.

"use strict";

// ─────────────────────────── ограничения загрузки ───────────────────────────

let instanceInfoCache = null;

/** Сводка по инстансу (кэшируется на сеанс). */
async function instanceInfo() {
  if (!instanceInfoCache) instanceInfoCache = call("instance_info").catch((error) => {
    instanceInfoCache = null;
    throw error;
  });
  return instanceInfoCache;
}

/** Время создания из ULID (decodeTime). */
function ulidTime(id) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = 0;
  for (const char of String(id || "").slice(0, 10).toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) return null;
    time = time * 32 + value;
  }
  return time;
}

/** Предельный размер файла для тега Autumn (instance.limits()). */
async function uploadLimit(tag) {
  const fallback = { attachments: 20e6, avatars: 4e6, backgrounds: 6e6, icons: 2.5e6, banners: 6e6, emojis: 5e5 };
  try {
    const { upload } = await instanceInfo();
    const created = state.me ? ulidTime(state.me.id) : null;
    const young = created !== null && Date.now() - created < upload.new_user_hours * 3600 * 1000;
    const sizes = young ? upload.new_user : upload.default;
    return sizes[tag] || fallback[tag] || 0;
  } catch {
    return fallback[tag] || 0;
  }
}

// ─────────────────────────── поле картинки (FileInput) ───────────────────────────

/**
 * Картинка 96 px высотой: щелчок открывает выбор файла (с обрезкой), крестик
 * убирает картинку. `crop` — параметры окна обрезки (cropProcess).
 */
function fileInput({ label, url = null, aspect = "1/1", rounded = true, tag, crop = null, onchange = null }) {
  const preview = h("button", { type: "button", class: "file-input-preview" + (rounded ? " rounded" : "") });
  preview.style.aspectRatio = aspect;
  const clear = h("button", { type: "button", class: "icon-button file-input-clear", title: t("Remove") }, [symbol("close", 20)]);
  let initial = url;
  const value = { file: null, url };

  const show = () => {
    preview.replaceChildren();
    const src = value.file ? value.file.preview : value.url ? mediaSrc(value.url) : null;
    if (src) preview.append(h("img", { src, alt: "" }));
    clear.disabled = !value.file && !value.url;
  };

  preview.onclick = async () => {
    const picked = await pickImage(crop || {}, await uploadLimit(tag));
    if (!picked) return;
    value.file = picked;
    show();
    onchange && onchange();
  };
  clear.onclick = () => {
    value.file = null;
    value.url = null;
    show();
    onchange && onchange();
  };
  show();

  return {
    node: h("div", { class: "field" }, [
      h("span", { class: "field-label", text: label }),
      h("div", { class: "file-input" }, [preview, clear]),
    ]),
    /** Изменено ли поле относительно исходного значения. */
    dirty: () => Boolean(value.file) || value.url !== initial,
    /** Выбранный файл, `null` — убрать, `undefined` — без изменений. */
    async result() {
      if (value.file) return uploadPicked(value.file, tag);
      if (!value.url && initial) return null;
      return undefined;
    },
    reset(next = initial) {
      initial = next;
      value.file = null;
      value.url = next;
      show();
    },
  };
}

/** Текстовое поле со счётчиком и подписью (Form2.TextField). */
function counterField({ label, value = "", minlength = 0, maxlength, placeholder = "", oninput = null }) {
  const input = textInput({ value, placeholder, maxlength });
  if (minlength) input.minLength = minlength;
  const counter = h("span", { class: "field-counter" });
  const count = () => (counter.textContent = `${input.value.length}/${maxlength}`);
  input.addEventListener("input", () => {
    count();
    oninput && oninput();
  });
  count();
  return {
    input,
    node: h("label", { class: "field" }, [h("span", { class: "field-label", text: label }), h("span", { class: "field-stack" }, [input, counter])]),
    valid: () => !input.value || input.value.length >= minlength,
  };
}

// ─────────────────────────── редактор профиля ───────────────────────────

/**
 * Редактор профиля (UserProfileEditor): аватар, баннер, отображаемое имя,
 * местоимения, «О себе». Отправляются только изменённые поля, пустые
 * значения — удаление. `extra` — дополнительные поля: { node, dirty, reset,
 * submit } (флажок «Разрешить другим приглашать бота»).
 */
function profileEditor({ user, profile, bot = false, extra = null, onsaved = null }) {
  const initial = {
    displayName: user.display_name || "",
    pronouns: (profile && profile.pronouns) || "",
    bio: (profile && profile.bio) || "",
  };

  const update = () => {
    const dirty =
      avatarInput.dirty() ||
      bannerInput.dirty() ||
      displayName.input.value !== initial.displayName ||
      pronouns.input.value !== initial.pronouns ||
      bio.value !== initial.bio ||
      Boolean(extra && extra.dirty());
    save.disabled = !dirty || !displayName.valid() || !pronouns.valid() || busy;
    reset.disabled = busy;
  };

  const avatarInput = fileInput({
    label: t("Avatar"),
    url: user.avatar,
    tag: "avatars",
    crop: { ratio: 1, ratioLabel: t("Square"), allowModeToggle: false, dialogTitle: t("Crop Avatar"), circularMask: true },
    onchange: update,
  });
  const bannerInput = fileInput({
    label: t("Banner"),
    url: profile ? profile.background : null,
    aspect: "232/100",
    rounded: false,
    tag: "backgrounds",
    crop: { ratio: 232 / 100, ratioLabel: t("Banner"), dialogTitle: t("Crop Banner") },
    onchange: update,
  });
  const displayName = counterField({ label: t("Display Name"), value: initial.displayName, minlength: 2, maxlength: 32, oninput: update });
  const pronouns = counterField({ label: t("Pronouns"), value: initial.pronouns, minlength: 1, maxlength: 24, oninput: update });
  const bio = h("textarea", { class: "text-field multiline", rows: 6, maxlength: 2000, placeholder: t("Something cool about me...") });
  bio.value = initial.bio;
  bio.addEventListener("input", update);
  if (extra && extra.onchange) extra.onchange(update);

  let busy = false;
  const reset = h("button", { type: "button", class: "button text", text: t("Reset") });
  const save = h("button", { type: "button", class: "button filled", text: t("Save") });
  const spinner = h("span", { class: "spinner hidden" });

  reset.onclick = () => {
    avatarInput.reset(user.avatar);
    bannerInput.reset(profile ? profile.background : null);
    displayName.input.value = initial.displayName;
    pronouns.input.value = initial.pronouns;
    bio.value = initial.bio;
    displayName.input.dispatchEvent(new Event("input"));
    pronouns.input.dispatchEvent(new Event("input"));
    if (extra) extra.reset();
    update();
  };

  save.onclick = async () => {
    busy = true;
    spinner.classList.remove("hidden");
    update();
    try {
      const remove = [];
      const args = { userId: bot ? user.id : null, displayName: null, pronouns: null, bio: null, avatar: null, background: null, remove };
      if (displayName.input.value !== initial.displayName) args.displayName = displayName.input.value;
      if (pronouns.input.value !== initial.pronouns) args.pronouns = pronouns.input.value;
      if (bio.value !== initial.bio) args.bio = bio.value;
      if (avatarInput.dirty()) {
        const avatarId = await avatarInput.result();
        if (avatarId === null) remove.push("Avatar");
        else if (avatarId) args.avatar = avatarId;
      }
      if (bannerInput.dirty()) {
        const bannerId = await bannerInput.result();
        if (bannerId === null) remove.push("ProfileBackground");
        else if (bannerId) args.background = bannerId;
      }
      const touched = Object.entries(args).some(([key, value]) => key !== "userId" && key !== "remove" && value !== null) || remove.length;
      const view = touched ? await call("edit_profile", args) : null;
      if (extra && extra.dirty()) await extra.submit();
      if (view && !bot) applyOwnUser(view);
      onsaved && (await onsaved(view));
    } catch (error) {
      toast(describe(error), "error");
    } finally {
      busy = false;
      spinner.classList.add("hidden");
      update();
    }
  };
  update();

  return h("div", { class: "form-stack" }, [
    avatarInput.node,
    bannerInput.node,
    displayName.node,
    pronouns.node,
    bot
      ? null
      : categoryGroup([
          categoryButton({
            icon: "badge",
            title: t("Want to change username?"),
            description: t("Go to account settings to edit your username"),
            action: "chevron",
            onclick: () => {
              settings.page = "account";
              renderSettings();
            },
          }),
        ]),
    h("span", { class: "field-label", text: t("Profile Bio") }),
    bio,
    extra ? extra.node : null,
    h("div", { class: "settings-actions" }, [reset, save, spinner]),
  ]);
}

// ─────────────────────────── «Профиль» ───────────────────────────

async function renderProfilePage(column, alive) {
  const [account, profile] = await Promise.all([call("account_info"), call("user_profile", { userId: state.me.id, serverId: null })]);
  if (!alive()) return;
  const servers = state.workspace ? state.workspace.servers : [];
  put(column,
    userSummary(account, null),
    categoryGroup([
      categoryCollapse({
        icon: "groups",
        title: t("Server Identities"),
        description: t("Change your profile per-server"),
        children: servers.map((server) =>
          categoryButton({
            icon: avatar({ url: server.icon, name: server.name, size: 24 }),
            title: server.name,
            onclick: () => serverIdentityModal(server),
          }),
        ),
      }),
    ]),
    h("h2", { class: "settings-heading", text: t("Edit Global Profile") }),
    profileEditor({ user: state.me, profile, onsaved: () => renderSettings() }),
  );
}

/** Окно «Изменить профиль на сервере» (ServerIdentity.tsx). */
async function serverIdentityModal(server) {
  if (!state.me) return;
  const profile = await call("user_profile", { userId: state.me.id, serverId: server.id });
  const member = profile.member || {};
  const avatarInput = fileInput({
    label: t("Server Avatar"),
    url: member.avatar || null,
    tag: "avatars",
    crop: { ratio: 1, ratioLabel: t("Square"), allowModeToggle: false, dialogTitle: t("Crop Avatar"), circularMask: true },
  });
  const nickname = counterField({ label: t("Nickname"), value: member.nickname || "", minlength: 1, maxlength: 32, placeholder: myName() });
  const pronouns = counterField({ label: t("Pronouns"), value: member.pronouns || "", minlength: 1, maxlength: 24 });

  openModal({
    title: t("Change identity on {0}", [server.name]),
    body: h("div", { class: "form-stack" }, [avatarInput.node, nickname.node, pronouns.node]),
    actions: [
      { label: t("Cancel"), onclick: closeModal },
      {
        label: t("Save"),
        primary: true,
        onclick: async () => {
          if (!nickname.valid() || !pronouns.valid()) return;
          try {
            const args = { serverId: server.id, nickname: null, pronouns: null, avatar: null, removeAvatar: null };
            if (nickname.input.value !== (member.nickname || "")) args.nickname = nickname.input.value;
            if (pronouns.input.value !== (member.pronouns || "")) args.pronouns = pronouns.input.value;
            if (avatarInput.dirty()) {
              const avatarId = await avatarInput.result();
              if (avatarId === null) args.removeAvatar = true;
              else if (avatarId) args.avatar = avatarId;
            }
            await call("edit_server_identity", args);
            membersCache.delete(server.id);
            if (state.serverId === server.id) loadMembers(server.id);
            closeModal();
          } catch (error) {
            toast(describe(error), "error");
          }
        },
      },
    ],
  });
  nickname.input.focus();
}

// ─────────────────────────── «Мои боты» ───────────────────────────

const DEVELOPERS_URL = "https://developers.stoat.chat";
const AUP_URL = "https://stoat.chat/aup";

async function renderBotsPage(column, alive) {
  const bots = await call("owned_bots");
  if (!alive()) return;
  put(column,
    categoryGroup([
      categoryButton({
        icon: "smart_toy",
        title: t("Create Bot"),
        description: t("You agree that your bot is subject to the Acceptable Usage Policy."),
        action: "chevron",
        onclick: createBotModal,
      }),
      categoryButton({
        icon: "library_books",
        title: t("Developer Documentation"),
        description: t("Learn more about how to create bots on Stoat."),
        action: "external",
        href: DEVELOPERS_URL,
      }),
    ]),
    bots.length
      ? categoryGroup(
          bots.map((bot) =>
            categoryButton({
              icon: avatar({ url: bot.user.avatar, name: bot.user.display_name || bot.user.username, size: 24 }),
              title: bot.user.display_name || bot.user.username,
              action: "chevron",
              onclick: () => openBotPage(bot.id),
            }),
          ),
        )
      : null,
  );
}

function openBotPage(botId) {
  settings.page = "bots/" + botId;
  renderSettings();
}

/** Окно «Создать бота» (CreateBot.tsx). */
function createBotModal() {
  const name = counterField({ label: t("Username"), minlength: 2, maxlength: 32 });
  const policy = h("p", { class: "settings-hint" },
    I18N.rich("By creating this bot, you agree to the <0>Acceptable Use Policy</0>.", null, {
      0: (text) => h("a", { class: "link", href: AUP_URL, target: "_blank", rel: "noreferrer", text }),
    }),
  );
  let create;
  const submit = async () => {
    if (create.disabled) return;
    create.disabled = true;
    try {
      const bot = await call("create_bot", { name: name.input.value });
      closeModal();
      openBotPage(bot.id);
    } catch (error) {
      toast(describe(error), "error");
      create.disabled = false;
    }
  };
  const box = openModal({
    title: t("Create a new bot"),
    body: h("div", { class: "form-stack" }, [policy, name.node]),
    actions: [
      { label: t("Close"), onclick: closeModal },
      { label: t("Create"), primary: true, disabled: true, onclick: submit },
    ],
  });
  create = box.querySelector(".button.filled");
  name.input.addEventListener("input", () => (create.disabled = name.input.value.length < 2));
  name.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });
  name.input.focus();
}

/** Подзаголовок страницы бота — имя пользователя бота. */
const botTitles = new Map();

async function renderBotPage(column, alive, botId) {
  const [bot, profile, info, about] = await Promise.all([
    call("bot_info", { botId }),
    call("user_profile", { userId: botId, serverId: null }),
    instanceInfo().catch(() => null),
    settings.about ? settings.about : call("about").catch(() => null),
  ]);
  if (about) settings.about = about;
  if (!alive()) return;
  botTitles.set(botId, bot.user.username);
  const crumb = column.querySelector(".settings-crumb-current");
  if (crumb) crumb.textContent = bot.user.username;

  // флажок «Разрешить другим приглашать бота» — часть формы профиля
  let isPublic = bot.public;
  let onchange = null;
  const publicRow = checkboxRow(t("Allow others to invite your bot"), isPublic, (value) => {
    isPublic = value;
    onchange && onchange();
  });
  const extra = {
    node: publicRow,
    dirty: () => isPublic !== bot.public,
    reset: () => {
      isPublic = bot.public;
      setCheckboxMark(publicRow.querySelector(".m3-checkbox"), isPublic);
    },
    submit: () => call("edit_bot", { botId, name: null, public: isPublic, resetToken: null }),
    onchange: (callback) => (onchange = callback),
  };

  const account = {
    display_name: bot.user.display_name || bot.user.username,
    username: bot.user.username,
    discriminator: bot.user.discriminator,
    avatar: bot.user.avatar,
    background: profile.background,
    created_at: profile.created_at,
    badges: bot.badges,
  };
  const origin = about && about.official ? "https://stoat.chat" : info && info.api_url ? webOrigin(info) : "https://stoat.chat";

  put(column,
    userSummary(account, null, { showBadges: true }),
    profileEditor({ user: bot.user, profile, bot: true, extra, onsaved: () => renderSettings() }),
    categoryGroup([
      categoryButton({
        icon: "token",
        title: t("Reset Token"),
        description: t("Generate a new token if it gets lost or compromised"),
        action: "chevron",
        onclick: () =>
          confirmModal({
            title: t("Reset {0}'s token?", [bot.user.username]),
            text: t("This will invalidate the current token and stop any existing instances of the bot from running."),
            confirm: t("Reset"),
            run: async () => {
              await call("edit_bot", { botId, name: null, public: null, resetToken: true });
              renderSettings();
            },
          }),
      }),
      categoryButton({
        icon: "badge",
        title: t("Change Username"),
        description: t("Change this bot's username"),
        action: "chevron",
        onclick: () =>
          formModal({
            title: t("Change bot username"),
            fields: [{ label: t("Username"), value: bot.user.username, maxlength: 32, counter: true, suffix: "#" + bot.user.discriminator }],
            cancel: t("Close"),
            confirm: t("Change"),
            submit: async (name) => {
              await call("edit_bot", { botId, name, public: null, resetToken: null });
              renderSettings();
            },
          }),
      }),
    ]),
    categoryGroup([
      categoryButton({ icon: "person_add", title: t("Invite Bot"), action: "chevron", onclick: () => addBotModal(botId) }),
      categoryButton({
        icon: "link",
        title: t("Copy Invite URL"),
        action: "copy",
        onclick: async () => {
          await copyText(`${origin}/bot/${botId}`);
          toast(t("Invite URL copied to clipboard"));
        },
      }),
      categoryButton({
        icon: "content_copy",
        title: t("Copy ID"),
        action: "copy",
        onclick: async () => {
          await copyText(botId);
          toast(t("ID copied to clipboard"));
        },
      }),
      categoryButton({
        icon: "key",
        title: t("Copy Token"),
        action: "copy",
        onclick: async () => {
          await copyText(bot.token);
          toast(t("Token copied to clipboard"));
        },
      }),
      categoryButton({
        icon: "delete",
        title: t("Delete Bot"),
        action: "chevron",
        onclick: () =>
          confirmModal({
            title: t("Delete {0}?", [bot.user.display_name || bot.user.username || bot.id]),
            text: t("Once it's deleted, there's no going back."),
            confirm: t("Delete"),
            run: async () => {
              const mfa = await call("mfa_status");
              const done = await mfaFlow(mfa.methods, (answer) => call("delete_bot", { botId, mfa: answer }));
              if (!done) return;
              settings.page = "bots";
              renderSettings();
            },
          }),
      }),
    ]),
    about && about.official ? await discoverSection(bot) : null,
  );
}

/** Адрес веб-клиента инстанса для ссылок-приглашений. */
function webOrigin(info) {
  try {
    const api = new URL(info.api_url);
    // api.stoat.chat → stoat.chat, stoat.chat/api → stoat.chat
    return api.origin.replace("://api.", "://");
  } catch {
    return "https://stoat.chat";
  }
}

/** Раздел «Обзор» (Discoverable.tsx) — только на официальном инстансе. */
async function discoverSection(bot) {
  const kind = t("bot");
  const box = h("div", { class: "form-stack" }, [h("h2", { class: "settings-heading medium", text: t("Discover") })]);
  const preview = (title, ...lines) =>
    h("div", { class: "discover-note" }, [h("span", { class: "discover-note-title", text: title }), ...lines.filter(Boolean).map((line) => h("span", { text: line }))]);
  const submitButton = () =>
    categoryGroup([
      categoryButton({
        icon: "public",
        title: t("Submit to Discover"),
        description: t("Allow others to add your bot to their servers from Discover"),
        action: "chevron",
        onclick: async () => {
          await call("request_bot_discover", { botId: bot.id });
          renderSettings();
        },
      }),
    ]);

  if (bot.discoverable) {
    box.append(preview(t("This {0} is discoverable", [kind]), t("Contact support to remove this {0} from discover", [kind])));
    return box;
  }
  let request;
  try {
    request = await call("bot_discover_status", { botId: bot.id });
  } catch (error) {
    box.append(preview(t("Can't get discover request status right now"), describe(error)));
    return box;
  }
  switch (request.status) {
    case "Pending":
    case "UnderReview":
      box.append(
        preview(t("Your {0} is under review", [kind]), t("Check back often to see if your {0} has been approved!", [kind])),
        categoryGroup([
          categoryButton({
            icon: "cancel",
            title: t("Cancel discover request"),
            description: t("Cancel your discover request and remove it from the review queue"),
            action: "chevron",
            onclick: async () => {
              await call("cancel_bot_discover", { botId: bot.id });
              renderSettings();
            },
          }),
        ]),
      );
      break;
    case "Denied":
      box.append(
        preview(t("Your discover request has been denied"), request.reason ? t("Reason: {0}", [request.reason]) : null, t("You can request again below")),
        submitButton(),
      );
      break;
    case "Removed":
      box.append(
        preview(
          t("Your discover request has been removed"),
          request.reason ? t("Reason: {0} Contact support for more information.", [request.reason]) : null,
        ),
      );
      break;
    default:
      box.append(submitButton());
  }
  return box;
}

/** Окно «Добавить бота» на сервер или в группу (AddBot.tsx). */
async function addBotModal(botId) {
  const invite = await call("public_bot", { botId });
  const groups = [
    ...(state.workspace ? state.workspace.servers : []).filter((server) => serverAllows(server, PERM.MANAGE_SERVER)).map((server) => ({ server })),
    ...(state.workspace ? state.workspace.dms : []).filter((channel) => channel.kind === "group").map((group) => ({ group })),
  ]
    .map((entry) => Object.assign(entry, { name: (entry.server || entry.group).name, id: (entry.server || entry.group).id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  let selected = null;
  const list = h("div", { class: "bot-targets", role: "listbox" });
  const search = h("input", { class: "text-field filled", type: "search", placeholder: t("Search for groups..."), autocomplete: "off" });
  const draw = () => {
    const filter = search.value.toLowerCase();
    list.replaceChildren(
      ...groups
        .filter((entry) => entry.name.toLowerCase().includes(filter))
        .map((entry) => {
          const item = h("button", { type: "button", class: "bot-target" + (selected === entry ? " selected" : ""), role: "option" }, [
            avatar({ url: (entry.server || entry.group).icon, name: entry.name, size: 24 }),
            h("span", { text: entry.name }),
          ]);
          if (entry.group) item.querySelector(".avatar") && item.querySelector(".avatar").classList.add("rounded-square");
          item.onclick = () => {
            selected = entry;
            add.disabled = false;
            draw();
          };
          return item;
        }),
    );
  };
  search.addEventListener("keyup", draw);

  const created = invite.created_at ? new Date(invite.created_at) : null;
  const description = invite.description
    ? h("div", { class: "bot-description" }, [
        segmentsNode({ segments: invite.description_segments, content: invite.description, emoji: {} }),
        h("span", { class: "bot-description-by", text: t("Description provided by {0}", [invite.username]) }),
      ])
    : null;

  const box = openModal({
    body: h("div", { class: "form-stack" }, [
      h("div", { class: "bot-invite-head" }, [
        avatar({ url: invite.avatar, name: invite.username, size: 64 }),
        h("span", { class: "bot-invite-name", text: invite.username }),
        created ? h("span", { class: "settings-hint" }, I18N.rich("Registered since <0/>", null, { 0: h("time", { text: calendarText(created) }) })) : null,
      ]),
      description,
      search,
      list,
      h("div", { class: "bot-invite-notes" }, [
        h("span", { text: t("Bots are not verified by Stoat.") }),
        h("span", { text: t("The bot will not be granted any permissions.") }),
      ]),
    ]),
    actions: [
      { label: t("Cancel"), onclick: closeModal },
      {
        label: t("Add"),
        primary: true,
        disabled: true,
        onclick: async () => {
          if (!selected) return;
          try {
            await call("invite_bot", { botId, serverId: selected.server ? selected.id : null, groupId: selected.group ? selected.id : null });
            closeModal();
          } catch (error) {
            toast(describe(error), "error");
          }
        },
      },
    ],
  });
  const add = box.querySelector(".button.filled");
  draw();
}
