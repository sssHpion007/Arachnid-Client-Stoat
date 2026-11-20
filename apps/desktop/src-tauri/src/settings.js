// Настройки веб-клиента: раздел «Плагины», выбор темы в «Внешнем виде»,
// группы списка настроек («О клиенте», «О программе») и подпись Arachnid
// Client.
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
  // На языке интерфейса Stoat (i18n.js, locales/*.json)
  const i18n = window.__arachnidI18n;
  const text = i18n.text("settings");
  /** От какого флажка встроенного плагина зависит его настройка */
  const BUILTIN_REQUIRES = { "builtin:qol": { gifs_open_favorites: "favorite_gifs" } };

  const BRAND = "Arachnid Client";
  /** Подпись for-web под версией, когда есть window.native */
  const STOAT_DESKTOP = "Stoat for Desktop";
  /** Приветствие, на месте которого появляется выбор темы */
  const WELCOME = "Welcome to the new appearance menu";
  /** Значок пункта «ПК» в боковой панели */
  const DESKTOP_ICON = "desktop_windows";
  /** Значок пункта «Горячие клавиши» (шрифтом, как у «ПК») */
  const HOTKEYS_ICON = "keyboard";
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

  /**
   * Заменить детей элемента. Пропуски (`null`, `false`) отбрасываются, как в
   * `h`: replaceChildren сам вывел бы их текстом «null».
   */
  const setChildren = (element, ...children) =>
    element.replaceChildren(
      ...children.flat().filter((child) => child !== undefined && child !== null && child !== false),
    );

  /**
   * Подпись в разметке for-web (пункты и группы боковой панели): ключ
   * словаря остаётся на элементе, после смены языка подпись меняется.
   */
  function translated(element, textKey) {
    element.dataset.arachnidText = textKey;
    element.textContent = text[textKey];
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
/* заголовок страницы for-web с кнопками справа («Внешний вид») */
[data-arachnid-title-row] { display: flex !important; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
[data-arachnid-title-row] > .arachnid-buttons { line-height: normal; }
.arachnid-page-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
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
.arachnid-item-icon[data-blank] { background: transparent; }
/* значок плагина из его папки: SVG — маской цвета текста, как значки шрифтом */
.arachnid-plugin-icon { width: 20px; height: 20px; }
span.arachnid-plugin-icon {
  background: currentColor;
  -webkit-mask: var(--arachnid-plugin-icon) center / contain no-repeat;
  mask: var(--arachnid-plugin-icon) center / contain no-repeat;
}
img.arachnid-plugin-icon { object-fit: contain; }
/* варианты CategoryButton for-web: tertiary — вариант списка, tertiaryAlt — выбранный */
.arachnid-item[data-variant="tertiary"] {
  --color: var(--md-sys-color-on-tertiary-container); --mdui-color-primary: var(--color);
  background: var(--md-sys-color-tertiary-container); color: var(--color);
}
.arachnid-item[data-variant="tertiaryAlt"] {
  --color: var(--md-sys-color-on-tertiary); --mdui-color-primary: var(--color);
  background: var(--md-sys-color-tertiary); color: var(--color);
}
.arachnid-item[data-variant="tertiary"][data-clickable]:hover {
  background: color-mix(in srgb, var(--color) 8%, var(--md-sys-color-tertiary-container));
}
.arachnid-item[data-variant="tertiaryAlt"][data-clickable]:hover {
  background: color-mix(in srgb, var(--color) 8%, var(--md-sys-color-tertiary));
}
/* CategoryButton.Select for-web: список под строкой раскрывается по высоте */
.arachnid-collapse-list {
  display: flex; flex-direction: column; gap: var(--gap-xs, 2px); height: 0;
  border-radius: var(--borderRadius-md, 12px); overflow-y: auto; scrollbar-width: none;
  opacity: 0; pointer-events: none; transition: 0.3s;
}
.arachnid-collapse[data-open] .arachnid-collapse-list { opacity: 1; pointer-events: auto; }
.arachnid-collapse > .arachnid-item { transition: background-color 0.1s ease-in-out, margin 0.3s; }
.arachnid-collapse[data-open] > .arachnid-item { margin-bottom: var(--gap-xs, 2px); }
.arachnid-collapse-chevron { width: 24px; height: 24px; display: grid; place-items: center; flex-shrink: 0; }
.arachnid-collapse-chevron > .arachnid-icon { font-size: 18px; transition: transform 0.3s; }
.arachnid-collapse[data-open] .arachnid-collapse-chevron > .arachnid-icon { transform: rotate(180deg); }
.arachnid-collapse-list mdui-radio { pointer-events: none; }
.arachnid-radio { width: 20px; height: 20px; margin: 10px; accent-color: currentColor; pointer-events: none; }
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
/* пояснение под флажком — с начала его подписи: у mdui-checkbox значок 40px
   и по 10px над и под подписью */
.arachnid-setting-hint { padding-inline-start: 40px; margin-top: -6px; }
label:has(> .arachnid-checkbox) + .arachnid-setting-hint { padding-inline-start: 32px; margin-top: 2px; }
.arachnid-hosts { margin: 0; padding-inline-start: 20px; font-family: var(--fonts-monospace, monospace); overflow-wrap: anywhere; }
.arachnid-item-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
/* сочетание горячей клавиши: клавиши плашками */
.arachnid-keys { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 2px; }
.arachnid-key {
  padding: 1px 8px; border-radius: 6px; font-size: 0.8125rem; line-height: 1.25rem; font-weight: 500;
  background: var(--md-sys-color-surface-container-highest); color: var(--md-sys-color-on-surface);
  box-shadow: inset 0 -1px 0 var(--md-sys-color-outline-variant);
}
.arachnid-item[data-recording] { outline: 2px solid var(--md-sys-color-primary); outline-offset: -2px; }
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
  function item({ iconName, iconNode, title, description, note, action, onClick }) {
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
      // без значка — пустое место под ним, как icon="blank" у CategoryButton
      h(
        "div",
        { class: "arachnid-item-icon", dataset: iconName || iconNode ? undefined : { blank: "" } },
        iconNode ?? (iconName ? icon(iconName) : null),
      ),
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
    let current = options.find((option) => option.value === value) ?? options[0];
    const shown = h("span", { class: "arachnid-select-value" }, current?.label ?? "");
    const trigger = h(
      "button",
      { type: "button", class: "arachnid-select", "aria-haspopup": "listbox" },
      h("span", { class: "arachnid-select-label" }, label),
      shown,
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
      if (option.value === current?.value) return;
      // поле показывает выбор сразу: окна настроек после сохранения не
      // перерисовываются
      current = option;
      shown.textContent = option.label;
      onChange(option.value);
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

  /** Радиокнопка for-web (mdui-radio), если она уже зарегистрирована */
  function radio(checked) {
    if (customElements.get("mdui-radio")) {
      const control = h("mdui-radio", { tabIndex: -1 });
      control.checked = checked;
      return control;
    }
    const control = h("input", { type: "radio", class: "arachnid-radio", tabIndex: -1 });
    control.checked = checked;
    return control;
  }

  /** Наибольшая высота раскрытого списка, как MAX_HEIGHT у CategoryButton */
  const CATEGORY_SELECT_HEIGHT = 340;

  /**
   * Выбор как CategoryButton.Select в for-web (выбор языка): строка со
   * значком, заголовком и выбранным вариантом, под ней раскрывается список
   * вариантов с радиокнопками. Щелчок по варианту выбирает его и сворачивает
   * список.
   */
  function categorySelect({ iconName, title, value, options, onChange }) {
    const current = options.find((option) => option.value === value) ?? options[0];
    let opened = false;

    const chevron = h("span", { class: "arachnid-collapse-chevron" }, icon("keyboard_arrow_down"));
    const summary = item({
      iconName,
      title,
      description: current?.label ?? "",
      action: chevron,
      onClick: () => toggle(),
    });
    summary.setAttribute("aria-expanded", "false");

    const rows = options.map((option) => {
      const selected = option.value === current?.value;
      const row = item({
        iconName: null,
        title: option.label,
        description: option.description,
        action: radio(selected),
        onClick: () => {
          toggle(false);
          if (option.value !== value) onChange(option.value);
        },
      });
      row.dataset.variant = selected ? "tertiaryAlt" : "tertiary";
      row.setAttribute("role", "radio");
      row.setAttribute("aria-checked", String(selected));
      row.tabIndex = -1;
      return row;
    });
    const list = h("div", { class: "arachnid-collapse-list", role: "radiogroup", "aria-label": title }, rows);
    const wrapper = h("div", { class: "arachnid-collapse" }, summary, list);

    function toggle(next = !opened) {
      if (next === opened) return;
      opened = next;
      wrapper.toggleAttribute("data-open", opened);
      summary.setAttribute("aria-expanded", String(opened));
      for (const row of rows) row.tabIndex = opened ? 0 : -1;
      const full = list.scrollHeight;
      list.style.height = `${opened ? Math.min(full, CATEGORY_SELECT_HEIGHT) : 0}px`;
      // длинный список — сразу на выбранном варианте
      if (opened && full > CATEGORY_SELECT_HEIGHT) {
        const selected = rows[options.indexOf(current)];
        if (selected) list.scrollTop += selected.getBoundingClientRect().top - list.getBoundingClientRect().top;
      }
    }

    return h("div", { class: "arachnid-group" }, wrapper);
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
        // пункт «Горячие клавиши» зависит от настроек «Quality of Life»
        else queueScan();
      })
      .catch((error) => {
        console.warn(`[Arachnid] ${command}:`, error);
        void refresh();
      });
  }

  const openFolder = (target) => void invoke("extensions_open", { target });

  // ───────────────────────────── раздел «Плагины» ─────────────────────────────
  /** Открытый свой раздел: { kind, sidebar, entry, column, panel, observer };
   *  kind — "plugins" или "hotkeys" */
  let page = null;

  /**
   * Плагин на языке интерфейса: название, описание и подписи настроек — из
   * перевода плагина (`locales/<язык>.toml`), у встроенного — из словаря
   * клиента. У зависимых настроек встроенного — `requires`.
   */
  function localized(plugin) {
    if (plugin.builtin) {
      const own = text.builtinSettings[plugin.file] ?? {};
      const requires = BUILTIN_REQUIRES[plugin.file] ?? {};
      return {
        ...plugin,
        description: text.builtinDescription[plugin.file] ?? plugin.description,
        settings: plugin.settings.map((setting) => ({
          ...setting,
          label: own[setting.name]?.label ?? setting.label,
          hint: own[setting.name]?.hint ?? setting.hint,
          requires: requires[setting.name],
        })),
      };
    }
    const code = i18n.pick(Object.keys(plugin.locales ?? {}));
    const locale = code ? plugin.locales[code] : null;
    if (!locale) return plugin;
    return {
      ...plugin,
      name: locale.name ?? plugin.name,
      description: locale.description ?? plugin.description,
      settings: plugin.settings.map((setting) => {
        const own = locale.settings?.[setting.name];
        if (!own) return setting;
        return {
          ...setting,
          label: own.label ?? setting.label,
          hint: own.hint ?? setting.hint,
          options: setting.options?.map((option) => ({ ...option, label: own.options?.[option.name] ?? option.label })),
        };
      }),
    };
  }

  /** Значок плагина из его папки: SVG — цветом текста, картинка — как есть */
  function pluginIcon(url) {
    if (!/\.svg$/i.test(new URL(url).pathname)) {
      return h("img", { class: "arachnid-plugin-icon", src: url, alt: "", draggable: "false" });
    }
    const mask = h("span", { class: "arachnid-plugin-icon", "aria-hidden": "true" });
    mask.style.setProperty("--arachnid-plugin-icon", `url("${url}")`);
    return mask;
  }

  function renderPluginsPage() {
    if (page?.kind !== "plugins" || !page.panel.isConnected) return;
    openSelect?.();
    const plugins = (overview?.plugins ?? []).map(localized);
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
        plugin.description,
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
        iconNode: plugin.icon ? pluginIcon(plugin.icon) : null,
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

    setChildren(
      page.panel,
      // заголовок, напротив него — папка плагинов
      h(
        "div",
        { class: "arachnid-page-header" },
        h("span", { class: "arachnid-title" }, text.plugins),
        button(text.openPlugins, () => openFolder("plugins"), undefined, "folder_open"),
      ),
      h(
        "div",
        { class: "arachnid-card" },
        icon("extension"),
        h(
          "div",
          { class: "arachnid-card-text" },
          h("span", { class: "arachnid-card-title" }, `${BRAND} ${version}`),
          h("span", { class: "arachnid-label", style: { color: "inherit" } }, text.about),
          overview?.author
            ? h("span", { class: "arachnid-label", style: { color: "inherit" } }, text.author(overview.author))
            : null,
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
      list.length ? h("div", { class: "arachnid-group" }, list) : null,
      actions.length
        ? h(
            "div",
            { class: "arachnid-column" },
            h("span", { class: "arachnid-subtitle" }, text.pluginActions),
            h("div", { class: "arachnid-group" }, actions),
          )
        : null,
    );
  }

  // ─────────────────────────── раздел «Горячие клавиши» ───────────────────────────
  // Назначения хранит Rust (hotkeys.rs); здесь — последний ответ:
  // { active, recording, bindings, actions }.
  let hotkeys = null;
  let hotkeysError = null;

  const QOL = "builtin:qol";
  /** Значки действий по порядку раздела */
  const HOTKEY_ICONS = {
    toggle_mute: "mic",
    toggle_deafen: "headset",
    disconnect: "call_end",
    toggle_camera: "videocam",
    toggle_screenshare: "screen_share",
    toggle_window: "web_asset",
  };

  /** Названия клавиш по виртуальным кодам Windows (у остальных — правила
   *  в keyName) */
  const KEY_NAMES = new Map([
    [0x08, "Backspace"],
    [0x09, "Tab"],
    [0x0c, "Clear"],
    [0x0d, "Enter"],
    [0x13, "Pause"],
    [0x14, "Caps Lock"],
    [0x1b, "Esc"],
    [0x21, "Page Up"],
    [0x22, "Page Down"],
    [0x23, "End"],
    [0x24, "Home"],
    [0x25, "←"],
    [0x26, "↑"],
    [0x27, "→"],
    [0x28, "↓"],
    [0x2c, "Print Screen"],
    [0x2d, "Insert"],
    [0x2e, "Delete"],
    [0x5d, "Menu"],
    [0x6a, "Num *"],
    [0x6b, "Num +"],
    [0x6d, "Num -"],
    [0x6e, "Num ."],
    [0x6f, "Num /"],
    [0x90, "Num Lock"],
    [0x91, "Scroll Lock"],
    [0xad, "Volume Mute"],
    [0xae, "Volume Down"],
    [0xaf, "Volume Up"],
    [0xb0, "Next Track"],
    [0xb1, "Previous Track"],
    [0xb2, "Stop"],
    [0xb3, "Play/Pause"],
    [0xba, ";"],
    [0xbb, "="],
    [0xbc, ","],
    [0xbd, "-"],
    [0xbe, "."],
    [0xbf, "/"],
    [0xc0, "`"],
    [0xdb, "["],
    [0xdc, "\\"],
    [0xdd, "]"],
    [0xde, "'"],
    [0xe2, "\\"],
  ]);

  function keyName(code) {
    if (code === 0x20) return text.keyNames.space;
    // цифры и латинские буквы — коды их символов
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)) return String.fromCharCode(code);
    if (code >= 0x60 && code <= 0x69) return `Num ${code - 0x60}`;
    if (code >= 0x70 && code <= 0x87) return `F${code - 0x6f}`;
    return KEY_NAMES.get(code) ?? text.keyNames.key(code);
  }

  /** Клавиши сочетания hotkeys.rs: «ctrl+shift+key:120» → Ctrl, Shift, F9 */
  function comboParts(combo) {
    return combo.split("+").map((part) => {
      if (part === "ctrl") return "Ctrl";
      if (part === "shift") return "Shift";
      if (part === "alt") return "Alt";
      if (part === "win") return text.keyNames.win;
      if (part.startsWith("mouse:")) return text.keyNames[part.slice("mouse:".length)] ?? part;
      if (part.startsWith("key:")) return keyName(Number(part.slice("key:".length)));
      return part;
    });
  }

  /** Раздел виден, пока включены «Quality of Life» и её настройка `hotkeys` */
  function hotkeysEnabled() {
    const qol = overview?.plugins?.find((plugin) => plugin.file === QOL);
    return Boolean(qol?.enabled && qol.values?.hotkeys === "1");
  }

  /** Команда hotkeys.rs, которая возвращает новое состояние */
  function hotkeysCommand(command, args) {
    return invoke(command, args).then(
      (next) => {
        hotkeys = next;
        hotkeysError = null;
        renderHotkeysPage();
      },
      (error) => {
        console.warn(`[Arachnid] ${command}:`, error);
        hotkeysError = i18n.errorText(error);
        renderHotkeysPage();
      },
    );
  }

  const refreshHotkeys = () => hotkeysCommand("hotkeys_overview");

  function renderHotkeysPage() {
    if (page?.kind !== "hotkeys" || !page.panel.isConnected) return;
    const rows = (hotkeys?.actions ?? []).map((action) => {
      const combo = hotkeys.bindings[action];
      const recording = hotkeys.recording === action;
      let description = text.hotkeyNone;
      if (recording) description = text.hotkeyRecording;
      else if (combo) {
        description = h(
          "span",
          { class: "arachnid-keys" },
          comboParts(combo).map((part) => h("span", { class: "arachnid-key" }, part)),
        );
      }
      const buttons = [
        combo && !recording
          ? iconButton("backspace", text.clearHotkey, () => void hotkeysCommand("hotkeys_set", { action, code: null }))
          : null,
        recording
          ? button(text.cancel, () => void hotkeysCommand("hotkeys_record", { action: null }), "text")
          : button(text.assignHotkey, () => void hotkeysCommand("hotkeys_record", { action })),
      ];
      const row = item({
        iconName: HOTKEY_ICONS[action] ?? "keyboard",
        title: text.hotkeyActions[action] ?? action,
        description,
        action: h("div", { class: "arachnid-item-actions" }, buttons),
      });
      row.dataset.arachnidHotkey = action;
      if (recording) row.dataset.recording = "";
      return row;
    });

    setChildren(
      page.panel,
      h("div", { class: "arachnid-page-header" }, h("span", { class: "arachnid-title" }, text.hotkeys)),
      h("span", { class: "arachnid-label" }, text.hotkeysIntro),
      // настройку включили, а «Quality of Life» ещё не запущена
      hotkeys && !hotkeys.active
        ? h(
            "div",
            { class: "arachnid-banner", role: "status" },
            icon("restart_alt"),
            h("span", {}, text.hotkeysInactive),
            button(text.reload, () => location.reload(), "filled"),
          )
        : null,
      hotkeysError
        ? h("span", { class: "arachnid-label", role: "alert", style: { color: "var(--md-sys-color-error)" } }, hotkeysError)
        : null,
      rows.length ? h("div", { class: "arachnid-group" }, rows) : null,
    );
  }

  function renderPage() {
    renderPluginsPage();
    renderHotkeysPage();
  }

  /** Показать раздел вместо текущей страницы настроек */
  function openPage(sidebar, entry, kind) {
    const content = sidebar.nextElementSibling;
    const column = content?.querySelector(".settings_cont")?.firstElementChild;
    if (!column) return;
    if (page?.column === column && page.kind === kind && page.panel.isConnected) return;
    closePage();

    const panel = h("div", { class: "arachnid-page", dataset: { arachnidPanel: "" } });
    column.append(panel);
    column.dataset.arachnidContentPage = kind;
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

    page = { kind, sidebar, entry, column, panel, observer };
    content.scrollTop = 0;
    renderPage();
    void refresh();
    if (kind === "hotkeys") void refreshHotkeys();
  }

  function closePage() {
    if (!page) return;
    // ушли из раздела, не нажав сочетание: запись отменяется
    if (page.kind === "hotkeys" && hotkeys?.recording) {
      hotkeys = { ...hotkeys, recording: null };
      void invoke("hotkeys_record", { action: null }).catch(() => {});
    }
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

  /**
   * Свой пункт — копия пункта for-web: «Плагины» (копия «Внешнего вида» со
   * значком extension) или «Горячие клавиши» (копия «ПК» со значком
   * keyboard). `svgIcon` — значок для пункта со значком svg.
   */
  function createEntry(sidebar, template, { kind, textKey, symbol: symbolName, svgIcon }) {
    const entry = template.cloneNode(true);
    entry.className = plainClass(sidebar) ?? template.className;
    entry.removeAttribute("id");
    entry.removeAttribute("href");
    entry.removeAttribute("data-arachnid-muted");
    entry.setAttribute("aria-selected", "false");
    entry.setAttribute("role", "button");
    entry.dataset.arachnidEntry = kind;

    const svg = entry.querySelector("svg");
    let label;
    if (svg) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", svgIcon.path);
      svg.replaceChildren(path);
      svg.setAttribute("viewBox", svgIcon.viewBox);
      label = svg.nextElementSibling;
    } else {
      // значок шрифтом Material Symbols
      const symbol = entry.querySelector(".material-symbols-outlined");
      if (symbol) symbol.textContent = symbolName;
      label = symbol?.nextElementSibling;
    }
    // подпись — самый вложенный элемент (OverflowingText)
    while (label?.firstElementChild) label = label.firstElementChild;
    translated(label ?? entry, textKey);

    entry.addEventListener("click", (event) => {
      event.preventDefault();
      openPage(sidebar, entry, kind);
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

    let entry = sidebar.querySelector('a.button[data-arachnid-entry="plugins"]');
    if (!entry) {
      entry = createEntry(sidebar, appearanceEntry, {
        kind: "plugins",
        textKey: "plugins",
        symbol: "extension",
        svgIcon: EXTENSION_ICON,
      });
    }
    // for-web мог перерисовать список: пункт остаётся после «Внешнего вида»
    if (appearanceEntry.nextElementSibling !== entry) appearanceEntry.after(entry);
    ensureHotkeysEntry(sidebar);

    if (!sidebar.dataset.arachnidListening) {
      sidebar.dataset.arachnidListening = "";
      // повторный щелчок по странице, которую for-web считает открытой:
      // она не перерисуется, поэтому раздел закрывается сам; остальные
      // страницы for-web заменят раздел сами
      sidebar.addEventListener(
        "click",
        (event) => {
          // язык могли сменить на странице «Язык»
          void i18n.refresh();
          const link = event.target instanceof Element ? event.target.closest("a.button") : null;
          if (page && link && link.hasAttribute("data-arachnid-muted")) closePage();
        },
        true,
      );
    }
  }

  /**
   * Пункт «Горячие клавиши» сразу после «ПК» — пока включена настройка
   * `hotkeys` «Quality of Life». Выключили — пункт и раздел убираются.
   */
  function ensureHotkeysEntry(sidebar) {
    const desktopEntry = findDesktopEntry(sidebar);
    let entry = sidebar.querySelector('a.button[data-arachnid-entry="hotkeys"]');
    if (!desktopEntry || !hotkeysEnabled()) {
      if (page?.kind === "hotkeys" && page.sidebar === sidebar) closePage();
      entry?.remove();
      return;
    }
    if (!entry) {
      entry = createEntry(sidebar, desktopEntry, { kind: "hotkeys", textKey: "hotkeys", symbol: HOTKEYS_ICON });
    }
    if (desktopEntry.nextElementSibling !== entry) desktopEntry.after(entry);
  }

  // ─────────────────────────── группы боковой панели ───────────────────────────
  // Порядок for-web (UserSettings.tsx): «Настройки пользователя» (профиль,
  // сессии), «Stoat» (мои боты, обратная связь), «Настройки клиента» (с «ПК»)
  // и группа без заголовка: «Что нового», «Исходный код», «Расширенные»,
  // «Пожертвовать», «Выйти». Клиент меняет её так:
  //
  // * «Мои боты» — в «Настройки пользователя», «Обратная связь» — между
  //   «Исходным кодом» и «Расширенными»; опустевшая группа «Stoat» скрыта;
  // * у последней группы — заголовок «О программе»;
  // * перед ней — своя группа «О клиенте» со ссылками на репозиторий клиента.
  //
  // Группы узнаются по месту относительно группы с «ПК», пункты — по месту в
  // группе (заголовки и подписи зависят от языка), а там, где for-web рисует
  // значки шрифтом Material Symbols, — ещё и по значку. Узнанные пункты
  // помечаются (data-arachnid-role): перенесённые остаются узнаваемыми.
  // Если for-web перерисует список, новые пункты снова окажутся на своих
  // местах — они переносятся заново, а старые убираются.

  /** Пункты группы «Stoat» и последней группы по порядку; значки — из for-web main */
  const STOAT_ROLES = [
    { role: "bots", symbol: "smart_toy" },
    { role: "feedback", symbol: "rate_review" },
  ];
  const ABOUT_ROLES = [
    { role: "news", symbol: "campaign" },
    { role: "source", symbol: "memory" },
    { role: "advanced", symbol: "science" },
    { role: "donate", symbol: "coffee" },
  ];

  /** Ссылки группы «О клиенте»: путь от адреса репозитория */
  const CLIENT_LINKS = [
    { id: "source", symbol: "code", textKey: "sourceCode", path: "" },
    { id: "releases", symbol: "new_releases", textKey: "releases", path: "/releases" },
    { id: "issues", symbol: "bug_report", textKey: "issues", path: "/issues" },
  ];

  /** Значок пункта шрифтом Material Symbols; null — значок svg */
  const symbolOf = (link) => link.querySelector(".material-symbols-outlined")?.textContent.trim() ?? null;

  /** Пункты for-web в списке группы (без своих) */
  const ownLinks = (list) =>
    [...list.children].filter((child) => child.matches("a.button") && !child.hasAttribute("data-arachnid-entry"));

  /**
   * Группа for-web — `Column` с заголовком (span) и списком пунктов (div);
   * `titled` — у неё должен быть заголовок.
   */
  function isCategory(element, titled) {
    if (!element || element.hasAttribute("data-arachnid-category")) return false;
    const list = element.lastElementChild;
    if (list?.localName !== "div") return false;
    const title = element.firstElementChild;
    return titled ? title !== list && title.localName === "span" : true;
  }

  /** Соседняя группа for-web (свои группы пропускаются) */
  function siblingCategory(element, forward) {
    let next = forward ? element.nextElementSibling : element.previousElementSibling;
    while (next?.hasAttribute("data-arachnid-category")) next = forward ? next.nextElementSibling : next.previousElementSibling;
    return next;
  }

  /** Группы боковой панели или null, если разметка не та */
  function sidebarCategories(sidebar) {
    const client = findDesktopEntry(sidebar)?.parentElement?.parentElement;
    if (!client || client === sidebar || !sidebar.contains(client) || !isCategory(client, true)) return null;
    const stoat = siblingCategory(client, false);
    const user = stoat && siblingCategory(stoat, false);
    const about = siblingCategory(client, true);
    if (!isCategory(stoat, true) || !isCategory(user, true) || !isCategory(about, false)) return null;
    return { user, stoat, client, about };
  }

  /**
   * Пометить пункты списка ролями, если там ровно эти пункты for-web (или,
   * для последней группы, они и «Выйти»). Старые пункты с теми же ролями —
   * от прошлой отрисовки for-web — убираются.
   */
  function markRoles(sidebar, list, roles, extra) {
    const links = ownLinks(list).filter((link) => !link.dataset.arachnidRole);
    if (links.length !== roles.length + extra) return;
    const fits = roles.every(({ symbol }, index) => {
      const shown = symbolOf(links[index]);
      return shown === null || shown === symbol;
    });
    if (!fits) return;
    roles.forEach(({ role }, index) => {
      for (const old of sidebar.querySelectorAll(`a.button[data-arachnid-role="${role}"]`)) old.remove();
      links[index].dataset.arachnidRole = role;
    });
  }

  /** Заголовок группы — с классом заголовка for-web */
  function categoryTitle(template, textKey) {
    return translated(h("span", { class: template.className, dataset: { arachnidTitle: "" } }), textKey);
  }

  /** Ссылка группы «О клиенте» — копия пункта «ПК» со своим значком */
  function clientLink(sidebar, template, link) {
    const entry = template.cloneNode(true);
    entry.className = plainClass(sidebar) ?? template.className;
    entry.removeAttribute("id");
    entry.removeAttribute("href");
    entry.removeAttribute("data-arachnid-muted");
    entry.setAttribute("aria-selected", "false");
    entry.setAttribute("role", "link");
    entry.dataset.arachnidEntry = `client-${link.id}`;
    const symbol = entry.querySelector(".material-symbols-outlined");
    symbol.textContent = link.symbol;
    let label = symbol.nextElementSibling;
    while (label?.firstElementChild) label = label.firstElementChild;
    translated(label ?? entry, link.textKey);
    entry.addEventListener("click", (event) => {
      event.preventDefault();
      // ссылки for-web открываются так же: window.open, клиент отдаёт их системе
      const open = () => overview?.repository && window.open(`${overview.repository}${link.path}`, "_blank");
      if (overview) open();
      else void refresh().then(open);
    });
    return entry;
  }

  function arrangeSidebar(sidebar) {
    const categories = sidebarCategories(sidebar);
    if (!categories) return;
    const { user, stoat, about } = categories;
    if (!overview) void refresh();

    markRoles(sidebar, stoat.lastElementChild, STOAT_ROLES, 0);
    markRoles(sidebar, about.lastElementChild, ABOUT_ROLES, 1);
    const role = (name) => sidebar.querySelector(`a.button[data-arachnid-role="${name}"]`);

    const bots = role("bots");
    if (bots && bots.parentElement !== user.lastElementChild) user.lastElementChild.append(bots);
    const feedback = role("feedback");
    const advanced = role("advanced");
    if (feedback && advanced && feedback.nextElementSibling !== advanced) advanced.before(feedback);
    stoat.toggleAttribute("data-arachnid-hidden", !stoat.lastElementChild.querySelector("a.button"));

    const titleTemplate = user.firstElementChild;
    if (!about.querySelector(":scope > [data-arachnid-title]")) about.prepend(categoryTitle(titleTemplate, "aboutApp"));

    let client = sidebar.querySelector('[data-arachnid-category="client"]');
    if (!client) {
      const template = findDesktopEntry(sidebar);
      client = h(
        "div",
        { class: about.className, dataset: { arachnidCategory: "client" } },
        categoryTitle(titleTemplate, "aboutClient"),
        h(
          "div",
          { class: about.lastElementChild.className },
          CLIENT_LINKS.map((link) => clientLink(sidebar, template, link)),
        ),
      );
    }
    if (about.previousElementSibling !== client) about.before(client);
  }

  // ───────────────────────────── «Внешний вид» ─────────────────────────────
  /** Обработанная страница: { root, picker, colours, block, title, label, actions } */
  let appearance = null;

  /** Текст заголовка страницы for-web (без своих кнопок) */
  const titleText = (title, actions) =>
    [...title.childNodes]
      .filter((node) => node !== actions)
      .map((node) => node.textContent)
      .join("")
      .trim();

  /**
   * Кнопки «Папка тем» и «QuickCSS» — справа напротив заголовка «Внешний
   * вид», как «Папка плагинов» в «Плагинах». Заголовок — первый элемент
   * колонки (Text с Breadcrumbs): он один на все страницы настроек, поэтому
   * кнопки стоят в нём, только пока открыт «Внешний вид» и заголовок тот
   * же — for-web меняет его сразу при переходе, а страница уходит после
   * анимации.
   */
  function syncAppearanceActions() {
    const current = appearance;
    if (!current?.title) return;
    const shown = current.root.isConnected && current.title.isConnected && titleText(current.title, current.actions) === current.label;
    if (!shown) return hideAppearanceActions(current);
    current.title.setAttribute("data-arachnid-title-row", "");
    if (current.actions.parentElement !== current.title) current.title.append(current.actions);
  }

  function hideAppearanceActions(current) {
    if (!current.title) return;
    current.actions.remove();
    current.title.removeAttribute("data-arachnid-title-row");
  }

  /** Найти «Внешний вид» в колонке страницы настроек */
  function findAppearance(column) {
    for (const wrapper of column.children) {
      const root = wrapper.firstElementChild;
      const welcome = root?.firstElementChild;
      if (welcome && welcome.textContent.trimStart().startsWith(WELCOME)) return { root, welcome };
    }
    return null;
  }

  /** Те же кнопки, что «Папка плагинов» в разделе «Плагины» */
  const appearanceButtons = () => [
    button(text.openThemes, () => openFolder("themes"), undefined, "folder_open"),
    button(text.quickCss, openQuickCss, undefined, "css"),
  ];

  function enhanceAppearance(content) {
    const column = content.querySelector(".settings_cont")?.firstElementChild;
    if (!column) return;
    if (appearance?.root.isConnected && column.contains(appearance.root)) return;
    if (appearance) hideAppearanceActions(appearance);
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

    const actions = h("div", { class: "arachnid-buttons", dataset: { arachnidAppearance: "actions" } }, appearanceButtons());
    // заголовок страницы — span перед блоком страницы; если его нет
    // (разметка for-web изменилась), кнопки остаются над выбором темы
    const title = column.firstElementChild;
    const titled = title?.localName === "span" && !title.contains(root);
    if (!titled) picker.before(actions);

    appearance = {
      root,
      picker,
      colours: coloursTitle === "Colours" ? colours : null,
      block,
      title: titled ? title : null,
      label: titled ? titleText(title, actions) : "",
      actions,
    };
    syncAppearanceActions();
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
      : null;

    setChildren(
      appearance.picker,
      // как выбор языка в for-web
      categorySelect({
        iconName: "palette",
        title: text.theme,
        value: active?.file ?? "",
        options: [
          { value: "", label: text.defaultTheme },
          ...themes.map((theme) => ({
            value: theme.file,
            label: theme.name ?? theme.file,
            description: theme.author ? text.author(theme.author) : undefined,
          })),
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
   * выбор, ползунок, число, цвет, текст; под полем — пояснение `hint`.
   * `set(name, value)` сохраняет.
   */
  function settingControls(settings, values, set) {
    return settings.map((setting) => {
      const control = settingControl(setting, values[setting.name] ?? setting.default, set);
      if (!setting.hint || setting.kind === "checkbox") return control;
      return h(
        "div",
        { class: "arachnid-column", style: { gap: "4px" } },
        control,
        h("span", { class: "arachnid-label" }, setting.hint),
      );
    });
  }

  function settingControl(setting, value, set) {
    switch (setting.kind) {
      case "checkbox": {
        const box = checkbox(value === "1", setting.label);
        const input = box instanceof HTMLInputElement ? box : box.querySelector?.("input") ?? box;
        input.dataset.arachnidSetting = setting.name;
        input.disabled = Boolean(setting.disabled);
        input.addEventListener("change", () => set(setting.name, input.checked ? "1" : "0"));
        if (input.classList?.contains("arachnid-checkbox")) input.style.pointerEvents = "auto";
        if (!setting.hint) return box;
        // пояснение — под подписью флажка
        return h(
          "div",
          { class: "arachnid-column", style: { gap: "0" } },
          box,
          h("span", { class: "arachnid-label arachnid-setting-hint" }, setting.hint),
        );
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

  /**
   * Настройки плагина — окно, как у QuickCSS: у плагина-папки — из
   * plugin.toml и его перевода, у встроенного — свои (подписи и пояснения
   * из словаря клиента). Значение сохраняется сразу.
   */
  function openPluginSettings(file) {
    const current = () => {
      const plugin = overview?.plugins?.find((entry) => entry.file === file);
      return plugin ? localized(plugin) : null;
    };
    const plugin = current();
    if (!plugin || !document.body) return;
    const body = h("div", { class: "arachnid-column" });
    const set = (name, value) => {
      // зависимые флажки доступны, только пока включён их флажок
      for (const setting of plugin.settings) {
        if (setting.requires !== name) continue;
        const input = body.querySelector(`[data-arachnid-setting="${CSS.escape(setting.name)}"]`);
        if (input) input.disabled = value !== "1";
      }
      void change("extensions_set_plugin_value", { file, name, value }, false);
    };
    const fill = () => {
      const shown = current();
      if (!shown) return;
      const settings = shown.settings.map((setting) =>
        setting.requires === undefined ? setting : { ...setting, disabled: shown.values[setting.requires] !== "1" },
      );
      body.replaceChildren(...settingControls(settings, shown.values, set));
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
        .catch((error) => setStatus(text.saveFailed(i18n.errorText(error)), true))
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
      (error) => setStatus(i18n.errorText(error), true),
    );
  }

  // ─────────────────────────────── обход ───────────────────────────────

  function renderAll() {
    renderPage();
    renderAppearance();
    // пункт «Горячие клавиши» зависит от настроек «Quality of Life»
    queueScan();
  }

  /** Открыты ли настройки при прошлой проверке */
  let settingsOpen = false;

  function scan() {
    if (page && !page.panel.isConnected) closePage();
    const sidebars = document.querySelectorAll(".settings_sidebar");
    // настройки закрыли: язык могли сменить
    if (settingsOpen && !sidebars.length) void i18n.refresh();
    settingsOpen = sidebars.length > 0;
    for (const sidebar of sidebars) {
      if (!isUserSettings(sidebar)) continue;
      ensureEntry(sidebar);
      arrangeSidebar(sidebar);
      const content = sidebar.nextElementSibling;
      if (content) enhanceAppearance(content);
    }
    syncAppearanceActions();
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

  // сменили язык интерфейса: подписи в разметке for-web и свои страницы
  i18n.onChange(() => {
    for (const element of document.querySelectorAll("[data-arachnid-text]")) {
      element.textContent = text[element.dataset.arachnidText];
    }
    appearance?.actions.replaceChildren(...appearanceButtons());
    renderAll();
  });

  desktop.subscribe((type) => {
    if (type === "extensions") void refresh();
    else if (type === "menu") renderPluginsPage();
    else if (type === "quickcss") quickCss?.reload();
    else if (type === "open-quickcss") openQuickCss();
    else if (type === "hotkeys") void refreshHotkeys();
  });

  function start() {
    mountStyle();
    new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
    queueScan();
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
