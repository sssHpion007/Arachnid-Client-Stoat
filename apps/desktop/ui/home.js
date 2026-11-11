// Разделы «Бесед», которые открываются вместо канала: «Домашняя страница»
// (Home.tsx), «Друзья» (Friends.tsx) и «Обзор» (Discover.tsx), а также окна
// AddFriend, CreateGroupOrServer, CreateGroup, CreateOrJoinServer,
// CreateServer и JoinServer браузерного клиента Stoat.
//
// Подключается после settings.js и пользуется его помощниками.

"use strict";

const HOME_DONATE_URL = "https://ko-fi.com/stoatchat";
const DISCOVER_ORIGIN = "https://stt.gg";

let officialInstanceTask = null;

/** Официальный ли инстанс (instance.isStoat): от этого зависят Lounge и «Обзор». */
function officialInstance() {
  if (!officialInstanceTask) {
    officialInstanceTask = call("about")
      .then((about) => Boolean(about && about.official))
      .catch(() => {
        officialInstanceTask = null;
        return false;
      });
  }
  return officialInstanceTask;
}

// ─────────────────────────── переходы ───────────────────────────

/**
 * Открыть раздел вместо канала: `home`, `friends` или `discover`.
 * Список слева — «Беседы» (для «Обзора» он скрыт, как в оригинале).
 */
function openHomePage(page = "home") {
  rememberHistory();
  openToken += 1; // недогруженный канал больше не нужен
  closeMenus();
  toggleEmojiPicker(false);
  state.page = page;
  state.serverId = null;
  state.channelId = null;
  state.messages = [];
  state.replies = [];
  state.editing = null;
  state.atEnd = true;
  state.side = { state: "default" };
  if (page !== "discover") writeSetting("homePath", page);
  applySidebar();
  renderRail();
  renderSidebar();
  renderHeader();
  renderComposer();
  renderMembers();
  renderSide();
  renderPage();
}

/** «Обзор» (stt.gg во встроенном окне); `path` — раздел внутри него. */
function openDiscover(path = discoverPath || readSetting("discoverPath", "/discover")) {
  discoverPath = path.startsWith("/discover") ? path : "/discover" + path;
  openHomePage("discover");
}

/** Показать раздел или канал: страница прячет ленту, поле ввода и участников. */
function renderPage() {
  const page = el("page");
  const main = el("main");
  const showing = Boolean(state.page);
  page.classList.toggle("hidden", !showing);
  main.classList.toggle("hidden", showing);
  if (!showing) {
    page.replaceChildren();
    return;
  }
  if (state.page === "home") page.replaceChildren(homePage());
  else if (state.page === "friends") page.replaceChildren(friendsPage());
  else if (state.page === "discover") page.replaceChildren(discoverFrame());
}

// ─────────────────────────── домашняя страница (Home.tsx) ───────────────────────────

function homePage() {
  const left = h("div", { class: "home-column" });
  const right = h("div", { class: "home-column" });

  left.append(
    categoryButton({
      icon: symbol("md:filled:add_circle", 22),
      title: t("Create a group or server"),
      description: t("Invite all of your friends, some cool bots, and throw a big party."),
      onclick: () => createGroupOrServerModal(),
    }),
  );
  const lounge = h("div", { class: "home-slot hidden" });
  left.append(
    lounge,
    categoryButton({
      icon: symbol("md:filled:payments", 22),
      title: t("Donate to Stoat"),
      description: t("Support the project by donating - thank you!"),
      variant: "tertiary-container",
      onclick: () => openExternal(HOME_DONATE_URL),
    }),
  );

  const discover = h("div", { class: "home-slot hidden" });
  right.append(
    discover,
    categoryButton({
      icon: symbol("md:filled:rate_review", 22),
      title: t("Give feedback on Stoat"),
      description: t("Let us know how we can improve our app by giving us feedback."),
      onclick: () => openUserSettings("feedback"),
    }),
    categoryButton({
      icon: symbol("md:filled:settings", 22),
      title: t("Open settings"),
      description: t("You can also click the gear icon in the bottom left."),
      onclick: () => openUserSettings(),
    }),
  );

  // Lounge и «Обзор» — только на stoat.chat
  officialInstance().then((official) => {
    if (!official) return;
    const inLounge = Boolean(serverById(LOUNGE_ID));
    lounge.replaceWith(
      categoryButton({
        icon: symbol("md:filled:groups_3", 22),
        title: inLounge ? t("Go to the Stoat Lounge") : t("Join the Stoat Lounge"),
        description: t("You can report issues and discuss improvements with us directly here."),
        onclick: () => (inLounge ? selectServer(LOUNGE_ID) : openInviteModal(LOUNGE_INVITE)),
      }),
    );
    discover.replaceWith(
      categoryButton({
        icon: symbol("md:filled:explore", 22),
        title: t("Discover Stoat"),
        description: t("Find a community based on your hobbies or interests."),
        onclick: () => openDiscover(),
      }),
    );
  });

  return h("div", { class: "home-page" }, [
    h("div", { class: "home-wordmark", role: "img", "aria-label": "Stoat" }),
    h("div", { class: "home-buttons" }, [left, right]),
  ]);
}

// ─────────────────────────── друзья (Friends.tsx) ───────────────────────────

let friendsTab = "online";

function byDisplayName(a, b) {
  return friendLabel(a).localeCompare(friendLabel(b));
}

function friendLabel(user) {
  return user.display_name || user.username;
}

/** Списки страницы «Друзья» из отношений рабочего пространства. */
function friendLists() {
  const all = (state.workspace && state.workspace.relationships) || [];
  const pick = (kind) =>
    all
      .filter((entry) => entry.relationship === kind)
      .map((entry) => entry.user)
      .sort(byDisplayName);
  const friends = pick("Friend");
  return {
    friends,
    online: friends.filter((user) => user.presence && user.presence !== "Offline"),
    incoming: pick("Incoming"),
    outgoing: pick("Outgoing"),
    blocked: pick("Blocked"),
  };
}

/** Число входящих заявок (бейдж «Друзей» и пункта «Ожидание»). */
function pendingRequests() {
  return friendLists().incoming.length;
}

function friendsPage() {
  const lists = friendLists();
  const pending = lists.incoming.length > 99 ? "99+" : lists.incoming.length;

  const add = h("button", { class: "rail-fab", type: "button" }, [symbol("add", 24)]);
  add.onclick = () => addFriendModal();
  attachTooltip(add, t("Add a new friend"), "right");

  const item = (value, icon, label, badge = null) => {
    const node = h("button", { class: "nav-rail-item" + (friendsTab === value ? " active" : ""), type: "button" }, [
      h("span", { class: "nav-rail-indicator" }, [symbol(icon, 24), badge ? h("span", { class: "nav-rail-badge", text: String(badge) }) : null]),
      h("span", { class: "nav-rail-label", text: label }),
    ]);
    node.onclick = () => {
      friendsTab = value;
      renderPage();
    };
    return node;
  };

  const rail = h("nav", { class: "nav-rail" }, [
    h("div", { class: "nav-rail-fab" }, [add]),
    item("online", "waving_hand", t("Online")),
    item("all", "all_inbox", t("All")),
    item("pending", "notifications", t("Pending"), pending || null),
    item("blocked", "block", t("Blocked")),
  ]);

  const list = h("div", { class: "friends-list" });
  if (friendsTab === "all") list.append(peopleList(t("All"), lists.friends));
  else if (friendsTab === "pending") list.append(peopleList(t("Incoming"), lists.incoming), peopleList(t("Outgoing"), lists.outgoing));
  else if (friendsTab === "blocked") list.append(peopleList(t("Blocked"), lists.blocked));
  else list.append(peopleList(t("Online"), lists.online));

  return h("div", { class: "page-main friends-page" }, [rail, list]);
}

function peopleList(title, users) {
  const box = h("div", { class: "people" }, [h("div", { class: "list-subheader", text: `${title} – ${users.length}` })]);
  if (!users.length) box.append(h("div", { class: "list-item disabled", text: t("Nobody here right now!") }));
  for (const user of users) {
    const friend = (friendLists().friends || []).some((item) => item.id === user.id);
    const name = friendLabel(user);
    const row = h("button", { class: "list-item friend", type: "button" }, [
      avatar({ url: user.avatar, name, size: 36, presence: friend ? user.presence || "Online" : null }),
      h("span", { class: "list-item-text", text: name }),
    ]);
    row.onclick = () => openProfileModal(user.id, null);
    row.oncontextmenu = (event) => openUserMenu(event, { id: user.id, name, username: user.username, relationship: relationshipOf(user.id) }, null);
    box.append(row);
  }
  return box;
}

/** «Добавить друга» (AddFriend.tsx). */
function addFriendModal() {
  const username = textInput({ placeholder: t("username#1234") });
  let box = null;
  const send = async () => {
    const button = box.querySelector(".modal-actions .button.filled");
    button.disabled = true;
    try {
      await call("send_friend_request", { username: username.value.trim() });
      closeModal();
      scheduleWorkspaceRefresh();
    } catch (error) {
      toast(describe(error), "error");
      button.disabled = !username.value.trim();
    }
  };
  box = openModal({
    title: t("Add a new friend"),
    body: h("form", { class: "form-stack", onsubmit: (event) => (event.preventDefault(), username.value.trim() && send()) }, [
      labelled(t("Username"), username),
    ]),
    actions: [
      { label: t("Close"), onclick: closeModal },
      { label: t("Send Request"), primary: true, disabled: true, onclick: send },
    ],
  });
  username.addEventListener("input", () => {
    box.querySelector(".modal-actions .button.filled").disabled = !username.value.trim();
  });
  username.focus();
}

// ─────────────────────────── «Обзор» (Discover.tsx) ───────────────────────────

// последний раздел «Обзора»; читается при первом открытии (app.js грузится позже)
let discoverPath = null;

function discoverFrame() {
  const frame = h("iframe", { class: "discover-frame", title: "Discover" });
  frame.src = `${DISCOVER_ORIGIN}${discoverPath}?embedded=true`;
  return frame;
}

/** Сообщения встроенного stt.gg: тема, путь и переход по приглашению или боту. */
window.addEventListener("message", (message) => {
  if (message.origin !== DISCOVER_ORIGIN) return;
  const frame = document.querySelector(".discover-frame");
  if (!frame || message.source !== frame.contentWindow) return;
  let data;
  try {
    data = JSON.parse(message.data);
  } catch {
    return;
  }
  if (data.source !== "discover") return;
  if (data.type === "init") {
    frame.contentWindow.postMessage(JSON.stringify({ source: "revolt", type: "theme", theme: {} }), "*");
  } else if (data.type === "path") {
    const path = String(data.path || "").replace(/\?$/, "");
    if (path.startsWith("/discover")) {
      discoverPath = path;
      writeSetting("discoverPath", path);
    }
  } else if (data.type === "navigate") {
    let url;
    try {
      url = new URL(data.url);
    } catch {
      return;
    }
    const invite = /\/invite\/(\w+)/.exec(url.pathname);
    const bot = /\/bot\/(\w+)/.exec(url.pathname);
    if (invite) openInviteModal(invite[1]);
    else if (bot) addBotModal(bot[1]).catch((error) => toast(describe(error), "error"));
  }
});

// ─────────────────────────── создание групп и серверов ───────────────────────────

/** «Создать группу или сервер» (CreateGroupOrServer.tsx). */
function createGroupOrServerModal() {
  openModal({
    title: t("Create a group or server"),
    body: h("div", { text: t("Would you like to create a new group or server?") }),
    actions: [
      { label: t("Group"), onclick: () => createGroupModal() },
      { label: t("Server"), onclick: () => createServerModal() },
    ],
  });
}

/** «Создать или вступить» (CreateOrJoinServer.tsx). */
function addServerModal() {
  openModal({
    title: t("Create or join a server"),
    body: h("div", { text: t("Would you like to create a new server or join an existing one?") }),
    actions: [
      { label: t("Create"), onclick: () => createServerModal() },
      { label: t("Join"), onclick: () => joinServerModal() },
    ],
  });
}

/** Окно с одним полем и кнопкой, которая доступна, пока поле не пустое. */
function inputModal({ title, intro = null, control, submitLabel, run }) {
  let box = null;
  const submit = async () => {
    const button = box.querySelector(".modal-actions .button.filled");
    if (button.disabled) return;
    button.disabled = true;
    try {
      await run();
    } catch (error) {
      toast(describe(error), "error");
      button.disabled = false;
    }
  };
  const input = control.querySelector("input") || control;
  box = openModal({
    title,
    body: h("form", { class: "form-stack", onsubmit: (event) => (event.preventDefault(), submit()) }, [intro, control]),
    actions: [
      { label: t("Close"), onclick: closeModal },
      { label: submitLabel, primary: true, disabled: true, onclick: submit },
    ],
  });
  input.addEventListener("input", () => {
    box.querySelector(".modal-actions .button.filled").disabled = !input.value.trim();
  });
  input.focus();
  return box;
}

/** «Создать сервер» (CreateServer.tsx). */
function createServerModal() {
  const name = textInput({ maxlength: 32 });
  inputModal({
    title: t("Create server"),
    intro: h(
      "p",
      { class: "modal-text" },
      I18N.rich("By creating this server, you agree to the <0>Community Guidelines</0>.", null, {
        0: (text) => {
          const link = h("a", { href: "https://stoat.chat/legal/community-guidelines", text });
          link.onclick = (event) => {
            event.preventDefault();
            openExternal(link.href);
          };
          return link;
        },
      }),
    ),
    control: labelled(t("Server Name"), name),
    submitLabel: t("Create"),
    run: async () => {
      const id = await call("create_server", { name: name.value });
      closeModal();
      await refreshWorkspace();
      if (serverById(id)) selectServer(id);
    },
  });
}

/** Код из ссылки-приглашения или сам код (RE_INVITE_URL). */
function inviteCodeOf(text) {
  const match = /(?:invite|stt\.gg|rvlt\.gg)\/([a-z0-9]+)/i.exec(text);
  return match ? match[1] : text.trim();
}

/** «Вступить на сервер» (JoinServer.tsx). */
function joinServerModal() {
  const code = textInput({ placeholder: "stt.gg/wVEJDGVs" });
  inputModal({
    title: t("Join a server"),
    intro: h("p", { class: "modal-text", text: t("Use a code or invite link") }),
    control: labelled(t("Code"), code),
    submitLabel: t("Join"),
    run: async () => {
      const id = await call("join_invite", { code: inviteCodeOf(code.value) });
      closeModal();
      await refreshWorkspace();
      if (serverById(id)) selectServer(id);
      else {
        const found = findChannel(id);
        if (found) openChannel(found.channel);
      }
    },
  });
}

/**
 * Выбор друзей (Form2.VirtualSelect с multiple): поиск по имени и список с
 * флажками. `exclude` — кого уже нет смысла предлагать.
 */
function friendPicker(exclude = []) {
  const filter = h("input", { class: "text-field filled", type: "text", placeholder: t("Search for users..."), autocomplete: "off" });
  const chosen = new Set();
  const list = h("div", { class: "member-select" });
  const listeners = [];
  const draw = () => {
    const query = filter.value.toLowerCase();
    const friends = friendLists().friends.filter(
      (user) => !exclude.includes(user.id) && friendLabel(user).toLowerCase().includes(query),
    );
    list.replaceChildren(
      ...friends.map((user) => {
        const mark = checkboxMark(chosen.has(user.id));
        const row = h("button", { class: "member-select-row", type: "button" }, [
          mark,
          avatar({ url: user.avatar, name: friendLabel(user), size: 24 }),
          h("span", { text: friendLabel(user) }),
        ]);
        row.onclick = () => {
          if (chosen.has(user.id)) chosen.delete(user.id);
          else chosen.add(user.id);
          setCheckboxMark(mark, chosen.has(user.id));
          for (const listener of listeners) listener();
        };
        return row;
      }),
    );
  };
  filter.addEventListener("keyup", draw);
  draw();
  return { filter, list, chosen, onChange: (listener) => listeners.push(listener) };
}

/** «Создать группу» (CreateGroup.tsx): название и друзья, которых добавить. */
function createGroupModal() {
  const name = textInput({ maxlength: 32 });
  const picker = friendPicker();
  let box = null;

  const create = async () => {
    const button = box.querySelector(".modal-actions .button.filled");
    button.disabled = true;
    try {
      const id = await call("create_group", { name: name.value.trim(), users: [...picker.chosen] });
      closeModal();
      await refreshWorkspace();
      const found = findChannel(id);
      if (found) openChannel(found.channel);
    } catch (error) {
      toast(describe(error), "error");
      button.disabled = false;
    }
  };

  box = openModal({
    title: t("Create a new group"),
    body: h("form", { class: "form-stack create-group", onsubmit: (event) => (event.preventDefault(), name.value.trim() && create()) }, [
      labelled(t("Group Name"), name),
      h("span", { class: "field-label", text: t("Select members to add") }),
      picker.filter,
      picker.list,
    ]),
    actions: [
      { label: t("Close"), onclick: closeModal },
      { label: t("Create"), primary: true, disabled: true, onclick: create },
    ],
  });
  name.addEventListener("input", () => {
    box.querySelector(".modal-actions .button.filled").disabled = !name.value.trim();
  });
  name.focus();
}

/** «Добавить друзей в группу» (AddMembersToGroup.tsx). */
function addMembersToGroupModal(group) {
  const picker = friendPicker(group.recipients || []);
  let box = null;
  const add = async () => {
    const button = box.querySelector(".modal-actions .button.filled");
    button.disabled = true;
    try {
      await call("add_group_members", { groupId: group.id, users: [...picker.chosen] });
      closeModal();
      scheduleWorkspaceRefresh();
    } catch (error) {
      toast(describe(error), "error");
      button.disabled = !picker.chosen.size;
    }
  };
  box = openModal({
    title: t("Add friends to group"),
    body: h("form", { class: "form-stack create-group", onsubmit: (event) => event.preventDefault() }, [picker.filter, picker.list]),
    actions: [
      { label: t("Close"), onclick: closeModal },
      { label: t("Add"), primary: true, disabled: true, onclick: add },
    ],
  });
  picker.onChange(() => {
    box.querySelector(".modal-actions .button.filled").disabled = !picker.chosen.size;
  });
  picker.filter.focus();
}
