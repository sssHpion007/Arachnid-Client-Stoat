// Настройки клиента: «Голос и видео», «Внешний вид», «Уведомления»,
// «Язык», «ПК», «Расширенные» и окно «Что нового» (VoiceSettings.tsx,
// AppearanceMenu.tsx, Notifications.tsx, Sounds.tsx, Language.tsx,
// Native.tsx, Advanced.tsx, Changelog.tsx браузерного клиента Stoat).
//
// Подключается после settings.js и пользуется его помощниками.

"use strict";

// ─────────────────────────── ползунок (Slider) ───────────────────────────

/** Ползунок Material 3 с подписью значения. */
function sliderControl({ min, max, step = 1, value, format = (v) => String(v), oninput }) {
  const input = h("input", { type: "range", class: "slider", min, max, step, value });
  const label = h("span", { class: "slider-value", text: format(Number(value)) });
  const paint = () => {
    const ratio = (Number(input.value) - min) / (max - min);
    input.style.setProperty("--slider-fill", ratio * 100 + "%");
  };
  input.addEventListener("input", () => {
    label.textContent = format(Number(input.value));
    paint();
    oninput(Number(input.value));
  });
  paint();
  return h("div", { class: "slider-row" }, [input, label]);
}

const percent = (value) => (value * 100).toFixed(0) + "%";

// ─────────────────────────── голос и видео ───────────────────────────

/** Устройства одного вида; «По умолчанию» всегда первым (useMediaDeviceSelect). */
async function mediaDevices(kind) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === kind);
  } catch {
    return [];
  }
}

async function deviceSelect(kind) {
  const key = { audioinput: "preferredAudioInputDevice", audiooutput: "preferredAudioOutputDevice", videoinput: "preferredVideoDevice" }[kind];
  const icon = { audioinput: "mic", audiooutput: "speaker", videoinput: "videocam" }[kind];
  const title = { audioinput: t("Select audio input"), audiooutput: t("Select audio output"), videoinput: t("Select video input") }[kind];
  const devices = await mediaDevices(kind);
  const fallback = devices.find((device) => device.deviceId === "default");
  const options = [{ id: "default", title: (fallback && fallback.label) || t("Default") }];
  for (const device of devices) {
    if (device.deviceId !== "default" && device.deviceId) options.push({ id: device.deviceId, title: device.label || device.deviceId });
  }
  return categorySelect({
    icon,
    title,
    options,
    value: getVoice()[key] || "default",
    onUpdate: (id) => setVoice({ [key]: id === "default" ? undefined : id }),
  });
}

async function renderVoicePage(column, alive) {
  const info = await instanceInfo().catch(() => null);
  const video = Boolean(info && info.video);
  const selects = await Promise.all(["audioinput", "audiooutput", ...(video ? ["videoinput"] : [])].map(deviceSelect));
  if (!alive()) return;
  const voice = getVoice();

  put(column,
    h("div", { class: "form-stack" }, [
      categoryGroup(selects),
      h("span", { class: "field-label", text: t("Input Volume") }),
      sliderControl({ min: 0, max: 3, step: 0.1, value: voice.inputVolume, format: percent, oninput: (inputVolume) => setVoice({ inputVolume }) }),
      h("span", { class: "field-label", text: t("Output Volume") }),
      sliderControl({ min: 0, max: 3, step: 0.1, value: voice.outputVolume, format: percent, oninput: (outputVolume) => setVoice({ outputVolume }) }),
    ]),
    h("div", { class: "form-stack" }, [
      h("h2", { class: "settings-heading small", text: t("Voice Processing") }),
      categoryGroup([
        categorySelect({
          icon: "blank",
          title: t("Select noise suppression"),
          options: [
            { id: "disabled", title: t("Disabled") },
            { id: "browser", title: t("Browser") },
            { id: "enhanced", title: t("Enhanced"), description: t("Powered by RNNoise"), shortDesc: t("Enhanced (RNNoise)") },
          ],
          value: voice.noiseSupression,
          onUpdate: (noiseSupression) => setVoice({ noiseSupression }),
        }),
        categoryCheckbox({
          icon: "blank",
          title: t("Browser Echo Cancellation"),
          get: () => getVoice().echoCancellation,
          set: (echoCancellation) => setVoice({ echoCancellation }),
        }),
        categoryCheckbox({
          icon: "blank",
          title: t("Automatic Gain Control"),
          get: () => getVoice().autoGainControl,
          set: (autoGainControl) => setVoice({ autoGainControl }),
        }),
      ]),
    ]),
    video
      ? h("div", { class: "form-stack" }, [
          h("h2", { class: "settings-heading small", text: t("Screen Share Settings") }),
          categoryGroup([
            categorySelect({
              icon: "screen_share",
              title: t("Select screen share quality"),
              options: screenShareQualities(info).map((quality) => ({ id: quality.name, title: quality.fullName })),
              value: voice.screenShareQuality,
              onUpdate: (screenShareQuality) => setVoice({ screenShareQuality }),
            }),
            categoryCheckbox({
              icon: "blank",
              title: t("Always Ask for Screen Share Quality"),
              get: () => getVoice().screenShareQualityAsk,
              set: (screenShareQualityAsk) => setVoice({ screenShareQualityAsk }),
            }),
          ]),
        ])
      : null,
  );
}

/** Качество демонстрации экрана (getEnabledScreenShareQualities): 1080p — если позволяет инстанс. */
function screenShareQualities(info) {
  const list = [{ name: "low", fullName: "720p 30FPS" }];
  const limit = (info && info.video_resolution) || [0, 0];
  if ((limit[0] === 0 || limit[0] >= 1920) && (limit[1] === 0 || limit[1] >= 1080)) list.push({ name: "high", fullName: "1080p 30FPS" });
  return list;
}

// ─────────────────────────── внешний вид ───────────────────────────

const ACCENT_COLOURS = ["#FF5733", "#ffdc2f", "#9bf088", "#54ecc1", "#549bec", "#5470ec", "#8C5FD3"];

/** Строка кнопок-сегментов (Button group="connected-*"). */
function connectedButtons(options, current, onchoose, small = false) {
  const row = choiceRow(options, current, onchoose);
  row.classList.add("connected");
  if (small) row.classList.add("small");
  return row;
}

/** Сообщение-образец для предпросмотра (MessageContainer). */
function previewMessage({ avatarNode, name, pronouns = null, content }) {
  const now = new Date();
  return h("div", { class: "message head preview" }, [
    h("div", { class: "message-row" }, [
      h("div", { class: "message-info" }, [avatarNode]),
      h("div", { class: "message-content" }, [
        h("div", { class: "message-head" }, [
          h("span", { class: "username", text: name }),
          pronouns ? h("span", { class: "pronouns", text: pronouns }) : null,
          h("time", { text: calendarText(now) }),
        ]),
        h("div", { class: "message-text" }, [content]),
      ]),
    ]),
  ]);
}

/** Образцы эмодзи набора (EmojiPack). */
function emojiPackPreview(pack) {
  const row = h("span", { class: "emoji-pack" });
  for (const emoji of ["😃", "😂", "😶‍🌫️", "🤨", "🤔"]) {
    const img = h("img", { class: "emoji", alt: emoji, draggable: "false" });
    unicodeEmojiUrl(emoji, pack).then((url) => url && (img.src = url));
    row.append(img);
  }
  row.append(h("span", { class: "emoji-pack-name", text: UNICODE_EMOJI_PACKS[pack] }));
  return row;
}

/** Выпадающий список с подписью (FloatingSelect). */
function floatingSelect({ label, options, value, onchange }) {
  const select = h("select", { class: "floating-select-input" });
  for (const option of options) {
    const item = h("option", { value: option.id, text: option.label });
    if (option.font) item.style.fontFamily = option.font;
    select.append(item);
  }
  select.value = value;
  select.onchange = () => onchange(select.value);
  return h("label", { class: "floating-select" }, [h("span", { class: "floating-select-label", text: label }), select, symbol("keyboard_arrow_down", 20)]);
}

/** Набор эмодзи: список с образцами (у select нет картинок). */
function emojiPackSelect() {
  const current = getOption("appearance:unicode_emoji");
  const head = h("button", { type: "button", class: "floating-select emoji-pack-select" }, [
    h("span", { class: "floating-select-label", text: t("Emoji Pack (affects your messages only)") }),
    emojiPackPreview(current),
    symbol("keyboard_arrow_down", 20),
  ]);
  head.onclick = (event) => {
    event.stopPropagation();
    const rect = head.getBoundingClientRect();
    openContextMenu(
      { clientX: rect.left, clientY: rect.bottom + 4, preventDefault() {}, stopPropagation() {} },
      Object.keys(UNICODE_EMOJI_PACKS).map((pack) => ({
        node: emojiPackPreview(pack),
        selected: pack === current,
        action: () => {
          setOption("appearance:unicode_emoji", pack);
          renderSettings();
        },
      })),
      null,
      { offset: 0 },
    );
  };
  return head;
}

function renderAppearancePage(column) {
  const theme = window.ArachnidTheme;
  const current = theme.get();
  const update = (patch) => theme.set(patch);

  const accents = h("div", { class: "accent-row" });
  const drawAccents = () => {
    const active = theme.get().accent.toLowerCase();
    accents.replaceChildren(
      ...ACCENT_COLOURS.map((colour) => {
        const button = h("button", { type: "button", class: "accent" + (active === colour.toLowerCase() ? " selected" : ""), title: colour });
        button.style.background = colour;
        button.onclick = () => {
          update({ accent: colour });
          drawAccents();
        };
        return button;
      }),
    );
  };
  // своя палитра: системный выбор цвета (MDPalette)
  const picker = h("input", { type: "color", class: "accent-picker-input", value: current.accent.length === 7 ? current.accent : "#5470ec" });
  picker.oninput = () => {
    update({ accent: picker.value });
    drawAccents();
  };
  const pickerButton = h("button", { type: "button", class: "icon-button filled square accent-picker", title: t("Custom colour") }, [symbol("palette", 24)]);
  pickerButton.onclick = () => picker.click();
  drawAccents();

  const me = state.me;
  const preview = h("div", { class: "appearance-preview" }, [
    h("div", { class: "appearance-preview-list" }, [
      previewMessage({
        avatarNode: avatar({ url: me && me.avatar, name: myName(), size: 36 }),
        name: myName(),
        pronouns: me && me.pronouns,
        content: "Sphinx of black quartz, judge my vow",
      }),
      previewMessage({
        avatarNode: avatar({ url: null, name: "M", size: 36 }),
        name: "MysticPixie",
        content: h("code", { class: "preview-mono", text: "The quick brown fox jumped over the lazy dog" }),
      }),
    ]),
  ]);

  put(column,
    h("div", { class: "appearance-intro" }, [
      h("p", { text: t("Welcome to the new appearance menu, custom themes are not available just yet but we are looking for feedback on how to best implement them!") }),
    ]),
    h("div", { class: "form-stack" }, [
      h("h2", { class: "settings-heading small", text: t("Colours") }),
      connectedButtons(
        [
          { id: "light", label: t("Light") },
          { id: "dark", label: t("Dark") },
          { id: "system", label: t("System") },
        ],
        current.mode,
        (mode) => update({ mode }),
      ),
      h("div", { class: "accent-line" }, [pickerButton, picker, accents]),
      connectedButtons(
        [
          { id: "-1.0", label: t("Reduced") },
          { id: "0.0", label: t("Normal") },
          { id: "0.5", label: t("More Contrast") },
          { id: "1.0", label: t("High Contrast") },
        ],
        current.contrast.toFixed(1),
        (contrast) => update({ contrast: Number(contrast) }),
        true,
      ),
      connectedButtons(
        [
          { id: "monochrome", label: t("Monochrome") },
          { id: "neutral", label: t("Neutral") },
          { id: "tonal_spot", label: t("Tonal Spot") },
          { id: "fruit_salad", label: t("Fruit Salad") },
        ],
        current.variant,
        (variant) => update({ variant }),
        true,
      ),
    ]),
    h("div", { class: "form-stack" }, [
      h("h2", { class: "settings-heading small", text: t("Display & Text") }),
      checkboxRow(t("Enable transparency glass/blur effects (slow on older machines)"), current.blur, (blur) => update({ blur })),
      preview,
      h("span", { class: "field-label", text: t("Message Size") }),
      sliderControl({ min: 12, max: 24, value: current.messageSize, format: (v) => v + "px", oninput: (messageSize) => update({ messageSize }) }),
      h("span", { class: "field-label", text: t("Message Group Spacing") }),
      sliderControl({
        min: 0,
        max: 16,
        value: current.messageGroupSpacing,
        format: (v) => v + "px",
        oninput: (messageGroupSpacing) => update({ messageGroupSpacing }),
      }),
      floatingSelect({
        label: t("Interface Font"),
        options: Object.keys(theme.FONTS).map((key) => ({ id: key, label: key, font: `"${theme.FONTS[key]}"` })),
        value: current.interfaceFont,
        onchange: (interfaceFont) => update({ interfaceFont }),
      }),
      floatingSelect({
        label: t("Monospace Font"),
        options: Object.keys(theme.MONOSPACE_FONTS).map((key) => ({ id: key, label: key, font: `"${theme.MONOSPACE_FONTS[key]}"` })),
        value: current.monospaceFont,
        onchange: (monospaceFont) => update({ monospaceFont }),
      }),
    ]),
    h("div", { class: "form-stack" }, [
      h("h2", { class: "settings-heading small", text: t("Chat Input") }),
      checkboxRow(t("Show send message button"), getOption("appearance:show_send_button"), (value) => setOption("appearance:show_send_button", value)),
      emojiPackSelect(),
    ]),
  );
}

// ─────────────────────────── уведомления ───────────────────────────

/** Звуки в порядке оригинала (Sounds.tsx). */
const SOUND_ROWS = [
  ["message", /* i18n */ "Message Received"],
  ["mute", /* i18n */ "Mute"],
  ["unmute", /* i18n */ "Unmute"],
  ["deafen", /* i18n */ "Deafen"],
  ["undeafen", /* i18n */ "Undeafen"],
  ["userJoinVoice", /* i18n */ "User Joined Call"],
  ["userLeaveVoice", /* i18n */ "User Left Call"],
  ["streamStart", /* i18n */ "Stream Start"],
  ["streamEnd", /* i18n */ "Stream End"],
];

function renderNotificationsPage(column) {
  const soundRow = ([name, title]) => {
    const play = h("button", { type: "button", class: "icon-button small", title: t("Play sound") }, [symbol("volume_up", 18)]);
    play.onclick = (event) => {
      event.stopPropagation();
      playSound(name, true);
    };
    return categoryCheckbox({
      title: h("span", { class: "sound-title" }, [t(title), play]),
      get: () => soundEnabled(name),
      set: () => toggleSound(name),
    });
  };
  put(column,
    categoryGroup([
      categoryCheckbox({
        icon: "notifications",
        title: t("Enable Desktop Notifications"),
        description: t("Receive notifications while the app is open and in the background."),
        get: () => getOption("notifications:desktop") === "allowed",
        set: (on) => setOption("notifications:desktop", on ? "allowed" : "denied"),
      }),
    ]),
    h("div", { class: "form-stack" }, [h("h2", { class: "settings-heading small", text: t("Sounds") }), categoryGroup(SOUND_ROWS.map(soundRow))]),
  );
}

// эти подписи переводятся через массив выше
/* i18n */ "Message Received";
/* i18n */ "Mute";
/* i18n */ "Unmute";
/* i18n */ "Deafen";
/* i18n */ "Undeafen";
/* i18n */ "User Joined Call";
/* i18n */ "User Left Call";
/* i18n */ "Stream Start";
/* i18n */ "Stream End";

// ─────────────────────────── язык ───────────────────────────

const TRANSLATE_URL = "https://translate.stoat.chat/projects/revolt/";

function renderLanguagePage(column) {
  const locale = I18N.get();
  const ids = Object.keys(I18N.LANGUAGES);
  // язык системы — первым (browserPreferredLanguage)
  const preferred = I18N.preferredLanguage();
  if (preferred) ids.unshift(ids.splice(ids.indexOf(preferred), 1)[0]);

  const lastWeek = new Date();
  lastWeek.setDate(lastWeek.getDate() - 7);
  const now = new Date();

  put(column,
    categoryGroup([
      categorySelect({
        icon: "language",
        title: t("Select your language"),
        options: ids.map((id) => {
          const lang = I18N.LANGUAGES[id];
          return {
            id,
            title: h("span", { class: "language-title" }, [lang.display, lang.verified ? symbol("verified_fill", 18) : null]),
            shortDesc: lang.display,
            icon: h("span", { class: "language-flag" }, [unicodeEmojiNode(lang.emoji)]),
          };
        }),
        value: locale.language,
        onUpdate: (id) => I18N.setLanguage(id),
      }),
    ]),
    categoryGroup([
      categorySelect({
        icon: "calendar_month",
        title: t("Date format"),
        options: [
          { id: "DD/MM/YYYY", shortDesc: t("Traditional (DD/MM/YYYY)"), description: I18N.date(lastWeek, "DD/MM/YYYY") },
          { id: "MM/DD/YYYY", shortDesc: t("American (MM/DD/YYYY)"), description: I18N.date(lastWeek, "MM/DD/YYYY") },
          { id: "YYYY-MM-DD", shortDesc: t("ISO Standard (YYYY-MM-DD)"), description: I18N.date(lastWeek, "YYYY-MM-DD") },
        ].map((option) => Object.assign(option, { title: option.shortDesc })),
        value: locale.dateFormat,
        onUpdate: (format) => I18N.setDateFormat(format),
      }),
      categorySelect({
        icon: "schedule",
        title: t("Time format"),
        options: [
          { id: "HH:mm", shortDesc: t("24 hours"), description: I18N.time(now, "HH:mm") },
          { id: "h:mm A", shortDesc: t("12 hours"), description: I18N.time(now, "h:mm A") },
        ].map((option) => Object.assign(option, { title: option.shortDesc })),
        value: locale.timeFormat,
        onUpdate: (format) => I18N.setTimeFormat(format),
      }),
    ]),
    categoryGroup([
      categoryButton({
        icon: "translate",
        title: t("Contribute a language"),
        description: t("Help contribute to an existing or new language"),
        action: "external",
        href: TRANSLATE_URL,
      }),
    ]),
  );
}

// ─────────────────────────── ПК ───────────────────────────

async function renderDesktopPage(column, alive) {
  let config = await call("desktop_config");
  if (!alive()) return;
  const set = async (patch) => {
    config = await call("set_desktop_config", { patch });
    return config;
  };
  const option = (key, icon, title, description) =>
    categoryCheckbox({
      icon,
      title,
      description,
      get: () => config[key],
      set: async (value) => (await set({ [key]: value }))[key],
    });

  const startMinimised = option("startMinimisedToTray", "minimize", t("Start Minimised to Tray"), t("Stoat will start in the system tray."));
  startMinimised.classList.toggle("hidden", !config.autostart);

  put(column,
    categoryGroup([
      categoryCheckbox({
        icon: "exit_to_app",
        title: t("Start with Computer"),
        description: t("Launch Stoat when you log into your computer."),
        get: () => config.autostart,
        set: async (value) => {
          const saved = (await set({ autostart: value })).autostart;
          startMinimised.classList.toggle("hidden", !saved);
          return saved;
        },
      }),
      startMinimised,
      option("minimiseToTray", "cancel_presentation", t("Minimise to Tray"), t("Instead of closing, Stoat will hide in your tray.")),
      categoryCheckbox({
        icon: "web_asset",
        title: t("Custom window frame"),
        description: t("Let Stoat use its own custom titlebar."),
        get: () => config.customFrame,
        set: async (value) => {
          const saved = (await set({ customFrame: value })).customFrame;
          applyDesktopConfig(config);
          return saved;
        },
      }),
    ]),
    categoryGroup([
      option("discordRpc", "groups_2", t("Discord RPC"), t("Rep Stoat using Discord rich presence.")),
      categoryCheckbox({
        icon: "spellcheck",
        title: t("Spellchecker"),
        description: t("Show corrections and suggestions as you type."),
        get: () => config.spellchecker,
        set: async (value) => {
          const saved = (await set({ spellchecker: value })).spellchecker;
          applyDesktopConfig(config);
          return saved;
        },
      }),
      option("hardwareAcceleration", "speed", t("Hardware Acceleration"), t("Use the graphics card to improve performance.")),
    ]),
    categoryGroup([
      categoryButton({
        icon: "desktop_windows",
        title: t("Stoat for Desktop"),
        description: t("Version:") + " " + config.version,
      }),
    ]),
  );
}

// ─────────────────────────── расширенные ───────────────────────────

/** Эксперименты (Experiments.ts): пока только заглушки. */
const EXPERIMENTS = {
  gif_picker: { title: /* i18n */ "GIF Picker Placeholder", description: /* i18n */ "Not available yet." },
  plugins: { title: /* i18n */ "Plugins v2 Placeholder", description: /* i18n */ "Not available yet." },
};

function readExperiments() {
  const saved = readSetting("experiments", []);
  return Array.isArray(saved) ? saved.filter((key) => key in EXPERIMENTS) : [];
}

function renderAdvancedPage(column) {
  put(column,
    h("div", { class: "form-stack tight" }, [
      checkboxRow(t("Compact mode"), getOption("appearance:compact_mode"), (value) => setOption("appearance:compact_mode", value)),
      checkboxRow(t("Show 'copy ID' in context menus"), getOption("advanced:copy_id"), (value) => setOption("advanced:copy_id", value)),
      checkboxRow(t("Show admin panel shortcuts in context menus"), getOption("advanced:admin_panel"), (value) =>
        setOption("advanced:admin_panel", value),
      ),
    ]),
    categoryGroup(
      Object.entries(EXPERIMENTS).map(([key, experiment]) =>
        categoryCheckbox({
          title: t(experiment.title),
          description: t(experiment.description),
          get: () => readExperiments().includes(key),
          set: (on) => {
            const list = readExperiments().filter((item) => item !== key);
            if (on) list.push(key);
            writeSetting("experiments", list);
          },
        }),
      ),
    ),
  );
}

/* i18n */ "GIF Picker Placeholder";
/* i18n */ "Plugins v2 Placeholder";
/* i18n */ "Not available yet.";

// ─────────────────────────── что нового ───────────────────────────

/** Узел из дерева разметки, которое собирает ядро (команда changelog). */
function markdownNode(node) {
  if (node.tag === "text") return document.createTextNode(node.text || "");
  if (node.tag === "br") return h("br");
  if (node.tag === "hr") return h("hr");
  if (node.tag === "img") return image(node.href, { alt: node.text || "", class: "changelog-image" });
  const tag = node.tag === "span" ? "span" : node.tag;
  const props = {};
  if (tag === "a") Object.assign(props, { href: node.href, target: "_blank", rel: "noreferrer", class: "link" });
  if (tag === "ol" && node.start && node.start !== 1) props.start = node.start;
  const element = h(tag, props);
  for (const child of node.children || []) element.append(markdownNode(child));
  if (node.text && !(node.children || []).length) element.append(node.text);
  return element;
}

/** Окно «Что нового» (Changelog.tsx): последний список изменений Stoat. */
async function openChangelog() {
  let changelog;
  try {
    changelog = await call("changelog");
  } catch (error) {
    console.warn("список изменений:", error);
    return;
  }
  if (!changelog) return;
  const published = new Date(changelog.published_at);
  openModal({
    title: t("What's new"),
    body: h("div", { class: "changelog" }, [
      h("span", { class: "changelog-date", text: Number.isNaN(published.getTime()) ? "" : I18N.longDate(published) }),
      h("div", { class: "changelog-body markdown" }, changelog.content.map(markdownNode)),
    ]),
    actions: [{ label: t("Close"), primary: true, onclick: closeModal }],
    wide: true,
  });
}
