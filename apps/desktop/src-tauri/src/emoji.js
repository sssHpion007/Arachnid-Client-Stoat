// Разделы с заголовками и «Часто используемые» в окне выбора эмодзи, как в
// Discord, крупные эмодзи в реакциях и значки ролей без обрезки. Избранные
// GIF — в gifs.js, тот же плагин «Quality of Life».
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
// * В колонке вверху — «Избранное» и «Часто используемые» (если они уже
//   есть), под серверами — разделы. Раздел, который сейчас виден в сетке,
//   подсвечивается. Пока разделы в колонке не видны (серверов много), внизу
//   колонки поверх серверов — кнопка перехода к стандартным эмодзи; переход
//   показывает разделы, и кнопка прячется, пока они снова не уйдут из вида.
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
// Реакции под сообщением (Reactions.tsx for-web) — плашки с эмодзи и
// счётчиком. Эмодзи в них — 1.2em: при 14 px текста это около 17 px на
// плашке высотой 37 px (отступы по 8 px и строка 1.5 — сброс стилей Panda),
// заметно мельче, чем в Discord. Плашка — flex-строка без выравнивания по
// вертикали, поэтому эмодзи прижат к верху строки текста и стоит примерно на
// 2 px выше середины. Скрипт делает эмодзи размером с эмодзи в тексте
// сообщений (`--emoji-size` Stoat — 1.4em; в плашке он не задан, поэтому
// размер записан числом) и ставит его по центру. 1.4em меньше строки (1.5),
// так что плашка не растёт: отступы, скругление, цвета и счётчик остаются как
// у Stoat. Стили for-web лежат в слоях (@layer) Panda, а стиль скрипта — вне
// слоёв, поэтому перекрывает их без !important. Опоры:
//
// * список реакций — блок, где среди детей есть кнопка «+» (`class="add"`,
//   for-web задаёт этот класс явно);
// * реакция — обёртка подсказки (div) с плашкой, у которой прямой ребёнок —
//   картинка эмодзи `img.emoji` (UnicodeEmoji и CustomEmoji for-web).
//
// Значок роли — картинка, которую загрузил сервер (autumn, тег icons:
// `<autumn>/icons/<id>`; пропорции autumn сохраняет), в квадрате 16 px: в
// заголовке группы роли в списке участников (MemberSidebar.tsx, RoleIcon) и
// рядом с ником в сообщении (Message.tsx, Avatar с формой rounded-square).
// for-web растягивает картинку на весь квадрат (object-fit: cover) и
// скругляет углы, поэтому неквадратный значок обрезается по краям. А если
// просто вписать её в квадрат (contain), широкий значок станет ниже и уже
// соседнего текста. Поэтому значок — во всю высоту (16 px), а ширина — по
// пропорциям картинки (не больше трёх высот, шире — вписывается), как в
// Discord; скругление снято: значки ролей — обычно картинки с прозрачным
// фоном, как эмодзи, и скругление срезало бы их края.
//
// * Заголовок группы — обычная картинка: ширину по пропорциям даёт CSS
//   (`width: auto`). Опора — картинка значка, за которой ровно два span: имя
//   роли и « – число».
// * Сам заголовок группы — строка виртуального списка участников, как и
//   карточка участника: все строки по 42 px. for-web даёт заголовку отступ
//   28 px сверху и 0 снизу, а значок — 16 px: заголовок выходит за строку на
//   2 px, и карточка участника под ним закрывает низ значка, а между
//   заголовком и карточкой нет зазора. Скрипт укладывает заголовок в 42 px:
//   20 px сверху, 16 px — значок и название (по центру друг друга, с
//   значком и без), 6 px зазора до карточки. Опора — строка списка
//   @minht11/solid-virtual-container, в которой блок из названия и « –
//   число» (и, может быть, значка перед ними).
// * Рядом с ником — Avatar: svg со стилем `width: 16px` и viewBox 0 0 32 32,
//   внутри foreignObject 32×32 с формой (div) и картинкой. Размер svg задан
//   числом, а viewBox из CSS не поменять, поэтому, когда картинка
//   загрузилась, скрипт ставит ширину svg, viewBox и ширину foreignObject по
//   её пропорциям и помечает svg (`data-arachnid-role-icon`: стиль больше не
//   `width: 16px`, а пометка оставляет его своим). Опора — Avatar 16 px прямо в
//   обёртке подсказки (div). Значок сервера в ссылке-приглашении — тоже
//   Avatar 16 px с картинкой icons, но он лежит прямо в ссылке (a или span) и
//   не меняется.
//
// Блок над списком for-web меняет его отступ от начала прокрутки, а список
// замеряет отступ при первом замере размеров (ResizeObserver) и потом только
// при смене ширины. Поэтому окно дополняется сразу, как только появилось
// (в обработчике MutationObserver, до первого кадра): первый замер уже
// видит блоки над списком. Если блок вырос, пока окно открыто (эмодзи
// добавили в избранное), расхождение до пяти строк (200 px) список
// перекрывает запасом отрисовки (overscan по умолчанию — 180 px,
// округляется до пяти строк); «Часто используемые» — не больше двух строк
// эмодзи с заголовком.
//
// Меню эмодзи (настройка `emoji_picker`, как и всё окно):
//
// * правый щелчок по эмодзи в окне — своё меню в стиле ContextMenu for-web:
//   «Скачать изображение» и «Добавить в избранное» / «Убрать из
//   избранного»;
// * «Избранное» — блок над «Часто используемыми» и кнопка со звёздочкой в
//   колонке, как в Discord: эмодзи в порядке добавления, в localStorage
//   отдельно для каждого аккаунта;
// * «Скачать изображение» есть и в меню for-web, которое открывает правый
//   щелчок по эмодзи в сообщении (меню сообщения): пункт добавляется первым.
//   Картинку берёт страница — ту же, что показывает, — а клиент спрашивает
//   окном «Сохранить как», куда её записать (image_save.rs).
//
// Это встроенный плагин «Quality of Life» (extensions.rs): он выполняется
// после загрузки страницы, как плагин-папка, — телом функции с объектом
// `plugin` — и выключается в разделе «Плагины» (страница перезагружается —
// стили реакций и значков уходят вместе с ним). У плагина есть настройки
// (шестерёнка в его строке): `interface` — реакции, значки ролей, заголовки
// групп участников, подсветка кнопок при наведении (см. «подсветка при
// наведении» ниже) и меню браузера там, где у for-web нет своего (см. «меню
// браузера»), `emoji_picker` — окно эмодзи. Они действуют сразу:
// стили и значки ролей меняются на месте, пункт «Скачать изображение» в меню
// сообщения появляется и пропадает сразу, окно эмодзи меняется со следующего
// открытия.
// Работает только там, где bridge.js создал window.__arachnidDesktop
// (страница веб-клиента из config.toml).
(() => {
  "use strict";

  if (!window.__arachnidDesktop) return;

  const internals = window.__TAURI_INTERNALS__;
  const invoke = (command, args) =>
    internals ? internals.invoke(command, args) : Promise.reject(new Error("Tauri недоступен"));

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
  /** Плашка реакции (Reactions.tsx): обёртка подсказки → плашка с img.emoji */
  const REACTION = "div:has(> div > .add) > div > div:has(> img.emoji)";
  /** Эмодзи в реакции — как --emoji-size Stoat для эмодзи в тексте */
  const REACTION_EMOJI = "1.4em";
  /** Картинка значка роли (или сервера): файл autumn с тегом icons */
  const ICON = 'img[src*="/icons/"]';
  /** Значок в заголовке группы роли: за ним имя роли и « – число» */
  const MEMBER_ROLE_ICON = `${ICON}:first-child:has(+ span + span:last-child)`;
  /** Пометка svg значка роли, которому скрипт уже задал ширину */
  const ROLE_ICON_MARK = "data-arachnid-role-icon";
  /**
   * Форма Avatar значка роли рядом с ником: Avatar 16 px (или уже
   * помеченный скриптом) прямо в обёртке подсказки
   */
  const MESSAGE_ROLE_ICON = `div > svg:is([style*="width: 16px"], [${ROLE_ICON_MARK}]) > g > foreignObject > div:has(> ${ICON})`;
  /**
   * Заголовок группы в списке участников (CategoryTitle): строка
   * виртуального списка — название и « – число», перед ними может быть значок
   */
  const MEMBER_GROUP = `${VIRTUAL_LIST} > div > div:is(:has(> span:first-child + span:last-child), :has(> img:first-child + span + span:last-child))`;
  /** Строка списка участников (itemSize в MemberSidebar.tsx) */
  const MEMBER_ROW = 42;
  /** Зазор между заголовком группы и карточкой участника под ним */
  const MEMBER_GROUP_GAP = 6;
  /** Высота значка роли — как у for-web (Avatar size 16, RoleIcon 16 px) */
  const ROLE_ICON_SIZE = 16;
  /** Значок роли шире стольких высот вписывается, а не растягивает строку */
  const ROLE_ICON_MAX_RATIO = 3;

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
        favorites: "Избранное",
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
        download: "Скачать изображение",
        favorite: "Добавить в избранное",
        unfavorite: "Убрать из избранного",
        failed: "Не удалось сохранить изображение",
      }
    : {
        favorites: "Favorites",
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
        download: "Download Image",
        favorite: "Add to Favorites",
        unfavorite: "Remove from Favorites",
        failed: "Could not save the image",
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

  // ─────────────────────────────── избранное ───────────────────────────────
  /** Ключ избранного — как у «Часто используемых», свой у каждого аккаунта */
  const favoritesKey = () => `arachnid:emoji-favorites:${currentUser() ?? "guest"}`;

  /** `[{ key, name, src, text? }]` в порядке добавления */
  function loadFavorites() {
    try {
      const list = JSON.parse(localStorage.getItem(favoritesKey()) ?? "[]");
      return Array.isArray(list)
        ? list.filter((entry) => entry && typeof entry.key === "string" && entry.name && entry.src)
        : [];
    } catch {
      return [];
    }
  }

  /** Открытые окна, которым нужно перерисовать «Избранное» */
  const favoriteListeners = new Set();

  const isFavorite = (key) => loadFavorites().some((entry) => entry.key === key);

  /** Добавить эмодзи в избранное (в конец) или убрать его оттуда */
  function toggleFavorite(entry) {
    const list = loadFavorites();
    const index = list.findIndex((item) => item.key === entry.key);
    if (index === -1) {
      const { key, name, src, text: emoji } = entry;
      list.push(emoji === undefined ? { key, name, src } : { key, name, src, text: emoji });
    } else {
      list.splice(index, 1);
    }
    try {
      localStorage.setItem(favoritesKey(), JSON.stringify(list));
    } catch {
      return;
    }
    for (const listener of favoriteListeners) listener();
  }

  /** Имя эмодзи сервера по картинке — из избранного или «Часто используемых» */
  const knownName = (key) =>
    (loadFavorites().find((entry) => entry.key === key) ?? loadFrequent().find((entry) => entry.key === key))
      ?.name ?? null;


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
  // (EmojiOption, EmojiPreviewBar, PreviewEmoji, PreviewName). Реакции и
  // значки ролей — отдельным стилем (INTERFACE_STYLE): его включает и
  // выключает настройка `interface`.
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
.arachnid-emoji-dock {
  position: sticky;
  bottom: 0;
  z-index: 1;
  flex-shrink: 0;
  height: 0;
  /* у колонки for-web — промежуток между элементами, у этого блока его нет */
  margin-top: calc(-1 * var(--gap-sm, 0px));
}
/* Как unicodeShortcut в Discord: полоса во всю ширину колонки с линией
   сверху и фоном окна, значок — как у остальных кнопок колонки. Прячется,
   уезжая вниз за край колонки. */
.arachnid-emoji-dock > .arachnid-emoji-rail-button {
  position: absolute;
  bottom: 0;
  left: 0;
  box-sizing: border-box;
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container);
  transition: transform 0.2s ease, opacity 0.2s ease;
}
.arachnid-emoji-dock > .arachnid-emoji-rail-button[hidden] {
  display: flex;
  visibility: hidden;
  pointer-events: none;
  opacity: 0;
  transform: translateY(100%);
  transition: transform 0.2s ease, opacity 0.2s ease, visibility 0s 0.2s;
}
.arachnid-emoji-divider {
  flex-shrink: 0;
  height: 1px;
  margin: 4px 8px;
  background: var(--md-sys-color-outline-variant);
}
.arachnid-emoji-rail-button[hidden],
.arachnid-emoji-favorites[hidden],
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
.arachnid-emoji-menu {
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
  box-shadow: var(--md-sys-elevation-2);
  user-select: none;
  font-size: 0.875rem;
  line-height: 1.25rem;
}
.arachnid-emoji-menu-item {
  display: flex;
  gap: var(--gap-md);
  align-items: center;
  padding: var(--gap-md) var(--gap-lg);
  cursor: pointer;
}
.arachnid-emoji-menu-item:hover {
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
}
.arachnid-emoji-menu-item:active {
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent);
}
.arachnid-emoji-menu-item > .material-symbols-outlined { font-size: 16px; }
.arachnid-emoji-menu-item > [data-fill] { font-variation-settings: "FILL" 1; }
.arachnid-emoji-menu-item > span:not([aria-hidden="true"]) { flex-grow: 1; margin-top: 1px; }
.arachnid-emoji-snackbar {
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

  /** Реакции, заголовки групп участников и значки ролей (см. начало файла) */
  const INTERFACE_STYLE = `
${REACTION} {
  align-items: center;
}
${REACTION} > img.emoji {
  width: ${REACTION_EMOJI};
  height: ${REACTION_EMOJI};
}
${MEMBER_GROUP} {
  box-sizing: border-box;
  height: ${MEMBER_ROW}px;
  padding-top: ${MEMBER_ROW - ROLE_ICON_SIZE - MEMBER_GROUP_GAP}px;
  padding-bottom: ${MEMBER_GROUP_GAP}px;
}
${MEMBER_ROLE_ICON} {
  width: auto;
  max-width: ${ROLE_ICON_SIZE * ROLE_ICON_MAX_RATIO}px;
  object-fit: contain;
  border-radius: 0;
}
${MESSAGE_ROLE_ICON} {
  border-radius: 0;
}
${MESSAGE_ROLE_ICON} > img {
  object-fit: contain;
}
`;

  function ensureStyle(id, css) {
    if (document.getElementById(id)) return;
    const style = h("style", { id });
    style.textContent = css;
    (document.head ?? document.documentElement).append(style);
  }

  // ─────────────────────────────── меню ───────────────────────────────
  // Правый щелчок в окне эмодзи — своё меню в стиле ContextMenu for-web
  // (как меню избранных GIF в gifs.js) вместо меню браузера.

  const errorText = (error) => String(error?.message ?? error ?? "");

  let snackbar = null;
  let snackbarTimer = 0;
  function toast(message) {
    snackbar?.remove();
    clearTimeout(snackbarTimer);
    snackbar = h("div", { class: "arachnid-emoji-snackbar", role: "status" }, message);
    document.body.append(snackbar);
    snackbarTimer = setTimeout(() => {
      snackbar?.remove();
      snackbar = null;
    }, 4000);
  }

  /** Не дать for-web закрыть окно эмодзи: оно закрывается по нажатию вне себя */
  function keepFloating(element) {
    for (const type of ["mousedown", "pointerdown"]) {
      element.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  let menuState = null;
  const closeMenu = () => menuState?.close();

  /** Меню у точки `x, y`: `entries` — `{ icon, label, fill?, action }` */
  function showMenu(x, y, entries) {
    closeMenu();
    const menu = h("div", { class: "arachnid-emoji-menu", role: "menu", "data-arachnid-emoji-menu": true });
    for (const entry of entries) {
      const glyph = icon(entry.icon);
      if (entry.fill) glyph.setAttribute("data-fill", "");
      const item = h("a", { class: "arachnid-emoji-menu-item", role: "menuitem" }, glyph, h("span", null, entry.label));
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
      // Escape закрывает только меню, окно эмодзи остаётся
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

  /**
   * Сохранить картинку эмодзи: страница берёт ту же картинку, что
   * показывает (стандартные эмодзи клиент отдаёт растром из своего набора),
   * а клиент спрашивает, куда её записать (image_save.rs).
   */
  async function downloadEmoji(entry) {
    try {
      const response = await fetch(entry.src);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = new Uint8Array(await response.arrayBuffer());
      const name = entry.name ?? idOf(entry.src) ?? "emoji";
      await invoke("image_save", { name, data: Array.from(data) });
    } catch (error) {
      console.warn("[emoji] картинка не сохранена", error);
      toast(`${text.failed}: ${errorText(error)}`);
    }
  }

  /** Пункты меню эмодзи: скачать и, если известно имя, избранное */
  function emojiMenuEntries(entry) {
    const entries = [{ icon: "download", label: text.download, action: () => void downloadEmoji(entry) }];
    if (entry.key && entry.name) {
      const favorite = isFavorite(entry.key);
      entries.push({
        icon: "star",
        fill: favorite,
        label: favorite ? text.unfavorite : text.favorite,
        action: () => toggleFavorite(entry),
      });
    }
    return entries;
  }

  /** Имя файла эмодзи сервера, если имени нет: id из адреса autumn */
  const idOf = (src) => /\/emojis\/([A-Za-z0-9_-]+)/.exec(src ?? "")?.[1] ?? null;

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
        // всё окно — блок в #floating (Portal for-web), иначе — поле с рядом
        const root = input.closest("#floating > *") ?? row.parentElement;
        return { root, input, rail, railList, grid, gridList, preview: column.children[1] ?? null };
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

  /** Блоки открытых улучшенных окон — у них своё меню */
  const pickerRoots = new Set();

  /** Дополнить окно; возвращает, что сделать, когда оно закроется */
  function enhance(picker) {
    const { root, input, rail, railList, grid, gridList, preview } = picker;
    input.dataset.arachnidEmoji = "";

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
    // Картинка эмодзи — прямо в ячейке (рядом с md-ripple). В заголовке
    // сервера картинка — значок сервера внутри Avatar: это не эмодзи.
    const imageOf = (cell) => cell.querySelector(":scope > img");
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
      for (const block of [favoritesBlock, frequentBlock]) {
        for (const image of block?.querySelectorAll("img.emoji") ?? []) {
          const own = packOf(image.src);
          if (own && own !== pack) image.src = image.src.replace(`/emoji/${own}/`, `/emoji/${pack}/`);
        }
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

    // ─────────────────── избранное и часто используемые ───────────────────
    /** Запись эмодзи у ячеек «Избранного» и «Часто используемых» */
    const entryOf = new WeakMap();

    /** Ячейка эмодзи из записи `{ key, name, src, text? }` */
    function entryCell(entry) {
      const standard = entry.text !== undefined;
      const image = h("img", {
        src: standard && pack ? emojiUrl(pack, entry.text) : entry.src,
        alt: entry.text ?? `:${entry.name}:`,
        class: standard ? "emoji" : null,
        draggable: "false",
      });
      const button = h(
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
      entryOf.set(button, entry);
      return button;
    }

    /** Блок над сеткой: заголовок и ячейки по `columns()` в строке */
    function entryBlock(kind, title) {
      const block = h(
        "div",
        { class: `arachnid-emoji-${kind}`, [`data-arachnid-emoji-${kind}`]: true },
        h("div", { class: "arachnid-emoji-title" }, title),
        h("div", { class: "arachnid-emoji-cells", role: "list" }),
      );
      block.lastChild.style.gridTemplateColumns = `repeat(${columns()}, ${CELL}px)`;
      return block;
    }

    // «Часто используемые» собираются при открытии окна и, пока оно
    // открыто, не меняются: иначе эмодзи уезжали бы из-под указателя.
    const frequent = loadFrequent().slice(0, columns() * FREQUENT_ROWS);
    let frequentBlock = null;
    if (frequent.length > 0) {
      frequentBlock = entryBlock("frequent", text.frequent);
      frequentBlock.lastChild.append(...frequent.map(entryCell));
      grid.insertBefore(frequentBlock, gridList);
    }

    // «Избранное» — над ними, как в Discord; меняется сразу из меню эмодзи
    const favoritesBlock = entryBlock("favorites", text.favorites);
    grid.insertBefore(favoritesBlock, frequentBlock ?? gridList);

    function renderFavorites() {
      const favorites = loadFavorites();
      favoritesBlock.lastChild.replaceChildren(...favorites.map(entryCell));
      favoritesBlock.hidden = favorites.length === 0 || filtering();
      buttons.get("favorites")?.toggleAttribute("hidden", favorites.length === 0);
      layout = null;
      update();
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
      for (const block of [favoritesBlock, frequentBlock]) {
        if (block) block.lastChild.style.gridTemplateColumns = `repeat(${count}, ${CELL}px)`;
      }
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
      favoritesBlock.hidden = searching || favoritesBlock.lastChild.childElementCount === 0;
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

    // ─────────────────────────── меню ───────────────────────────
    /** Стандартный эмодзи как запись избранного */
    const standardEntry = (emoji, name, src) => ({
      key: `u:${emoji}`,
      name,
      src: src || emojiUrl(pack ?? WEB_DEFAULT_PACK, emoji),
      text: emoji,
    });

    /**
     * Эмодзи под указателем: свои ячейки — разделы, «Избранное» и «Часто
     * используемые», — и ячейки for-web (эмодзи серверов и результаты
     * поиска). У эмодзи сервера имя — из полосы предпросмотра for-web (она
     * показывает эмодзи под указателем) или из сохранённых записей; без
     * имени его не добавить в избранное (выбор идёт поиском по имени), но
     * можно скачать. Заголовки — серверов (со значком сервера) и разделов —
     * не эмодзи: меню на них нет.
     */
    function emojiAt(target) {
      if (!(target instanceof Element)) return null;
      const button = target.closest(".arachnid-emoji-cell");
      if (button) {
        if (button.hidden) return null;
        const own = entryOf.get(button);
        if (own) return own;
        const mapped = MAPPING[Number(button.dataset.index)];
        return mapped ? standardEntry(mapped[0], mapped[1], button.firstChild.getAttribute("src")) : null;
      }
      let cell = target;
      while (cell && cell.parentElement !== gridList) cell = cell.parentElement;
      const image = cell && imageOf(cell);
      if (!image?.src) return null;
      if (image.classList.contains("emoji")) {
        const name = NAMES.get(image.alt)?.[0];
        return name ? standardEntry(image.alt, name, image.src) : null;
      }
      const key = `c:${image.src}`;
      return { key, name: previewName(image) ?? knownName(key), src: image.src };
    }

    // На эмодзи — своё меню. Обработчик стоит на всём окне в фазе
    // перехвата: меню for-web на картинках ячеек (если оно есть) не
    // открывается вместе с ним. Меню браузера на остальном месте окна
    // убирает настройка `interface` (см. «меню браузера» ниже) — для всего
    // интерфейса сразу.
    function onContextMenu(event) {
      const entry = emojiAt(event.target);
      if (!entry) return;
      event.preventDefault();
      event.stopPropagation();
      showMenu(event.clientX, event.clientY, emojiMenuEntries(entry));
    }
    root.addEventListener("contextmenu", onContextMenu, true);
    pickerRoots.add(root);

    // ─────────────────────────── колонка ───────────────────────────
    const sectionTop = (index) => offsetOf(standard) + shape.sections[index].header * CELL;

    function jumpToCategory(index) {
      setFilter("");
      scrollGrid(sectionTop(index));
    }

    /** «Избранное» и «Часто используемые» при поиске скрыты — сначала сброс */
    function jumpToBlock(block) {
      setFilter("");
      scrollGrid(offsetOf(block));
    }

    /**
     * Сервер в колонке. for-web прокручивает сетку к его эмодзи на «номер
     * строки × 40» от начала своего списка (EmojiPicker.tsx), а над списком
     * теперь «Избранное» и «Часто используемые»: заголовок сервера оказался
     * бы ниже верха сетки на их высоту и выглядывал бы снизу. Щелчок for-web
     * обрабатывает в том же событии (делегирование Solid на document), а
     * кадр — после него: поправка ставит заголовок к верху до отрисовки.
     * Несколько щелчков до кадра — одна поправка: for-web каждый раз ставит
     * ту же прокрутку от начала списка.
     */
    let serverJump = false;
    function onServerClick(event) {
      if (serverJump || !(event.target instanceof Element) || !event.target.closest('[role="listitem"]')) return;
      serverJump = true;
      requestAnimationFrame(() => {
        serverJump = false;
        // при поиске над списком ничего нет — поправка нулевая
        scrollGrid(grid.scrollTop + offsetOf(gridList));
      });
    }
    railList.addEventListener("click", onServerClick, true);

    /** Разделы в колонке — в поле зрения; сетка — к первому, если она не в них */
    function jumpToStandard() {
      const inStandard = !filtering() && CATEGORIES.some((category) => category.id === activeSection());
      if (!inStandard) jumpToCategory(0);
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
      railButton("favorites", "star", text.favorites, () => jumpToBlock(favoritesBlock)),
      frequentBlock
        ? railButton("frequent", "schedule", text.frequent, () => jumpToBlock(frequentBlock))
        : null,
    );
    // Кнопка перехода к стандартным эмодзи — внизу колонки поверх серверов,
    // как unicodeShortcut в Discord: блок нулевой высоты, прилипающий к низу
    // (sticky), между списком серверов и разделами, а кнопка в нём выступает
    // вверх. Места в колонке она не занимает, поэтому её показ и скрытие
    // ничего не сдвигают.
    const standardButton = railButton("standard", "emoji_emotions", text.standard, jumpToStandard);
    const standardDock = h("div", { class: "arachnid-emoji-dock" }, standardButton);
    const categoryBlock = h(
      "div",
      { class: "arachnid-emoji-rail", "data-arachnid-emoji-rail": "categories" },
      h("div", { class: "arachnid-emoji-divider", role: "separator" }),
      ...CATEGORIES.map((category, index) =>
        railButton(category.id, category.icon, text[category.id], () => jumpToCategory(index)),
      ),
    );
    rail.insertBefore(topBlock, railList);
    railList.after(standardDock, categoryBlock);

    // кнопка видна, только пока разделов в колонке не видно
    standardButton.hidden = true;
    const categoryWatch = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) standardButton.hidden = entry.isIntersecting;
      },
      { root: rail },
    );
    categoryWatch.observe(categoryBlock);

    // ─────────────────────────── прокрутка ───────────────────────────
    // Размеры сетки читаются не при каждой прокрутке: чтение заставляет
    // браузер сразу пересчитать раскладку, которую список for-web только что
    // поменял. Меняются они лишь вместе с размерами сетки и блоков в ней
    // (ширина и высота окна, поиск, эмодзи серверов, «Часто используемые»),
    // за которыми следит ResizeObserver.
    let layout = null;
    const measure = () =>
      (layout ??= {
        frequentTop: frequentBlock ? offsetOf(frequentBlock) : null,
        listTop: offsetOf(gridList),
        standardTop: offsetOf(standard),
        height: grid.clientHeight,
      });

    function activeSection() {
      if (filtering()) return null;
      const { frequentTop, listTop, standardTop } = measure();
      const top = grid.scrollTop + 1;
      if (top < standardTop) {
        if (top >= listTop) return null;
        const favorites = !favoritesBlock.hidden;
        if (frequentTop !== null && (top >= frequentTop || !favorites)) return "frequent";
        return favorites ? "favorites" : null;
      }
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
    for (const element of [grid, gridList, favoritesBlock, frequentBlock]) if (element) resize.observe(element);

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

    favoriteListeners.add(renderFavorites);
    renderFavorites();
    showSearch(filtering());

    // окно закрыто
    return () => {
      root.removeEventListener("contextmenu", onContextMenu, true);
      railList.removeEventListener("click", onServerClick, true);
      pickerRoots.delete(root);
      favoriteListeners.delete(renderFavorites);
      closeMenu();
      resize.disconnect();
      categoryWatch.disconnect();
      listWatch.disconnect();
      packWatch?.disconnect();
      window.removeEventListener("input", onInput);
    };
  }

  // ─────────────────────────── значки ролей ───────────────────────────
  /**
   * Значок роли рядом с ником — по пропорциям картинки: svg Avatar шириной
   * `16 × пропорция` px, viewBox и foreignObject — `32 × пропорция` единиц
   * (в высоту по-прежнему 32), чтобы картинка была во всю высоту.
   */
  function fitRoleIcon(img) {
    if (!img.naturalWidth || !img.naturalHeight) return;
    const object = img.parentElement?.parentElement;
    const svg = object?.parentElement?.parentElement;
    if (object?.localName !== "foreignObject" || svg?.localName !== "svg") return;
    const ratio = Math.min(img.naturalWidth / img.naturalHeight, ROLE_ICON_MAX_RATIO);
    const units = Math.round(32 * ratio * 100) / 100;
    svg.setAttribute(ROLE_ICON_MARK, "");
    svg.setAttribute("viewBox", `0 0 ${units} 32`);
    object.setAttribute("width", String(units));
    svg.style.setProperty("width", `${(ROLE_ICON_SIZE * units) / 32}px`);
  }

  const MESSAGE_ROLE_ICON_IMAGE = `${MESSAGE_ROLE_ICON} > img`;

  /**
   * Картинки не всплывают с событием load, но проходят через document при
   * перехвате: так значок подгоняется, как только загрузился (и после смены
   * картинки), без наблюдения за каждым новым сообщением.
   */
  function onImageLoad(event) {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.src.includes("/icons/")) return;
    if (img.matches(MESSAGE_ROLE_ICON_IMAGE)) fitRoleIcon(img);
  }

  function watchRoleIcons() {
    document.addEventListener("load", onImageLoad, true);
    // уже загруженные до запуска плагина или до включения настройки
    for (const img of document.querySelectorAll(MESSAGE_ROLE_ICON_IMAGE)) {
      if (img.complete) fitRoleIcon(img);
    }
  }

  /** Вернуть значкам у ника вид for-web: квадрат 16 px */
  function unwatchRoleIcons() {
    document.removeEventListener("load", onImageLoad, true);
    for (const svg of document.querySelectorAll(`svg[${ROLE_ICON_MARK}]`)) {
      svg.removeAttribute(ROLE_ICON_MARK);
      svg.setAttribute("viewBox", "0 0 32 32");
      svg.querySelector(":scope > g > foreignObject")?.setAttribute("width", "32");
      svg.style.setProperty("width", "16px");
    }
  }

  // ─────────────────────── подсветка при наведении ───────────────────────
  // Подсветку кнопок при наведении и нажатии рисует md-ripple
  // (@material/web, Ripple.tsx for-web): IconButton (GIF, эмодзи в поле
  // сообщения), CategoryButton (строки настроек, выбор языка) и другие.
  // Подсветка — псевдоэлемент ::before в его shadow root, который
  // появляется и гаснет переходом opacity за 15 мс. Такой переход Chromium
  // выполняет в компоновщике: на время перехода псевдоэлемент получает свой
  // слой, а потом рисуется обратно в слой страницы. В WebView2 после этого
  // часть кнопки — обычно нижняя, по границе плитки растра — иногда не
  // перерисовывается, и подсветка остаётся на ней, когда указатель уже
  // ушёл. 15 мс — меньше одного кадра, поэтому переход убирается: подсветка
  // меняется обычной перерисовкой, как у остальных кнопок for-web, а на вид
  // ничего не меняется. Волна нажатия (::after) остаётся как есть.
  //
  // md-ripple — элемент Lit: стили shadow root он берёт из
  // `elementStyles` своего класса (adoptedStyleSheets). Свой лист
  // добавляется туда — для новых кнопок — и в уже созданные кнопки.
  const RIPPLE_CSS = ".surface::before { transition: none; }";
  let rippleSheet = null;
  let rippleWaiting = false;

  function patchRipple(root, on) {
    if (!root) return;
    const sheets = root.adoptedStyleSheets;
    const has = sheets.includes(rippleSheet);
    if (on && !has) root.adoptedStyleSheets = [...sheets, rippleSheet];
    else if (!on && has) root.adoptedStyleSheets = sheets.filter((sheet) => sheet !== rippleSheet);
  }

  function applyRipple() {
    const on = interfaceOn;
    const Ripple = customElements.get("md-ripple");
    if (!Ripple) {
      // for-web регистрирует md-ripple при загрузке своих модулей
      if (on && !rippleWaiting) {
        rippleWaiting = true;
        void customElements.whenDefined("md-ripple").then(() => {
          rippleWaiting = false;
          applyRipple();
        });
      }
      return;
    }
    if (!rippleSheet) {
      rippleSheet = new CSSStyleSheet();
      rippleSheet.replaceSync(RIPPLE_CSS);
    }
    const styles = Ripple.elementStyles;
    if (Array.isArray(styles)) {
      const index = styles.indexOf(rippleSheet);
      if (on && index === -1) styles.push(rippleSheet);
      else if (!on && index !== -1) styles.splice(index, 1);
    }
    for (const ripple of document.querySelectorAll("md-ripple")) patchRipple(ripple.shadowRoot, on);
  }

  // ─────────────────────────── настройки ───────────────────────────
  // ─────────────────────────── меню браузера ───────────────────────────
  // Правый щелчок там, где у for-web нет своего меню, открывает меню
  // WebView2: «Назад», «Обновить», «Сохранить как», «Печать», «Сохранить
  // картинку как…» — в мессенджере всё это не нужно. Обработчик стоит на окне
  // в фазе всплытия, то есть срабатывает после обработчиков for-web и
  // плагинов: если они уже открыли своё меню (preventDefault), он ничего не
  // делает, а иначе отменяет меню WebView2. Меню остаётся только там, где
  // оно нужно:
  //
  // * в полях ввода и редактируемом тексте — «Вырезать», «Вставить»,
  //   подсказки проверки орфографии и «Добавить в словарь»;
  // * при выделенном тексте — «Копировать» (например, в профиле).
  const isEditable = (node) =>
    node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node.isContentEditable === true;

  function onBrowserMenu(event) {
    if (event.defaultPrevented) return;
    if (event.composedPath().some(isEditable)) return;
    const selection = getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim() !== "") return;
    event.preventDefault();
  }

  const INTERFACE_STYLE_ID = "arachnid-interface-style";
  let interfaceOn = false;

  /** Включить или выключить исправления интерфейса по настройке */
  function applyInterface() {
    const wanted = plugin.settings.interface !== false;
    if (wanted === interfaceOn) return;
    interfaceOn = wanted;
    if (wanted) {
      ensureStyle(INTERFACE_STYLE_ID, INTERFACE_STYLE);
      watchRoleIcons();
      addEventListener("contextmenu", onBrowserMenu);
    } else {
      document.getElementById(INTERFACE_STYLE_ID)?.remove();
      unwatchRoleIcons();
      removeEventListener("contextmenu", onBrowserMenu);
    }
    applyRipple();
  }

  const pickerOn = () => plugin.settings.emoji_picker !== false;

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
    // окно без улучшений — как у for-web; включённая настройка подействует
    // со следующего открытия
    if (!pickerOn()) {
      waiting.delete(field);
      return;
    }
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
        if (chatCandidate) considerMenu(node);
        if (!hasField(node)) continue;
        // сразу, до первого замера списка for-web (см. начало файла)
        if (node.matches(FIELDS)) consider(node);
        for (const field of node.querySelectorAll(FIELDS)) consider(field);
      }
    }
    if (wanted) queueScan();
  }

  // ─────────────────────────── меню в чате ───────────────────────────
  // Правый щелчок по эмодзи в сообщении открывает меню сообщения for-web
  // (use:floating на сообщении). Обработчик перехвата на окне запоминает
  // эмодзи, а когда в документе появится меню for-web — блок, где первый
  // ребёнок и ещё хотя бы один — пункты-ссылки, — первым пунктом в него
  // встаёт «Скачать изображение» (копия пункта for-web со своим значком и
  // текстом, за ним — копия разделителя).
  const MENU_WAIT_MS = 1000;
  let chatCandidate = null;

  function onChatContextMenu(event) {
    chatCandidate = null;
    if (!pickerOn()) return;
    const target = event.target;
    if (!(target instanceof HTMLImageElement) || !target.classList.contains("emoji")) return;
    if (!target.src || target.closest("[data-arachnid-emoji-menu]")) return;
    for (const root of pickerRoots) if (root.contains(target)) return;
    chatCandidate = { element: target, time: performance.now() };
  }

  /** Меню for-web: div с пунктами-ссылками */
  function findMenu(node) {
    const isMenu = (element) =>
      element.firstElementChild?.localName === "a" && element.querySelectorAll(":scope > a").length >= 2;
    if (isMenu(node)) return node;
    for (const element of node.querySelectorAll("div")) if (isMenu(element)) return element;
    return null;
  }

  function considerMenu(node) {
    if (performance.now() - chatCandidate.time > MENU_WAIT_MS || !chatCandidate.element.isConnected) {
      chatCandidate = null;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const menu = findMenu(node);
    if (!menu || menu.querySelector("[data-arachnid-emoji-download]")) return;
    const { element } = chatCandidate;
    chatCandidate = null;
    insertDownload(menu, element);
  }

  /** Эмодзи из сообщения: стандартный — с именем for-web, сервера — по id */
  function chatEmoji(image) {
    const src = image.currentSrc || image.src;
    if (packOf(src)) {
      // перед эмодзи может стоять метка набора и ZWNJ (UnicodeEmoji for-web)
      const emoji = image.alt.replace(/[\uE0E0-\uE0E6\u200C]/g, "");
      return { src, name: NAMES.get(emoji)?.[0] ?? null };
    }
    return { src, name: knownName(`c:${src}`) ?? /^:([^:\s]+):$/.exec(image.alt)?.[1] ?? null };
  }

  function insertDownload(menu, image) {
    const sample = menu.querySelector(":scope > a");
    const item = sample.cloneNode(true);
    for (const name of ["href", "id", "target", "download"]) item.removeAttribute(name);
    item.setAttribute("data-arachnid-emoji-download", "");
    // пункты for-web — с заглавной буквы каждого слова (английский текст)
    item.style.textTransform = "none";
    const children = Array.from(item.children);
    const glyph = children.find(
      (child) => child.localName === "svg" || (child.localName === "span" && child.getAttribute("aria-hidden") === "true"),
    );
    const label = children.filter((child) => child.localName === "span" && child !== glyph).at(0) ?? null;
    if (label) label.textContent = text.download;
    else item.append(h("span", null, text.download));
    if (glyph?.localName === "span") {
      // Symbol for-web: тот же шрифт значков
      glyph.textContent = "download";
      glyph.style.removeProperty("font-variation-settings");
    } else {
      const own = icon("download");
      own.style.cssText = "display:block;font-size:16px";
      if (glyph) glyph.replaceWith(own);
      else item.prepend(own);
    }
    item.addEventListener("click", () => {
      // меню for-web закроется само: оно закрывается по любому щелчку
      void downloadEmoji(chatEmoji(image));
    });
    menu.prepend(item);
    const divider = Array.from(menu.children).find(
      (child) => child.localName === "div" && child.childElementCount === 0 && !child.textContent.trim(),
    );
    if (divider) item.after(divider.cloneNode(true));
  }

  function start() {
    ensureStyle("arachnid-emoji-style", STYLE);
    addEventListener("contextmenu", onChatContextMenu, true);
    applyInterface();
    plugin.onSettingsChange(applyInterface);
    new MutationObserver(observe).observe(document.body, { childList: true, subtree: true });
    added.push(document.body);
    scan();
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
