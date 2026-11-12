// Разделы с заголовками и «Часто используемые» в окне выбора эмодзи, как в
// Discord.
//
// У for-web (EmojiPicker.tsx) слева от сетки — колонка с серверами, а все
// стандартные эмодзи идут одним списком под заголовком «Default», без
// разделов: до нужного приходится долго листать. for-web открыт с сервера
// Stoat, поэтому окно дополняется так же, как раздел настроек (settings.js):
// скрипт находит открытое окно и дополняет его.
//
// * Стандартные эмодзи разбиты на разделы с заголовками так же, как в
//   Discord: люди, природа, еда, занятия, путешествия, предметы, символы,
//   флаги — с тем же составом и порядком эмодзи в разделах. Список
//   for-web строится внутри компонента (элементы с заголовками там есть, но
//   стандартные эмодзи добавляются одним куском), поэтому эту часть сетки
//   показывает сам скрипт: список for-web обрезается перед заголовком
//   «Default» (эмодзи серверов остаются его), а под ним — свой список с
//   заголовками разделов. Он тоже виртуальный: отрисованы только видимые
//   строки (и по четыре строки запаса), при прокрутке строки переиспользуются.
//   Пока в поле поиска есть текст, показываются результаты поиска for-web, как
//   обычно.
// * Щелчок по эмодзи передаётся ячейке for-web: поиск по имени показывает её
//   в сетке, щелчок по ней делает то же, что и обычный выбор (эмодзи
//   вставляется в сообщение или ставится реакцией, смотря откуда открыто
//   окно, с меткой набора эмодзи). Всё это происходит синхронно, до
//   отрисовки кадра, — поиск на экране не мелькает. Под сеткой, как у for-web,
//   — эмодзи под указателем и его имя.
// * В колонке вверху — «Часто используемые» (если они уже есть) и быстрый
//   переход к стандартным эмодзи, под серверами — разделы. Раздел, который
//   сейчас виден в сетке, подсвечивается.
// * «Часто используемые» — блок над сеткой, как в Discord. Сюда попадают и
//   стандартные эмодзи, и эмодзи серверов; счётчики хранятся в localStorage
//   отдельно для каждого аккаунта.
//
// Опоры не зависят от сгенерированных имён классов:
//
// * окно — поле поиска (mdui-text-field) с подсказкой «Search for emojis...»
//   (for-web выводит её без перевода), за ним ряд из колонки серверов и
//   столбца с сеткой и полосой предпросмотра;
// * колонка и сетка — прокручиваемые блоки со списком
//   @minht11/solid-virtual-container (класс `virtual-container-<хеш>`):
//   ячейки по 40 px, сдвинутые `transform: translate(x, y)`, отрисованы
//   только видимые; высота списка — свойство `height` его стиля;
// * в сетке подряд идут эмодзи серверов, заголовок «Default», выровненный
//   до целой строки, и стандартные эмодзи — emojiMapping.json for-web. Копию
//   этого файла (`emoji_mapping.json`, stoat-for-web 0.16.3) клиент
//   подставляет в скрипт: по ней считается, где в списке for-web кончаются
//   эмодзи серверов, и берутся имена эмодзи;
// * разделы — `emoji_categories.json`, его тоже подставляет клиент: эмодзи
//   for-web, распределённые по разделам Discord и в его порядке (собирает
//   tools/emoji_categories.mjs из выгрузки Discord). Эмодзи Discord, которых
//   нет у for-web (например, 👩 и 👨 — у for-web только 🧑), не показываются:
//   выбор идёт через ячейку for-web;
// * картинка эмодзи — тот же адрес, что у UnicodeEmoji for-web; набор
//   эмодзи — из отрисованной картинки for-web, а пока её нет — из настроек
//   for-web в IndexedDB (как в defaults.js).
//
// Блок над списком for-web меняет его отступ от начала прокрутки, а список
// замеряет отступ только при смене ширины. Расхождение до пяти строк
// (200 px) он перекрывает запасом отрисовки (overscan по умолчанию — 180 px,
// округляется до пяти строк), поэтому «Часто используемые» — не больше двух
// строк эмодзи с заголовком.
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
  /**
   * emojiMapping.json for-web: `[эмодзи, имя, другие имена…]` в порядке
   * сетки. Подставляет клиент (desktop.rs).
   */
  const MAPPING = __ARACHNID_EMOJI_MAPPING__;
  const EMOJI_COUNT = MAPPING.length;
  /**
   * Первое вхождение каждого эмодзи и его имена: поиск for-web идёт по
   * списку без повторов (EMOJI_MAP_DEDUPE), где остаются первые вхождения.
   */
  const FIRST = new Map();
  const NAMES = new Map();
  MAPPING.forEach(([emoji, ...names], index) => {
    if (FIRST.has(emoji)) return;
    FIRST.set(emoji, index);
    NAMES.set(emoji, names);
  });
  /**
   * Разделы Discord: `{ раздел: [эмодзи…] }` в порядке Discord. Подставляет
   * клиент (desktop.rs).
   */
  const GROUPS = __ARACHNID_EMOJI_CATEGORIES__;
  /** Строк запаса над и под видимой частью своего списка */
  const OVERSCAN_ROWS = 4;
  /** Не больше стольких строк в «Часто используемых» */
  const FREQUENT_ROWS = 2;
  /** Сколько эмодзи помнить */
  const FREQUENT_LIMIT = 50;
  const VIRTUAL_LIST = '[class*="virtual-container-"]';
  /** Набор for-web по умолчанию (Settings.ts) */
  const WEB_DEFAULT_PACK = "fluent-3d";

  /**
   * Разделы в порядке Discord; `indices` — номера эмодзи раздела в
   * emojiMapping.json. «Люди» у Discord — смайлики вместе с людьми, жестами
   * и одеждой.
   */
  const CATEGORIES = [
    { id: "people", icon: "emoji_people" },
    { id: "nature", icon: "emoji_nature" },
    { id: "food", icon: "emoji_food_beverage" },
    { id: "activity", icon: "emoji_events" },
    { id: "travel", icon: "emoji_transportation" },
    { id: "objects", icon: "emoji_objects" },
    { id: "symbols", icon: "emoji_symbols" },
    { id: "flags", icon: "flag" },
  ].map((category) => ({
    ...category,
    indices: (GROUPS[category.id] ?? []).map((emoji) => FIRST.get(emoji)).filter((index) => index !== undefined),
  }));

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
        activity: "Занятия",
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
        activity: "Activities",
        objects: "Objects",
        symbols: "Symbols",
        flags: "Flags",
      };

  /** Картинка стандартного эмодзи — как unicodeEmojiUrl for-web */
  const emojiUrl = (pack, emoji) =>
    `https://static.stoat.chat/emoji/${pack}/${Array.from(emoji, (c) => c.codePointAt(0).toString(16)).join("-")}.svg?v=1`;

  // ───────────────────────── часто используемые ─────────────────────────
  /** Id вошедшего пользователя из копии `auth` for-web или null */
  function currentUser() {
    try {
      const id = JSON.parse(localStorage.getItem("auth") ?? "null")?.session?.userId;
      return typeof id === "string" && id ? id : null;
    } catch {
      return null;
    }
  }

  /** Ключ хранилища — свой у каждого аккаунта, без сессии — общий */
  const storageKey = () => `arachnid:emoji-frequent:${currentUser() ?? "guest"}`;

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

  // Цвета — переменные Material 3 for-web, подходят к любой теме. Заголовки,
  // ячейки и полоса предпросмотра повторяют свои элементы for-web
  // (EmojiOption, EmojiPreviewBar, PreviewEmoji, PreviewName).
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
.arachnid-emoji-frequent[hidden],
.arachnid-emoji-standard[hidden],
.arachnid-emoji-cell[hidden] { display: none; }
.arachnid-emoji-title {
  height: ${CELL}px;
  display: flex;
  align-items: center;
  padding-inline: var(--gap-md);
}
.arachnid-emoji-cells { display: grid; }
.arachnid-emoji-cell {
  flex-shrink: 0;
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
.arachnid-emoji-standard {
  position: relative;
  flex-shrink: 0;
}
.arachnid-emoji-standard > * {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: ${CELL}px;
  box-sizing: border-box;
  contain: strict;
}
.arachnid-emoji-row { display: flex; }
.arachnid-emoji-preview {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding: var(--gap-xs) var(--gap-md);
  min-height: 36px;
  flex-shrink: 0;
  box-sizing: border-box;
}
.arachnid-emoji-preview > img {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  object-fit: contain;
}
.arachnid-emoji-preview > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.2;
  color: var(--colour-foreground);
}
[data-arachnid-emoji-hidden] { display: none !important; }
`;

  function ensureStyle() {
    if (document.getElementById("arachnid-emoji-style")) return;
    const style = h("style", { id: "arachnid-emoji-style" });
    style.textContent = STYLE;
    (document.head ?? document.documentElement).append(style);
  }

  // ─────────────────────────────── набор ───────────────────────────────

  /** Набор стандартных эмодзи из адреса картинки for-web */
  const packOf = (src) => /\/emoji\/([a-z0-9-]+)\//.exec(src ?? "")?.[1] ?? null;

  /**
   * Набор из настроек for-web: IndexedDB `localforage`, ключ `settings` в
   * хранилище аккаунта или общем (подробно — в defaults.js); без настройки —
   * набор for-web по умолчанию. null — настроек нет. Базу и хранилища скрипт
   * не создаёт и обновлению базы не мешает.
   */
  function storedPack() {
    return new Promise((resolve) => {
      const request = indexedDB.open("localforage");
      request.onupgradeneeded = () => request.transaction.abort();
      request.onerror = (event) => {
        event.preventDefault();
        resolve(null);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        const names = Array.from(db.objectStoreNames);
        const own = `@${currentUser()}`;
        const store = names.includes(own) ? own : names.includes("keyvaluepairs") ? "keyvaluepairs" : null;
        if (!store) {
          db.close();
          resolve(null);
          return;
        }
        const read = db.transaction(store, "readonly").objectStore(store).get("settings");
        read.onsuccess = () => {
          db.close();
          const settings = read.result;
          const pack = settings && typeof settings === "object" ? (settings["appearance:unicode_emoji"] ?? WEB_DEFAULT_PACK) : null;
          resolve(typeof pack === "string" && /^[a-z0-9-]+$/.test(pack) ? pack : null);
        };
        read.onerror = (event) => {
          event.preventDefault();
          db.close();
          resolve(null);
        };
      };
    });
  }

  // ─────────────────────────────── окно ───────────────────────────────

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

  /**
   * Строки своего списка при `columns` эмодзи в строке: у каждого раздела —
   * строка заголовка и строки эмодзи.
   */
  function shapeFor(columns) {
    let row = 0;
    const sections = CATEGORIES.map((category) => {
      const section = { category, header: row, rows: Math.ceil(category.indices.length / columns) };
      row += 1 + section.rows;
      return section;
    });
    return { columns, sections, rows: row };
  }

  /**
   * Имя для поиска for-web, под которым эмодзи найдётся быстрее всего: из его
   * имён — то, что входит в имена меньшего числа эмодзи (поиск for-web ищет
   * подстроку).
   */
  function searchName(emoji) {
    const names = NAMES.get(emoji);
    if (!names?.length) return null;
    let best = names[0];
    let fewest = Infinity;
    for (const name of names) {
      const needle = name.toLowerCase();
      let count = 0;
      for (const others of NAMES.values()) {
        if (others.some((other) => other.toLowerCase().includes(needle))) count++;
      }
      if (count < fewest) {
        best = name;
        fewest = count;
      }
    }
    return best;
  }

  /** Дополнить окно; возвращает, что сделать, когда оно закроется */
  function enhance(picker) {
    const { input, rail, railList, grid, gridList, preview } = picker;
    input.dataset.arachnidEmoji = "";
    ensureStyle();

    /**
     * Ширина содержимого сетки — её же for-web берёт у ResizeObserver для
     * числа эмодзи в строке. До первого замера — по размерам блока.
     */
    let gridWidth = null;
    function columns() {
      if (gridWidth === null) {
        const style = getComputedStyle(grid);
        gridWidth = grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      }
      return Math.max(1, Math.floor(gridWidth / CELL));
    }
    const filtering = () => input.value !== "";
    /** Отступ элемента от начала прокрутки сетки */
    const offsetOf = (element) =>
      element.getBoundingClientRect().top - grid.getBoundingClientRect().top + grid.scrollTop;

    /** Поиск for-web: Solid берёт значение поля из события input */
    function setFilter(value) {
      if (input.value === value) return;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const cells = () => Array.from(gridList.children);
    const imageOf = (cell) => cell.querySelector("img");
    const nextFrame = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    function scrollGrid(top) {
      grid.scrollTop = Math.max(0, Math.round(top));
    }

    // ─────────────────────── выбор через for-web ───────────────────────
    // Выбор эмодзи for-web делает в обработчике щелчка своей ячейки (вставка в
    // сообщение или реакция — смотря откуда открыто окно, с меткой набора), и
    // снаружи до него не добраться. Поэтому щелчок по своей ячейке передаётся
    // ячейке for-web.
    let activating = false;

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
     * сетке, щелчок по ней делает то же, что и обычный выбор. Обычно всё
     * происходит синхронно, до отрисовки кадра, — поиск на экране не
     * мелькает. Только если результатов много и нужная ячейка не отрисована,
     * результаты пролистываются с начала.
     */
    async function activate(entry) {
      if (activating) return;
      activating = true;
      const top = grid.scrollTop;
      try {
        showSearch(true);
        setFilter((entry.text !== undefined && searchName(entry.text)) || entry.name);
        let cell = findCell(entry);
        if (!cell) {
          scrollGrid(offsetOf(gridList));
          await nextFrame();
          cell = findCell(entry);
        }
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
        activating = false;
        showSearch(filtering());
        grid.scrollTop = top;
      }
    }

    // ─────────────────────── набор эмодзи ───────────────────────
    /** Набор стандартных эмодзи; null — ещё не известен */
    let pack = null;

    /** Набор по отрисованной картинке for-web (и в обрезанной части списка) */
    function seenPack() {
      for (const image of gridList.querySelectorAll("img.emoji")) {
        const own = packOf(image.src);
        if (own) return own;
      }
      return null;
    }

    function setPack(value) {
      if (!value || value === pack) return;
      pack = value;
      for (const image of frequentBlock?.querySelectorAll("img.emoji") ?? []) {
        const own = packOf(image.src);
        if (own && own !== pack) image.src = image.src.replace(`/emoji/${own}/`, `/emoji/${pack}/`);
      }
      for (const [row, element] of drawn) fillRow(element, row);
    }

    // ─────────────────────── предпросмотр ───────────────────────
    // Полоса for-web показывает эмодзи под указателем только для своих
    // ячеек; для своих ячеек на её месте — своя полоса.
    const ownPreview = preview
      ? h(
          "div",
          { class: "arachnid-emoji-preview", "data-arachnid-emoji-preview": true, "data-arachnid-emoji-hidden": true },
          h("img", { alt: "", draggable: "false" }),
          h("span"),
        )
      : null;
    preview?.after(ownPreview);

    function showOwnPreview(own) {
      if (!ownPreview) return;
      ownPreview.toggleAttribute("data-arachnid-emoji-hidden", !own);
      preview.toggleAttribute("data-arachnid-emoji-hidden", own);
    }

    function showPreview(src, alt, name) {
      if (!ownPreview) return;
      const image = ownPreview.firstChild;
      if (src) image.src = src;
      else image.removeAttribute("src");
      image.alt = alt;
      ownPreview.lastChild.textContent = `:${name}:`;
      showOwnPreview(true);
    }

    // ячейки for-web — снова полоса for-web
    gridList.addEventListener("mouseover", () => showOwnPreview(false));

    // ─────────────────────── часто используемые ───────────────────────
    const frequent = loadFrequent().slice(0, columns() * FREQUENT_ROWS);
    let frequentBlock = null;

    if (frequent.length > 0) {
      frequentBlock = h(
        "div",
        { class: "arachnid-emoji-frequent", "data-arachnid-emoji-frequent": true },
        h("div", { class: "arachnid-emoji-title" }, text.frequent),
        h(
          "div",
          { class: "arachnid-emoji-cells", role: "list" },
          ...frequent.map((entry) => {
            const image = h("img", {
              src: entry.src,
              alt: entry.text ?? `:${entry.name}:`,
              class: entry.text !== undefined ? "emoji" : null,
              draggable: "false",
            });
            return h(
              "button",
              {
                type: "button",
                class: "arachnid-emoji-cell",
                role: "listitem",
                title: `:${entry.name}:`,
                onClick: () => void activate(entry),
                onMouseEnter: () => showPreview(image.src, image.alt, entry.name),
              },
              image,
            );
          }),
        ),
      );
      frequentBlock.lastChild.style.gridTemplateColumns = `repeat(${columns()}, ${CELL}px)`;
      grid.insertBefore(frequentBlock, gridList);
    }

    // ─────────────────────── стандартные эмодзи ───────────────────────
    // Список for-web обрезается перед заголовком «Default»: строк в нём —
    // высота из его стиля / 40, из них стандартных эмодзи — EMOJI_COUNT по
    // `columns` в строке. Сам список при этом не меняется (его ячейки за
    // обрезкой не видны, и их картинки не загружаются), а прокрутка и
    // разметка над ним остаются прежними.
    const standard = h("div", {
      class: "arachnid-emoji-standard",
      role: "list",
      "data-arachnid-emoji-standard": true,
    });
    gridList.after(standard);

    let shape = shapeFor(columns());
    standard.style.height = `${shape.rows * CELL}px`;
    /** Отрисованные строки своего списка: номер строки → элемент */
    const drawn = new Map();
    /** Убранные элементы строк — для повторного использования */
    const spare = { titles: [], rows: [] };

    const sectionAt = (row) =>
      shape.sections.find((section) => row >= section.header && row <= section.header + section.rows);

    const titleElement = () =>
      spare.titles.pop() ??
      h("div", { class: "arachnid-emoji-title", role: "heading", "aria-level": "3" }, h("span"));

    function rowElement() {
      const reused = spare.rows.pop();
      if (reused) return reused;
      const row = h("div", { class: "arachnid-emoji-row", role: "presentation" });
      for (let column = 0; column < shape.columns; column++) {
        row.append(
          h(
            "button",
            { type: "button", class: "arachnid-emoji-cell", role: "listitem" },
            h("img", { class: "emoji", draggable: "false", alt: "" }),
          ),
        );
      }
      return row;
    }

    /** Показать в элементе строку `row` своего списка */
    function fillRow(element, row) {
      const section = sectionAt(row);
      element.style.transform = `translateY(${row * CELL}px)`;
      if (row === section.header) {
        element.firstChild.textContent = text[section.category.id];
        return;
      }
      const start = (row - section.header - 1) * shape.columns;
      for (let column = 0; column < shape.columns; column++) {
        const button = element.children[column];
        const index = section.category.indices[start + column];
        button.hidden = index === undefined;
        if (button.hidden) continue;
        const [emoji, name] = MAPPING[index];
        const image = button.firstChild;
        button.dataset.index = String(index);
        button.title = `:${name}:`;
        image.alt = emoji;
        const src = pack ? emojiUrl(pack, emoji) : null;
        if (!src) image.removeAttribute("src");
        else if (image.getAttribute("src") !== src) image.src = src;
      }
    }

    function dropRow(row) {
      const element = drawn.get(row);
      drawn.delete(row);
      element.remove();
      (element.classList.contains("arachnid-emoji-row") ? spare.rows : spare.titles).push(element);
    }

    /** Отрисовать видимые строки своего списка (и запас вокруг них) */
    function drawStandard() {
      if (standard.hidden) return;
      const { standardTop, height } = measure();
      const view = grid.scrollTop - standardTop;
      const first = Math.max(0, Math.floor(view / CELL) - OVERSCAN_ROWS);
      const last = Math.min(shape.rows - 1, Math.floor((view + height) / CELL) + OVERSCAN_ROWS);
      for (const row of Array.from(drawn.keys())) if (row < first || row > last) dropRow(row);
      for (let row = first; row <= last; row++) {
        if (drawn.has(row)) continue;
        const element = row === sectionAt(row).header ? titleElement() : rowElement();
        fillRow(element, row);
        drawn.set(row, element);
        standard.append(element);
      }
    }

    /** Ширина сетки изменилась — строки другой длины */
    function reshape() {
      const count = columns();
      if (count === shape.columns) return;
      for (const row of Array.from(drawn.keys())) dropRow(row);
      spare.rows.length = 0;
      shape = shapeFor(count);
      standard.style.height = `${shape.rows * CELL}px`;
    }

    function cutList() {
      const total = Math.round(parseFloat(gridList.style.height || "0") / CELL);
      const leading = total - Math.ceil(EMOJI_COUNT / shape.columns);
      const height = `${Math.max(0, leading - 1) * CELL}px`;
      if (gridList.style.getPropertyValue("max-height") !== height) {
        gridList.style.setProperty("max-height", height, "important");
      }
      if (gridList.style.getPropertyValue("overflow") !== "clip") {
        gridList.style.setProperty("overflow", "clip", "important");
      }
    }

    function uncutList() {
      gridList.style.removeProperty("max-height");
      gridList.style.removeProperty("overflow");
    }

    /** Поиск — результаты for-web целиком; без поиска — свои разделы */
    function showSearch(searching) {
      if (frequentBlock) frequentBlock.hidden = searching;
      standard.hidden = searching;
      if (searching) {
        uncutList();
        showOwnPreview(false);
      } else cutList();
      layout = null;
      update();
    }

    const cellOf = (event) => {
      const button = event.target instanceof Element ? event.target.closest(".arachnid-emoji-cell") : null;
      const entry = button && !button.hidden ? MAPPING[Number(button.dataset.index)] : null;
      return entry ? { button, emoji: entry[0], name: entry[1] } : null;
    };
    standard.addEventListener("mouseover", (event) => {
      const cell = cellOf(event);
      if (cell) showPreview(cell.button.firstChild.getAttribute("src"), cell.emoji, cell.name);
    });
    standard.addEventListener("click", (event) => {
      const cell = cellOf(event);
      if (cell) void activate({ text: cell.emoji, name: cell.name });
    });

    // ─────────────────────── учёт выбранных эмодзи ───────────────────────
    /** Имя из полосы предпросмотра for-web, если она показывает эту картинку */
    function previewName(image) {
      const shown = preview?.querySelector("img");
      if (!shown || image.classList.contains("emoji") || shown.src !== image.src) return null;
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
      if (image.classList.contains("emoji")) {
        // имя стандартного — то же, что показывает for-web
        const name = NAMES.get(image.alt)?.[0];
        if (name) recordUse({ key: `u:${image.alt}`, name, src: image.src, text: image.alt });
        return;
      }
      const key = `c:${image.src}`;
      const name =
        previewName(image) ??
        (activating ? input.value : null) ??
        loadFrequent().find((entry) => entry.key === key)?.name;
      if (name) recordUse({ key, name, src: image.src });
    });

    // ─────────────────────────── колонка ───────────────────────────
    const sectionTop = (index) => offsetOf(standard) + shape.sections[index].header * CELL;

    function jumpToCategory(index) {
      setFilter("");
      scrollGrid(sectionTop(index));
    }

    function jumpToStandard() {
      jumpToCategory(0);
      // и разделы в колонке — в поле зрения
      rail.scrollTop += categoryBlock.getBoundingClientRect().top - rail.getBoundingClientRect().top;
    }

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
      ...CATEGORIES.map((category, index) =>
        railButton(category.id, category.icon, text[category.id], () => jumpToCategory(index)),
      ),
    );
    rail.insertBefore(topBlock, railList);
    railList.after(categoryBlock);

    // ─────────────────────────── прокрутка ───────────────────────────
    // Размеры сетки читаются не при каждой прокрутке: чтение заставляет
    // браузер сразу пересчитать раскладку, которую список for-web только что
    // поменял. Меняются они лишь вместе с размерами сетки и блоков в ней
    // (ширина и высота окна, поиск, эмодзи серверов, «Часто используемые»),
    // за которыми следит ResizeObserver.
    let layout = null;
    const measure = () =>
      (layout ??= {
        listTop: offsetOf(gridList),
        standardTop: offsetOf(standard),
        height: grid.clientHeight,
      });

    function activeSection() {
      if (filtering()) return null;
      const { listTop, standardTop } = measure();
      const top = grid.scrollTop + 1;
      if (top < standardTop) return frequentBlock && top < listTop ? "frequent" : null;
      // раздел, заголовок которого дошёл до верха, уже считается открытым
      let active = null;
      for (const section of shape.sections) {
        if (standardTop + section.header * CELL <= top) active = section.category.id;
      }
      return active;
    }

    let shown;
    function highlight() {
      const active = activeSection();
      if (active === shown) return;
      shown = active;
      for (const [id, button] of buttons) button.toggleAttribute("data-active", id === active);
    }

    let pending = false;
    function update() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        drawStandard();
        highlight();
      });
    }

    const resize = new ResizeObserver((entries) => {
      for (const entry of entries) if (entry.target === grid) gridWidth = entry.contentRect.width;
      reshape();
      if (!filtering() && !activating) cutList();
      layout = null;
      update();
    });
    for (const element of [grid, gridList, frequentBlock]) if (element) resize.observe(element);

    // высота списка for-web меняется вместе с эмодзи серверов и поиском
    const listWatch = new MutationObserver(() => {
      if (!filtering() && !activating) cutList();
    });
    listWatch.observe(gridList, { attributes: true, attributeFilter: ["style"] });

    grid.addEventListener("scroll", update, { passive: true });

    // Поиск for-web обновляет список в обработчике события input на document
    // (делегирование Solid); слушатель на window срабатывает после него.
    const onInput = (event) => {
      if (event.target === input && !activating) showSearch(filtering());
    };
    window.addEventListener("input", onInput);

    // Набор — по картинке for-web; пока её нет (наверху только эмодзи
    // серверов) — из настроек for-web. Пока окно открыто, набор не меняется:
    // наблюдение нужно только до первой картинки.
    let packWatch = null;
    let packSeen = false;
    function watchPack() {
      const seen = seenPack();
      if (!seen) return false;
      packSeen = true;
      setPack(seen);
      packWatch?.disconnect();
      packWatch = null;
      return true;
    }
    if (!watchPack()) {
      packWatch = new MutationObserver(watchPack);
      packWatch.observe(gridList, { childList: true, subtree: true });
      void storedPack().then((stored) => {
        if (!packSeen && input.isConnected) setPack(stored);
      });
    }

    showSearch(filtering());

    // окно закрыто
    return () => {
      resize.disconnect();
      listWatch.disconnect();
      packWatch?.disconnect();
      window.removeEventListener("input", onInput);
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
