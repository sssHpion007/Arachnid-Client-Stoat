// Профили, статус и меню своего аватара.
//
// Повторяет браузерный клиент Stoat:
//  • UserMenu.tsx — меню по клику на свой аватар (присутствие, текст статуса);
//  • CustomStatus.tsx — окно «Задать статус»;
//  • UserCard.tsx — карточка по клику на имя или аватар;
//  • UserProfile.tsx — полный профиль.
//
// Файл подключается до app.js и пользуется его помощниками (state, h, call…)
// только во время вызова, поэтому порядок загрузки не важен.

"use strict";

/** Варианты присутствия в том порядке, в каком их показывает оригинал. */
const PRESENCES = [
  { id: "Online", label: "В сети" },
  { id: "Idle", label: "Нет на месте" },
  { id: "Focus", label: "Фокус", hint: "Уведомления будут только об упоминаниях" },
  { id: "Busy", label: "Не беспокоить", hint: "Уведомлений не будет" },
  { id: "Invisible", label: "Невидимка" },
];

/** Значки профиля (битовая маска `badges` из API) — как в ProfileBadges.tsx. */
const BADGES = [
  { bit: 16, icon: "crown", title: "Основатель Stoat" },
  { bit: 1, icon: "edit_note", title: "Разработчик Stoat" },
  { bit: 4, icon: "favorite", title: "Поддержал Stoat пожертвованием" },
  { bit: 2, icon: "forum", title: "Помогал переводить Stoat" },
  { bit: 256, icon: "verified", title: "Один из первой тысячи пользователей" },
  { bit: 32, icon: "badge", title: "Модератор платформы" },
  { bit: 8, icon: "block", title: "Ответственно сообщил об уязвимости" },
  { bit: 128, icon: "pets", title: "🦊" },
];

const STATUS_LIMIT = 128;

// ─────────────────────────── окна ───────────────────────────

let modalClosed = null;

/** Модальное окно в стиле оригинала: заголовок, содержимое, кнопки. */
function openModal({ title, body, actions = [], wide = false, onClose = null }) {
  closeModal();
  const backdrop = el("modal");
  const box = h("div", { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true" });
  box.addEventListener("click", (event) => event.stopPropagation());
  if (title) box.append(h("h2", { class: "modal-title", text: title }));
  box.append(h("div", { class: "modal-body" }, [body]));
  if (actions.length) {
    box.append(
      h(
        "div",
        { class: "modal-actions" },
        actions.map((action) =>
          h("button", {
            type: "button",
            class: "button " + (action.primary ? "filled" : "text"),
            text: action.label,
            disabled: Boolean(action.disabled),
            onclick: action.onclick,
          }),
        ),
      ),
    );
  }
  backdrop.replaceChildren(box);
  backdrop.classList.remove("hidden");
  modalClosed = onClose;
  return box;
}

function closeModal() {
  const backdrop = el("modal");
  if (!backdrop || backdrop.classList.contains("hidden")) return;
  backdrop.classList.add("hidden");
  backdrop.textContent = "";
  if (modalClosed) {
    const done = modalClosed;
    modalClosed = null;
    done();
  }
}

function modalOpen() {
  const backdrop = el("modal");
  return Boolean(backdrop && !backdrop.classList.contains("hidden"));
}

// ─────────────────────────── меню своего аватара ───────────────────────────

function presenceDot(presence) {
  return h("span", { class: "presence-dot " + presence });
}

/** Меню по клику на свой аватар в рельсе (UserMenu.tsx). */
function toggleAccountMenu(event) {
  event.stopPropagation();
  const menu = el("account-menu");
  const wasOpen = !menu.classList.contains("hidden");
  closeMenus();
  if (wasOpen || !state.me) return;
  const me = state.me;
  const item = (icon, label, action, extra = {}) =>
    h(
      "button",
      {
        type: "button",
        class: "menu-item" + (extra.danger ? " danger" : "") + (extra.selected ? " selected" : ""),
        title: extra.hint || "",
        onclick: async () => {
          closeMenus();
          try {
            await action();
          } catch (error) {
            toast(describe(error), "error");
          }
        },
      },
      [typeof icon === "string" ? symbol(icon, 20) : icon, h("span", { class: "menu-item-label", text: label })],
    );

  // как в оригинале: шапка меню открывает настройки
  const card = h("button", { type: "button", class: "account-card", title: "Настройки" }, [
    avatar({ url: me.avatar, name: myName(), size: 32, presence: me.presence || "Online" }),
    h("span", { class: "account-text" }, [
      h("span", { class: "account-name", text: myName() }),
      h("span", { class: "account-id", text: `${me.username}#${me.discriminator}` }),
    ]),
  ]);
  card.onclick = () => openUserSettings();

  const children = [
    card,
    item("person", "Мой профиль", () => openProfileModal(me.id, null)),
    item("swap_horiz", "Сменить аккаунт", () => location.replace("login.html?switch")),
    h("div", { class: "menu-divider" }),
  ];
  for (const presence of PRESENCES) {
    children.push(
      item(presenceDot(presence.id), presence.label, () => setPresence(presence.id), {
        selected: (me.presence || "Online") === presence.id,
        hint: presence.hint,
      }),
    );
  }
  children.push(h("div", { class: "menu-divider" }));
  if (me.status) {
    children.push(item("edit", me.status, openStatusModal, { hint: "Изменить статус" }));
    children.push(item("cancel", "Очистить статус", () => saveStatusText(null)));
  } else {
    children.push(item("mood", "Добавить статус", openStatusModal));
  }
  children.push(h("div", { class: "menu-divider" }));
  children.push(item("fingerprint", "Копировать ID", () => copyText(me.id)));
  children.push(item("logout", "Выйти", logout, { danger: true }));

  menu.replaceChildren(...children);
  const rect = event.currentTarget.getBoundingClientRect();
  menu.classList.remove("hidden");
  const height = menu.getBoundingClientRect().height;
  menu.style.left = rect.right + 8 + "px";
  menu.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - height - 8)) + "px";
}

/** Свой профиль поменялся: перерисовать всё, где виден свой аватар. */
function applyOwnUser(view) {
  if (!view) return;
  state.me = Object.assign({}, state.me, view);
  if (state.workspace) state.workspace.me = state.me;
  renderRail();
  renderMembers();
}

async function setPresence(presence) {
  applyOwnUser(await call("set_presence", { presence }));
}

async function saveStatusText(text) {
  applyOwnUser(await call("set_status_text", { text }));
}

/** Окно «Задать статус» (CustomStatus.tsx). */
function openStatusModal() {
  const input = h("input", {
    class: "text-field",
    type: "text",
    maxlength: STATUS_LIMIT,
    placeholder: "Чем заняты?",
    value: (state.me && state.me.status) || "",
    autocomplete: "off",
  });
  const counter = h("span", { class: "field-counter" });
  const update = () => {
    counter.textContent = `${input.value.length}/${STATUS_LIMIT}`;
  };
  update();
  input.addEventListener("input", update);

  const save = async () => {
    try {
      await saveStatusText(input.value.trim() || null);
      closeModal();
    } catch (error) {
      toast(describe(error), "error");
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    }
  });

  openModal({
    title: "Задать статус",
    body: h("label", { class: "field" }, [h("span", { class: "field-label", text: "Текст статуса" }), input, counter]),
    actions: [
      { label: "Закрыть", onclick: closeModal },
      { label: "Сохранить", primary: true, onclick: save },
    ],
  });
  input.focus();
  input.select();
}

// ─────────────────────────── карточка профиля ───────────────────────────

let cardToken = 0;

function closeUserCard() {
  const card = el("user-card");
  if (!card || card.classList.contains("hidden")) return;
  card.classList.add("hidden");
  card.textContent = "";
  cardToken++;
}

/** Встать рядом с элементом, не вылезая за край окна. */
function placeFloating(node, anchor) {
  const rect = anchor.getBoundingClientRect();
  const box = node.getBoundingClientRect();
  let x = rect.right + 8;
  if (x + box.width > window.innerWidth - 8) x = rect.left - box.width - 8;
  if (x < 8) x = Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8));
  const y = Math.max(8, Math.min(rect.top, window.innerHeight - box.height - 8));
  node.style.left = x + "px";
  node.style.top = y + "px";
}

/** Карточка по клику на имя или аватар (UserCard.tsx). */
async function openUserCard(event, userId, serverId = state.serverId) {
  event.preventDefault();
  event.stopPropagation();
  if (!userId) return;
  const anchor = event.currentTarget instanceof Element ? event.currentTarget : event.target;
  const card = el("user-card");
  const wasSame = !card.classList.contains("hidden") && card.dataset.user === userId;
  closeMenus();
  if (wasSame) return;

  const token = ++cardToken;
  card.dataset.user = userId;
  card.replaceChildren(h("div", { class: "profile-loading", text: "Загрузка профиля…" }));
  card.classList.remove("hidden");
  placeFloating(card, anchor);

  let profile;
  try {
    profile = await call("user_profile", { userId, serverId: serverId || null });
  } catch (error) {
    if (token !== cardToken) return;
    card.replaceChildren(h("div", { class: "profile-loading", text: "Профиль недоступен: " + describe(error) }));
    return;
  }
  if (token !== cardToken) return;

  const open = () => {
    closeUserCard();
    openProfileModal(userId, serverId);
  };
  const cards = [
    bannerCard(profile, { onclick: open }),
    actionsCard(profile, serverId),
    rolesCard(profile),
    badgesCard(profile),
    statusCard(profile),
    joinedCard(profile),
    ownerCard(profile),
    bioCard(profile, { onclick: open, clamp: true }),
  ].filter(Boolean);
  card.replaceChildren(h("div", { class: "profile-grid" }, cards));
  placeFloating(card, anchor);
}

// ─────────────────────────── полный профиль ───────────────────────────

/** Полный профиль (UserProfile.tsx): то же, что в карточке, и общие связи. */
async function openProfileModal(userId, serverId = state.serverId) {
  closeMenus();
  const body = h("div", { class: "profile-grid wide" }, [
    h("div", { class: "profile-loading", text: "Загрузка профиля…" }),
  ]);
  openModal({ body, wide: true });

  let profile;
  try {
    profile = await call("user_profile", { userId, serverId: serverId || null });
  } catch (error) {
    body.replaceChildren(h("div", { class: "profile-loading", text: "Профиль недоступен: " + describe(error) }));
    return;
  }
  const mutualSlot = profile.is_me || profile.bot ? null : h("div", { class: "profile-card w3 hidden" });
  body.replaceChildren(
    ...[
      bannerCard(profile, { wide: true }),
      actionsCard(profile, serverId),
      statusCard(profile),
      badgesCard(profile),
      joinedCard(profile),
      rolesCard(profile),
      ownerCard(profile),
      bioCard(profile, {}),
      mutualSlot,
    ].filter(Boolean),
  );

  if (mutualSlot) {
    try {
      const mutual = await call("user_mutual", { userId });
      fillMutual(mutualSlot, mutual);
    } catch (error) {
      console.warn("общие связи не получены:", error);
    }
  }
}

function fillMutual(slot, mutual) {
  const servers = mutual.servers || [];
  const friends = mutual.friends || [];
  if (!servers.length && !friends.length) return;
  const row = (picture, name, onclick) => {
    const button = h("button", { type: "button", class: "mutual-item", title: name }, [
      picture,
      h("span", { class: "mutual-name", text: name }),
    ]);
    button.onclick = onclick;
    return button;
  };
  const parts = [h("span", { class: "profile-card-title", text: "Общее" })];
  if (servers.length) {
    parts.push(h("span", { class: "profile-subtitle", text: `Серверы – ${servers.length}` }));
    parts.push(
      h(
        "div",
        { class: "mutual-list" },
        servers.map((server) =>
          row(avatar({ url: server.icon, name: server.name, size: 32 }), server.name, () => {
            closeModal();
            selectServer(server.id);
          }),
        ),
      ),
    );
  }
  if (friends.length) {
    parts.push(h("span", { class: "profile-subtitle", text: `Друзья – ${friends.length}` }));
    parts.push(
      h(
        "div",
        { class: "mutual-list" },
        friends.map((friend) =>
          row(
            avatar({ url: friend.avatar, name: friend.display_name || friend.username, size: 32, presence: friend.presence }),
            friend.display_name || friend.username,
            () => openProfileModal(friend.id, null),
          ),
        ),
      ),
    );
  }
  slot.replaceChildren(...parts);
  slot.classList.remove("hidden");
}

// ─────────────────────────── части профиля ───────────────────────────

function profileCard(title, children, extra = "") {
  return h("div", { class: "profile-card " + extra }, [
    title ? h("span", { class: "profile-card-title", text: title }) : null,
    ...children,
  ]);
}

function longDate(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

/** Шапка с фоном, аватаром и именем (ProfileBanner.tsx). */
function bannerCard(profile, { onclick = null, wide = false } = {}) {
  const banner = h("div", { class: "profile-banner w2" + (wide ? " w3" : "") + (onclick ? " clickable" : "") });
  if (profile.background) {
    mediaUrl(profile.background).then((data) => {
      if (data) {
        banner.style.backgroundImage = `linear-gradient(rgba(0,0,0,.2), rgba(0,0,0,.7)), url("${data}")`;
      }
    });
  }
  if (onclick) banner.onclick = onclick;

  const tag = `${profile.username}#${profile.discriminator}`;
  const username = h("button", { type: "button", class: "profile-username", text: tag, title: "Копировать" });
  username.onclick = async (event) => {
    event.stopPropagation();
    await copyText(tag);
    username.textContent = "Скопировано!";
    setTimeout(() => (username.textContent = tag), 1200);
  };

  const shownName = profile.name !== profile.username ? profile.name : null;
  banner.append(
    h("div", { class: "profile-banner-row" }, [
      avatar({ url: profile.avatar, name: profile.name, size: 48, presence: profile.presence }),
      h("div", { class: "profile-names" }, [
        shownName ? h("span", { class: "profile-display-name", text: shownName }) : null,
        username,
        profile.pronouns ? h("span", { class: "profile-pronouns", text: profile.pronouns }) : null,
      ]),
    ]),
  );
  return banner;
}

/** Кнопки по отношению к пользователю (ProfileActions.tsx). */
function actionsCard(profile, serverId) {
  const buttons = [];
  const action = (icon, label, run, kind = "tonal") => {
    const button = h("button", { type: "button", class: "button " + kind, title: label }, [
      symbol(icon, 20),
      h("span", { text: label }),
    ]);
    button.onclick = async (event) => {
      event.stopPropagation();
      button.disabled = true;
      try {
        await run();
      } catch (error) {
        toast(describe(error), "error");
      } finally {
        button.disabled = false;
      }
    };
    return button;
  };
  const relate = (kind) => async () => {
    const relationship = await call("set_relationship", { userId: profile.id, action: kind });
    profile.relationship = relationship;
    toast(relationshipToast(kind, relationship));
    closeUserCard();
  };

  if (!profile.is_me) {
    switch (profile.relationship) {
      case "Friend":
        buttons.push(action("chat", "Написать", () => openDirectMessage(profile.id), "filled"));
        break;
      case "Incoming":
        buttons.push(action("how_to_reg", "Принять запрос", relate("add"), "filled"));
        buttons.push(action("close", "Отклонить", relate("remove")));
        break;
      case "Outgoing":
        buttons.push(action("cancel", "Отменить запрос", relate("remove")));
        break;
      case "Blocked":
        buttons.push(action("block", "Разблокировать", relate("unblock")));
        break;
      case "BlockedOther":
        break;
      default:
        if (!profile.bot) buttons.push(action("person_add", "Добавить в друзья", relate("add"), "filled"));
        else buttons.push(action("chat", "Написать", () => openDirectMessage(profile.id), "filled"));
        break;
    }
  }

  const more = h("button", { type: "button", class: "icon-button", title: "Ещё" }, [symbol("more_vert", 20)]);
  more.onclick = (event) => openUserMenu(event, { id: profile.id, name: profile.name, username: profile.username, relationship: profile.relationship }, serverId);

  return h("div", { class: "profile-actions w2" }, [...buttons, h("span", { class: "spacer" }), more]);
}

function relationshipToast(kind, relationship) {
  if (kind === "block") return "Пользователь заблокирован";
  if (kind === "unblock") return "Пользователь разблокирован";
  if (relationship === "Friend") return "Теперь вы друзья";
  if (relationship === "Outgoing") return "Запрос дружбы отправлен";
  return "Готово";
}

function statusCard(profile) {
  if (!profile.status) return null;
  return profileCard("Статус", [h("span", { class: "profile-status", text: profile.status })]);
}

function badgesCard(profile) {
  const list = BADGES.filter((badge) => profile.badges & badge.bit);
  if (!list.length) return null;
  return profileCard("Значки", [
    h(
      "div",
      { class: "profile-badges" },
      list.map((badge) => h("span", { class: "profile-badge", title: badge.title }, [symbol(badge.icon, 24)])),
    ),
  ]);
}

function joinedCard(profile) {
  const rows = [];
  if (profile.created_at) {
    rows.push(
      h("div", { class: "profile-joined" }, [
        symbol("cake", 20),
        h("span", { text: "Stoat" }),
        h("span", { class: "profile-muted", text: longDate(profile.created_at) }),
      ]),
    );
  }
  if (profile.member && profile.member.joined_at) {
    rows.push(
      h("div", { class: "profile-joined" }, [
        symbol("calendar_month", 20),
        h("span", { text: profile.member.server_name }),
        h("span", { class: "profile-muted", text: longDate(profile.member.joined_at) }),
      ]),
    );
  }
  if (!rows.length) return null;
  return profileCard("Присоединился", rows);
}

function rolesCard(profile) {
  const roles = (profile.member && profile.member.roles) || [];
  if (!roles.length && !(profile.member && profile.member.owner)) return null;
  const chips = roles.map((role) =>
    h("span", { class: "profile-role" }, [
      h("span", { class: "role-dot", style: role.colour ? { background: role.colour } : null }),
      h("span", { text: role.name }),
    ]),
  );
  if (profile.member.owner) {
    chips.unshift(h("span", { class: "profile-role" }, [symbol("crown", 16), h("span", { text: "Владелец" })]));
  }
  return profileCard("Роли", [h("div", { class: "profile-roles" }, chips)]);
}

function ownerCard(profile) {
  if (!profile.bot) return null;
  const owner = profile.bot_owner;
  const children = [
    h("div", { class: "profile-joined" }, [symbol("smart_toy", 20), h("span", { text: "Бот" })]),
  ];
  if (owner) {
    const row = h("button", { type: "button", class: "mutual-item" }, [
      avatar({ url: owner.avatar, name: owner.display_name || owner.username, size: 24 }),
      h("span", { class: "mutual-name", text: owner.display_name || owner.username }),
    ]);
    row.onclick = (event) => openUserCard(event, owner.id, null);
    children.push(row);
  }
  return profileCard("Владелец", children);
}

function bioCard(profile, { onclick = null, clamp = false }) {
  if (!profile.bio) return null;
  const text = h("div", { class: "profile-bio" + (clamp ? " clamp" : "") });
  text.append(segmentsNode({ segments: profile.bio_segments, content: profile.bio, emoji: profile.bio_emoji }));
  const card = profileCard("Обо мне", [text], "w2" + (onclick ? " clickable" : ""));
  if (onclick) {
    card.onclick = (event) => {
      if (event.target.closest("a, button, .md-spoiler")) return;
      onclick();
    };
  }
  return card;
}

// ─────────────────────────── действия ───────────────────────────

/** Открыть (или создать) личную переписку и перейти в неё. */
async function openDirectMessage(userId) {
  closeUserCard();
  closeModal();
  const channelId = await call("open_dm", { userId });
  let found = findChannel(channelId);
  if (!found) {
    await refreshWorkspace();
    found = findChannel(channelId);
  }
  if (!found) {
    toast("Переписка создана, но ещё не появилась в списке", "error");
    return;
  }
  state.serverId = null;
  renderRail();
  renderSidebar();
  await openChannel(found.channel);
}
