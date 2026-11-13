// Избранные GIF в окне выбора GIF, как в Discord: часть встроенного плагина
// «Quality of Life» (выполняется вместе с emoji.js).
//
// * В сетке категорий Gifbox первая плитка — «Избранное». Внутри — свой
//   поиск (по каждому слову описания, запроса Gifbox и ссылки), кнопка «+»
//   (GIF по любой ссылке: на файл, на вложение Stoat, на страницу Tenor,
//   Giphy, Imgur и любого сайта с GIF или видео в тегах Open Graph) и сетка в
//   две колонки: каждая GIF — в более короткую колонку, по порядку, как
//   читается текст. Порядок меняется перетаскиванием, новые — в начале.
// * Добавить и убрать — через меню правой кнопки: у GIF, картинок и видео в
//   чате (пункт for-web рядом с «Copy link to file»), у плиток Gifbox и в
//   самом избранном (там же «Отправить», «Переместить в самый верх»,
//   «Изменить описание», «Копировать ссылку»). Звёздочек на плитках нет.
// * Над результатами поиска Gifbox — ряд «Из избранного» с подходящими GIF.
// * GIF в избранном и в Gifbox воспроизводятся, только пока на них наведён
//   указатель; до того видно превью — один кадр. Превью делает эта
//   страница (WebView2 умеет разбирать всё, что показывает), а файлы для
//   него скачивает и хранит клиент (favorite_gifs.rs): список и превью в
//   несколько килобайт — в каталоге данных, на этом компьютере. Сами GIF не
//   сохраняются — только ссылки.
// * Отправка — как у Gifbox for-web: ссылка уходит сообщением в открытый
//   канал через API Stoat с сессией страницы, набранный текст не меняется.
//   Окно, открытое с панели сообщения, отвечает на это сообщение (как for-web).
//
// for-web ничего не знает об избранном: всё, что видно, добавляет скрипт,
// а элементы for-web он только скрывает и показывает. Работает только там,
// где bridge.js создал window.__arachnidDesktop.
(() => {
  "use strict";

  const desktop = window.__arachnidDesktop;
  const internals = window.__TAURI_INTERNALS__;
  if (!desktop || !internals) return;

  const invoke = (command, args) => internals.invoke(command, args);

  // ─────────────────────────────── данные ───────────────────────────────
  const SEARCH_PLACEHOLDER = "Search for GIFs...";
  /** Сервер Gifbox for-web (Instance.ts), если запросов к нему ещё не было */
  const GIFBOX_URL = "https://api.gifbox.me";
  /** Ширина превью */
  const PREVIEW_WIDTH = 240;
  /** Самое высокое превью — во столько раз выше ширины */
  const PREVIEW_MAX_RATIO = 4;
  /** Плитка не ниже и не выше стольких ширин колонки */
  const TILE_MIN_RATIO = 0.3;
  const TILE_MAX_RATIO = 2.5;
  /** Высота ряда «Из избранного» и сколько в нём GIF */
  const ROW_HEIGHT = 96;
  const ROW_LIMIT = 24;
  /** Запас над и под видимой частью сетки, px */
  const OVERSCAN = 400;
  /** Сдвиг указателя, после которого нажатие становится перетаскиванием */
  const DRAG_THRESHOLD = 6;
  /** Полоса у края сетки, где перетаскивание прокручивает её */
  const SCROLL_EDGE = 40;
  /** Окно, открытое щелчком по сообщению за столько мс, отвечает на него */
  const REPLY_WINDOW = 3000;
  const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  /** Значки пунктов меню for-web (outlined, 24×24) */
  const STAR_PATH =
    "m22 9.24-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z";
  const STAR_FILLED_PATH = "M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27z";

  // Как и остальные добавления клиента — на языке системы.
  const russian = /^ru\b/i.test(navigator.language || "");
  const text = russian
    ? {
        favorites: "Избранное",
        fromFavorites: "Из избранного",
        search: "Поиск в избранном",
        back: "Назад",
        addByLink: "Добавить GIF по ссылке",
        add: "Добавить в избранное",
        remove: "Убрать из избранного",
        send: "Отправить",
        moveTop: "Переместить в самый верх",
        describe: "Изменить описание",
        copyLink: "Копировать ссылку",
        emptyTitle: "В избранном пока пусто",
        emptyBody:
          "Добавляйте GIF через меню правой кнопки — в чате и в Gifbox — или по ссылке кнопкой «+».",
        notFound: "В избранном такого нет",
        dialogAdd: "GIF по ссылке",
        dialogDescribe: "Описание GIF",
        link: "Ссылка",
        linkHint: "На GIF, видео, вложение Stoat или страницу Tenor, Giphy, Imgur…",
        description: "Описание",
        descriptionHint: "По словам описания GIF найдётся в поиске",
        checking: "Проверяем ссылку…",
        cancel: "Отмена",
        confirm: "Добавить",
        save: "Сохранить",
        added: "Добавлено в избранное",
        removed: "Убрано из избранного",
        copied: "Ссылка скопирована",
        failed: "Не получилось",
        noChannel: "Откройте канал, чтобы отправить GIF",
        signedOut: "нет сессии Stoat",
        badMedia: "файл не открывается как картинка или видео",
      }
    : {
        favorites: "Favorites",
        fromFavorites: "From Favorites",
        search: "Search favorites",
        back: "Back",
        addByLink: "Add a GIF by link",
        add: "Add to Favorites",
        remove: "Remove from Favorites",
        send: "Send",
        moveTop: "Move to Top",
        describe: "Edit Description",
        copyLink: "Copy Link",
        emptyTitle: "No favorite GIFs yet",
        emptyBody: "Add GIFs from the right-click menu — in chat and in Gifbox — or by link with the + button.",
        notFound: "No favorites match",
        dialogAdd: "GIF by link",
        dialogDescribe: "GIF description",
        link: "Link",
        linkHint: "To a GIF, a video, a Stoat attachment or a Tenor, Giphy, Imgur… page",
        description: "Description",
        descriptionHint: "Search finds the GIF by the words of its description",
        checking: "Checking the link…",
        cancel: "Cancel",
        confirm: "Add",
        save: "Save",
        added: "Added to Favorites",
        removed: "Removed from Favorites",
        copied: "Link copied",
        failed: "Failed",
        noChannel: "Open a channel to send a GIF",
        signedOut: "no Stoat session",
        badMedia: "the file does not open as an image or a video",
      };

  const errorText = (error) => String(error?.message ?? error ?? "");

  // ─────────────────────────────── элементы ───────────────────────────────
  function h(tag, props, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") element.className = value;
      else if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.slice(2).toLowerCase(), value);
      } else element.setAttribute(key, value === true ? "" : String(value));
    }
    element.append(...children.filter((child) => child !== null && child !== undefined));
    return element;
  }

  const icon = (name) => h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, name);

  function iconButton(name, label, onClick) {
    return h("button", { type: "button", class: "arachnid-gifs-icon-button", title: label, "aria-label": label, onClick }, icon(name));
  }

  /**
   * Поле ввода for-web (mdui-text-field, TextField.tsx); где mdui нет —
   * обычное поле с тем же поведением (`value`, событие input).
   */
  function textField({ label, placeholder, helper, maxlength, clearable }) {
    if (customElements.get("mdui-text-field")) {
      return h("mdui-text-field", {
        variant: "outlined",
        label,
        placeholder,
        helper,
        maxlength,
        clearable,
        class: "arachnid-gifs-field",
      });
    }
    return h("input", { type: "text", placeholder: placeholder ?? label, "aria-label": label ?? placeholder, maxlength, class: "arachnid-gifs-field arachnid-gifs-plain-field" });
  }

  /** Не дать for-web закрыть окно GIF или меню: оно закрывается по нажатию вне себя */
  function keepFloating(element) {
    for (const type of ["mousedown", "pointerdown"]) {
      element.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  // Цвета и размеры — переменные Material 3 for-web, подходят к любой теме.
  // Плитки повторяют tileInteractive из GifPicker.tsx, меню — ContextMenu.tsx,
  // окно — Dialog.tsx.
  const STYLE = `
[data-arachnid-gifs-hidden] { display: none !important; }
.arachnid-gifs-tile,
.arachnid-gifs-category {
  position: relative;
  box-sizing: border-box;
  border-radius: var(--borderRadius-md);
  overflow: hidden;
  cursor: pointer;
  background-color: var(--md-sys-color-surface-container-highest);
  transition: translate 200ms cubic-bezier(0.2, 0, 0, 1), scale 200ms cubic-bezier(0.2, 0, 0, 1);
}
.arachnid-gifs-tile::after,
.arachnid-gifs-category::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-color: transparent;
  transition: background-color 150ms cubic-bezier(0.2, 0, 0, 1);
}
.arachnid-gifs-tile:hover::after,
.arachnid-gifs-category:hover::after {
  background-color: color-mix(in srgb, 8% var(--md-sys-color-on-surface), transparent);
}
.arachnid-gifs-tile:active::after,
.arachnid-gifs-category:active::after {
  background-color: color-mix(in srgb, 12% var(--md-sys-color-on-surface), transparent);
}
.arachnid-gifs-tile:active,
.arachnid-gifs-category:active { scale: 0.97; }
.arachnid-gifs-tile:focus-visible,
.arachnid-gifs-category:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}
.arachnid-gifs-grid > .arachnid-gifs-tile {
  position: absolute;
  left: 0;
  top: 0;
}
.arachnid-gifs-tile[data-dragging] {
  z-index: 2;
  cursor: grabbing;
  transition: scale 200ms cubic-bezier(0.2, 0, 0, 1);
  scale: 1.04;
  box-shadow: var(--md-sys-elevation-3, 0 4px 12px rgba(0, 0, 0, 0.4));
}
.arachnid-gifs-tile > img,
.arachnid-gifs-tile > video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
}
.arachnid-gifs-tile > .arachnid-gifs-live { opacity: 0; }
.arachnid-gifs-tile > .arachnid-gifs-live[data-ready] { opacity: 1; }
.arachnid-gifs-tile > .material-symbols-outlined {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  color: var(--md-sys-color-on-surface-variant);
  pointer-events: none;
}
.arachnid-gifs-category {
  width: 100%;
  aspect-ratio: 16 / 10;
  background-size: cover;
  background-position: center;
  display: flex;
  align-items: end;
  justify-content: start;
  padding: var(--gap-md);
  box-shadow: inset 0 -56px 48px -16px rgba(0, 0, 0, 0.7);
  background-image: linear-gradient(135deg, var(--md-sys-color-secondary), var(--md-sys-color-tertiary));
}
.arachnid-gifs-category > span {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: var(--gap-xs, 4px);
  color: white;
  font-size: 0.875rem;
  line-height: 1.25rem;
  letter-spacing: 0.00625rem;
  font-weight: 550;
}
.arachnid-gifs-category > span > .material-symbols-outlined {
  font-size: 18px;
  font-variation-settings: "FILL" 1;
}
.arachnid-gifs-view {
  flex-grow: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}
.arachnid-gifs-view[hidden] { display: none; }
.arachnid-gifs-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding-inline: var(--gap-md);
}
.arachnid-gifs-bar > .arachnid-gifs-field { flex-grow: 1; min-width: 0; cursor: text; }
.arachnid-gifs-plain-field {
  box-sizing: border-box;
  height: 56px;
  padding: 0 16px;
  border: 1px solid var(--md-sys-color-outline);
  border-radius: var(--borderRadius-xs, 4px);
  background: none;
  color: var(--md-sys-color-on-surface);
  font: inherit;
}
.arachnid-gifs-icon-button {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--md-sys-color-on-surface-variant);
  transition: background-color 150ms cubic-bezier(0.2, 0, 0, 1);
}
.arachnid-gifs-icon-button:hover {
  background: color-mix(in srgb, 8% var(--md-sys-color-on-surface-variant), transparent);
}
.arachnid-gifs-icon-button:active {
  background: color-mix(in srgb, 12% var(--md-sys-color-on-surface-variant), transparent);
}
.arachnid-gifs-icon-button > span { font-size: 24px; }
.arachnid-gifs-scroller {
  position: relative;
  flex-grow: 1;
  min-height: 0;
  overflow-y: auto;
  padding-inline: var(--gap-md);
  scrollbar-width: none;
  display: flex;
  flex-direction: column;
}
.arachnid-gifs-scroller::-webkit-scrollbar { display: none; }
.arachnid-gifs-grid {
  position: relative;
  flex-shrink: 0;
  gap: var(--gap-sm);
  margin-block: var(--gap-sm);
}
.arachnid-gifs-empty {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--gap-md);
  padding: var(--gap-lg);
  text-align: center;
  color: var(--md-sys-color-on-surface-variant);
}
.arachnid-gifs-empty[hidden] { display: none; }
.arachnid-gifs-title {
  font-size: 0.875rem;
  line-height: 1.25rem;
  letter-spacing: 0.00625rem;
  font-weight: 550;
  color: var(--md-sys-color-on-surface);
}
.arachnid-gifs-body {
  font-size: 0.75rem;
  line-height: 1rem;
  letter-spacing: 0.025rem;
  color: var(--md-sys-color-on-surface-variant);
}
.arachnid-gifs-row {
  display: flex;
  flex-direction: column;
  gap: var(--gap-sm);
  padding-block: var(--gap-sm);
}
.arachnid-gifs-row-tiles {
  display: flex;
  gap: var(--gap-sm);
  overflow-x: auto;
  scrollbar-width: none;
}
.arachnid-gifs-row-tiles::-webkit-scrollbar { display: none; }
.arachnid-gifs-row-tiles > .arachnid-gifs-tile {
  flex-shrink: 0;
  height: ${ROW_HEIGHT}px;
}
.arachnid-gifs-menu {
  position: fixed;
  z-index: 1001;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  padding: var(--gap-md) 0;
  overflow: hidden;
  border-radius: var(--borderRadius-xs);
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface);
  fill: var(--md-sys-color-on-surface);
  box-shadow: var(--md-sys-elevation-2);
  user-select: none;
  font-size: 0.875rem;
  line-height: 1.25rem;
}
.arachnid-gifs-menu-item {
  display: flex;
  gap: var(--gap-md);
  align-items: center;
  padding: var(--gap-md) var(--gap-lg);
  cursor: pointer;
}
.arachnid-gifs-menu-item:hover {
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
}
.arachnid-gifs-menu-item:active {
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent);
}
.arachnid-gifs-menu-item > .material-symbols-outlined { font-size: 16px; }
.arachnid-gifs-menu-item > span:not([aria-hidden="true"]) { flex-grow: 1; margin-top: 1px; }
.arachnid-gifs-menu-item[data-destructive] {
  color: var(--md-sys-color-error);
  fill: var(--md-sys-color-error);
}
.arachnid-gifs-menu-divider {
  height: 1px;
  margin: var(--gap-sm) 0;
  background: var(--md-sys-color-outline-variant);
}
.arachnid-gifs-scrim {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 30px;
  background: rgba(from var(--md-sys-color-scrim, #000) r g b / 0.32);
  user-select: none;
}
.arachnid-gifs-dialog {
  box-sizing: border-box;
  width: min(440px, 100%);
  max-height: 100%;
  overflow-y: auto;
  padding: 24px;
  border-radius: 28px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-high);
}
.arachnid-gifs-dialog-title {
  font-size: 1.5rem;
  line-height: 2rem;
  font-weight: 400;
}
.arachnid-gifs-dialog-preview {
  height: 180px;
  border-radius: var(--borderRadius-md);
  background: var(--md-sys-color-surface-container-highest);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.875rem;
  text-align: center;
  padding: 0 var(--gap-md);
}
.arachnid-gifs-dialog-preview > img,
.arachnid-gifs-dialog-preview > video {
  max-width: 100%;
  max-height: 100%;
  display: block;
}
.arachnid-gifs-dialog-preview[data-error] { color: var(--md-sys-color-error); }
.arachnid-gifs-dialog-actions {
  display: flex;
  justify-content: end;
  gap: 8px;
  margin-top: 8px;
}
.arachnid-gifs-text-button {
  height: 40px;
  padding: 0 16px;
  border: none;
  border-radius: 20px;
  background: none;
  color: var(--md-sys-color-primary);
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 150ms cubic-bezier(0.2, 0, 0, 1);
}
.arachnid-gifs-text-button:hover {
  background: color-mix(in srgb, 8% var(--md-sys-color-primary), transparent);
}
.arachnid-gifs-text-button:disabled {
  color: color-mix(in srgb, 38% var(--md-sys-color-on-surface), transparent);
  background: none;
  cursor: default;
}
.arachnid-gifs-snackbar {
  position: fixed;
  left: 50%;
  bottom: 24px;
  z-index: 1002;
  translate: -50% 0;
  max-width: min(560px, calc(100% - 48px));
  padding: 14px 16px;
  border-radius: var(--borderRadius-xs, 4px);
  background: var(--md-sys-color-inverse-surface);
  color: var(--md-sys-color-inverse-on-surface);
  box-shadow: var(--md-sys-elevation-3, 0 4px 12px rgba(0, 0, 0, 0.4));
  font-size: 0.875rem;
  line-height: 1.25rem;
  pointer-events: none;
}
`;

  function ensureStyle() {
    if (document.getElementById("arachnid-gifs-style")) return;
    const style = h("style", { id: "arachnid-gifs-style" });
    style.textContent = STYLE;
    (document.head ?? document.documentElement).append(style);
  }

  // ─────────────────────────────── снэкбар ───────────────────────────────
  let snackbar = null;
  let snackbarTimer = 0;
  function toast(message) {
    snackbar?.remove();
    clearTimeout(snackbarTimer);
    snackbar = h("div", { class: "arachnid-gifs-snackbar", role: "status" }, message);
    document.body.append(snackbar);
    snackbarTimer = setTimeout(() => {
      snackbar?.remove();
      snackbar = null;
    }, 4000);
  }
  const failure = (error) => toast(`${text.failed}: ${errorText(error)}`);

  // ─────────────────────────────── избранное ───────────────────────────────
  /** Список клиента: `base` — начало адресов превью, `list` — по порядку */
  const store = { base: "", list: [], loading: null };
  const listeners = new Set();

  function changed() {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[favorite gifs]", error);
      }
    }
  }

  function load() {
    store.loading ??= invoke("favorite_gifs_list").then(
      (listing) => {
        store.base = listing.base;
        store.list = listing.favorites;
        changed();
        void makePreviews();
      },
      (error) => {
        store.loading = null;
        console.error("[favorite gifs]", error);
      },
    );
    return store.loading;
  }

  function put(favorite, { top = false } = {}) {
    const rest = store.list.filter((known) => known.id !== favorite.id);
    if (top) store.list = [favorite, ...rest];
    else store.list = store.list.map((known) => (known.id === favorite.id ? favorite : known));
    changed();
  }

  const findFavorite = (url) => (url ? (store.list.find((known) => known.url === url || known.media === url) ?? null) : null);
  const previewUrl = (favorite) => (favorite.preview ? `${store.base}${favorite.id}.webp?v=${favorite.preview}` : null);

  /** Слова поиска: всё, что не буквы и не цифры, разделяет слова */
  const words = (value) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  /** GIF подходят под запрос, если каждое слово входит в описание, запрос или ссылку */
  function matching(query) {
    const needles = words(query);
    if (needles.length === 0) return store.list;
    return store.list.filter((favorite) => {
      const haystack = `${favorite.description} ${favorite.query} ${decoded(favorite.url)}`.toLowerCase();
      return needles.every((needle) => haystack.includes(needle));
    });
  }

  /** Ссылка с раскрытыми %-последовательностями: слова в ней тоже ищутся */
  function decoded(url) {
    try {
      return decodeURIComponent(url);
    } catch {
      return url;
    }
  }

  /** Превью, которое сейчас делается, и те, что не получились */
  const busy = new Set();
  const broken = new Set();

  /**
   * Добавить GIF. Если размеры неизвестны, сначала снимается кадр (он же —
   * превью); иначе превью делается после добавления.
   */
  async function addFavorite(entry, shot = null) {
    let { width, height, kind } = entry;
    if (!(width > 0 && height > 0)) {
      shot ??= await capture(entry.media, entry.kind);
      ({ width, height, kind } = shot);
    }
    const favorite = await invoke("favorite_gifs_add", {
      favorite: { ...entry, kind, width: Math.round(width), height: Math.round(height) },
    });
    put(favorite, { top: true });
    if (shot && !favorite.preview) {
      busy.add(favorite.id);
      try {
        put(await invoke("favorite_gifs_set_preview", { id: favorite.id, preview: Array.from(shot.webp) }));
      } catch (error) {
        console.warn("[favorite gifs] превью", error);
      } finally {
        busy.delete(favorite.id);
      }
    }
    void makePreviews();
    return favorite;
  }

  async function removeFavorite(favorite) {
    await invoke("favorite_gifs_remove", { id: favorite.id });
    store.list = store.list.filter((known) => known.id !== favorite.id);
    changed();
  }

  async function moveFavorite(favorite, index) {
    const rest = store.list.filter((known) => known.id !== favorite.id);
    rest.splice(Math.min(index, rest.length), 0, favorite);
    store.list = rest;
    changed();
    try {
      await invoke("favorite_gifs_move", { id: favorite.id, index });
    } catch (error) {
      failure(error);
      store.loading = null;
      await load();
    }
  }

  async function describeFavorite(favorite, description) {
    put(await invoke("favorite_gifs_describe", { id: favorite.id, description }));
  }

  // ─────────────────────────────── превью ───────────────────────────────
  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(text.badMedia)), ms))]);
  }

  /** Первый кадр файла: картинка (GIF, WebP, APNG…) или видео */
  async function firstFrame(blob, kind) {
    const asImage = async () => {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, kind: "image", close: () => bitmap.close() };
    };
    const asVideo = async () => {
      const url = URL.createObjectURL(blob);
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      const close = () => {
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
      };
      try {
        await withTimeout(
          new Promise((resolve, reject) => {
            video.addEventListener("loadeddata", resolve, { once: true });
            video.addEventListener("error", () => reject(new Error(text.badMedia)), { once: true });
            video.src = url;
          }),
          20000,
        );
      } catch (error) {
        close();
        throw error;
      }
      return { source: video, width: video.videoWidth, height: video.videoHeight, kind: "video", close };
    };
    const [first, second] = kind === "video" ? [asVideo, asImage] : [asImage, asVideo];
    try {
      return await first();
    } catch {
      try {
        return await second();
      } catch {
        throw new Error(text.badMedia);
      }
    }
  }

  /**
   * Скачать файл (клиентом: чужие сайты не дают странице рисовать свои
   * файлы на холсте) и снять первый кадр: WebP до 240 px в ширину.
   * `blob` — сам файл, для показа в окне «+».
   */
  async function capture(media, kind) {
    const buffer = await invoke("favorite_gifs_download", { url: media });
    const blob = new Blob([buffer]);
    const frame = await firstFrame(blob, kind);
    try {
      if (!(frame.width > 0 && frame.height > 0)) throw new Error(text.badMedia);
      const width = Math.min(PREVIEW_WIDTH, frame.width);
      const height = Math.max(1, Math.min(Math.round((width * frame.height) / frame.width), width * PREVIEW_MAX_RATIO));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(frame.source, 0, 0, width, height);
      const webp = await new Promise((resolve, reject) =>
        canvas.toBlob((result) => (result ? resolve(result) : reject(new Error(text.badMedia))), "image/webp", 0.8),
      );
      return {
        webp: new Uint8Array(await webp.arrayBuffer()),
        width: frame.width,
        height: frame.height,
        kind: frame.kind,
        blob,
      };
    } finally {
      frame.close();
    }
  }

  /**
   * Превью для GIF, у которых его нет (пропал файл, не успело сделаться), —
   * по одной. Не получилось — до перезапуска плитка остаётся без превью.
   */
  let making = false;
  async function makePreviews() {
    if (making) return;
    making = true;
    try {
      for (;;) {
        const favorite = store.list.find((known) => !known.preview && !busy.has(known.id) && !broken.has(known.id));
        if (!favorite) break;
        busy.add(favorite.id);
        try {
          const shot = await capture(favorite.media, favorite.kind);
          put(await invoke("favorite_gifs_set_preview", { id: favorite.id, preview: Array.from(shot.webp) }));
        } catch (error) {
          broken.add(favorite.id);
          console.warn("[favorite gifs] нет превью", favorite.url, error);
          changed();
        } finally {
          busy.delete(favorite.id);
        }
      }
    } finally {
      making = false;
    }
  }

  // ─────────────────────────────── Stoat ───────────────────────────────
  /** Сессия for-web из копии `auth` в localStorage */
  function sessionToken() {
    try {
      const token = JSON.parse(localStorage.getItem("auth") ?? "null")?.session?.token;
      return typeof token === "string" && token ? token : null;
    } catch {
      return null;
    }
  }

  /**
   * Адрес API: у stoat.chat — api.stoat.chat (env.ts for-web), у своего
   * сервера — из /.well-known/stoat, как for-web узнаёт API инстанса.
   */
  let apiUrl = null;
  async function api() {
    if (apiUrl) return apiUrl;
    if (location.hostname === "stoat.chat") return (apiUrl = "https://api.stoat.chat");
    try {
      const response = await fetch(`${location.origin}/.well-known/stoat`);
      const value = response.ok ? (await response.json())?.api : null;
      if (typeof value === "string" && /^https?:\/\//.test(value)) return (apiUrl = value.replace(/\/+$/, ""));
    } catch {
      // не удалось — попробуется при следующей отправке
    }
    return `${location.origin}/api`;
  }

  /** Ключ повтора отправки — ULID, как у for-web */
  function ulid() {
    let time = Date.now();
    let head = "";
    for (let i = 0; i < 10; i++) {
      head = CROCKFORD[time % 32] + head;
      time = Math.floor(time / 32);
    }
    const random = crypto.getRandomValues(new Uint8Array(16));
    return head + Array.from(random, (byte) => CROCKFORD[byte % 32]).join("");
  }

  async function request(method, path, body) {
    const token = sessionToken();
    if (!token) throw new Error(text.signedOut);
    const headers = { "X-Session-Token": token };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method === "POST") headers["Idempotency-Key"] = ulid();
    const response = await fetch(`${await api()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let type = "";
      try {
        type = (await response.json())?.type ?? "";
      } catch {
        // тело не JSON
      }
      throw new Error(`HTTP ${response.status}${type ? ` ${type}` : ""}`);
    }
    return response.status === 204 ? null : response.json();
  }

  const currentChannel = () => /\/channel\/([0-9A-HJKMNP-TV-Z]{26})(?:\/|$)/.exec(location.pathname)?.[1] ?? null;

  /** Id сообщения, внутри которого элемент (MessageContainer: id = id сообщения) */
  function messageOf(element) {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      if (ULID.test(node.id)) return node.id;
    }
    return null;
  }

  /**
   * Откуда открыто окно: щелчок по панели сообщения или пункт «Добавить
   * реакцию» его меню — тогда GIF отвечает на это сообщение, как у for-web
   * (Message.tsx); кнопка поля ввода — просто в канал.
   */
  const lastPointer = { message: null, time: 0 };
  function rememberPointer(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const floating = target.closest("#floating");
    if (floating) {
      // щелчок в меню for-web продолжает то, что начали на сообщении
      if (!target.closest(".arachnid-gifs-view")) lastPointer.time = Date.now();
      return;
    }
    lastPointer.message = messageOf(target);
    lastPointer.time = Date.now();
  }
  const replyTarget = () => (Date.now() - lastPointer.time < REPLY_WINDOW ? lastPointer.message : null);

  /** Окно выбора for-web закрывается нажатием вне себя (CompositionMediaPicker) */
  function closePicker() {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  }

  async function sendFavorite(favorite, picker) {
    const channel = currentChannel();
    if (!channel) {
      toast(text.noChannel);
      return;
    }
    const body = { content: favorite.url };
    if (picker?.replyTo) body.replies = [{ id: picker.replyTo, mention: true }];
    try {
      await request("POST", `/channels/${channel}/messages`, body);
    } catch (error) {
      failure(error);
      return;
    }
    closePicker();
    invoke("favorite_gifs_sent", { id: favorite.id }).then(
      () => {
        const known = store.list.find((item) => item.id === favorite.id);
        if (known) put({ ...known, sent: known.sent + 1, lastSent: Date.now() });
      },
      (error) => console.warn("[favorite gifs]", error),
    );
  }

  function copyLink(url) {
    navigator.clipboard.writeText(url).then(() => toast(text.copied), failure);
  }

  // ─────────────────────────────── меню ───────────────────────────────
  let menuState = null;
  const closeMenu = () => menuState?.close();

  /** Своё меню в стиле ContextMenu for-web у точки `x, y` */
  function showMenu(x, y, entries) {
    closeMenu();
    const menu = h("div", { class: "arachnid-gifs-menu", role: "menu" });
    for (const entry of entries) {
      if (entry === "divider") {
        menu.append(h("div", { class: "arachnid-gifs-menu-divider" }));
        continue;
      }
      const item = h(
        "a",
        { class: "arachnid-gifs-menu-item", role: "menuitem", "data-destructive": entry.destructive },
        icon(entry.icon),
        h("span", null, entry.label),
      );
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        entry.action();
      });
      menu.append(item);
    }
    keepFloating(menu);
    menu.addEventListener("contextmenu", (event) => event.preventDefault());
    document.body.append(menu);

    // как floating-ui for-web: offset 5, flip и shift
    const { width, height } = menu.getBoundingClientRect();
    let left = x + 5;
    let top = y + 5;
    if (left + width > innerWidth - 8) left = Math.max(8, x - 5 - width);
    if (top + height > innerHeight - 8) top = Math.max(8, y - 5 - height);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const onPointer = (event) => {
      if (!menu.contains(event.target)) close();
    };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    function close() {
      removeEventListener("pointerdown", onPointer, true);
      removeEventListener("keydown", onKey, true);
      removeEventListener("blur", close);
      removeEventListener("resize", close);
      menu.remove();
      if (menuState?.menu === menu) menuState = null;
    }
    addEventListener("pointerdown", onPointer, true);
    addEventListener("keydown", onKey, true);
    addEventListener("blur", close);
    addEventListener("resize", close);
    menuState = { menu, close };
    return menu;
  }

  /** Меню GIF из избранного */
  function favoriteMenu(event, favorite, picker) {
    event.preventDefault();
    event.stopPropagation();
    showMenu(event.clientX, event.clientY, [
      { icon: "send", label: text.send, action: () => void sendFavorite(favorite, picker) },
      {
        icon: "vertical_align_top",
        label: text.moveTop,
        action: () => void moveFavorite(favorite, 0),
      },
      { icon: "edit", label: text.describe, action: () => openDescribeDialog(favorite) },
      { icon: "link", label: text.copyLink, action: () => copyLink(favorite.url) },
      "divider",
      {
        icon: "star",
        label: text.remove,
        destructive: true,
        action: () => removeFavorite(favorite).then(() => toast(text.removed), failure),
      },
    ]);
  }

  // ─────────────────────────────── окно «+» ───────────────────────────────
  /**
   * Окно в стиле Dialog for-web: ссылка (новая GIF) или только описание.
   * Ссылка проверяется сразу: клиент находит по ней файл, страница снимает
   * кадр и показывает саму GIF.
   */
  function openDialog({ favorite = null } = {}) {
    closeMenu();
    const adding = favorite === null;
    const linkField = adding ? textField({ label: text.link, placeholder: "https://", helper: text.linkHint }) : null;
    const descriptionField = textField({ label: text.description, helper: text.descriptionHint, maxlength: 500 });
    if (!adding) descriptionField.value = favorite.description;
    const preview = h("div", { class: "arachnid-gifs-dialog-preview" });
    const cancel = h("button", { type: "button", class: "arachnid-gifs-text-button" }, text.cancel);
    const confirm = h("button", { type: "button", class: "arachnid-gifs-text-button", disabled: adding }, adding ? text.confirm : text.save);
    const dialog = h(
      "div",
      { class: "arachnid-gifs-dialog", role: "dialog", "aria-modal": "true", "aria-label": adding ? text.dialogAdd : text.dialogDescribe },
      h("div", { class: "arachnid-gifs-dialog-title" }, adding ? text.dialogAdd : text.dialogDescribe),
      preview,
      linkField,
      descriptionField,
      h("div", { class: "arachnid-gifs-dialog-actions" }, cancel, confirm),
    );
    const scrim = h("div", { class: "arachnid-gifs-scrim" }, dialog);
    keepFloating(scrim);

    /** Найденное по ссылке: `{ url, media, kind, shot }` */
    let found = null;
    let objectUrl = null;
    let checkTimer = 0;
    let checking = 0;
    let saving = false;

    function showMedia(src, kind) {
      const media =
        kind === "video"
          ? h("video", { autoplay: true, loop: true, playsinline: true })
          : h("img", { alt: "", draggable: "false" });
      if (kind === "video") media.muted = true;
      media.src = src;
      preview.removeAttribute("data-error");
      preview.replaceChildren(media);
    }

    function showStatus(message, error = false) {
      preview.toggleAttribute("data-error", error);
      preview.replaceChildren(message);
    }

    function release() {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }

    async function check() {
      const url = (linkField.value ?? "").trim();
      const turn = ++checking;
      found = null;
      confirm.disabled = true;
      release();
      if (!url) {
        showStatus("");
        return;
      }
      showStatus(text.checking);
      try {
        const known = findFavorite(url);
        const resolved = await invoke("favorite_gifs_resolve", { url });
        if (turn !== checking) return;
        const shot = await capture(resolved.media, resolved.kind);
        if (turn !== checking) return;
        objectUrl = URL.createObjectURL(shot.blob);
        showMedia(objectUrl, shot.kind);
        found = { url, media: resolved.media, kind: shot.kind, shot };
        if (known && !descriptionField.value) descriptionField.value = known.description;
        confirm.disabled = false;
      } catch (error) {
        if (turn === checking) showStatus(errorText(error), true);
      }
    }

    function close() {
      clearTimeout(checkTimer);
      checking++;
      release();
      scrim.remove();
    }

    async function save() {
      if (saving || confirm.disabled) return;
      saving = true;
      confirm.disabled = true;
      try {
        if (adding) {
          const { url, media, kind, shot } = found;
          await addFavorite(
            { url, media, kind, width: shot.width, height: shot.height, description: descriptionField.value ?? "", query: "" },
            shot,
          );
          toast(text.added);
        } else {
          await describeFavorite(favorite, descriptionField.value ?? "");
        }
        close();
      } catch (error) {
        saving = false;
        confirm.disabled = false;
        failure(error);
      }
    }

    linkField?.addEventListener("input", () => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(check, 500);
    });
    for (const field of [linkField, descriptionField]) {
      field?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void save();
        }
      });
    }
    cancel.addEventListener("click", close);
    confirm.addEventListener("click", () => void save());
    scrim.addEventListener("click", (event) => {
      if (event.target === scrim) close();
    });
    scrim.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    });

    if (adding) showStatus(text.linkHint);
    else {
      const src = previewUrl(favorite);
      if (favorite.media) showMedia(favorite.media, favorite.kind);
      else if (src) showMedia(src, "image");
    }
    document.body.append(scrim);
    requestAnimationFrame(() => (linkField ?? descriptionField).focus());
    return { scrim, linkField, descriptionField, confirm, check };
  }

  const openAddDialog = () => openDialog();
  const openDescribeDialog = (favorite) => openDialog({ favorite });

  // ─────────────────────────────── плитки ───────────────────────────────
  /** Плитка GIF: превью, а под указателем — сама GIF по ссылке */
  function createTile(favorite) {
    const tile = h("div", {
      class: "arachnid-gifs-tile",
      role: "listitem",
      tabindex: "0",
      title: favorite.description || favorite.url,
      "data-id": favorite.id,
    });
    fillTile(tile, favorite);
    tile.addEventListener("pointerenter", () => startLive(tile));
    tile.addEventListener("pointerleave", () => stopLive(tile));
    return tile;
  }

  function fillTile(tile, favorite) {
    tile.favorite = favorite;
    tile.title = favorite.description || favorite.url;
    const src = previewUrl(favorite);
    const still = tile.querySelector(":scope > .arachnid-gifs-still");
    if (src) {
      if (still?.getAttribute("src") === src) return;
      const image = h("img", { class: "arachnid-gifs-still", alt: "", draggable: "false", decoding: "async", src });
      tile.querySelector(":scope > .material-symbols-outlined")?.remove();
      if (still) still.replaceWith(image);
      else tile.prepend(image);
    } else {
      still?.remove();
      const name = broken.has(favorite.id) ? "broken_image" : "gif";
      const placeholder = tile.querySelector(":scope > .material-symbols-outlined");
      if (placeholder) placeholder.textContent = name;
      else tile.prepend(icon(name));
    }
  }

  function startLive(tile) {
    const favorite = tile.favorite;
    if (!favorite || tile.querySelector(":scope > .arachnid-gifs-live")) return;
    const video = favorite.kind === "video";
    const live = video
      ? h("video", { class: "arachnid-gifs-live", autoplay: true, loop: true, playsinline: true })
      : h("img", { class: "arachnid-gifs-live", alt: "", draggable: "false" });
    if (video) live.muted = true;
    live.addEventListener(video ? "playing" : "load", () => live.setAttribute("data-ready", ""), { once: true });
    live.src = favorite.media;
    tile.append(live);
  }

  function stopLive(tile) {
    const live = tile.querySelector(":scope > .arachnid-gifs-live");
    if (!live) return;
    if (live instanceof HTMLVideoElement) {
      live.pause();
      live.removeAttribute("src");
      live.load();
    }
    live.remove();
  }

  /** Высота плитки при ширине колонки `column` */
  function tileHeight(favorite, column) {
    const ratio = favorite.width > 0 ? favorite.height / favorite.width : 1;
    return Math.round(column * Math.min(TILE_MAX_RATIO, Math.max(TILE_MIN_RATIO, ratio)));
  }

  /**
   * Раскладка в две колонки: каждая GIF — в более короткую колонку, по
   * порядку (читается по строкам, а не по колонкам, как Masonry for-web).
   */
  function layout(list, width, gap) {
    const column = Math.max(1, (width - gap) / 2);
    const heights = [0, 0];
    const places = new Map();
    for (const favorite of list) {
      const index = heights[0] <= heights[1] ? 0 : 1;
      const height = tileHeight(favorite, column);
      places.set(favorite.id, { x: index * (column + gap), y: heights[index], width: column, height });
      heights[index] += height + gap;
    }
    return { places, height: Math.max(0, Math.max(...heights) - gap) };
  }

  // ─────────────────────────────── избранное в окне ───────────────────────────────
  /** Раздел «Избранное» вместо содержимого окна GIF for-web */
  function createView(picker) {
    const back = iconButton("arrow_back", text.back, () => picker.closeFavorites());
    const search = textField({ placeholder: text.search, clearable: true });
    const plus = iconButton("add", text.addByLink, () => openAddDialog());
    const grid = h("div", { class: "arachnid-gifs-grid", role: "list" });
    const emptyTitle = h("span", { class: "arachnid-gifs-title" });
    const emptyBody = h("span", { class: "arachnid-gifs-body" });
    const empty = h("div", { class: "arachnid-gifs-empty", hidden: true }, emptyTitle, emptyBody);
    const scroller = h("div", { class: "arachnid-gifs-scroller" }, grid, empty);
    const view = h(
      "div",
      { class: "arachnid-gifs-view", hidden: true },
      h("div", { class: "arachnid-gifs-bar" }, back, search, plus),
      scroller,
    );

    /** Плитки на экране: id → элемент */
    const tiles = new Map();
    let filter = "";
    let shown = [];
    let places = new Map();
    /** Перетаскивание: `{ favorite, tile, order, … }` */
    let drag = null;
    let pressed = null;

    function gap() {
      return parseFloat(getComputedStyle(grid).columnGap) || 8;
    }

    function render() {
      if (view.hidden) return;
      shown = drag ? drag.order : matching(filter);
      const nothing = shown.length === 0;
      empty.hidden = !nothing;
      grid.hidden = nothing;
      if (nothing) {
        emptyTitle.textContent = store.list.length === 0 ? text.emptyTitle : text.notFound;
        emptyBody.textContent = store.list.length === 0 ? text.emptyBody : "";
      }
      const result = layout(shown, grid.clientWidth || scroller.clientWidth, gap());
      places = result.places;
      grid.style.height = `${result.height}px`;
      draw();
    }

    /** Отрисовать плитки, которые видны (с запасом) */
    function draw() {
      const offset = grid.offsetTop;
      const top = scroller.scrollTop - OVERSCAN - offset;
      const bottom = scroller.scrollTop + scroller.clientHeight + OVERSCAN - offset;
      const wanted = new Set();
      for (const favorite of shown) {
        const place = places.get(favorite.id);
        const dragged = drag?.favorite.id === favorite.id;
        if (!dragged && (place.y + place.height < top || place.y > bottom)) continue;
        wanted.add(favorite.id);
        let tile = tiles.get(favorite.id);
        if (!tile) {
          tile = createTile(favorite);
          tiles.set(favorite.id, tile);
          grid.append(tile);
        } else if (tile.favorite !== favorite) {
          fillTile(tile, favorite);
        }
        tile.style.width = `${place.width}px`;
        tile.style.height = `${place.height}px`;
        if (!dragged) tile.style.translate = `${place.x}px ${place.y}px`;
      }
      for (const [id, tile] of tiles) {
        if (wanted.has(id)) continue;
        stopLive(tile);
        tile.remove();
        tiles.delete(id);
      }
    }

    // ───── перетаскивание: свои события указателя, без HTML5 drag and drop
    function onPointerDown(event) {
      const tile = event.target.closest?.(".arachnid-gifs-tile");
      if (!tile || event.button !== 0) return;
      event.preventDefault();
      pressed = { tile, favorite: tile.favorite, x: event.clientX, y: event.clientY };
      addEventListener("pointermove", onPointerMove, true);
      addEventListener("pointerup", onPointerUp, true);
      addEventListener("pointercancel", onPointerCancel, true);
    }

    function startDrag(event) {
      const { tile, favorite } = pressed;
      const rect = tile.getBoundingClientRect();
      drag = {
        tile,
        favorite,
        order: store.list.slice(),
        from: store.list.indexOf(favorite),
        dx: event.clientX - rect.left,
        dy: event.clientY - rect.top,
        x: event.clientX,
        y: event.clientY,
        hover: null,
        frame: 0,
      };
      tile.setAttribute("data-dragging", "");
      stopLive(tile);
      autoScroll();
    }

    /** Плитка следует за указателем, остальные расступаются */
    function moveDrag() {
      const box = grid.getBoundingClientRect();
      const x = drag.x - box.left - drag.dx;
      const y = drag.y - box.top - drag.dy;
      drag.tile.style.translate = `${x}px ${y}px`;
      const px = drag.x - box.left;
      const py = drag.y - box.top;
      let hover = null;
      for (const favorite of drag.order) {
        if (favorite.id === drag.favorite.id) continue;
        const place = places.get(favorite.id);
        if (px >= place.x && px <= place.x + place.width && py >= place.y && py <= place.y + place.height) {
          hover = favorite;
          break;
        }
      }
      if (hover === drag.hover) return;
      drag.hover = hover;
      if (!hover) return;
      const order = drag.order.filter((favorite) => favorite.id !== drag.favorite.id);
      order.splice(drag.order.indexOf(hover), 0, drag.favorite);
      drag.order = order;
      render();
    }

    function autoScroll() {
      if (!drag) return;
      const box = scroller.getBoundingClientRect();
      let step = 0;
      if (drag.y < box.top + SCROLL_EDGE) step = -8;
      else if (drag.y > box.bottom - SCROLL_EDGE) step = 8;
      if (step) {
        scroller.scrollTop += step;
        moveDrag();
      }
      drag.frame = requestAnimationFrame(autoScroll);
    }

    function onPointerMove(event) {
      if (!pressed) return;
      if (!drag) {
        const moved = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y);
        // в поиске порядок не меняется: видна только часть списка
        if (moved < DRAG_THRESHOLD || filter.trim()) return;
        startDrag(event);
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
      moveDrag();
    }

    function stopPointer() {
      removeEventListener("pointermove", onPointerMove, true);
      removeEventListener("pointerup", onPointerUp, true);
      removeEventListener("pointercancel", onPointerCancel, true);
      pressed = null;
    }

    function endDrag() {
      const { tile, favorite, order, from, frame } = drag;
      cancelAnimationFrame(frame);
      tile.removeAttribute("data-dragging");
      drag = null;
      const to = order.indexOf(favorite);
      if (to !== from) void moveFavorite(favorite, to);
      else render();
    }

    function onPointerUp(event) {
      const wasDrag = Boolean(drag);
      const favorite = pressed?.favorite;
      const inside = pressed?.tile.contains(event.target);
      stopPointer();
      if (wasDrag) endDrag();
      else if (favorite && inside) void sendFavorite(favorite, picker);
    }

    function onPointerCancel() {
      stopPointer();
      if (drag) {
        drag.order = store.list.slice();
        endDrag();
      }
    }

    grid.addEventListener("pointerdown", onPointerDown);
    grid.addEventListener("keydown", (event) => {
      const tile = event.target.closest?.(".arachnid-gifs-tile");
      if (tile && event.key === "Enter") void sendFavorite(tile.favorite, picker);
    });
    grid.addEventListener("contextmenu", (event) => {
      const tile = event.target.closest?.(".arachnid-gifs-tile");
      if (tile) favoriteMenu(event, tile.favorite, picker);
    });
    search.addEventListener("input", () => {
      filter = search.value ?? "";
      scroller.scrollTop = 0;
      render();
    });
    search.addEventListener("clear", () => {
      filter = "";
      render();
    });
    let queued = false;
    scroller.addEventListener("scroll", () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (!view.hidden) draw();
      });
    });
    const resize = new ResizeObserver(() => render());
    resize.observe(scroller);

    return {
      view,
      grid,
      search,
      open() {
        view.hidden = false;
        filter = search.value ?? "";
        render();
        requestAnimationFrame(() => search.focus());
      },
      close() {
        view.hidden = true;
        for (const tile of tiles.values()) stopLive(tile);
      },
      render,
      dispose() {
        resize.disconnect();
        stopPointer();
        if (drag) cancelAnimationFrame(drag.frame);
        drag = null;
        view.remove();
      },
    };
  }

  // ─────────────────────────────── окно GIF for-web ───────────────────────────────
  /** Части окна GIF по полю поиска (GifPicker.tsx) */
  function parts(input) {
    const searchArea = input.parentElement;
    const stack = searchArea?.parentElement;
    const container = stack?.parentElement;
    if (!container || !container.querySelector(":scope > .CompositionButton")) return null;
    return { input, searchArea, stack, container };
  }

  /** Список Gifbox (Masonry) или сетка категорий в окне */
  function lists(stack) {
    let grid = null;
    let masonry = null;
    for (const list of stack.querySelectorAll('[role="list"]')) {
      if (list.closest(".arachnid-gifs-view, .arachnid-gifs-row")) continue;
      if (list.querySelector('[role="listitem"] video') || getComputedStyle(list).columnCount === "2") masonry = list;
      else grid = list;
    }
    return { grid, masonry };
  }

  /** Сервер Gifbox и последний запрос for-web к нему (PerformanceObserver) */
  let gifboxRequest = null;
  function watchGifbox() {
    try {
      new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          if (entry.initiatorType !== "fetch") continue;
          try {
            const url = new URL(entry.name);
            if (/\/(search|trending)$/.test(url.pathname) && url.searchParams.has("locale")) gifboxRequest = url;
          } catch {
            // не адрес
          }
        }
      }).observe({ type: "resource", buffered: true });
    } catch {
      // без PerformanceObserver — сервер по умолчанию
    }
  }

  /**
   * Ответ Gifbox для плитки: в разметке for-web есть только видео
   * (tinywebm), а отправляет он ссылку на страницу GIF (`url`). Запрос — тот
   * же, что for-web сделал для этих результатов.
   */
  async function gifboxResult(video, query) {
    const src = video.currentSrc || video.src;
    const origin = gifboxRequest?.origin ?? GIFBOX_URL;
    const path = query === "trending" ? "/trending" : "/search";
    const url = new URL(`${origin}${path}`);
    url.searchParams.set("locale", gifboxRequest?.searchParams.get("locale") ?? "en_US");
    if (query !== "trending") url.searchParams.set("query", query);
    const token = sessionToken();
    const response = await fetch(url, { headers: token ? { "X-Session-Token": token } : {} });
    if (!response.ok) throw new Error(`Gifbox: HTTP ${response.status}`);
    const results = (await response.json())?.results ?? [];
    return (
      results.find((result) =>
        Object.values(result?.media_formats ?? {}).some((format) => format?.url === src),
      ) ?? null
    );
  }

  /** GIF из плитки Gifbox */
  async function gifboxEntry(tile, query) {
    const video = tile.querySelector("video");
    const media = video.currentSrc || video.src;
    let url = media;
    try {
      url = (await gifboxResult(video, query))?.url || media;
    } catch (error) {
      console.warn("[favorite gifs] Gifbox", error);
    }
    return {
      url,
      media,
      kind: "video",
      width: video.videoWidth,
      height: video.videoHeight,
      description: "",
      query: query.trim(),
    };
  }

  /** Улучшенные окна GIF: поле поиска → окно */
  const pickers = new Map();

  /** Видео Gifbox не играет само (autoplay for-web), а показывает первый кадр */
  function quietVideo(video) {
    if (video.dataset.arachnidGifs !== undefined || video.classList.contains("arachnid-gifs-live")) return;
    video.dataset.arachnidGifs = "";
    video.autoplay = false;
    video.preload = "auto";
    video.pause();
  }

  function enhance(found) {
    const { input, stack, container } = found;
    input.dataset.arachnidGifs = "";
    const picker = {
      ...found,
      replyTo: replyTarget(),
      category: null,
      row: null,
      view: null,
      openFavorites,
      closeFavorites,
      refresh,
      dispose,
    };

    /** Запрос for-web: поле поиска в нижнем регистре (debouncedFilterLowercase) */
    const query = () => (input.value ?? "").toLowerCase();

    // ───── плитка «Избранное» в сетке категорий
    function categoryTile() {
      const tile = h(
        "div",
        { class: "arachnid-gifs-category", role: "listitem", tabindex: "0" },
        h("span", null, icon("star"), text.favorites),
      );
      tile.addEventListener("mousedown", (event) => event.preventDefault());
      tile.addEventListener("click", openFavorites);
      tile.addEventListener("keydown", (event) => {
        if (event.key === "Enter") openFavorites();
      });
      return tile;
    }

    function paintCategory() {
      if (!picker.category) return;
      const cover = store.list.find((favorite) => favorite.preview);
      picker.category.style.backgroundImage = cover ? `url("${previewUrl(cover)}")` : "";
    }

    // ───── ряд «Из избранного» над результатами Gifbox
    function updateRow(masonry) {
      const value = query().trim();
      const list = value ? matching(value).slice(0, ROW_LIMIT) : [];
      const place = masonry ?? stack.querySelector(":scope > :last-child");
      if (list.length === 0 || !place || place === picker.row) {
        picker.row?.remove();
        return;
      }
      if (!picker.row) {
        const tiles = h("div", { class: "arachnid-gifs-row-tiles", role: "list" });
        picker.row = h("div", { class: "arachnid-gifs-row" }, h("span", { class: "arachnid-gifs-title" }, text.fromFavorites), tiles);
        tiles.addEventListener("mousedown", (event) => event.preventDefault());
        tiles.addEventListener("click", (event) => {
          const tile = event.target.closest(".arachnid-gifs-tile");
          if (tile) void sendFavorite(tile.favorite, picker);
        });
        tiles.addEventListener("contextmenu", (event) => {
          const tile = event.target.closest(".arachnid-gifs-tile");
          if (tile) favoriteMenu(event, tile.favorite, picker);
        });
      }
      const tiles = picker.row.lastElementChild;
      const ids = list.map((favorite) => favorite.id).join();
      if (tiles.dataset.ids !== ids || tiles.dataset.base !== store.base) {
        tiles.dataset.ids = ids;
        tiles.dataset.base = store.base;
        tiles.replaceChildren(
          ...list.map((favorite) => {
            const tile = createTile(favorite);
            const ratio = favorite.height > 0 ? favorite.width / favorite.height : 1;
            tile.style.width = `${Math.round(ROW_HEIGHT * Math.min(2.5, Math.max(0.5, ratio)))}px`;
            return tile;
          }),
        );
      } else {
        for (const tile of tiles.children) {
          const favorite = store.list.find((known) => known.id === tile.dataset.id);
          if (favorite && favorite !== tile.favorite) fillTile(tile, favorite);
        }
      }
      // в прокрутке результатов — перед ними, без результатов — перед «No GIFs found»
      if (picker.row.nextElementSibling !== place) place.before(picker.row);
    }

    // ───── плитки Gifbox: только под указателем, до того — первый кадр
    function quiet(masonry) {
      for (const video of masonry.querySelectorAll("video")) quietVideo(video);
    }

    function onOver(event) {
      const video = event.target.closest?.('[role="listitem"]')?.querySelector(":scope > video[data-arachnid-gifs]");
      if (video?.paused) void video.play().catch(() => {});
    }

    function onOut(event) {
      const tile = event.target.closest?.('[role="listitem"]');
      const video = tile?.querySelector(":scope > video[data-arachnid-gifs]");
      if (!video || tile.contains(event.relatedTarget)) return;
      video.pause();
      video.currentTime = 0;
    }

    function onContextMenu(event) {
      const tile = event.target.closest?.('[role="listitem"]');
      if (!tile?.querySelector(":scope > video") || tile.closest(".arachnid-gifs-row")) return;
      event.preventDefault();
      event.stopPropagation();
      const value = query();
      const video = tile.querySelector(":scope > video");
      const known = findFavorite(video.currentSrc || video.src);
      showMenu(event.clientX, event.clientY, [
        known
          ? {
              icon: "star",
              label: text.remove,
              destructive: true,
              action: () => removeFavorite(known).then(() => toast(text.removed), failure),
            }
          : {
              icon: "star",
              label: text.add,
              action: () =>
                gifboxEntry(tile, value)
                  .then((entry) => addFavorite(entry))
                  .then(() => toast(text.added), failure),
            },
        {
          icon: "link",
          label: text.copyLink,
          action: () =>
            gifboxEntry(tile, value).then((entry) => copyLink(entry.url), failure),
        },
      ]);
    }

    stack.addEventListener("pointerover", onOver);
    stack.addEventListener("pointerout", onOut);
    stack.addEventListener("contextmenu", onContextMenu);

    function openFavorites() {
      picker.view ??= createView(picker);
      if (picker.view.view.parentElement !== container) container.append(picker.view.view);
      stack.setAttribute("data-arachnid-gifs-hidden", "");
      picker.view.open();
    }

    function closeFavorites() {
      picker.view?.close();
      stack.removeAttribute("data-arachnid-gifs-hidden");
      input.focus?.();
    }

    function refresh() {
      const { grid, masonry } = lists(stack);
      if (grid) {
        picker.category ??= categoryTile();
        if (grid.firstElementChild !== picker.category) grid.prepend(picker.category);
        paintCategory();
      }
      if (masonry) quiet(masonry);
      // пока for-web ждёт конца ввода (250 мс), видны ещё категории
      if (grid) picker.row?.remove();
      else updateRow(masonry);
    }

    const onInput = () => refresh();
    input.addEventListener("input", onInput);
    listeners.add(onChange);
    function onChange() {
      refresh();
      picker.view?.render();
    }

    function dispose() {
      listeners.delete(onChange);
      input.removeEventListener("input", onInput);
      stack.removeEventListener("pointerover", onOver);
      stack.removeEventListener("pointerout", onOut);
      stack.removeEventListener("contextmenu", onContextMenu);
      picker.view?.dispose();
      picker.row?.remove();
      picker.category?.remove();
      stack.removeAttribute("data-arachnid-gifs-hidden");
      closeMenu();
    }

    void load();
    refresh();
    return picker;
  }

  // ─────────────────────────────── меню в чате ───────────────────────────────
  // Меню файла for-web (MessageContextMenu с `file`) открывает правый щелчок
  // по самой картинке или видео вложения и встраивания: обработчик
  // use:floating стоит на элементе и вызывает stopImmediatePropagation.
  // Обработчик, добавленный на элемент из фазы захвата окна, встаёт в
  // очередь после него и срабатывает, только если своего обработчика у
  // элемента нет — тогда меню общее (сообщения, ссылки). Пункт добавляется
  // за «Copy link to file» — вторым пунктом меню файла.
  let candidate = null;

  function onContextMenuCapture(event) {
    rememberPointer(event);
    const target = event.target;
    candidate = null;
    if (!(target instanceof HTMLImageElement || target instanceof HTMLVideoElement)) return;
    if (target.classList.contains("emoji") || target.closest("foreignObject")) return;
    if (target.closest(".arachnid-gifs-view, .arachnid-gifs-row, .arachnid-gifs-dialog, .CompositionButton ~ *")) return;
    const own = { element: target, file: true, time: performance.now() };
    candidate = own;
    const controller = new AbortController();
    target.addEventListener("contextmenu", () => (own.file = false), { once: true, signal: controller.signal });
    setTimeout(() => controller.abort(), 1000);
  }

  /** Меню for-web в добавленном блоке: div с пунктами-ссылками */
  function findMenu(node) {
    const isMenu = (element) => element.childElementCount >= 2 && element.children[0].tagName === "A" && element.children[1].tagName === "A";
    if (isMenu(node)) return node;
    for (const element of node.querySelectorAll("div")) if (isMenu(element)) return element;
    return null;
  }

  /** Ссылка на файл картинки или видео из чата */
  function chatMedia(element) {
    const raw = element.currentSrc || element.src;
    if (!raw) return null;
    let url;
    try {
      url = new URL(raw, location.href);
      // прокси встраиваний January: /proxy?url=<файл>
      const proxied = url.pathname.endsWith("/proxy") ? url.searchParams.get("url") : null;
      if (proxied) url = new URL(proxied);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(url.protocol)) return null;
    // вложение autumn: превью → сам файл
    if (/\/attachments\/[A-Za-z0-9_-]+$/.test(url.pathname)) url.pathname += "/original";
    return url.href;
  }

  /**
   * GIF из чата. Ссылку на страницу (Tenor, Gifbox…) и размеры даёт
   * сообщение из API: в разметке for-web их нет, а сообщение только из GIF
   * ссылку не показывает.
   */
  async function chatEntry(element) {
    const media = chatMedia(element);
    const kind = element instanceof HTMLVideoElement ? "video" : "image";
    const entry = {
      url: media,
      media,
      kind,
      width: kind === "video" ? element.videoWidth : element.naturalWidth,
      height: kind === "video" ? element.videoHeight : element.naturalHeight,
      description: "",
      query: "",
    };
    const channel = currentChannel();
    const id = messageOf(element);
    if (!channel || !id || !sessionToken()) return entry;
    try {
      const message = await request("GET", `/channels/${channel}/messages/${id}`);
      for (const attachment of message?.attachments ?? []) {
        if (!media.includes(`/${attachment._id}/`)) continue;
        entry.width = attachment.metadata?.width || entry.width;
        entry.height = attachment.metadata?.height || entry.height;
      }
      for (const embed of message?.embeds ?? []) {
        const parts = embed.type === "Website" ? [embed.video, embed.image] : [embed];
        const part = parts.find((item) => item?.url && chatMedia({ src: item.url }) === media);
        if (!part) continue;
        if (embed.type === "Website") entry.url = embed.original_url || embed.url || media;
        entry.width = part.width || entry.width;
        entry.height = part.height || entry.height;
      }
    } catch (error) {
      console.warn("[favorite gifs] сообщение", error);
    }
    return entry;
  }

  function starIcon(template, filled) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const name of ["width", "height", "class", "style"]) {
      const value = template?.getAttribute(name);
      if (value !== null && value !== undefined) svg.setAttribute(name, value);
    }
    if (!svg.hasAttribute("width")) svg.setAttribute("width", "16");
    if (!svg.hasAttribute("height")) svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", filled ? STAR_FILLED_PATH : STAR_PATH);
    svg.append(path);
    return svg;
  }

  /** Пункт «Добавить в избранное» / «Убрать из избранного» по образцу соседнего */
  function insertChatItem(menu, element) {
    const sample = menu.children[1];
    const media = chatMedia(element);
    if (!media) return;
    const known = findFavorite(media);
    const item = sample.cloneNode(true);
    item.removeAttribute("href");
    item.removeAttribute("id");
    item.setAttribute("data-arachnid-gifs", "");
    const svg = item.querySelector("svg");
    if (svg) svg.replaceWith(starIcon(svg, Boolean(known)));
    const label =
      Array.from(item.querySelectorAll("span")).find((span) => span.getAttribute("aria-hidden") !== "true") ?? item;
    label.textContent = known ? text.remove : text.add;
    item.addEventListener("click", () => {
      // меню for-web закроется само: оно закрывается по любому щелчку
      const current = findFavorite(media);
      if (current) {
        removeFavorite(current).then(() => toast(text.removed), failure);
        return;
      }
      chatEntry(element)
        .then((entry) => addFavorite(entry))
        .then(() => toast(text.added), failure);
    });
    sample.after(item);
  }

  // ─────────────────────────────── наблюдение ───────────────────────────────
  // Окна выбора, меню и окна for-web выводит в #floating; за ним и
  // следит скрипт. Поле поиска — mdui-text-field: Solid задаёт подсказку
  // свойством, а атрибутом она становится позже, поэтому проверяется
  // свойство.
  const FIELDS = "mdui-text-field, input";
  let added = [];
  let queued = false;

  function consider(field) {
    if (field.dataset.arachnidGifs !== undefined || field.placeholder !== SEARCH_PLACEHOLDER) return;
    const found = parts(field);
    if (found) pickers.set(field, enhance(found));
  }

  function scan() {
    for (const [field, picker] of pickers) {
      if (field.isConnected) picker.refresh();
      else {
        picker.dispose();
        pickers.delete(field);
      }
    }
    const roots = added;
    added = [];
    for (const root of roots) {
      if (!root.isConnected) continue;
      if (root.matches(FIELDS)) consider(root);
      for (const field of root.querySelectorAll(FIELDS)) consider(field);
    }
  }

  function queueScan() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  }

  const OWN = ".arachnid-gifs-view, .arachnid-gifs-row, .arachnid-gifs-category";

  function observe(records) {
    let wanted = false;
    for (const record of records) {
      // свои плитки меняются при прокрутке — окно от этого не меняется
      if (record.target.closest?.(OWN)) continue;
      if (pickers.size > 0) wanted = true;
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE || node.closest(OWN)) continue;
        // autoplay сработал бы раньше следующего кадра
        if (pickers.size > 0) {
          const videos = node instanceof HTMLVideoElement ? [node] : node.querySelectorAll("video");
          for (const video of videos) {
            if (video.closest(".CompositionButton ~ *")) quietVideo(video);
          }
        }
        if (candidate?.file && performance.now() - candidate.time < 1000) {
          const menu = findMenu(node);
          if (menu && !menu.querySelector("[data-arachnid-gifs]")) {
            const { element } = candidate;
            candidate = null;
            insertChatItem(menu, element);
          }
        }
        added.push(node);
        wanted = true;
      }
    }
    if (wanted) queueScan();
  }

  function start() {
    ensureStyle();
    watchGifbox();
    addEventListener("contextmenu", onContextMenuCapture, true);
    addEventListener("click", rememberPointer, true);
    const root = document.getElementById("floating") ?? document.body;
    new MutationObserver(observe).observe(root, { childList: true, subtree: true });
    added.push(root);
    scan();
    void load();
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
