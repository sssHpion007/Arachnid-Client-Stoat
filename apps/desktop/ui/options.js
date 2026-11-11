// Настройки клиента (хранилища Settings, Sounds и Voice браузерного клиента
// Stoat): флажки «appearance:*», «advanced:*», «notifications:*», звуки и
// голос. Хранятся в localStorage; при изменении рассылается событие
// «arachnid-options», и интерфейс обновляет то, что от них зависит.

"use strict";

// ─────────────────────────── флажки (Settings.ts) ───────────────────────────

const OPTIONS_KEY = "stoat.ui.settings";

/** Значения по умолчанию (DEFAULT_VALUES). */
const OPTION_DEFAULTS = {
  // в приложении для ПК уведомления разрешены сразу, без запроса браузера
  "notifications:desktop": "allowed",
  "appearance:unicode_emoji": "fluent-3d",
  "appearance:show_send_button": true,
  "appearance:compact_mode": false,
  "advanced:copy_id": false,
  "advanced:admin_panel": false,
};

/** Наборы эмодзи (UNICODE_EMOJI_PACKS) и их названия. */
const UNICODE_EMOJI_PACKS = {
  "fluent-3d": "Fluent 3D",
  "fluent-color": "Fluent Color",
  "fluent-flat": "Fluent Flat",
  mutant: "Mutant Remix",
  noto: "Noto",
  twemoji: "Twemoji",
};

function readOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

let optionValues = readOptions();

/** Значение настройки клиента или значение по умолчанию. */
function getOption(key) {
  const value = optionValues[key];
  if (value === undefined || value === null) return OPTION_DEFAULTS[key];
  if (key === "appearance:unicode_emoji" && !(value in UNICODE_EMOJI_PACKS)) return OPTION_DEFAULTS[key];
  return value;
}

function setOption(key, value) {
  optionValues = Object.assign({}, optionValues, { [key]: value });
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(optionValues));
  } catch {
    /* хранилище недоступно — действует до перезапуска */
  }
  applyOptions();
  window.dispatchEvent(new CustomEvent("arachnid-options", { detail: { key } }));
}

/** Классы корня, от которых зависят стили (кнопка отправки, компактный режим). */
function applyOptions() {
  const root = document.documentElement;
  root.classList.toggle("no-send-button", !getOption("appearance:show_send_button"));
  root.classList.toggle("compact-mode", Boolean(getOption("appearance:compact_mode")));
}

applyOptions();

// ─────────────────────────── звуки (Sounds.ts) ───────────────────────────

const SOUNDS_KEY = "stoat.ui.sounds";

/** Звук → файл в ui/sounds. */
const SOUND_FILES = {
  deafen: "deafen",
  message: "message_sound",
  mute: "mute",
  ringtoneIncoming: "ringtone_incoming",
  ringtoneOutgoing: "ringtone_outgoing",
  streamEnd: "stream_end",
  streamStart: "stream_start",
  streamViewerJoin: "stream_viewer_join",
  streamViewerLeave: "stream_viewer_leave",
  undeafen: "undeafen",
  unmute: "unmute",
  userJoinVoice: "user_join_voice",
  userLeaveVoice: "user_leave_voice",
  userMoved: "user_moved",
};

function readSounds() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SOUNDS_KEY) || "{}") || {};
  } catch {
    saved = {};
  }
  const result = {};
  for (const name of Object.keys(SOUND_FILES)) result[name] = typeof saved[name] === "boolean" ? saved[name] : true;
  return result;
}

let soundValues = readSounds();
let soundNode = null;

function soundEnabled(name) {
  return Boolean(soundValues[name]);
}

function toggleSound(name) {
  soundValues = Object.assign({}, soundValues, { [name]: !soundEnabled(name) });
  try {
    localStorage.setItem(SOUNDS_KEY, JSON.stringify(soundValues));
  } catch {
    /* хранилище недоступно */
  }
  return soundValues[name];
}

/** Проиграть звук (SoundController.playSound); `force` — даже выключенный. */
function playSound(name, force = false) {
  if (!SOUND_FILES[name] || (!force && !soundEnabled(name))) return false;
  soundNode = new Audio(`sounds/${SOUND_FILES[name]}.ogg`);
  soundNode.play().catch(() => {});
  return true;
}

// ─────────────────────────── голос (Voice.ts) ───────────────────────────

const VOICE_KEY = "stoat.ui.voice";

const VOICE_DEFAULTS = {
  preferredAudioInputDevice: undefined,
  preferredAudioOutputDevice: undefined,
  preferredVideoDevice: undefined,
  echoCancellation: true,
  noiseSupression: "enhanced",
  autoGainControl: true,
  screenShareQuality: "low",
  screenShareQualityAsk: true,
  inputVolume: 1.0,
  outputVolume: 1.0,
};

const NOISE_SUPPRESSION_STATES = ["disabled", "browser", "enhanced"];

/** Прочитать и привести к допустимым значениям (Voice.clean()). */
function readVoice() {
  let input = {};
  try {
    input = JSON.parse(localStorage.getItem(VOICE_KEY) || "{}") || {};
  } catch {
    input = {};
  }
  const data = Object.assign({}, VOICE_DEFAULTS);
  for (const key of ["preferredAudioInputDevice", "preferredAudioOutputDevice", "preferredVideoDevice"]) {
    if (typeof input[key] === "string") data[key] = input[key];
  }
  for (const key of ["echoCancellation", "autoGainControl", "screenShareQualityAsk"]) {
    if (typeof input[key] === "boolean") data[key] = input[key];
  }
  if (input.noiseSupression === "true") data.noiseSupression = "enhanced";
  else if (input.noiseSupression === "false") data.noiseSupression = "disabled";
  else if (NOISE_SUPPRESSION_STATES.includes(input.noiseSupression)) data.noiseSupression = input.noiseSupression;
  if (["low", "high"].includes(input.screenShareQuality)) data.screenShareQuality = input.screenShareQuality;
  for (const key of ["inputVolume", "outputVolume"]) {
    if (typeof input[key] === "number" && input[key] >= 0 && input[key] <= 3) data[key] = input[key];
  }
  return data;
}

let voiceValues = readVoice();

function getVoice() {
  return Object.assign({}, voiceValues);
}

function setVoice(patch) {
  voiceValues = Object.assign({}, voiceValues, patch);
  try {
    localStorage.setItem(VOICE_KEY, JSON.stringify(voiceValues));
  } catch {
    /* хранилище недоступно */
  }
}

// ─────────────────────────── уведомления (NotificationsWorker) ───────────────────────────

/** Показывать ли уведомление о новом сообщении и с каким заголовком. */
function notificationFor(message, channel, server, me) {
  if (!me || message.author_id === me.id) return null;
  // смотрим этот канал прямо сейчас
  if (state.channelId === message.channel && document.hasFocus()) return null;
  if (getOption("notifications:desktop") !== "allowed") return null;
  if (channel.kind === "notes") return null;
  const mentioned = (message.mentions || []).includes(me.id);
  // на серверах по умолчанию — только упоминания, в личках и группах — всё
  if (server && !mentioned) return null;
  const presence = me.presence;
  if (presence === "Busy" || (presence === "Focus" && !mentioned)) return null;

  const author = message.author || "";
  let title;
  if (!server && channel.kind === "group") {
    title = message.author_id === "00000000000000000000000000" ? channel.name : `@${author} - ${channel.name}`;
  } else if (!server) {
    title = "@" + author;
  } else {
    title = `@${author} (#${channel.name}, ${server.name})`;
  }

  let body = message.content || "";
  if (message.system_event) body = systemEventText(message.system_event, { plain: true, server: Boolean(server) });
  else if (!body && message.attachments && message.attachments.length) {
    body = t("Sent {0} attachments", [message.attachments.length]);
  }
  return { title, body };
}

/** Уведомление и звук о новом сообщении. */
function notifyIncoming(message, channel, server) {
  const notice = notificationFor(message, channel, server, state.me);
  if (!notice) return;
  playSound("message");
  call("notify", { title: notice.title, body: notice.body }).catch((error) => console.warn("уведомление:", error));
}
