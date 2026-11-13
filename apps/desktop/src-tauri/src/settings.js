// Настройки веб-клиента: раздел «Плагины», выбор темы в «Внешнем виде» и
// подпись Arachnid Client.
//
// for-web открыт с сервера Stoat, его исходники здесь не меняются. Поэтому
// раздел добавляется в уже отрисованные настройки, как это делают клиентские
// моды: скрипт следит за документом и, когда открыты настройки
// пользователя, дополняет их. Опоры выбраны так, чтобы не зависеть от языка
// интерфейса и от сгенерированных имён классов:
//
// * настройки пользователя — боковая панель `.settings_sidebar` с пунктом
//   «ПК» (значок desktop_windows) или с подписью «Stoat for Desktop»
//   (for-web выводит её без перевода, когда есть window.native); подпись
//   заменяется на «Arachnid Client»;
// * место для раздела — в «Настройках клиента» сразу после «Внешнего вида»,
//   перед «Уведомлениями»: там, где у for-web закомментирован свой пункт
//   plugins. «Внешний вид» узнаётся по значку palette (контур и четыре
//   кружка), а если значок изменится — по месту: второй пункт категории с
//   «ПК»;
// * «Внешний вид» — страница, которая начинается с приветствия «Welcome to
//   the new appearance menu…» (без перевода), за ним блок «Colours».
//
// Если for-web изменится и опоры пропадут, настройки останутся как есть:
// темы и плагины по-прежнему доступны из трея.
//
// Скрипт выполняется после bridge.js и только там, где он создал
// window.__arachnidDesktop (страница веб-клиента из config.toml).
(() => {
  "use strict";

  const desktop = window.__arachnidDesktop;
  const internals = window.__TAURI_INTERNALS__;
  if (!desktop || !internals) return;

  const invoke = (command, args) => internals.invoke(command, args);
  const version = window.native?.versions?.desktop?.() ?? "";

  // ─────────────────────────────── подписи ───────────────────────────────
  // Как и меню трея — на языке системы.
  const russian = /^ru\b/i.test(navigator.language || "");
  const text = russian
    ? {
        plugins: "Плагины",
        about: "Настольный клиент Stoat: темы, плагины и QuickCSS.",
        pluginsIntro:
          "Плагины — файлы .js или папки с plugin.toml в папке plugins. Они выполняются на странице Stoat с теми же правами, что и сам клиент, включая доступ к аккаунту: включайте только те, которым доверяете.",
        noPlugins: "Своих плагинов пока нет. Положите файл .js или папку плагина в папку plugins — он появится здесь.",
        core: (api) => `Ядро клиента всегда включено · API плагинов ${api}`,
        builtin: "Встроенный",
        builtinDescription: {
          "builtin:qol": "Окно эмодзи с разделами и «Часто используемыми», как в Discord, крупные эмодзи в реакциях и значки ролей целиком.",
        },
        network: (hosts) => `Доступ в сеть: ${hosts}`,
        needsGrant: "Ждёт разрешения на доступ в сеть",
        broken: (error) => `Не загружен: ${error}`,
        allow: "Разрешить",
        cancel: "Отмена",
        pluginSettings: (name) => `Настройки: ${name}`,
        resetPlugin: "Сбросить настройки",
        permissionsTitle: (name) => `Разрешить «${name}» доступ в сеть?`,
        permissionsIntro:
          "Плагин сможет отправлять запросы к этим адресам от имени клиента, в обход ограничений страницы:",
        permissionsHint:
          "Другие адреса ему недоступны. Если новая версия плагина попросит больше, клиент спросит снова.",
        reloadNeeded: "Изменения плагинов вступят в силу после перезагрузки клиента.",
        reload: "Перезагрузить",
        willStart: "Запустится после перезагрузки",
        willStop: "Остановится после перезагрузки",
        pluginActions: "Действия плагинов",
        openPlugins: "Папка плагинов",
        openThemes: "Папка тем",
        quickCss: "Изменить QuickCSS",
        quickCssHint: "Свой CSS поверх клиента и темы. Изменения применяются сразу и сохраняются в quickcss.css.",
        saving: "Сохранение…",
        saved: "Сохранено",
        saveFailed: (message) => `Не сохранено: ${message}`,
        openInEditor: "Открыть в редакторе",
        done: "Готово",
        theme: "Тема",
        defaultTheme: "Stoat (по умолчанию)",
        themesHint:
          "Свои темы — файлы .css или папки с theme.toml в папке themes. У выбранной темы здесь появятся её настройки.",
        themeSettings: "Настройки темы",
        noThemeSettings: "У этой темы нет своих настроек.",
        unsupported: (name) =>
          `Тема написана для препроцессора «${name}», Arachnid Client его не поддерживает: тема подключена как есть, её настройки не применяются.`,
        reset: "Сбросить настройки темы",
        author: (name) => `Автор: ${name}`,
        version: (value) => `Версия ${value}`,
      }
    : {
        plugins: "Plugins",
        about: "Desktop client for Stoat: themes, plugins and QuickCSS.",
        pluginsIntro:
          "Plugins are .js files or folders with a plugin.toml in the plugins folder. They run on the Stoat page with the same rights as the client itself, including access to your account: only enable the ones you trust.",
        noPlugins: "No plugins of your own yet. Put a .js file or a plugin folder into the plugins folder and it will show up here.",
        core: (api) => `The client core is always on · Plugin API ${api}`,
        builtin: "Built-in",
        builtinDescription: {
          "builtin:qol": "Emoji picker with sections and “Frequently Used”, like in Discord, larger emoji in reactions and uncropped role icons.",
        },
        network: (hosts) => `Network access: ${hosts}`,
        needsGrant: "Waiting for network permission",
        broken: (error) => `Not loaded: ${error}`,
        allow: "Allow",
        cancel: "Cancel",
        pluginSettings: (name) => `Settings: ${name}`,
        resetPlugin: "Reset Settings",
        permissionsTitle: (name) => `Allow “${name}” to access the network?`,
        permissionsIntro:
          "The plugin will be able to send requests to these addresses on behalf of the client, bypassing the page's restrictions:",
        permissionsHint:
          "Other addresses stay closed to it. If a newer version of the plugin asks for more, the client will ask again.",
        reloadNeeded: "Plugin changes take effect after the client reloads.",
        reload: "Reload",
        willStart: "Starts after reload",
        willStop: "Stops after reload",
        pluginActions: "Plugin Actions",
        openPlugins: "Plugins Folder",
        openThemes: "Themes Folder",
        quickCss: "Edit QuickCSS",
        quickCssHint: "Your own CSS on top of the client and the theme. Changes apply instantly and are saved to quickcss.css.",
        saving: "Saving…",
        saved: "Saved",
        saveFailed: (message) => `Not saved: ${message}`,
        openInEditor: "Open in Editor",
        done: "Done",
        theme: "Theme",
        defaultTheme: "Stoat (default)",
        themesHint:
          "Custom themes are .css files or folders with a theme.toml in the themes folder. The selected theme shows its own settings here.",
        themeSettings: "Theme Settings",
        noThemeSettings: "This theme has no settings of its own.",
        unsupported: (name) =>
          `This theme is written for the “${name}” preprocessor, which Arachnid Client does not support: the theme is applied as is and its settings are ignored.`,
        reset: "Reset Theme Settings",
        author: (name) => `By ${name}`,
        version: (value) => `Version ${value}`,
      };

  const BRAND = "Arachnid Client";
  /** Подпись for-web под версией, когда есть window.native */
  const STOAT_DESKTOP = "Stoat for Desktop";
  /** Приветствие, на месте которого появляется выбор темы */
  const WELCOME = "Welcome to the new appearance menu";
  /** Значок пункта «ПК» в боковой панели */
  const DESKTOP_ICON = "desktop_windows";
  /**
   * Значок «extension» из Material Symbols (@material-symbols/svg-400,
   * outlined) — набор, которым for-web рисует и значок «ПК». У него
   * визуальный центр посередине; у старого extension из
   * @material-design-icons тело пазла сидит ниже соседних значков.
   */
  const EXTENSION_ICON = {
    viewBox: "0 -960 960 960",
    path: "M356-120H180q-24 0-42-18t-18-42v-176q44-5 75.5-34.5T227-463q0-43-31.5-72.5T120-570v-176q0-24 18-42t42-18h177q11-40 39.5-67t68.5-27q40 0 68.5 27t39.5 67h173q24 0 42 18t18 42v173q40 11 65.5 41.5T897-461q0 40-25.5 67T806-356v176q0 24-18 42t-42 18H570q-5-48-35.5-77.5T463-227q-41 0-71.5 29.5T356-120Zm-176-60h130q25-61 69.89-84t83-23Q501-287 546-264t70 84h130v-235h45q20 0 33-13t13-33q0-20-13-33t-33-13h-45v-239H511v-48q0-20-13-33t-33-13q-20 0-33 13t-13 33v48H180v130q48.15 17.82 77.58 59.69Q287-514.45 287-462.78 287-412 257.5-370T180-310v130Zm285-281Z",
  };

  // ─────────────────────────────── элементы ───────────────────────────────

  /** Создать элемент: `h("div", { class, onClick, dataset }, ...дети)` */
  function h(tag, props, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") element.className = value;
      else if (key === "dataset") Object.assign(element.dataset, value);
      else if (key === "style") Object.assign(element.style, value);
      else if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in element && typeof value !== "string") element[key] = value;
      else element.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return element;
  }

  /** Значок Material Symbols (шрифт for-web) */
  const icon = (name) =>
    h("span", { class: "material-symbols-outlined arachnid-icon", "aria-hidden": "true" }, name);

  // ─────────────────────────────── стили ───────────────────────────────
  // Повторяют компоненты for-web (CategoryButton, FloatingSelect, Text) и
  // берут цвета из переменных Material 3 — подходят к любой теме.
  const STYLE = `
.settings_sidebar a.button[data-arachnid-muted] {
  background: unset !important;
}
.settings_sidebar a.button[data-arachnid-entry][aria-selected="true"] {
  background: var(--md-sys-color-primary-container) !important;
}
[data-arachnid-content-page] > :not([data-arachnid-panel]),
[data-arachnid-hidden] {
  display: none !important;
}
.arachnid-icon { font-size: 20px; line-height: 1; user-select: none; }
.arachnid-page, .arachnid-column { display: flex; flex-direction: column; gap: var(--gap-md, 12px); }
.arachnid-page { gap: var(--gap-lg, 16px); padding-bottom: 80px; color: var(--md-sys-color-on-surface); }
.arachnid-title { line-height: 1.75rem; font-size: 1.375rem; font-weight: 550; }
.arachnid-subtitle { line-height: 1.25rem; font-size: 0.875rem; letter-spacing: 0.00625rem; font-weight: 550; }
.arachnid-label { line-height: 1rem; font-size: 0.75rem; letter-spacing: 0.03125rem; font-weight: 500; color: var(--md-sys-color-on-surface-variant); }
.arachnid-card {
  display: flex; align-items: center; gap: 16px; padding: 16px;
  border-radius: var(--borderRadius-xl, 28px);
  background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container);
}
.arachnid-card .arachnid-icon {
  font-size: 28px; width: 48px; height: 48px; display: grid; place-items: center; flex-shrink: 0;
  border-radius: var(--borderRadius-full, 9999px);
  background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary);
}
.arachnid-card-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.arachnid-card-title { font-size: 1rem; line-height: 1.5rem; font-weight: 550; }
.arachnid-banner {
  display: flex; align-items: center; gap: 16px; padding: 8px 8px 8px 16px;
  border-radius: var(--borderRadius-lg, 16px);
  background: var(--md-sys-color-tertiary-container); color: var(--md-sys-color-on-tertiary-container);
  font-size: 0.875rem; line-height: 1.25rem;
}
.arachnid-banner > span:not(.arachnid-icon) { flex-grow: 1; }
.arachnid-group { display: flex; flex-direction: column; gap: var(--gap-xs, 2px); border-radius: var(--borderRadius-xl, 28px); overflow: hidden; }
.arachnid-item {
  position: relative; display: flex; align-items: center; gap: 16px; padding: 13px;
  border-radius: var(--borderRadius-md, 12px); user-select: none;
  background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container);
  transition: background-color 0.1s ease-in-out;
}
.arachnid-item[data-clickable] { cursor: pointer; }
.arachnid-item[data-clickable]:hover {
  background: color-mix(in srgb, var(--md-sys-color-on-secondary-container) 8%, var(--md-sys-color-secondary-container));
}
.arachnid-item-icon {
  width: 36px; height: 36px; flex-shrink: 0; display: grid; place-items: center;
  border-radius: var(--borderRadius-full, 9999px);
  background: var(--md-sys-color-surface-dim); color: var(--md-sys-color-on-surface);
}
.arachnid-item-content { display: flex; flex-direction: column; flex-grow: 1; gap: 2px; min-width: 0; font-weight: 500; font-size: 14px; }
.arachnid-item-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.arachnid-item-description { line-height: 1rem; font-size: 0.75rem; letter-spacing: 0.03125rem; font-weight: 500; white-space: pre-line; overflow-wrap: anywhere; }
.arachnid-item-note { color: var(--md-sys-color-tertiary); }
.arachnid-buttons { display: flex; flex-wrap: wrap; gap: var(--gap-sm, 8px); }
.arachnid-button {
  height: 40px; padding: 0 24px; border: none; flex-shrink: 0;
  display: inline-flex; align-items: center; gap: 8px;
  border-radius: var(--borderRadius-full, 9999px);
  background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container);
  font: inherit; font-size: 14px; font-weight: 500; cursor: pointer;
}
.arachnid-button:hover {
  background: color-mix(in srgb, var(--md-sys-color-on-secondary-container) 8%, var(--md-sys-color-secondary-container));
}
.arachnid-button[data-variant="filled"] { background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary); }
.arachnid-button[data-variant="text"] { background: transparent; color: var(--md-sys-color-primary); padding: 0 12px; }
.arachnid-button[data-variant="text"]:hover { background: color-mix(in srgb, var(--md-sys-color-primary) 8%, transparent); }
.arachnid-checkbox { width: 18px; height: 18px; margin: 3px; accent-color: var(--md-sys-color-primary); flex-shrink: 0; pointer-events: none; }
.arachnid-select, .arachnid-field {
  position: relative; box-sizing: border-box; width: 100%; min-height: 56px; padding: 8px 16px;
  display: flex; align-items: center; gap: 8px;
  border: none; border-bottom: 1px solid var(--md-sys-color-outline); border-radius: 4px 4px 0 0;
  background: var(--md-sys-color-surface-container-highest); color: var(--md-sys-color-on-surface);
  font: inherit; font-size: 16px; text-align: left; transition: border-color 0.2s;
}
.arachnid-select { cursor: pointer; }
.arachnid-select:hover, .arachnid-field:hover { border-bottom-color: var(--md-sys-color-on-surface); }
.arachnid-select:focus, .arachnid-select[data-open], .arachnid-field:focus-within {
  outline: none; border-bottom: 2px solid var(--md-sys-color-primary);
}
.arachnid-select-label, .arachnid-field-label {
  position: absolute; left: 16px; top: 8px; font-size: 12px; line-height: 16px;
  color: var(--md-sys-color-on-surface-variant); pointer-events: none;
}
.arachnid-select-value { flex: 1; padding-top: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.arachnid-select svg { width: 24px; height: 24px; flex-shrink: 0; fill: var(--md-sys-color-on-surface-variant); transition: transform 0.2s; }
.arachnid-select[data-open] svg { transform: rotate(180deg); }
.arachnid-field input {
  flex: 1; min-width: 0; margin: 16px 0 0; padding: 0; border: none; outline: none;
  background: transparent; color: inherit; font: inherit;
}
.arachnid-swatch {
  width: 32px; height: 32px; flex-shrink: 0; padding: 0; cursor: pointer;
  border: 2px solid var(--md-sys-color-outline); border-radius: var(--borderRadius-full, 9999px);
}
.arachnid-swatch input { position: absolute; width: 0; height: 0; padding: 0; border: 0; opacity: 0; }
.arachnid-select-menu {
  position: fixed; z-index: 10000; box-sizing: border-box; display: flex; flex-direction: column;
  max-height: 40vh; overflow-y: auto; scrollbar-width: none; padding: 8px 0;
  border-radius: 4px; background: var(--md-sys-color-surface-container); color: var(--md-sys-color-on-surface);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  opacity: 0; transform: translateY(-8px); transition: opacity 0.2s, transform 0.2s cubic-bezier(0.87, 0, 0.13, 1);
}
.arachnid-select-menu[data-shown] { opacity: 1; transform: none; }
.arachnid-select-item {
  display: flex; align-items: center; height: 3rem; padding: 0 1.5rem; flex-shrink: 0;
  cursor: pointer; white-space: nowrap; font-size: 14px; outline: none; transition: background 0.2s;
}
.arachnid-select-item:hover, .arachnid-select-item:focus-visible {
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
}
.arachnid-select-item[aria-selected="true"] {
  background: color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent);
}
.arachnid-slider { display: flex; align-items: center; gap: 12px; }
.arachnid-slider > :first-child { flex: 1; }
.arachnid-slider input[type="range"] { accent-color: var(--md-sys-color-primary); }
.arachnid-slider-value { min-width: 4em; text-align: right; font-size: 0.875rem; font-variant-numeric: tabular-nums; }
.arachnid-scrim {
  position: fixed; inset: 0; z-index: 999; box-sizing: border-box; padding: 80px;
  display: grid; place-items: center;
  background: rgba(0, 0, 0, 0.32); background: rgba(from var(--md-sys-color-scrim) r g b / 0.32);
  /* клиент за окном размыт; появляется и исчезает вместе с подложкой */
  backdrop-filter: blur(8px);
  animation: arachnid-fade 0.1s forwards;
}
@media (max-width: 768px) { .arachnid-scrim { padding: 30px; } }
.arachnid-scrim[data-closing] { animation: arachnid-fade 0.2s reverse forwards; pointer-events: none; }
.arachnid-dialog {
  box-sizing: border-box; width: min(960px, 100%); height: min(720px, 100%); padding: 24px;
  display: flex; flex-direction: column; border-radius: 28px; user-select: none;
  color: var(--md-sys-color-on-surface); background: var(--md-sys-color-surface-container-high);
  animation: arachnid-rise 0.3s cubic-bezier(0.05, 0.7, 0.1, 1);
}
.arachnid-scrim[data-closing] .arachnid-dialog { animation: arachnid-sink 0.2s cubic-bezier(0.3, 0, 0.8, 0.15) forwards; }
.arachnid-dialog-title { line-height: 2rem; font-size: 1.5rem; font-weight: 400; margin-block-end: 16px; }
.arachnid-dialog-content { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px; }
.arachnid-dialog-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-block-start: 24px; }
.arachnid-dialog[data-compact] { width: min(560px, 100%); height: auto; max-height: 100%; }
.arachnid-dialog[data-compact] .arachnid-dialog-content { overflow-y: auto; font-size: 0.875rem; line-height: 1.25rem; }
.arachnid-hosts { margin: 0; padding-inline-start: 20px; font-family: var(--fonts-monospace, monospace); overflow-wrap: anywhere; }
.arachnid-item-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.arachnid-icon-button {
  width: 40px; height: 40px; padding: 0; border: none; display: grid; place-items: center; cursor: pointer;
  border-radius: var(--borderRadius-full, 9999px); background: transparent; color: inherit;
}
.arachnid-icon-button:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.arachnid-dialog-status { flex: 1; min-width: 0; }
.arachnid-dialog-status[data-error] { color: var(--md-sys-color-error); }
.arachnid-code {
  flex: 1; min-height: 0; display: flex; overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant); border-radius: var(--borderRadius-md, 12px);
  background: var(--md-sys-color-surface-container-lowest);
}
.arachnid-code:focus-within { border-color: var(--md-sys-color-primary); }
.arachnid-code-lines, .arachnid-code textarea {
  margin: 0; font-family: var(--fonts-monospace, monospace); font-size: 13px; line-height: 20px;
}
.arachnid-code-lines {
  flex-shrink: 0; min-width: 3ch; padding: 12px 8px 40px 12px; overflow: hidden;
  white-space: pre; text-align: right; color: var(--md-sys-color-outline); user-select: none;
}
.arachnid-code textarea {
  flex: 1; min-width: 0; padding: 12px; border: none; outline: none; resize: none;
  white-space: pre; overflow: auto; tab-size: 2; user-select: text;
  background: transparent; color: var(--md-sys-color-on-surface); caret-color: var(--md-sys-color-primary);
}
@keyframes arachnid-fade { from { opacity: 0; } }
@keyframes arachnid-rise { from { opacity: 0; transform: translateY(20px); } }
@keyframes arachnid-sink { to { opacity: 0; transform: translateY(-20px); } }
`;

  function mountStyle() {
    if (document.querySelector("style[data-arachnid-settings]")) return;
    (document.head ?? document.documentElement).append(h("style", { dataset: { arachnidSettings: "" } }, STYLE));
  }

  // ─────────────────────────────── компоненты ───────────────────────────────

  /** Флажок for-web (mdui-checkbox), если он уже зарегистрирован */
  function checkbox(checked, label) {
    if (customElements.get("mdui-checkbox")) {
      const box = h("mdui-checkbox", {}, label ?? "");
      box.checked = checked;
      return box;
    }
    const box = h("input", { type: "checkbox", class: "arachnid-checkbox", tabIndex: -1 });
    box.checked = checked;
    if (label === undefined) return box;
    return h("label", { class: "arachnid-item-content", style: { flexDirection: "row", alignItems: "center", gap: "8px" } }, box, label);
  }

  /**
   * Строка как CategoryButton: значок, заголовок, описание и действие.
   * Щелчок по строке отменяет переключение самого флажка (как в for-web) и
   * вызывает onClick.
   */
  function item({ iconName, title, description, note, action, onClick }) {
    return h(
      "div",
      {
        class: "arachnid-item",
        role: onClick ? "button" : undefined,
        tabIndex: onClick ? 0 : undefined,
        dataset: onClick ? { clickable: "" } : undefined,
        onClick: onClick
          ? (event) => {
              event.preventDefault();
              onClick();
            }
          : undefined,
        onKeydown: onClick
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick();
              }
            }
          : undefined,
      },
      h("div", { class: "arachnid-item-icon" }, icon(iconName)),
      h(
        "div",
        { class: "arachnid-item-content" },
        h("div", { class: "arachnid-item-title" }, title),
        description ? h("span", { class: "arachnid-item-description" }, description) : null,
        note ? h("span", { class: "arachnid-item-description arachnid-item-note" }, note) : null,
      ),
      action ?? null,
    );
  }

  const button = (label, onClick, variant, iconName) =>
    h(
      "button",
      { type: "button", class: "arachnid-button", dataset: variant ? { variant } : undefined, onClick },
      iconName ? icon(iconName) : null,
      label,
    );

  /** Кнопка-значок внутри строки: щелчок не переключает саму строку */
  const iconButton = (name, label, onClick) =>
    h(
      "button",
      {
        type: "button",
        class: "arachnid-icon-button",
        title: label,
        "aria-label": label,
        onClick: (event) => {
          event.stopPropagation();
          onClick();
        },
        onKeydown: (event) => event.stopPropagation(),
      },
      icon(name),
    );

  /** Открытая сейчас шторка выбора: закрывается при открытии другой */
  let openSelect = null;

  /**
   * Выпадающий список как FloatingSelect в for-web: поле с плавающей
   * подписью и шторка под ним. Шторка живёт в <body> с position: fixed —
   * в окне настроек есть трансформации, внутри них fixed не работает.
   */
  function select({ label, value, options, onChange }) {
    const current = options.find((option) => option.value === value) ?? options[0];
    const trigger = h(
      "button",
      { type: "button", class: "arachnid-select", "aria-haspopup": "listbox" },
      h("span", { class: "arachnid-select-label" }, label),
      h("span", { class: "arachnid-select-value" }, current?.label ?? ""),
    );
    trigger.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>');

    let menu = null;

    function place() {
      if (!menu) return;
      if (!trigger.isConnected) return close();
      const rect = trigger.getBoundingClientRect();
      menu.style.minWidth = `${rect.width}px`;
      menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8))}px`;
      const below = innerHeight - rect.bottom - 8;
      const height = menu.offsetHeight;
      const top = height > below && rect.top > below ? Math.max(8, rect.top - 4 - height) : rect.bottom + 4;
      menu.style.top = `${top}px`;
    }

    function onOutside(event) {
      if (menu && !menu.contains(event.target) && !trigger.contains(event.target)) close();
    }

    function onKey(event) {
      if (!menu) return;
      const items = [...menu.children];
      const index = items.indexOf(document.activeElement);
      if (event.key === "Escape") {
        // иначе for-web закроет всё окно настроек
        event.preventDefault();
        event.stopPropagation();
        close();
        trigger.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        items[(index + step + items.length) % items.length]?.focus();
      }
    }

    function close() {
      if (!menu) return;
      menu.remove();
      menu = null;
      delete trigger.dataset.open;
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      if (openSelect === close) openSelect = null;
    }

    function choose(option) {
      close();
      trigger.focus();
      if (option.value !== value) onChange(option.value);
    }

    function open() {
      openSelect?.();
      menu = h(
        "div",
        { class: "arachnid-select-menu", role: "listbox", "aria-label": label },
        options.map((option) =>
          h(
            "div",
            {
              class: "arachnid-select-item",
              role: "option",
              tabIndex: 0,
              "aria-selected": String(option.value === current?.value),
              onClick: () => choose(option),
              onKeydown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  choose(option);
                }
              },
            },
            option.label,
          ),
        ),
      );
      document.body.append(menu);
      trigger.dataset.open = "";
      trigger.setAttribute("aria-expanded", "true");
      place();
      requestAnimationFrame(() => menu?.setAttribute("data-shown", ""));
      menu.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
      document.addEventListener("mousedown", onOutside, true);
      // раньше обработчиков for-web: Escape закрывает только шторку
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", place);
      document.addEventListener("scroll", place, true);
      openSelect = close;
    }

    trigger.addEventListener("click", () => (menu ? close() : open()));
    return trigger;
  }

  /** Поле ввода с плавающей подписью; onCommit — по Enter или уходу с поля */
  function field({ label, value, type, onCommit, extra }) {
    const input = h("input", { type: type ?? "text", value, spellcheck: "false" });
    input.addEventListener("change", () => onCommit(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
    return h("label", { class: "arachnid-field" }, h("span", { class: "arachnid-field-label" }, label), input, extra ?? null);
  }

  /** Ползунок for-web (mdui-slider), если он зарегистрирован */
  function slider({ min, max, step, value, unit, onCommit }) {
    const shown = h("span", { class: "arachnid-slider-value" }, `${value}${unit ?? ""}`);
    let control;
    if (customElements.get("mdui-slider")) {
      control = h("mdui-slider", {});
      Object.assign(control, { min, max, step: step ?? 1, value: Number(value) });
      control.labelFormatter = (current) => `${current}${unit ?? ""}`;
    } else {
      control = h("input", { type: "range", min, max, step: step ?? 1, value });
    }
    control.addEventListener("input", () => (shown.textContent = `${control.value}${unit ?? ""}`));
    control.addEventListener("change", () => onCommit(String(control.value)));
    return h("div", { class: "arachnid-slider" }, control, shown);
  }

  // ─────────────────────────────── данные ───────────────────────────────
  // Темы и плагины хранит Rust (extensions.rs); здесь — последний ответ.
  let overview = null;
  let fetching = null;

  function refresh() {
    fetching ??= invoke("extensions_overview")
      .then((next) => {
        overview = next;
        renderAll();
      })
      .catch((error) => console.warn("[Arachnid] темы и плагины не получены", error))
      .finally(() => (fetching = null));
    return fetching;
  }

  /** Выполнить команду, которая возвращает новое состояние */
  function change(command, args, rerender = true) {
    return invoke(command, args)
      .then((next) => {
        overview = next;
        if (rerender) renderAll();
      })
      .catch((error) => {
        console.warn(`[Arachnid] ${command}:`, error);
        void refresh();
      });
  }

  const openFolder = (target) => void invoke("extensions_open", { target });

  // ───────────────────────────── раздел «Плагины» ─────────────────────────────
  /** Открытый раздел: { sidebar, entry, column, panel, observer } */
  let page = null;

  function renderPluginsPage() {
    if (!page?.panel.isConnected) return;
    openSelect?.();
    const plugins = overview?.plugins ?? [];
    const menu = desktop.pluginMenu();

    const list = plugins.map((plugin) => {
      const name = plugin.name ?? plugin.file;
      const tags = [
        plugin.builtin && text.builtin,
        plugin.author && text.author(plugin.author),
        plugin.version && text.version(plugin.version),
        plugin.native && "WebAssembly",
        !plugin.builtin && plugin.file,
      ].filter(Boolean);
      const details = [
        (plugin.builtin && text.builtinDescription[plugin.file]) || plugin.description,
        plugin.network.length ? text.network(plugin.network.join(", ")) : null,
        tags.join(" · "),
      ].filter(Boolean);
      const waiting = plugin.enabled && !plugin.granted && !plugin.error;
      let note = null;
      if (plugin.error) note = text.broken(plugin.error);
      else if (waiting) note = text.needsGrant;
      else if (plugin.enabled && !plugin.running) note = text.willStart;
      else if (!plugin.enabled && plugin.running) note = text.willStop;
      const box = checkbox(plugin.enabled);
      const extra = [
        waiting ? iconButton("lock_open", text.allow, () => askPermissions(plugin)) : null,
        plugin.settings.length ? iconButton("settings", text.pluginSettings(name), () => openPluginSettings(plugin.file)) : null,
      ].filter(Boolean);
      return item({
        iconName: plugin.builtin ? "auto_awesome" : plugin.folder ? "folder_special" : "extension",
        title: name,
        description: details.join("\n"),
        note,
        action: extra.length ? h("div", { class: "arachnid-item-actions" }, extra, box) : box,
        onClick: () => {
          if (!plugin.enabled && plugin.error) return;
          // сеть — только после согласия в окне разрешений
          if (!plugin.enabled && !plugin.granted) return askPermissions(plugin);
          box.checked = !plugin.enabled;
          void change("extensions_set_plugin", { file: plugin.file, enabled: !plugin.enabled });
        },
      });
    });

    const actions = menu.flatMap((entry) => {
      if (!entry.items) {
        return [item({ iconName: "bolt", title: entry.name, action: icon("chevron_right"), onClick: () => desktop.runMenuItem(entry.id) })];
      }
      if (entry.items.length === 0) return [];
      return [
        h("span", { class: "arachnid-label", style: { padding: "8px 13px 0" } }, entry.name),
        ...entry.items.map((child) =>
          item({ iconName: "tune", title: child.name, action: icon("chevron_right"), onClick: () => desktop.runMenuItem(child.id) }),
        ),
      ];
    });

    page.panel.replaceChildren(
      h("span", { class: "arachnid-title" }, text.plugins),
      h(
        "div",
        { class: "arachnid-card" },
        icon("extension"),
        h(
          "div",
          { class: "arachnid-card-text" },
          h("span", { class: "arachnid-card-title" }, `${BRAND} ${version}`),
          h("span", { class: "arachnid-label", style: { color: "inherit" } }, text.about),
          // ядро — первая строка раздела, его не выключить
          h(
            "span",
            { class: "arachnid-label", style: { color: "inherit", display: "flex", alignItems: "center", gap: "4px" } },
            h("span", { class: "material-symbols-outlined", style: { fontSize: "14px" }, "aria-hidden": "true" }, "lock"),
            text.core(overview?.apiVersion ?? 1),
          ),
        ),
      ),
      overview?.reloadNeeded
        ? h(
            "div",
            { class: "arachnid-banner", role: "status" },
            icon("restart_alt"),
            h("span", {}, text.reloadNeeded),
            button(text.reload, () => location.reload(), "filled"),
          )
        : null,
      h("span", { class: "arachnid-label" }, text.pluginsIntro),
      list.length ? h("div", { class: "arachnid-group" }, list) : null,
      plugins.some((plugin) => !plugin.builtin) ? null : h("span", { class: "arachnid-label" }, text.noPlugins),
      actions.length
        ? h(
            "div",
            { class: "arachnid-column" },
            h("span", { class: "arachnid-subtitle" }, text.pluginActions),
            h("div", { class: "arachnid-group" }, actions),
          )
        : null,
      h(
        "div",
        { class: "arachnid-buttons" },
        button(text.openPlugins, () => openFolder("plugins"), undefined, "folder_open"),
      ),
    );
  }

  /** Показать раздел вместо текущей страницы настроек */
  function openPage(sidebar, entry) {
    const content = sidebar.nextElementSibling;
    const column = content?.querySelector(".settings_cont")?.firstElementChild;
    if (!column) return;
    if (page?.column === column && page.panel.isConnected) return;
    closePage();

    const panel = h("div", { class: "arachnid-page", dataset: { arachnidPanel: "" } });
    column.append(panel);
    column.dataset.arachnidContentPage = "plugins";
    // подсветка открытой страницы for-web — класс варианта Panda, а не
    // атрибут: она гасится, пока открыт раздел
    for (const link of selectedLinks(sidebar)) link.setAttribute("data-arachnid-muted", "");
    entry.setAttribute("aria-selected", "true");

    // for-web перешёл на другую страницу (новый блок в колонке) — раздел
    // уступает ей место
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && !node.hasAttribute("data-arachnid-panel")) {
            closePage();
            return;
          }
        }
      }
    });
    observer.observe(column, { childList: true });

    page = { sidebar, entry, column, panel, observer };
    content.scrollTop = 0;
    renderPluginsPage();
    void refresh();
  }

  function closePage() {
    if (!page) return;
    page.observer.disconnect();
    page.panel.remove();
    delete page.column.dataset.arachnidContentPage;
    for (const link of page.sidebar.querySelectorAll("[data-arachnid-muted]")) {
      link.removeAttribute("data-arachnid-muted");
    }
    page.entry.setAttribute("aria-selected", "false");
    page = null;
  }

  // ───────────────────────────── боковая панель ─────────────────────────────

  /** Текстовый узел, который начинается с `prefix` */
  function findText(root, prefix) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.data.trimStart().startsWith(prefix)) return node;
    }
    return null;
  }

  /** Пункты боковой панели for-web (без нашего) */
  function sidebarLinks(sidebar) {
    return [...sidebar.querySelectorAll("a.button")].filter((link) => !link.hasAttribute("data-arachnid-entry"));
  }

  /**
   * Класс обычного, невыбранного пункта. for-web отмечает открытую страницу
   * классом варианта Panda (атрибут aria-selected до разметки не доходит),
   * поэтому обычный класс — тот, что у большинства пунктов.
   */
  function plainClass(sidebar) {
    const counts = new Map();
    for (const link of sidebarLinks(sidebar)) counts.set(link.className, (counts.get(link.className) ?? 0) + 1);
    let best = null;
    let most = 0;
    for (const [name, count] of counts) {
      if (count > most) {
        best = name;
        most = count;
      }
    }
    return best;
  }

  /** Пункты for-web, отмеченные как открытая страница */
  function selectedLinks(sidebar) {
    const plain = plainClass(sidebar);
    return plain === null ? [] : sidebarLinks(sidebar).filter((link) => link.className !== plain);
  }

  /** Пункт «ПК»: ссылка боковой панели со значком desktop_windows */
  function findDesktopEntry(sidebar) {
    for (const symbol of sidebar.querySelectorAll("a.button .material-symbols-outlined")) {
      if (symbol.textContent.trim() === DESKTOP_ICON) return symbol.closest("a.button");
    }
    return null;
  }

  /** Значок palette из @material-design-icons: контур и четыре кружка */
  function isPaletteIcon(svg) {
    return svg.querySelectorAll("circle").length === 4 && svg.querySelectorAll("path").length === 1;
  }

  /**
   * «Внешний вид»: пункт со значком palette; если значок не узнан — второй
   * пункт категории с «ПК» (порядок for-web: голос, внешний вид,
   * уведомления, язык, ПК).
   */
  function findAppearanceEntry(sidebar) {
    for (const svg of sidebar.querySelectorAll("a.button svg")) {
      const link = svg.closest("a.button");
      if (!link.hasAttribute("data-arachnid-entry") && isPaletteIcon(svg)) return link;
    }
    const entries = findDesktopEntry(sidebar)?.parentElement;
    if (!entries) return null;
    const links = [...entries.children].filter(
      (child) => child.matches("a.button") && !child.hasAttribute("data-arachnid-entry"),
    );
    return links.length >= 3 ? links[1] : null;
  }

  /**
   * Настройки пользователя (а не сервера или канала): в них есть пункт «ПК»,
   * а в подвале панели — подпись «Stoat for Desktop <версия>». Подпись
   * заменяется на Arachnid Client.
   */
  function isUserSettings(sidebar) {
    const node = findText(sidebar, STOAT_DESKTOP);
    if (node) {
      node.data = node.data.replace(STOAT_DESKTOP, BRAND);
      node.parentElement?.setAttribute("data-arachnid-footer", "");
    }
    return Boolean(node || sidebar.querySelector("[data-arachnid-footer]") || findDesktopEntry(sidebar));
  }

  /** Пункт «Плагины»: копия «Внешнего вида» со значком extension */
  function createEntry(sidebar, template) {
    const entry = template.cloneNode(true);
    entry.className = plainClass(sidebar) ?? template.className;
    entry.removeAttribute("id");
    entry.removeAttribute("href");
    entry.removeAttribute("data-arachnid-muted");
    entry.setAttribute("aria-selected", "false");
    entry.setAttribute("role", "button");
    entry.dataset.arachnidEntry = "plugins";

    const svg = entry.querySelector("svg");
    let label;
    if (svg) {
      svg.replaceChildren(document.createElementNS("http://www.w3.org/2000/svg", "path"));
      svg.firstChild.setAttribute("d", EXTENSION_ICON.path);
      svg.setAttribute("viewBox", EXTENSION_ICON.viewBox);
      label = svg.nextElementSibling;
    } else {
      // значок шрифтом Material Symbols
      const symbol = entry.querySelector(".material-symbols-outlined");
      if (symbol) symbol.textContent = "extension";
      label = symbol?.nextElementSibling;
    }
    // подпись — самый вложенный элемент (OverflowingText)
    while (label?.firstElementChild) label = label.firstElementChild;
    (label ?? entry).textContent = text.plugins;

    entry.addEventListener("click", (event) => {
      event.preventDefault();
      openPage(sidebar, entry);
    });
    return entry;
  }

  /**
   * Пункт «Плагины» в «Настройках клиента» между «Внешним видом» и
   * «Уведомлениями». Он копирует разметку соседнего пункта, поэтому
   * выглядит как пункт for-web и следует теме.
   */
  function ensureEntry(sidebar) {
    const appearanceEntry = findAppearanceEntry(sidebar);
    if (!appearanceEntry) return;

    let entry = sidebar.querySelector("a.button[data-arachnid-entry]");
    if (!entry) entry = createEntry(sidebar, appearanceEntry);
    // for-web мог перерисовать список: пункт остаётся после «Внешнего вида»
    if (appearanceEntry.nextElementSibling !== entry) appearanceEntry.after(entry);

    if (!sidebar.dataset.arachnidListening) {
      sidebar.dataset.arachnidListening = "";
      // повторный щелчок по странице, которую for-web считает открытой:
      // она не перерисуется, поэтому раздел закрывается сам; остальные
      // страницы for-web заменят раздел сами
      sidebar.addEventListener(
        "click",
        (event) => {
          const link = event.target instanceof Element ? event.target.closest("a.button") : null;
          if (page && link && link.hasAttribute("data-arachnid-muted")) closePage();
        },
        true,
      );
    }
  }

  // ───────────────────────────── «Внешний вид» ─────────────────────────────
  /** Обработанная страница: { root, picker, colours, block } */
  let appearance = null;

  /** Найти «Внешний вид» в колонке страницы настроек */
  function findAppearance(column) {
    for (const wrapper of column.children) {
      const root = wrapper.firstElementChild;
      const welcome = root?.firstElementChild;
      if (welcome && welcome.textContent.trimStart().startsWith(WELCOME)) return { root, welcome };
    }
    return null;
  }

  function enhanceAppearance(content) {
    const column = content.querySelector(".settings_cont")?.firstElementChild;
    if (!column) return;
    if (appearance?.root.isConnected && column.contains(appearance.root)) return;
    appearance = null;
    const found = findAppearance(column);
    if (!found) return;

    const { root, welcome } = found;
    // за приветствием — блок «Colours»: это настройки стандартного оформления
    const colours = welcome.nextElementSibling;
    const coloursTitle = colours?.firstElementChild?.textContent.trim();
    const picker = h("div", { class: "arachnid-column", dataset: { arachnidAppearance: "picker" } });
    const block = h("div", { class: "arachnid-column", dataset: { arachnidAppearance: "theme" } });
    welcome.setAttribute("data-arachnid-hidden", "");
    welcome.before(picker);
    if (colours && coloursTitle === "Colours") colours.after(block);
    else welcome.after(block);

    appearance = { root, picker, colours: coloursTitle === "Colours" ? colours : null, block };
    renderAppearance();
    void refresh();
  }

  function renderAppearance() {
    if (!appearance?.root.isConnected) return;
    openSelect?.();
    const themes = overview?.themes ?? [];
    const active = themes.find((theme) => theme.file === overview?.theme) ?? null;

    // встроенные цвета относятся к стандартному оформлению
    appearance.colours?.toggleAttribute("data-arachnid-hidden", Boolean(active));

    const details = active
      ? [active.description, [active.author && text.author(active.author), active.version && text.version(active.version)].filter(Boolean).join(" · ")]
          .filter(Boolean)
          .join("\n")
      : text.themesHint;

    appearance.picker.replaceChildren(
      // те же кнопки, что «Папка плагинов» в разделе «Плагины»
      h(
        "div",
        { class: "arachnid-buttons" },
        button(text.openThemes, () => openFolder("themes"), undefined, "folder_open"),
        button(text.quickCss, openQuickCss, undefined, "css"),
      ),
      select({
        label: text.theme,
        value: active?.file ?? "",
        options: [
          { value: "", label: text.defaultTheme },
          ...themes.map((theme) => ({ value: theme.file, label: theme.name ?? theme.file })),
        ],
        onChange: (file) => void change("extensions_set_theme", { file: file || null }),
      }),
      details ? h("span", { class: "arachnid-label", style: { whiteSpace: "pre-line" } }, details) : null,
    );

    appearance.block.toggleAttribute("data-arachnid-hidden", !active);
    appearance.block.replaceChildren(...(active ? themeSettings(active) : []));
  }

  /** Настройки выбранной темы — на месте блока «Colours» */
  function themeSettings(theme) {
    const title = h("span", { class: "arachnid-subtitle" }, text.themeSettings);
    if (theme.error) return [title, h("span", { class: "arachnid-label" }, text.broken(theme.error))];
    if (!theme.supported) return [title, h("span", { class: "arachnid-label" }, text.unsupported(theme.preprocessor))];
    if (!theme.settings.length) return [title, h("span", { class: "arachnid-label" }, text.noThemeSettings)];

    const set = (name, value) =>
      // поле уже показывает новое значение: перерисовывать не нужно
      void change("extensions_set_theme_value", { file: theme.file, name, value }, false);

    return [
      title,
      ...settingControls(theme.settings, theme.values, set),
      h(
        "div",
        { class: "arachnid-buttons" },
        button(text.reset, () => void change("extensions_reset_theme", { file: theme.file }), "text", "restart_alt"),
      ),
    ];
  }

  /**
   * Поля настроек темы или плагина-папки (`usercss::Setting`): флажок,
   * выбор, ползунок, число, цвет, текст. `set(name, value)` сохраняет.
   */
  function settingControls(settings, values, set) {
    return settings.map((setting) => {
      const value = values[setting.name] ?? setting.default;
      switch (setting.kind) {
        case "checkbox": {
          const box = checkbox(value === "1", setting.label);
          const input = box instanceof HTMLInputElement ? box : box.querySelector?.("input") ?? box;
          input.addEventListener("change", () => set(setting.name, input.checked ? "1" : "0"));
          if (input.classList?.contains("arachnid-checkbox")) input.style.pointerEvents = "auto";
          return box;
        }
        case "select":
          return select({
            label: setting.label,
            value,
            options: setting.options.map((option) => ({ value: option.name, label: option.label })),
            onChange: (next) => set(setting.name, next),
          });
        case "range":
          return h(
            "div",
            { class: "arachnid-column", style: { gap: "4px" } },
            h("span", { class: "arachnid-label" }, setting.label),
            slider({
              min: setting.min,
              max: setting.max,
              step: setting.step,
              value,
              unit: setting.unit,
              onCommit: (next) => set(setting.name, next),
            }),
          );
        case "number":
          return field({
            label: setting.unit ? `${setting.label}, ${setting.unit}` : setting.label,
            value,
            type: "number",
            onCommit: (next) => set(setting.name, next),
          });
        case "color": {
          const picker = h("input", { type: "color", tabIndex: -1 });
          const swatch = h("span", { class: "arachnid-swatch", role: "button", style: { background: value } }, picker);
          const shown = field({
            label: setting.label,
            value,
            onCommit: (next) => {
              swatch.style.background = next;
              set(setting.name, next);
            },
            extra: swatch,
          });
          const textInput = shown.querySelector("input");
          if (/^#[0-9a-f]{6}$/i.test(value)) picker.value = value;
          swatch.addEventListener("click", (event) => {
            // щелчок самого выбора цвета тоже проходит через образец
            if (event.target === picker) return;
            event.preventDefault();
            if (typeof picker.showPicker === "function") picker.showPicker();
            else picker.click();
          });
          picker.addEventListener("input", () => {
            swatch.style.background = picker.value;
            textInput.value = picker.value;
          });
          picker.addEventListener("change", () => set(setting.name, picker.value));
          return shown;
        }
        default:
          return field({ label: setting.label, value, onCommit: (next) => set(setting.name, next) });
      }
    });
  }

  // ─────────────────────────────── окна ───────────────────────────────
  // Окно поверх клиента, как Dialog в for-web (Material 3: подложка,
  // карточка 28px, кнопки-текст справа внизу): QuickCSS, настройки и
  // разрешения плагинов. Закрывается по Esc, кнопкой или щелчком мимо.

  let dialogs = 0;

  /**
   * Показать окно; `onClose` вызывается один раз, до анимации закрытия.
   * `compact` — небольшое окно по содержимому. Возвращает `{ close }`.
   */
  function openDialog({ title, content, actions, dataset, compact, onClose }) {
    mountStyle();
    openSelect?.();
    const opener = document.activeElement;
    const titleId = `arachnid-dialog-title-${++dialogs}`;
    let closed = false;

    function close() {
      if (closed) return;
      closed = true;
      onClose?.();
      scrim.setAttribute("data-closing", "");
      setTimeout(() => scrim.remove(), 200);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    }

    const dialog = h(
      "div",
      {
        class: "arachnid-dialog",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
        dataset: compact ? { compact: "" } : undefined,
      },
      h("span", { class: "arachnid-dialog-title", id: titleId }, title),
      h("div", { class: "arachnid-dialog-content" }, content),
      h("div", { class: "arachnid-dialog-actions" }, actions),
    );

    // закрывает только щелчок, который и начался, и закончился на подложке:
    // выделение текста, отпущенное за краем окна, его не закрывает
    let pressedOutside = false;
    const scrim = h(
      "div",
      {
        class: "arachnid-scrim",
        dataset,
        onPointerdown: (event) => (pressedOutside = event.target === scrim),
        onClick: (event) => {
          if (pressedOutside && event.target === scrim) close();
          pressedOutside = false;
        },
        // клавиши остаются в окне: сочетания for-web (Esc закрывает
        // настройки) слушают document.body
        onKeydown: (event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !event.isComposing) {
            event.preventDefault();
            close();
          }
        },
        onKeyup: (event) => event.stopPropagation(),
      },
      dialog,
    );

    (document.getElementById("floating") ?? document.body).append(scrim);
    return { close };
  }

  /** Настройки плагина-папки из plugin.toml */
  function openPluginSettings(file) {
    const plugin = overview?.plugins?.find((entry) => entry.file === file);
    if (!plugin || !document.body) return;
    const body = h("div", { class: "arachnid-column" });
    const set = (name, value) => void change("extensions_set_plugin_value", { file, name, value }, false);
    const fill = () => {
      const current = overview?.plugins?.find((entry) => entry.file === file);
      if (current) body.replaceChildren(...settingControls(current.settings, current.values, set));
    };
    const dialog = openDialog({
      title: text.pluginSettings(plugin.name ?? file),
      compact: true,
      dataset: { arachnidPluginSettings: file },
      content: body,
      actions: [
        button(text.resetPlugin, () => void change("extensions_reset_plugin", { file }).then(fill), "text", "restart_alt"),
        button(text.done, () => dialog.close(), "text"),
      ],
    });
    fill();
  }

  /** Спросить разрешение на сеть и включить плагин */
  function askPermissions(plugin) {
    if (!document.body) return;
    const dialog = openDialog({
      title: text.permissionsTitle(plugin.name ?? plugin.file),
      compact: true,
      dataset: { arachnidPermissions: plugin.file },
      content: [
        h("span", {}, text.permissionsIntro),
        h("ul", { class: "arachnid-hosts" }, plugin.network.map((host) => h("li", {}, host))),
        h("span", { class: "arachnid-label" }, text.permissionsHint),
      ],
      actions: [
        button(text.cancel, () => dialog.close(), "text"),
        button(
          text.allow,
          () => {
            dialog.close();
            void change("extensions_set_plugin", { file: plugin.file, enabled: true, grant: true });
          },
          "filled",
        ),
      ],
    });
  }

  // ─────────────────────────────── QuickCSS ───────────────────────────────
  // Редактор quickcss.css — окно поверх клиента, как Dialog в for-web
  // (Material 3: подложка, карточка 28px, кнопки-текст справа внизу). Текст
  // применяется и сохраняется сам через долю секунды после правки, поэтому
  // окно можно закрыть в любой момент: Esc, «Готово» или щелчок мимо.

  /** Отступ, который вставляет Tab */
  const INDENT = "  ";
  /** Пауза после правки до сохранения, мс */
  const SAVE_DELAY = 300;

  /** Открытый редактор: `{ reload, close }` */
  let quickCss = null;

  function openQuickCss() {
    if (quickCss) {
      quickCss.focus();
      return;
    }
    if (!document.body) return;

    // saved — текст, который сейчас в файле (null, пока не загружен)
    const state = { saved: null, timer: 0, saving: null, again: false, closed: false, lines: 0 };

    const status = h("span", { class: "arachnid-label arachnid-dialog-status", role: "status" });
    const gutter = h("div", { class: "arachnid-code-lines", "aria-hidden": "true" });
    const textarea = h("textarea", {
      spellcheck: "false",
      autocapitalize: "off",
      autocomplete: "off",
      wrap: "off",
      "aria-label": "QuickCSS",
      disabled: true,
      onInput: changed,
      onScroll: () => (gutter.scrollTop = textarea.scrollTop),
      onKeydown: onEditorKey,
    });

    const setStatus = (message, error = false) => {
      status.textContent = message;
      status.toggleAttribute("data-error", error);
    };

    function updateLines() {
      let count = 1;
      for (let at = textarea.value.indexOf("\n"); at !== -1; at = textarea.value.indexOf("\n", at + 1)) count++;
      if (count === state.lines) return;
      state.lines = count;
      gutter.textContent = Array.from({ length: count }, (_, index) => index + 1).join("\n");
      gutter.scrollTop = textarea.scrollTop;
    }

    function changed() {
      updateLines();
      clearTimeout(state.timer);
      state.timer = setTimeout(save, SAVE_DELAY);
    }

    /** Сохранить текущий текст; правки во время сохранения уйдут следом */
    function save() {
      clearTimeout(state.timer);
      state.timer = 0;
      if (state.saved === null) return Promise.resolve();
      if (state.saving) {
        state.again = true;
        return state.saving;
      }
      const css = textarea.value;
      if (css === state.saved) return Promise.resolve();
      setStatus(text.saving);
      state.saving = invoke("extensions_set_quick_css", { css })
        .then(() => {
          state.saved = css;
          if (!state.timer && textarea.value === css) setStatus(text.saved);
        })
        .catch((error) => setStatus(text.saveFailed(error?.message ?? String(error)), true))
        .finally(() => {
          state.saving = null;
          if (state.again) {
            state.again = false;
            void save();
          }
        });
      return state.saving;
    }

    /** quickcss.css изменили в другой программе: показать, если здесь нет своих правок */
    function reload() {
      const untouched = () => !state.closed && !state.timer && !state.saving && textarea.value === state.saved;
      if (state.saved === null || !untouched()) return;
      invoke("extensions_quick_css").then(
        (css) => {
          if (!untouched() || css === state.saved) return;
          const { selectionStart, selectionEnd, scrollTop } = textarea;
          state.saved = css;
          textarea.value = css;
          textarea.setSelectionRange(Math.min(selectionStart, css.length), Math.min(selectionEnd, css.length));
          textarea.scrollTop = scrollTop;
          updateLines();
        },
        () => {},
      );
    }

    /** Вставить текст так, чтобы работала отмена (Ctrl+Z) */
    function insert(value) {
      const viaHistory = typeof document.execCommand === "function" && document.execCommand("insertText", false, value);
      if (!viaHistory) {
        textarea.setRangeText(value, textarea.selectionStart, textarea.selectionEnd, "end");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    /** Tab и Shift+Tab: отступ строки или выделенных строк */
    function indent(outdent) {
      const { value, selectionStart: start, selectionEnd: end } = textarea;
      if (!outdent && start === end) {
        insert(INDENT);
        return;
      }
      const from = value.lastIndexOf("\n", start - 1) + 1;
      // выделение до начала строки эту строку не захватывает
      const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
      const to = value.indexOf("\n", last) === -1 ? value.length : value.indexOf("\n", last);
      const block = value.slice(from, to);
      const lines = block.split("\n");
      const next = lines.map((line) => (outdent ? line.replace(/^( {1,2}|\t)/, "") : INDENT + line)).join("\n");
      if (next === block) return;
      const shift = next.split("\n")[0].length - lines[0].length;
      textarea.setSelectionRange(from, to);
      insert(next);
      if (start === end) {
        const caret = Math.max(from, start + shift);
        textarea.setSelectionRange(caret, caret);
      } else {
        textarea.setSelectionRange(from, from + next.length);
      }
    }

    /** Enter: новая строка с тем же отступом, после «{» — на шаг глубже */
    function newline() {
      const { value, selectionStart: start, selectionEnd: end } = textarea;
      const line = value.slice(value.lastIndexOf("\n", start - 1) + 1, start);
      const current = /^[ \t]*/.exec(line)[0];
      const opens = line.trimEnd().endsWith("{");
      if (opens && value[end] === "}") {
        insert(`\n${current}${INDENT}\n${current}`);
        const caret = start + 1 + current.length + INDENT.length;
        textarea.setSelectionRange(caret, caret);
      } else {
        insert(`\n${current}${opens ? INDENT : ""}`);
      }
    }

    function onEditorKey(event) {
      if (event.isComposing || event.altKey) return;
      const command = event.ctrlKey || event.metaKey;
      if (event.key === "Tab" && !command) {
        event.preventDefault();
        indent(event.shiftKey);
      } else if (event.key === "Enter" && !command && !event.shiftKey) {
        event.preventDefault();
        newline();
      } else if (command && !event.shiftKey && event.code === "KeyS") {
        event.preventDefault();
        void save();
      }
    }

    const dialog = openDialog({
      title: "QuickCSS",
      dataset: { arachnidQuickcss: "" },
      content: [h("span", { class: "arachnid-label" }, text.quickCssHint), h("div", { class: "arachnid-code" }, gutter, textarea)],
      actions: [
        status,
        // внешний редактор откроет уже сохранённый текст
        button(text.openInEditor, () => void save().then(() => openFolder("quickCss")), "text", "open_in_new"),
        button(text.done, () => dialog.close(), "text"),
      ],
      onClose: () => {
        state.closed = true;
        void save();
        quickCss = null;
      },
    });
    quickCss = { reload, close: dialog.close, focus: () => textarea.focus() };
    updateLines();

    invoke("extensions_quick_css").then(
      (css) => {
        if (state.closed) return;
        state.saved = css;
        textarea.value = css;
        textarea.disabled = false;
        updateLines();
        textarea.focus();
        textarea.setSelectionRange(0, 0);
      },
      (error) => setStatus(error?.message ?? String(error), true),
    );
  }

  // ─────────────────────────────── обход ───────────────────────────────

  function renderAll() {
    renderPluginsPage();
    renderAppearance();
  }

  function scan() {
    if (page && !page.panel.isConnected) closePage();
    for (const sidebar of document.querySelectorAll(".settings_sidebar")) {
      if (!isUserSettings(sidebar)) continue;
      ensureEntry(sidebar);
      const content = sidebar.nextElementSibling;
      if (content) enhanceAppearance(content);
    }
  }

  // Настройки открываются и перерисовываются в любой момент: проверка раз в
  // кадр после изменений документа. Без открытых настроек она сводится к
  // одному querySelectorAll.
  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scan();
    });
  }

  desktop.subscribe((type) => {
    if (type === "extensions") void refresh();
    else if (type === "menu") renderPluginsPage();
    else if (type === "quickcss") quickCss?.reload();
    else if (type === "open-quickcss") openQuickCss();
  });

  function start() {
    mountStyle();
    new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
    queueScan();
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
