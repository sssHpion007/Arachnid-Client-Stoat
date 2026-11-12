// Категории и «Часто используемые» в окне выбора эмодзи, как в Discord.
//
// У for-web (EmojiPicker.tsx) слева от сетки — колонка с серверами, а все
// стандартные эмодзи идут одним списком под заголовком «Default», без
// разделов: до нужного приходится долго листать. for-web открыт с сервера
// Stoat, поэтому окно дополняется так же, как раздел настроек (settings.js):
// скрипт находит открытое окно и добавляет в колонку кнопки.
//
// * Вверху колонки — «Часто используемые» (если они уже есть) и быстрый
//   переход к стандартным эмодзи. Внизу, под серверами, — разделы Discord:
//   люди, природа, еда, путешествия, занятия, предметы, символы, флаги.
//   Раздел, который сейчас виден в сетке, подсвечивается.
// * «Часто используемые» — блок над сеткой, как в Discord. Сюда попадают и
//   стандартные эмодзи, и эмодзи серверов; счётчики хранятся в localStorage
//   отдельно для каждого аккаунта. Щелчок по такому эмодзи передаётся той
//   же ячейке for-web, что и обычный выбор: эмодзи вставляется в сообщение
//   или ставится реакцией, смотря откуда открыто окно.
//
// Опоры не зависят от сгенерированных имён классов:
//
// * окно — поле поиска (mdui-text-field) с подсказкой «Search for emojis...»
//   (for-web выводит её без перевода), за ним ряд из колонки серверов и
//   сетки;
// * колонка и сетка — прокручиваемые блоки со списком
//   @minht11/solid-virtual-container (класс `virtual-container-<хеш>`):
//   ячейки по 40 px, сдвинутые `transform: translate(x, y)`, отрисованы
//   только видимые;
// * в сетке подряд идут эмодзи серверов, заголовок «Default», выровненный
//   до целой строки, и стандартные эмодзи в порядке emojiMapping.json
//   for-web — по группам Unicode (emoji-metadata, emoji_17_0_ordering).
//   Начало раздела — номер его первого эмодзи в этом списке. После
//   прокрутки положение сверяется с отрисованной ячейкой (атрибут alt —
//   сам эмодзи), так что небольшие правки списка в for-web не сбивают
//   переход.
//
// Блоки над списками меняют их отступ от начала прокрутки, а список
// замеряет отступ только при смене ширины. Расхождение до пяти строк
// (200 px) он перекрывает запасом отрисовки (overscan по умолчанию — 180 px,
// округляется до пяти строк), поэтому высота добавленных блоков меньше этого:
// не больше двух строк эмодзи с заголовком, двух кнопок в колонке.
//
// Скрипт выполняется после bridge.js и только там, где он создал
// window.__arachnidDesktop (страница веб-клиента из config.toml).
(() => {
  "use strict";

  if (!window.__arachnidDesktop) return;

  // ─────────────────────────────── данные ───────────────────────────────
  const SEARCH_PLACEHOLDER = "Search for emojis...";
  /** Сторона ячейки в списках for-web */
  const CELL = 40;
  /** Длина emojiMapping.json for-web */
  const EMOJI_COUNT = 1785;
  /** Не больше стольких строк в «Часто используемых» */
  const FREQUENT_ROWS = 2;
  /** Сколько эмодзи помнить */
  const FREQUENT_LIMIT = 50;
  const VIRTUAL_LIST = '[class*="virtual-container-"]';

  /**
   * Разделы Discord: номер первого эмодзи в emojiMapping.json и сам эмодзи.
   * «Люди» у Discord — смайлики вместе с людьми и жестами.
   */
  const CATEGORIES = [
    { id: "people", icon: "emoji_people", start: 0, first: "😀" },
    { id: "nature", icon: "emoji_nature", start: 366, first: "💐" },
    { id: "food", icon: "emoji_food_beverage", start: 591, first: "🍓" },
    { id: "travel", icon: "emoji_transportation", start: 723, first: "🛑" },
    { id: "activities", icon: "emoji_events", start: 845, first: "🎉" },
    { id: "objects", icon: "emoji_objects", start: 962, first: "📱" },
    { id: "symbols", icon: "emoji_symbols", start: 1229, first: "🔴" },
    { id: "flags", icon: "flag", start: 1515, first: "🏁" },
  ];

  // Как и остальные добавления клиента — на языке системы.
  const russian = /^ru\b/i.test(navigator.language || "");
  const text = russian
    ? {
        frequent: "Часто используемые",
        standard: "Стандартные эмодзи",
        people: "Люди",
        nature: "Природа",
        food: "Еда и напитки",
        travel: "Путешествия и места",
        activities: "Занятия",
        objects: "Предметы",
        symbols: "Символы",
        flags: "Флаги",
      }
    : {
        frequent: "Frequently Used",
        standard: "Standard Emoji",
        people: "People",
        nature: "Nature",
        food: "Food & Drink",
        travel: "Travel & Places",
        activities: "Activities",
        objects: "Objects",
        symbols: "Symbols",
        flags: "Flags",
      };

  // ───────────────────────── часто используемые ─────────────────────────
  /** Ключ хранилища — свой у каждого аккаунта (id из копии `auth` for-web) */
  function storageKey() {
    let user = "guest";
    try {
      const id = JSON.parse(localStorage.getItem("auth") ?? "null")?.session?.userId;
      if (typeof id === "string" && id) user = id;
    } catch {
      // без сессии — общий список
    }
    return `arachnid:emoji-frequent:${user}`;
  }

  /**
   * `[{ key, name, src, text?, count, last }]`: `text` — стандартный эмодзи,
   * без него — эмодзи сервера с картинкой `src`.
   */
  function loadFrequent() {
    try {
      const list = JSON.parse(localStorage.getItem(storageKey()) ?? "[]");
      return Array.isArray(list)
        ? list.filter((entry) => entry && typeof entry.key === "string" && entry.name && entry.src)
        : [];
    } catch {
      return [];
    }
  }

  const byUse = (a, b) => b.count - a.count || b.last - a.last;

  function recordUse(entry) {
    const list = loadFrequent();
    const known = list.find((item) => item.key === entry.key);
    if (known) {
      Object.assign(known, entry, { count: known.count + 1, last: Date.now() });
    } else {
      list.push({ ...entry, count: 1, last: Date.now() });
    }
    list.sort(byUse);
    try {
      localStorage.setItem(storageKey(), JSON.stringify(list.slice(0, FREQUENT_LIMIT)));
    } catch {
      // хранилище переполнено — список просто не обновится
    }
  }

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

  const icon = (name) =>
    h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, name);

  // Цвета — переменные Material 3 for-web, подходят к любой теме.
  const STYLE = `
.arachnid-emoji-rail {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.arachnid-emoji-rail-button {
  flex-shrink: 0;
  width: 100%;
  height: ${CELL}px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--md-sys-color-on-surface-variant);
}
.arachnid-emoji-rail-button > span {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  transition: background-color 0.1s, color 0.1s;
}
.arachnid-emoji-rail-button:hover > span {
  color: var(--md-sys-color-on-surface);
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
}
.arachnid-emoji-rail-button[data-active] > span {
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
}
.arachnid-emoji-divider {
  flex-shrink: 0;
  height: 1px;
  margin: 4px 8px;
  background: var(--md-sys-color-outline-variant);
}
.arachnid-emoji-frequent[hidden] { display: none; }
.arachnid-emoji-title {
  height: ${CELL}px;
  display: flex;
  align-items: center;
  padding-inline: var(--gap-md);
}
.arachnid-emoji-cells { display: grid; }
.arachnid-emoji-cell {
  width: ${CELL}px;
  height: ${CELL}px;
  padding: var(--gap-sm);
  border: none;
  border-radius: var(--borderRadius-sm);
  background: none;
  cursor: pointer;
}
.arachnid-emoji-cell:hover {
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
}
.arachnid-emoji-cell img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}
`;

  function ensureStyle() {
    if (document.getElementById("arachnid-emoji-style")) return;
    const style = h("style", { id: "arachnid-emoji-style" });
    style.textContent = STYLE;
    (document.head ?? document.documentElement).append(style);
  }

  // ─────────────────────────────── окно ───────────────────────────────

  /** Строка `y` из `transform: translate(x, y)` ячейки */
  function cellTop(cell) {
    const match = /translate\(\s*[-\d.]+px,\s*([-\d.]+)px\)/.exec(cell.style.transform);
    return match ? Number(match[1]) : null;
  }

  /** Набор стандартных эмодзи из адреса картинки for-web */
  const packOf = (src) => /\/emoji\/([^/]+)\//.exec(src ?? "")?.[1] ?? null;

  /** Найти части окна выбора эмодзи по полю поиска */
  function parts(input) {
    let block = input;
    for (let depth = 0; depth < 6 && block; depth++) {
      const row = block.nextElementSibling;
      if (row?.querySelector(VIRTUAL_LIST)) {
        const rail = row.children[0];
        const column = row.children[1];
        const grid = column?.children[0];
        const railList = rail?.querySelector(`:scope > ${VIRTUAL_LIST}`);
        const gridList = grid?.querySelector(`:scope > ${VIRTUAL_LIST}`);
        if (!railList || !gridList) return null;
        return { input, rail, railList, grid, gridList, preview: column.children[1] ?? null };
      }
      block = block.parentElement;
    }
    return null;
  }

  /** Дополнить окно; возвращает, что сделать, когда оно закроется */
  function enhance(picker) {
    const { input, rail, railList, grid, gridList, preview } = picker;
    input.dataset.arachnidEmoji = "";
    ensureStyle();

    const columns = () => Math.max(1, Math.floor(grid.clientWidth / CELL));
    const filtering = () => input.value !== "";

    /** Отступ списка от начала прокрутки сетки */
    const listOffset = () =>
      gridList.getBoundingClientRect().top - grid.getBoundingClientRect().top + grid.scrollTop;

    /** Строк до стандартных эмодзи: серверы и заголовок «Default» */
    const leadingRows = () =>
      Math.round(gridList.offsetHeight / CELL) - Math.ceil(EMOJI_COUNT / columns());

    /** Поиск for-web: Solid берёт значение поля из события input */
    function setFilter(value) {
      if (input.value === value) return;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const cells = () => Array.from(gridList.children);
    const imageOf = (cell) => cell.querySelector("img");

    /** Ячейка стандартного эмодзи, ближайшая к строке `top` (в списке есть повторы) */
    function findUnicode(emoji, top) {
      let best = null;
      for (const cell of cells()) {
        const image = imageOf(cell);
        const y = cellTop(cell);
        if (image?.classList.contains("emoji") && image.alt === emoji && y !== null) {
          if (!best || Math.abs(y - top) < Math.abs(best.y - top)) best = { cell, y };
        }
      }
      return best;
    }

    // ─────────────────────── прокрутка к разделам ───────────────────────
    const nextFrame = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    function scrollGrid(top) {
      grid.scrollTop = Math.max(0, Math.round(top));
    }

    async function jumpToCategory(category) {
      setFilter("");
      const offset = listOffset();
      const top = (leadingRows() + Math.floor(category.start / columns())) * CELL;
      scrollGrid(offset + top);
      // сверка с отрисованной ячейкой: список for-web мог немного измениться
      await nextFrame();
      const found = findUnicode(category.first, top);
      if (found && found.y !== top) scrollGrid(listOffset() + found.y);
    }

    function jumpToStandard() {
      setFilter("");
      scrollGrid(listOffset() + (leadingRows() - 1) * CELL);
      // и разделы в колонке — в поле зрения
      rail.scrollTop += categoryBlock.getBoundingClientRect().top - rail.getBoundingClientRect().top;
    }

    // ─────────────────────── часто используемые ───────────────────────
    const frequent = loadFrequent().slice(0, columns() * FREQUENT_ROWS);
    let frequentBlock = null;
    let activating = false;

    /** Текущий набор стандартных эмодзи — по отрисованной ячейке */
    function currentPack() {
      for (const image of gridList.querySelectorAll("img.emoji")) {
        const pack = packOf(image.src);
        if (pack) return pack;
      }
      return null;
    }

    /** Картинки «Часто используемых» — тем же набором, что и сетка */
    function syncPack() {
      const pack = currentPack();
      if (!pack || !frequentBlock) return false;
      for (const image of frequentBlock.querySelectorAll("img.emoji")) {
        const own = packOf(image.src);
        if (own && own !== pack) image.src = image.src.replace(`/emoji/${own}/`, `/emoji/${pack}/`);
      }
      return true;
    }

    /** Ячейка for-web с этим эмодзи среди отрисованных */
    function findCell(entry) {
      return (
        cells().find((cell) => {
          const image = imageOf(cell);
          if (!image) return false;
          return entry.text !== undefined
            ? image.classList.contains("emoji") && image.alt === entry.text
            : !image.classList.contains("emoji") && image.src === entry.src;
        }) ?? null
      );
    }

    /**
     * Выбрать эмодзи через ячейку for-web: поиск по имени показывает её в
     * сетке, щелчок по ней делает то же, что и обычный выбор. Всё происходит
     * синхронно, до отрисовки кадра, — поиск на экране не мелькает. Только
     * если имя совпадает со многими эмодзи (например, «a») и ячейка не
     * отрисована, результаты пролистываются.
     */
    async function activate(entry) {
      if (activating) return;
      activating = true;
      const top = grid.scrollTop;
      try {
        setFilter(entry.name);
        let cell = findCell(entry);
        for (let page = 0; !cell && page < 100; page++) {
          const max = grid.scrollHeight - grid.clientHeight;
          if (grid.scrollTop >= max) break;
          grid.scrollTop = Math.min(max, grid.scrollTop + grid.clientHeight);
          await nextFrame();
          cell = findCell(entry);
        }
        cell?.click();
      } finally {
        setFilter("");
        grid.scrollTop = top;
        activating = false;
        updateFrequentVisibility();
      }
    }

    function updateFrequentVisibility() {
      if (frequentBlock && !activating) frequentBlock.hidden = filtering();
    }

    if (frequent.length > 0) {
      const pack = currentPack();
      frequentBlock = h(
        "div",
        { class: "arachnid-emoji-frequent", "data-arachnid-emoji-frequent": true },
        h("div", { class: "arachnid-emoji-title" }, text.frequent),
        h(
          "div",
          { class: "arachnid-emoji-cells", role: "list" },
          ...frequent.map((entry) => {
            const own = packOf(entry.src);
            const src =
              entry.text !== undefined && pack && own
                ? entry.src.replace(`/emoji/${own}/`, `/emoji/${pack}/`)
                : entry.src;
            const image = h("img", {
              src,
              alt: entry.text ?? `:${entry.name}:`,
              class: entry.text !== undefined ? "emoji" : null,
              draggable: "false",
              loading: "lazy",
            });
            return h(
              "button",
              {
                type: "button",
                class: "arachnid-emoji-cell",
                role: "listitem",
                title: `:${entry.name}:`,
                onClick: () => void activate(entry),
              },
              image,
            );
          }),
        ),
      );
      frequentBlock.lastChild.style.gridTemplateColumns = `repeat(${columns()}, ${CELL}px)`;
      grid.insertBefore(frequentBlock, gridList);
      updateFrequentVisibility();
    }

    // ─────────────────────── учёт выбранных эмодзи ───────────────────────
    /** Имя из полосы предпросмотра, если она показывает эту картинку */
    function previewName(image) {
      const shown = preview?.querySelector("img");
      if (!shown) return null;
      const same = image.classList.contains("emoji")
        ? shown.alt === image.alt
        : shown.src === image.src;
      if (!same) return null;
      for (const span of preview.querySelectorAll("span")) {
        const match = /^:([^:\s]+):$/.exec(span.textContent.trim());
        if (match) return match[1];
      }
      return null;
    }

    gridList.addEventListener("click", (event) => {
      let cell = event.target instanceof Element ? event.target : null;
      while (cell && cell.parentElement !== gridList) cell = cell.parentElement;
      const image = cell && imageOf(cell);
      if (!image) return;
      const unicode = image.classList.contains("emoji");
      const key = unicode ? `u:${image.alt}` : `c:${image.src}`;
      const name =
        previewName(image) ??
        (activating ? input.value : null) ??
        loadFrequent().find((entry) => entry.key === key)?.name;
      if (!name) return;
      recordUse(unicode ? { key, name, src: image.src, text: image.alt } : { key, name, src: image.src });
    });

    // ─────────────────────────── колонка ───────────────────────────
    const buttons = new Map();
    const railButton = (id, iconName, label, onClick) => {
      const button = h(
        "button",
        { type: "button", class: "arachnid-emoji-rail-button", title: label, "aria-label": label, onClick },
        icon(iconName),
      );
      buttons.set(id, button);
      return button;
    };

    const topBlock = h(
      "div",
      { class: "arachnid-emoji-rail", "data-arachnid-emoji-rail": "top" },
      frequentBlock ? railButton("frequent", "schedule", text.frequent, () => scrollGrid(0)) : null,
      railButton("standard", "emoji_emotions", text.standard, jumpToStandard),
    );
    const categoryBlock = h(
      "div",
      { class: "arachnid-emoji-rail", "data-arachnid-emoji-rail": "categories" },
      h("div", { class: "arachnid-emoji-divider", role: "separator" }),
      ...CATEGORIES.map((category) =>
        railButton(category.id, category.icon, text[category.id], () => void jumpToCategory(category)),
      ),
    );
    rail.insertBefore(topBlock, railList);
    railList.after(categoryBlock);

    // ─────────────────────── подсветка раздела ───────────────────────
    // Размеры сетки читаются не при каждой прокрутке: чтение заставляет
    // браузер сразу пересчитать раскладку, которую список for-web только что
    // поменял. Меняются они лишь вместе с размерами сетки и списка (ширина
    // окна, поиск, «Часто используемые»), за которыми следит ResizeObserver.
    let layout = null;
    const measure = () =>
      (layout ??= { offset: listOffset(), leading: leadingRows(), columns: columns() });

    function activeSection() {
      if (filtering()) return null;
      const { offset, leading, columns: count } = measure();
      if (frequentBlock && grid.scrollTop < offset) return "frequent";
      const row = Math.floor((grid.scrollTop - offset + 1) / CELL) - leading;
      if (row < 0) return null;
      // раздел, который начинается в верхней видимой строке, уже считается открытым
      const last = (row + 1) * count - 1;
      let active = null;
      for (const category of CATEGORIES) if (category.start <= last) active = category.id;
      return active;
    }

    let pending = false;
    let shown;
    function highlight() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const active = activeSection();
        if (active === shown) return;
        shown = active;
        for (const [id, button] of buttons) button.toggleAttribute("data-active", id === active);
      });
    }

    const resize = new ResizeObserver(() => {
      layout = null;
      highlight();
    });
    for (const element of [grid, gridList, frequentBlock]) if (element) resize.observe(element);

    grid.addEventListener("scroll", highlight, { passive: true });
    input.addEventListener("input", () => {
      updateFrequentVisibility();
      highlight();
    });

    // Набор виден по первой отрисованной картинке сетки, и пока окно открыто,
    // он не меняется: наблюдение нужно только до неё.
    let packWatch = null;
    if (frequentBlock && !syncPack()) {
      packWatch = new MutationObserver(() => {
        if (!syncPack()) return;
        packWatch.disconnect();
        packWatch = null;
      });
      packWatch.observe(gridList, { childList: true, subtree: true });
    }
    highlight();

    // окно закрыто
    return () => {
      resize.disconnect();
      packWatch?.disconnect();
    };
  }

  // ─────────────────────────── наблюдение ───────────────────────────
  // Поле поиска for-web — mdui-text-field (TextField.tsx). Solid задаёт ему
  // подсказку свойством, а атрибутом она становится позже, при отрисовке
  // самого mdui, поэтому проверяется свойство.
  //
  // Документ for-web меняется постоянно: сообщения, набор текста, а пока
  // окно открыто — его же список при каждой прокрутке, иногда по нескольку
  // раз за кадр. Поэтому записи наблюдателя только просматриваются: окно
  // ищется там, где в документ добавлено поле ввода, и не чаще раза в кадр.
  // Раньше на каждое изменение обходился весь документ, и прокрутка окна
  // тормозила — тем сильнее, чем больше открытый канал.
  const FIELDS = "mdui-text-field, input";
  /** Улучшенные окна: поле поиска → что сделать, когда окно закроется */
  const pickers = new Map();
  /** Поля поиска, у которых окно ещё не собрано */
  const waiting = new Set();
  /** Добавленные блоки с полями ввода — до ближайшего кадра */
  let added = [];

  function consider(field) {
    if (field.dataset.arachnidEmoji !== undefined) return;
    if (field.placeholder !== SEARCH_PLACEHOLDER) return;
    const picker = parts(field);
    if (picker) {
      waiting.delete(field);
      pickers.set(field, enhance(picker));
    } else {
      waiting.add(field);
    }
  }

  function scan() {
    for (const [field, dispose] of pickers) {
      if (field.isConnected) continue;
      dispose();
      pickers.delete(field);
    }
    for (const field of waiting) {
      if (field.isConnected) consider(field);
      else waiting.delete(field);
    }
    const roots = added;
    added = [];
    for (const root of roots) {
      if (!root.isConnected) continue;
      if (root.matches(FIELDS)) consider(root);
      for (const field of root.querySelectorAll(FIELDS)) consider(field);
    }
  }

  let queued = false;
  function queueScan() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  }

  const hasField = (node) =>
    node.nodeType === Node.ELEMENT_NODE &&
    (node.matches(FIELDS) || node.querySelector(FIELDS) !== null);

  function observe(records) {
    let wanted = waiting.size > 0;
    for (const record of records) {
      if (pickers.size > 0 && record.removedNodes.length > 0) wanted = true;
      for (const node of record.addedNodes) {
        if (!hasField(node)) continue;
        added.push(node);
        wanted = true;
      }
    }
    if (wanted) queueScan();
  }

  function start() {
    new MutationObserver(observe).observe(document.body, { childList: true, subtree: true });
    added.push(document.body);
    scan();
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
