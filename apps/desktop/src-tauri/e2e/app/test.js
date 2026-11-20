// Проверка клиента в настоящем WebView2 (run.ps1): страница открыта как
// веб-клиент инстанса, поэтому получает мост и скрипты клиента так же, как
// stoat.chat/app.
//
// Шаги идут через перезагрузки страницы (номер шага — в localStorage):
//
// 0. первый запуск: эмодзи первой страницы и запрос страницы отдаёт клиент,
//    новое хранилище localforage сразу получает Twemoji; регистрируется
//    service worker;
// 1. страница под service worker (как for-web после первого входа): запросы
//    страницы и самого service worker отдаёт клиент; настройки с fluent-3d
//    без отметки клиента — как у тех, кто уже пользовался клиентом;
// 2. такие настройки получили Twemoji, остальное в них не тронуто; затем
//    набор выбирается вручную;
// 3. выбранный вручную набор остаётся; окно выбора эмодзи получает разделы
//    в колонке и заголовки разделов в сетке, отрисованы только видимые
//    строки, щелчок по эмодзи доходит до ячейки for-web, а прокрутка не
//    заставляет клиент искать окно по всему документу; на эмодзи — своё
//    меню: эмодзи
//    добавляется в «Избранное» и убирается оттуда, команда сохранения
//    принимает только картинки; в меню сообщения for-web на эмодзи —
//    «Скачать изображение»;
//    шторка выбора набора получает кнопки, Mutant Remix скачивается и
//    удаляется кнопками шторки; эмодзи в реакциях крупнее и по центру
//    плашки, плашка той же высоты; значки ролей видны целиком, во всю
//    высоту и с шириной по пропорциям картинки; заголовок группы участников
//    помещается в строку списка, с зазором до карточки участника;
// 4. избранные GIF: клиент находит GIF по ссылке на файл и на страницу с
//    og:image (и файл, который сайт отдаёт браузеру страницей, как Tenor),
//    страницу без GIF не принимает; окно GIF получает плитку
//    «Избранное», кнопка «+» добавляет GIF по ссылке с описанием и превью
//    WebP, поиск идёт по словам описания, перетаскивание меняет порядок,
//    щелчок отправляет ссылку через API Stoat в открытый канал, в
//    результатах Gifbox избранного нет, а их видео не играют сами; меню
//    избранного убирает GIF вместе с превью; раздел «Плагины» без «null»,
//    у «Quality of Life» — шестерёнка и окно настроек, настройки действуют
//    сразу (избранное в окне GIF, окно сразу на избранном, исправления
//    интерфейса, в том числе подсветка md-ripple без перехода и меню
//    браузера только в полях ввода и при выделенном тексте, пункт меню
//    сообщения для эмодзи); вход
//    создаёт сессию с именем «Arachnid Client» (имя, заданное не for-web,
//    остаётся).
//
// Плагины: на шаге 0 встроенный «Quality of Life» включён, а плагин-папка
// (e2e/plugins/e2e-folder) включается только с разрешением на сеть; на
// шаге 2 он уже запущен: API plugin, настройки, стили и файлы папки,
// хранилище, нативный модуль WebAssembly и отказ в чужих адресах.
(async () => {
  "use strict";

  const STEP = "e2e:step";
  const RESULTS = "e2e:results";
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const emoji = (pack, code) => `https://static.stoat.chat/emoji/${pack}/${code}.svg?v=1`;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  const results = JSON.parse(localStorage.getItem(RESULTS) || "[]");
  const step = Number(localStorage.getItem(STEP) || "0");

  function send(path, body) {
    return fetch(path, { method: "POST", body }).catch(() => {});
  }
  function log(line) {
    document.getElementById("log").textContent += line + "\n";
    return send("/log", `[шаг ${step}] ${line}`);
  }
  /** `measured` — замер: подробности попадают в итог и при успехе */
  async function check(name, ok, details, { measured = false } = {}) {
    results.push({ step, name, ok: Boolean(ok), details, measured });
    localStorage.setItem(RESULTS, JSON.stringify(results));
    await log(`${ok ? "OK  " : "FAIL"} ${name}${details === undefined ? "" : " — " + JSON.stringify(details)}`);
  }
  async function next() {
    localStorage.setItem(STEP, String(step + 1));
    location.reload();
  }
  async function finish(error) {
    if (error) results.push({ step, name: "без исключений", ok: false, details: String(error?.stack || error) });
    await send("/result", JSON.stringify({ results }));
  }

  /** Кто отдал ответ: описание `arachnid` из Server-Timing или null */
  function source(timing) {
    const match = /arachnid;desc="([a-z]+)"/.exec(timing || "");
    return match ? match[1] : null;
  }
  async function fetched(url) {
    try {
      const response = await fetch(url, { mode: "cors", cache: "no-store" });
      const body = new Uint8Array(await response.arrayBuffer());
      const signature = [0x89, 0x50, 0x4e, 0x47];
      return {
        status: response.status,
        source: source(response.headers.get("server-timing")),
        // картинки эмодзи клиент отдаёт растром (emoji_raster.rs)
        png:
          response.headers.get("content-type") === "image/png" &&
          signature.every((byte, index) => body[index] === byte),
      };
    } catch (error) {
      return { error: String(error), source: null };
    }
  }
  async function imageSource(img) {
    if (!img.complete) {
      await new Promise((resolve) => {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
      });
    }
    const [entry] = performance.getEntriesByName(img.src);
    const timing = entry?.serverTiming?.find((item) => item.name === "arachnid");
    return { loaded: img.naturalWidth > 0, source: timing?.description ?? null };
  }
  let messageId = 0;
  function workerFetch(url) {
    const id = ++messageId;
    return new Promise((resolve) => {
      const onMessage = (event) => {
        if (event.data?.id !== id) return;
        navigator.serviceWorker.removeEventListener("message", onMessage);
        resolve({ ...event.data.result, source: source(event.data.result.timing) });
      };
      navigator.serviceWorker.addEventListener("message", onMessage);
      navigator.serviceWorker.controller.postMessage({ id, url });
    });
  }
  async function waitFor(condition, timeout, interval = 250) {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await condition();
      if (value || Date.now() > end) return value;
      await sleep(interval);
    }
  }
  const settings = () => localforage.getItem("settings");

  /**
   * Окно выбора эмодзи, как его строит EmojiPicker for-web: поле поиска, за
   * ним ряд из колонки серверов и сетки. Списки — @minht11/solid-virtual-
   * container: ячейки по 40 px со сдвигом transform, отрисованы только
   * видимые. В сетке — строка заголовка «Default» и 1785 стандартных эмодзи;
   * при поиске — найденные эмодзи из `NAMES` (поиск подстроки, как у
   * for-web). Щелчки по ячейкам записываются в `picked`.
   */
  function emojiPicker() {
    const h = (tag, style, ...children) => {
      const element = document.createElement(tag);
      if (style) element.style.cssText = style;
      element.append(...children);
      return element;
    };
    const columns = 9;
    const rows = 1 + Math.ceil(1785 / columns);
    const input = h("input");
    input.placeholder = "Search for emojis...";
    // колонка серверов: 12 значков по 40 px — выше колонки, разделы под ними
    // сначала не видны
    const railList = h("div", "position:relative;flex-shrink:0;height:480px");
    railList.className = "virtual-container-e2e";
    const rail = h("div", "display:flex;flex-direction:column;width:40px;overflow-y:scroll;scrollbar-width:none", railList);
    const gridList = h("div", `position:relative;flex-shrink:0;height:${rows * 40}px`);
    gridList.className = "virtual-container-e2e";
    const grid = h("div", "height:300px;overflow-y:scroll;scrollbar-width:none", gridList);
    const column = h("div", "display:flex;flex-direction:column;width:360px", grid, h("div", "min-height:36px"));
    const base = h(
      "div",
      "position:fixed;left:0;top:0;width:400px;height:400px;display:flex;flex-direction:column",
      h("div", null, input),
      h("div", "display:flex;flex-grow:1;min-height:0", rail, column),
    );
    const codes = ["1f600", "1f602", "1f60d", "1f618", "1f923", "1f44d", "1f525", "1f389"];
    const NAMES = [["😀", "smile"], ["😂", "joy"], ["🏁", "chequered-flag"]];
    const picked = [];
    let turn = 0;
    const cell = (column, row, alt, code) => {
      const img = h("img", "width:100%;height:100%");
      img.className = "emoji";
      img.alt = alt;
      img.src = emoji("twemoji", code);
      const element = h("div", `position:absolute;width:40px;height:40px;transform:translate(${column * 40}px, ${row * 40}px)`, img);
      element.addEventListener("click", () => picked.push(alt));
      return element;
    };
    /** Перерисовка, как при прокрутке: Show keyed for-web пересоздаёт картинки */
    function render() {
      turn++;
      const filter = input.value.toLowerCase();
      if (filter) {
        const found = NAMES.filter(([, name]) => name.includes(filter));
        gridList.style.height = `${Math.ceil(found.length / columns) * 40}px`;
        gridList.replaceChildren(...found.map(([alt], i) => cell(i % columns, Math.floor(i / columns), alt, codes[i])));
        return;
      }
      gridList.style.height = `${rows * 40}px`;
      const first = Math.floor(grid.scrollTop / 40);
      const cells = [];
      for (let row = first; row < Math.min(rows, first + 18); row++) {
        for (let column = 0; column < columns; column++) {
          const alt = String.fromCodePoint(0x1f600 + ((row + column + turn) % 40));
          cells.push(cell(column, row, alt, codes[(row * columns + column + turn) % codes.length]));
        }
      }
      gridList.replaceChildren(...cells);
    }
    // поиск for-web перестраивает список сразу, в обработчике ввода
    input.addEventListener("input", render);
    render();
    return { base, input, rail, railList, grid, gridList, render, picked };
  }
  /** Правый щелчок по элементу; false — обработчик отменил меню браузера */
  function rightClick(target) {
    const rect = target.getBoundingClientRect();
    return target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 2,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
  }
  /**
   * Сообщение с эмодзи и меню сообщения for-web (MessageContextMenu): правый
   * щелчок по сообщению выводит в #floating блок с пунктами-ссылками
   * (значок Symbol и текст) и разделителем.
   */
  function chatEmojiMock() {
    const image = document.createElement("img");
    image.className = "emoji";
    image.alt = "👍";
    image.src = emoji("twemoji", "1f44d");
    const words = document.createElement("span");
    words.textContent = "привет ";
    const base = document.createElement("div");
    base.style.cssText = "position:fixed;left:0;top:0;font-size:14px";
    base.append(words, image);
    const menus = [];
    const item = (glyph, label) => {
      const link = document.createElement("a");
      const symbol = document.createElement("span");
      symbol.setAttribute("aria-hidden", "true");
      symbol.style.cssText = "display:block;font-size:16px;font-variation-settings:'FILL' 0";
      symbol.textContent = glyph;
      const text = document.createElement("span");
      text.textContent = label;
      link.append(symbol, text);
      return link;
    };
    base.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const menu = document.createElement("div");
      menu.append(item("reply", "Reply"), item("mark_chat_unread", "Mark as unread"), document.createElement("div"), item("content_copy", "Copy text"));
      const wrapper = document.createElement("div");
      wrapper.append(menu);
      document.getElementById("floating").append(wrapper);
      menus.push(wrapper);
    });
    const close = () => {
      for (const wrapper of menus.splice(0)) wrapper.remove();
    };
    return { base, image, words, menu: () => menus.at(-1)?.firstElementChild ?? null, close };
  }
  /** Есть ли в меню сообщения пункт «Скачать изображение» */
  async function chatDownloadItem(chat, target) {
    rightClick(target);
    await frame();
    const item = chat.menu()?.querySelector("[data-arachnid-emoji-download]") ?? null;
    const result = item && {
      first: chat.menu().firstElementChild === item,
      label: item.lastElementChild?.textContent,
      glyph: item.firstElementChild?.textContent,
      divider: item.nextElementSibling?.localName === "div" && item.nextElementSibling.childElementCount === 0,
    };
    chat.close();
    return result;
  }
  const DOWNLOAD_LABELS = ["Скачать изображение", "Download Image"];

  /**
   * Реакции под сообщением, как у for-web (Reactions.tsx): список, в нём
   * обёртки подсказок с плашками (картинка эмодзи и счётчик) и кнопка «+»
   * (`class="add"`). Для сравнения — такой же блок без кнопки «+».
   */
  function reactionsMock() {
    const style = document.createElement("style");
    style.textContent = `@layer utilities {
  .e2e-reactions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .e2e-reaction { position: relative; display: flex; flex-direction: row; gap: 8px; padding: 8px; border-radius: 12px; font-weight: 600; }
  .e2e-reaction img { width: 1.2em; height: 1.2em; object-fit: contain; }
  .e2e-emoji { display: inline-block; width: 1.4em; height: 1.4em; margin: 0 0.05em 0 0.1em; vertical-align: -0.3em; }
}`;
    const h = (tag, className, ...children) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      element.append(...children);
      return element;
    };
    const image = () => {
      const img = h("img", "emoji e2e-emoji");
      img.alt = "👍";
      img.src = emoji("twemoji", "1f44d");
      return img;
    };
    const ripple = () => {
      const element = h("div");
      element.style.cssText = "position:absolute;inset:0";
      return element;
    };
    const emojiImage = image();
    const pill = h("div", "e2e-reaction", ripple(), emojiImage, " 3");
    const otherImage = image();
    const list = h("div", "e2e-reactions", h("div", null, pill), h("div", null, h("div", "e2e-reaction add", "+")));
    const lonely = h("div", "e2e-reactions", h("div", null, h("div", "e2e-reaction", otherImage, " 1")));
    const base = h("div", null, style, list, lonely);
    base.style.cssText = "position:fixed;left:0;top:0;font-size:14px;line-height:1.5";
    return { base, pill, emoji: emojiImage, other: otherImage };
  }

  /**
   * Значки ролей, как у for-web: заголовок группы роли в списке участников
   * (MemberSidebar.tsx: картинка, имя роли, « – число») и Avatar 16 px в
   * обёртке подсказки рядом с ником (Message.tsx, Avatar.tsx). Для сравнения
   * — картинка без имени и числа, значок сервера 16 px в ссылке
   * (anchors.tsx) и большой значок сервера. Картинка везде одна — 40×32,
   * как файл autumn с тегом icons.
   */
  function roleIconsMock() {
    const icon = "/icons/e2e-wide";
    const avatar = (size, src) =>
      `<svg style="width: ${size}px; height: ${size}px;" viewBox="0 0 32 32"><g>` +
      `<foreignObject x="0" y="0" width="32" height="32"><div class="e2e-shape">` +
      `<img class="e2e-avatar" src="${src}" draggable="false"></div></foreignObject></g></svg>`;
    const base = document.createElement("div");
    base.style.cssText = "position:fixed;left:0;top:0";
    base.innerHTML = `<style>@layer utilities {
  .e2e-title { padding: 28px 14px 0; display: flex; align-items: center; gap: 6px; font-size: 11px; line-height: 14px; }
  .e2e-card { height: 42px; background: #333; }
  .e2e-role-icon { width: 16px; height: 16px; border-radius: 8px; object-fit: cover; }
  .e2e-shape { overflow: hidden; width: 100%; height: 100%; border-radius: 12px; }
  .e2e-avatar { width: 100%; height: 100%; object-fit: cover; }
}</style>
<div class="virtual-container-e2e" style="position:relative;width:240px;height:${42 * 4}px">
<div style="position:absolute;top:0;width:100%"><div class="e2e-title" id="e2e-member"><img class="e2e-role-icon" src="${icon}" alt=""><span>Админ</span><span> – 1</span></div></div>
<div style="position:absolute;top:42px;width:100%"><div id="e2e-card"><div class="e2e-card"></div></div></div>
<div style="position:absolute;top:84px;width:100%"><div class="e2e-title" id="e2e-online"><span>Online</span><span> – 1</span></div></div>
<div style="position:absolute;top:126px;width:100%"><div><div class="e2e-card"></div></div></div>
</div>
<div class="e2e-title" id="e2e-lonely"><img class="e2e-role-icon" src="${icon}" alt=""><span>Админ</span></div>
<div id="e2e-message"><div>Ник</div><div><div>${avatar(16, icon)}</div></div></div>
<p id="e2e-link"><a href="#">${avatar(16, icon)}Сервер</a></p>
<div id="e2e-server"><div>${avatar(42, icon)}</div></div>`;
    const find = (selector) => base.querySelector(selector);
    return {
      base,
      parts: {
        memberIcon: find("#e2e-member img"),
        lonelyIcon: find("#e2e-lonely img"),
        messageIcon: find("#e2e-message img"),
        messageShape: find("#e2e-message .e2e-shape"),
        linkIcon: find("#e2e-link img"),
        linkShape: find("#e2e-link .e2e-shape"),
        serverIcon: find("#e2e-server img"),
        serverShape: find("#e2e-server .e2e-shape"),
        memberTitle: find("#e2e-member"),
        memberName: find("#e2e-member span"),
        onlineTitle: find("#e2e-online"),
        onlineName: find("#e2e-online span"),
        card: find("#e2e-card"),
        messageSvg: find("#e2e-message svg"),
        linkSvg: find("#e2e-link svg"),
        serverSvg: find("#e2e-server svg"),
      },
    };
  }

  /**
   * Окно GIF, как его строит for-web (CompositionMediaPicker.tsx,
   * GifPicker.tsx): в Container — ряд кнопок «GIFs/Emoji» (.CompositionButton)
   * и Stack из поля поиска в SearchArea и прокрутки с сеткой категорий
   * (role=list). `search` показывает результаты Gifbox — Masonry из плиток с
   * видео, `categories` — снова сетку.
   */
  function gifPicker() {
    const base = document.createElement("div");
    base.style.cssText = "position:fixed;right:0;bottom:0;width:400px;height:400px";
    base.innerHTML = `<div class="e2e-container" style="width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden">
<div class="CompositionButton"><button>GIFs</button><button>Emoji</button></div>
<div class="e2e-stack" style="min-height:0;flex-grow:1;display:flex;flex-direction:column">
<div class="e2e-search" style="display:flex"><input placeholder="Search for GIFs..."></div>
</div></div>`;
    const container = base.firstElementChild;
    const stack = container.querySelector(".e2e-stack");
    const input = stack.querySelector("input");
    const scroller = () => {
      const element = document.createElement("div");
      element.style.cssText = "flex-grow:1;min-height:0;overflow-y:auto";
      return element;
    };
    const grid = document.createElement("div");
    grid.setAttribute("role", "list");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(2,1fr)";
    for (const title of ["Trending GIFs", "cat"]) {
      const tile = document.createElement("div");
      tile.setAttribute("role", "listitem");
      tile.textContent = title;
      tile.style.aspectRatio = "16 / 10";
      grid.append(tile);
    }
    const categoriesView = scroller();
    categoriesView.append(grid);
    stack.append(categoriesView);
    let current = categoriesView;
    const show = (element) => {
      current.replaceWith(element);
      current = element;
    };
    return {
      base,
      container,
      stack,
      input,
      grid,
      search(value) {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const masonry = document.createElement("div");
        masonry.setAttribute("role", "list");
        masonry.style.columnCount = "2";
        const tile = document.createElement("div");
        tile.setAttribute("role", "listitem");
        const video = document.createElement("video");
        video.muted = true;
        video.loop = true;
        video.autoplay = true;
        video.src = "/e2e/missing.webm";
        tile.append(video);
        masonry.append(tile);
        const results = scroller();
        results.append(masonry);
        show(results);
        return masonry;
      },
      categories() {
        input.dispatchEvent(new Event("input", { bubbles: true }));
        show(categoriesView);
      },
    };
  }

  const packState = async (id) => (await invoke("emoji_packs")).packs.find((pack) => pack.id === id);
  const FOLDER = "e2e-folder";
  const pluginInfo = async (file) => (await invoke("extensions_overview")).plugins.find((plugin) => plugin.file === file);

  try {
    await log(`загрузка, ${navigator.userAgent}`);
    if (!window.__arachnidDesktop || !window.__TAURI_INTERNALS__) {
      await check("мост клиента на странице инстанса", false);
      return finish();
    }

    if (step === 0) {
      const first = await imageSource(document.getElementById("first"));
      await check("эмодзи первой страницы отдал клиент (Twemoji)", first.source === "builtin", first);

      const page = await fetched(emoji("twemoji", "1f602"));
      await check("запрос страницы отдал клиент", page.source === "builtin" && page.png, page);

      const fresh = await settings();
      await check(
        "первый запуск: набор эмодзи Twemoji",
        fresh?.["appearance:unicode_emoji"] === "twemoji",
        fresh,
      );

      const overview = await invoke("emoji_packs");
      await check("emoji_packs: скачивание поддерживается", overview.supported, overview.sizes);

      // плагины: встроенный включён сразу, плагин-папке нужно разрешение
      const qol = await pluginInfo("builtin:qol");
      await check("встроенный плагин «Quality of Life» включён", qol?.builtin && qol.enabled, qol);
      const folder = await pluginInfo(FOLDER);
      await check(
        "плагин-папка виден и ждёт разрешения",
        folder?.folder && !folder.enabled && !folder.granted && folder.native && folder.network.join() === "example.com",
        folder,
      );
      const refused = await invoke("extensions_set_plugin", { file: FOLDER, enabled: true }).then(
        () => null,
        (error) => error,
      );
      await check("без разрешения плагин-папка не включается", refused?.kind === "permissions", refused);
      const allowed = await invoke("extensions_set_plugin", { file: FOLDER, enabled: true, grant: true });
      const enabled = allowed.plugins.find((plugin) => plugin.file === FOLDER);
      await check("с разрешением включён", enabled?.enabled && enabled.granted, enabled);

      await navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) =>
          navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }),
        );
      }
      await check("service worker зарегистрирован", Boolean(navigator.serviceWorker.controller));
      return next();
    }

    if (step === 1) {
      await check("страница под service worker", Boolean(navigator.serviceWorker.controller));

      const page = await fetched(emoji("twemoji", "1f923"));
      await check("под service worker: запрос страницы отдал клиент", page.source === "builtin", page);

      const img = document.createElement("img");
      img.src = emoji("twemoji", "1f60d");
      document.body.append(img);
      const image = await imageSource(img);
      await check("под service worker: картинку отдал клиент", image.source === "builtin", image);

      const worker = await workerFetch(emoji("twemoji", "1f618"));
      await check("запрос самого service worker отдал клиент", worker.source === "builtin", worker);

      const heart = await fetched(emoji("twemoji", "2764-fe0f"));
      await check("форма с fe0f (❤️) из встроенного набора", heart.source === "builtin" && heart.png, heart);

      await localforage.setItem("settings", {
        "appearance:unicode_emoji": "fluent-3d",
        "appearance:compact_mode": true,
      });
      localStorage.removeItem("arachnid:defaults:keyvaluepairs");
      return next();
    }

    if (step === 2) {
      // плагин-папка запущен после загрузки страницы
      const report = await waitFor(() => window.__e2eFolderPlugin?.ready && window.__e2eFolderPlugin, 15000, 50);
      await check("плагин-папка запущен", Boolean(report) && !report.error, report?.error ?? report);
      if (report) {
        await check(
          "plugin: id, версия API и манифест",
          report.id === FOLDER && report.apiVersion === 1 && report.name === "E2E Folder",
          report,
        );
        await check(
          "plugin.settings: значения по типам",
          report.settings.flag === true && report.settings.size === 4 && report.settings.mode === "one",
          report.settings,
        );
        await check("plugin.network: подтверждённые адреса", report.network.join() === "example.com", report.network);
        await check(
          "plugin.storage: записано и прочитано",
          report.stored?.text === "привет",
          report.stored,
        );
        await check(
          "plugin.native: echo модуля WebAssembly",
          report.native && report.echo?.text === "ok" && report.echo.list?.join() === "1,2",
          report.echo,
        );
        await check("модуль читает то же хранилище", report.greeting?.text === "привет", report.greeting);
        await check(
          "plugin.fetch: чужой адрес отклонён",
          report.denied?.kind === "network" && /permissions/.test(report.denied.message),
          report.denied,
        );

        const asset = await fetch(report.asset, { cache: "no-store" }).then(
          async (response) => ({
            status: response.status,
            type: response.headers.get("content-type"),
            size: (await response.arrayBuffer()).byteLength,
          }),
          (error) => ({ error: String(error) }),
        );
        await check("файл папки плагина доступен странице", asset.status === 200 && asset.type === "image/png", {
          url: report.asset,
          ...asset,
        });
        const outside = await fetch(report.asset.replace("img/dot.png", "..%2F..%2Fconfig.toml")).then(
          (response) => response.status,
          (error) => String(error),
        );
        await check("файлы вне папки плагина недоступны", outside === 404, outside);

        const style = () => document.querySelector(`style[data-arachnid-style="plugin:${FOLDER}"]`)?.textContent ?? "";
        await check(
          "стили плагина: переменные настроек и url() от папки",
          style().includes("--size: 4px;") && style().includes(`url("${report.asset}")`),
          style(),
        );
        const probe = document.createElement("div");
        probe.id = "e2e-folder-probe";
        document.body.append(probe);
        const image = await waitFor(() => {
          const value = getComputedStyle(probe).backgroundImage;
          return value.includes("dot.png") ? value : null;
        }, 3000);
        await check("стили плагина действуют на странице", probe.getBoundingClientRect().width === 4 && image, {
          width: probe.getBoundingClientRect().width,
          image,
        });

        await invoke("extensions_set_plugin_value", { file: FOLDER, name: "size", value: "7" });
        const changed = await waitFor(() => report.changes.at(-1)?.size === 7, 5000, 50);
        await check("plugin.onSettingsChange: новое значение", changed, report.changes);
        await waitFor(() => style().includes("--size: 7px;"), 5000, 50);
        await check("стили плагина: новое значение настройки", probe.getBoundingClientRect().width === 7, style());
        probe.remove();
        await invoke("extensions_reset_plugin", { file: FOLDER });
      }

      const current = await settings();
      await check(
        "прежние настройки с fluent-3d получили Twemoji",
        current?.["appearance:unicode_emoji"] === "twemoji",
        current,
      );
      await check("остальные настройки не тронуты", current?.["appearance:compact_mode"] === true, current);
      await localforage.setItem("settings", { ...current, "appearance:unicode_emoji": "fluent-3d" });
      return next();
    }

    if (step === 3) {
      const chosen = await settings();
      await check(
        "выбранный вручную набор остаётся",
        chosen?.["appearance:unicode_emoji"] === "fluent-3d",
        chosen,
      );

      // Реакции: разметка и стили Reactions.tsx for-web. Стили for-web — в
      // слое, как у Panda, строка 1.5 — как сброс стилей Panda, текст 14 px.
      // стиль встроенного плагина появляется, когда клиент его выполнит
      await waitFor(() => document.getElementById("arachnid-emoji-style"), 5000, 50);
      const reactions = reactionsMock();
      document.body.append(reactions.base);
      const box = (element) => element.getBoundingClientRect();
      const emojiBox = box(reactions.emoji);
      const pillBox = box(reactions.pill);
      const reactionShape = {
        emoji: emojiBox.height,
        pill: pillBox.height,
        offset: emojiBox.top + emojiBox.height / 2 - (pillBox.top + pillBox.height / 2),
      };
      await check("реакции: эмодзи 1.4em (19.6 px)", Math.abs(emojiBox.width - 19.6) < 0.5, reactionShape);
      await check("реакции: эмодзи по центру плашки", Math.abs(reactionShape.offset) < 0.5, reactionShape);
      await check("реакции: высота плашки как у Stoat (37 px)", Math.abs(pillBox.height - 37) < 0.5, reactionShape);
      const other = box(reactions.other).width;
      await check("реакции: другие картинки эмодзи не тронуты", Math.abs(other - 16.8) < 0.5, other);
      reactions.base.remove();

      // значки ролей: заголовок группы в списке участников и рядом с ником
      const icons = roleIconsMock();
      document.body.append(icons.base);
      const iconImages = Array.from(icons.base.querySelectorAll("img"));
      await waitFor(() => iconImages.every((img) => img.complete) && icons.parts.messageSvg.hasAttribute("data-arachnid-role-icon"), 5000, 50);
      const look = (element) => {
        const style = getComputedStyle(element);
        return `${style.objectFit} ${style.borderTopLeftRadius}`;
      };
      const styled = ["memberIcon", "lonelyIcon", "messageIcon", "messageShape", "linkIcon", "linkShape", "serverIcon", "serverShape"];
      const iconLooks = Object.fromEntries(styled.map((name) => [name, look(icons.parts[name])]));
      await check(
        "значок роли в заголовке группы — целиком, без скругления",
        iconLooks.memberIcon === "contain 0px",
        iconLooks,
      );
      await check(
        "значок роли у ника — целиком, без скругления",
        iconLooks.messageIcon.startsWith("contain") && iconLooks.messageShape.endsWith(" 0px"),
        iconLooks,
      );
      await check(
        "значки серверов и другие картинки не тронуты",
        iconLooks.lonelyIcon === "cover 8px" &&
          iconLooks.linkIcon.startsWith("cover") &&
          iconLooks.linkShape.endsWith(" 12px") &&
          iconLooks.serverIcon.startsWith("cover") &&
          iconLooks.serverShape.endsWith(" 12px"),
        iconLooks,
      );
      // картинка 40×32: во всю высоту 16 px — значит, 20 px в ширину
      const size = (element) => {
        const rect = element.getBoundingClientRect();
        return `${Math.round(rect.width * 10) / 10}x${Math.round(rect.height * 10) / 10}`;
      };
      const iconSizes = {
        member: size(icons.parts.memberIcon),
        message: size(icons.parts.messageSvg),
        viewBox: icons.parts.messageSvg.getAttribute("viewBox"),
        object: icons.parts.messageSvg.querySelector("foreignObject").getAttribute("width"),
        lonely: size(icons.parts.lonelyIcon),
        link: size(icons.parts.linkSvg),
        server: size(icons.parts.serverSvg),
      };
      await check("значок роли в заголовке группы — во всю высоту, ширина по картинке", iconSizes.member === "20x16", iconSizes);
      await check(
        "значок роли у ника — во всю высоту, ширина по картинке",
        iconSizes.message === "20x16" && iconSizes.viewBox === "0 0 40 32" && iconSizes.object === "40",
        iconSizes,
      );
      await check(
        "значки серверов и другие картинки — прежнего размера",
        iconSizes.lonely === "16x16" && iconSizes.link === "16x16" && iconSizes.server === "42x42",
        iconSizes,
      );
      // заголовок группы — в своей строке (42 px), зазор 6 px до карточки
      const rect = (name) => icons.parts[name].getBoundingClientRect();
      const title = rect("memberTitle");
      const roleIcon = rect("memberIcon");
      const online = rect("onlineTitle");
      const middle = (name, of) => {
        const box = rect(name);
        return Math.round((box.top + box.height / 2 - of.top) * 10) / 10;
      };
      const group = {
        title: Math.round(title.height * 10) / 10,
        online: Math.round(online.height * 10) / 10,
        iconTop: Math.round((roleIcon.top - title.top) * 10) / 10,
        gap: Math.round((rect("card").top - roleIcon.bottom) * 10) / 10,
        nameMiddle: middle("memberName", title),
        onlineMiddle: middle("onlineName", online),
      };
      await check(
        "заголовок группы участников — в строке списка, значок не под карточкой",
        group.title === 42 && group.online === 42 && group.iconTop >= 0 && group.gap === 6,
        group,
      );
      await check("заголовки групп со значком и без — название на одной высоте", group.nameMiddle === group.onlineMiddle, group);
      icons.base.remove();

      // окно выбора эмодзи
      const picker = emojiPicker();
      document.getElementById("floating").append(picker.base);
      const railButtons = () => picker.rail.querySelectorAll(".arachnid-emoji-rail-button:not([hidden])");
      const enhanced = await waitFor(() => railButtons().length === 9, 5000, 50);
      await check("окно эмодзи: разделы в колонке", enhanced, railButtons().length);

      // Кнопка перехода к стандартным эмодзи — внизу колонки поверх серверов,
      // пока разделы в колонке не видны; переход показывает разделы и прячет
      // её, а когда разделы снова уходят из вида, она возвращается.
      const standardButton = picker.rail.querySelector(".arachnid-emoji-dock > .arachnid-emoji-rail-button");
      // кнопка выезжает снизу — замер после перехода
      await Promise.all(standardButton?.getAnimations().map((animation) => animation.finished) ?? []);
      const railBox = picker.rail.getBoundingClientRect();
      const dockBox = standardButton?.getBoundingClientRect();
      const docked = {
        visible: standardButton ? !standardButton.hidden : null,
        bottom: dockBox && Math.round(railBox.bottom - dockBox.bottom),
        height: dockBox && Math.round(dockBox.height),
        width: dockBox && Math.round(dockBox.width),
        opaque: standardButton ? getComputedStyle(standardButton).backgroundColor !== "rgba(0, 0, 0, 0)" : null,
      };
      standardButton?.click();
      const jumped = await waitFor(() => standardButton?.hidden, 3000, 50);
      const categoriesTop = Math.round(
        picker.rail.querySelector('[data-arachnid-emoji-rail="categories"]').getBoundingClientRect().top - railBox.top,
      );
      picker.rail.scrollTop = 0;
      const back = await waitFor(() => standardButton && !standardButton.hidden, 3000, 50);
      await check(
        "окно эмодзи: кнопка стандартных эмодзи внизу колонки, после перехода прячется",
        docked.visible &&
          docked.bottom === 0 &&
          docked.height === 40 &&
          docked.width === 40 &&
          jumped &&
          categoriesTop >= 0 &&
          categoriesTop < railBox.height - 40 &&
          back,
        { ...docked, jumped, categoriesTop, back },
      );
      picker.grid.scrollTop = 0;
      await frame();

      // Поиск окна (по подсказке поля) не должен идти при каждой перерисовке
      // списка: так клиент раньше обходил весь документ на каждый кадр
      // прокрутки.
      let searches = 0;
      const counted = (original) =>
        function (selector) {
          if (String(selector).includes("mdui-text-field")) searches++;
          return original.call(this, selector);
        };
      const documentQuery = Document.prototype.querySelectorAll;
      const elementQuery = Element.prototype.querySelectorAll;
      Document.prototype.querySelectorAll = counted(documentQuery);
      Element.prototype.querySelectorAll = counted(elementQuery);
      const started = performance.now();
      for (let i = 0; i < 120; i++) {
        picker.grid.scrollTop = i * 60;
        picker.render();
        await frame();
      }
      const elapsed = performance.now() - started;
      Document.prototype.querySelectorAll = documentQuery;
      Element.prototype.querySelectorAll = elementQuery;
      await check("окно эмодзи: прокрутка без поиска окна по документу", searches === 0, {
        searches,
        frame: +(elapsed / 120).toFixed(1),
      });
      await check("окно эмодзи: дополнено один раз", railButtons().length === 9, railButtons().length);

      // Стандартные эмодзи — свой список с заголовками разделов: в нём
      // отрисованы только видимые строки (300 px — 8 строк) и по 4 строки
      // запаса, сколько ни листать.
      const standard = picker.grid.querySelector("[data-arachnid-emoji-standard]");
      const headings = () => Array.from(standard?.querySelectorAll('[role="heading"]') ?? [], (title) => title.textContent);
      const rendered = { rows: standard?.children.length, images: standard?.querySelectorAll("img").length };
      await check(
        "окно эмодзи: отрисованы только видимые строки",
        rendered.rows > 0 && rendered.rows <= 8 + 1 + 4 * 2 && rendered.images <= rendered.rows * 9,
        rendered,
      );
      const top = (element) => element.getBoundingClientRect().top - picker.grid.getBoundingClientRect().top;
      picker.grid.scrollTop = 0;
      picker.render();
      await frame();
      await frame();
      const firstTitle = standard?.querySelector('[role="heading"]');
      await check(
        "окно эмодзи: стандартные эмодзи начинаются с заголовка «Люди»",
        ["Люди", "People"].includes(firstTitle?.textContent) && Math.abs(top(firstTitle)) < 1 && picker.gridList.getBoundingClientRect().height === 0,
        { headings: headings(), top: firstTitle && top(firstTitle) },
      );
      const images = Array.from(standard?.querySelectorAll("img[src]") ?? []);
      await check(
        "окно эмодзи: картинки тем же набором, что у for-web",
        images.length > 0 && images.every((image) => image.src.includes("/emoji/twemoji/")),
        images[0]?.src,
      );

      // Щелчок по своей ячейке доходит до ячейки for-web (через поиск), а
      // окно возвращается к прежнему виду.
      picker.grid.scrollTop = 40;
      await frame();
      await frame();
      const joy = Array.from(standard?.querySelectorAll("img") ?? []).find((image) => image.alt === "😂");
      joy?.parentElement.click();
      await frame();
      await check(
        "окно эмодзи: щелчок по эмодзи — выбор в for-web",
        picker.picked.includes("😂") && picker.input.value === "" && !standard.hidden && picker.grid.scrollTop === 40,
        { picked: picker.picked, filter: picker.input.value, scroll: picker.grid.scrollTop },
      );

      const flags = picker.rail.querySelector('.arachnid-emoji-rail-button[title="Flags"], .arachnid-emoji-rail-button[title="Флаги"]');
      flags.click();
      await frame();
      picker.render();
      await waitFor(() => flags.hasAttribute("data-active"), 2000, 50);
      await check("окно эмодзи: переход к флагам и подсветка раздела", flags.hasAttribute("data-active"), picker.grid.scrollTop);
      const flagsTitle = Array.from(standard.querySelectorAll('[role="heading"]')).find((title) => ["Флаги", "Flags"].includes(title.textContent));
      await check("окно эмодзи: заголовок «Флаги» вверху сетки", Boolean(flagsTitle) && Math.abs(top(flagsTitle)) < 1, {
        headings: headings(),
        top: flagsTitle && top(flagsTitle),
      });

      // Состав разделов — как у Discord: «Символы» начинаются с сердец (в
      // группах Unicode сердца — среди смайликов).
      const symbols = picker.rail.querySelector('.arachnid-emoji-rail-button[title="Symbols"], .arachnid-emoji-rail-button[title="Символы"]');
      symbols.click();
      await frame();
      await frame();
      const firstRow = Array.from(standard.querySelectorAll(".arachnid-emoji-cell:not([hidden]) img"))
        .filter((image) => Math.abs(top(image.parentElement) - 40) < 1)
        .map((image) => image.alt);
      await check("окно эмодзи: разделы как в Discord (сердца — в «Символах»)", firstRow[0] === "🩷" && firstRow[1] === "❤️", firstRow);

      // Сервер в колонке: for-web прокручивает к нему на «строка × 40» от
      // начала своего списка, а над списком — «Избранное» и «Часто
      // используемые» (здесь — блок их высоты): заголовок сервера всё равно
      // должен встать к верху сетки.
      const aboveList = document.createElement("div");
      aboveList.style.cssText = "flex-shrink:0;height:120px";
      picker.gridList.before(aboveList);
      const listOffset = Math.round(top(picker.gridList) + picker.grid.scrollTop);
      const serverItem = document.createElement("div");
      serverItem.setAttribute("role", "listitem");
      serverItem.style.cssText = "position:absolute;left:0;top:0;width:40px;height:40px";
      serverItem.addEventListener("click", () => (picker.grid.scrollTop = 0));
      picker.railList.append(serverItem);
      picker.grid.scrollTop = 600;
      await frame();
      serverItem.click();
      await frame();
      await frame();
      const serverJump = { listOffset, listTop: Math.round(top(picker.gridList)), scroll: picker.grid.scrollTop };
      serverItem.remove();
      aboveList.remove();
      await check("окно эмодзи: переход к серверу ставит его заголовок к верху сетки", listOffset > 0 && serverJump.listTop === 0, serverJump);

      // Меню эмодзи: на эмодзи — своё меню со скачиванием и избранным, на
      // пустом месте окна его нет.
      const emojiMenu = () => document.querySelector("[data-arachnid-emoji-menu]");
      const menuItems = () => Array.from(emojiMenu()?.querySelectorAll(".arachnid-emoji-menu-item") ?? []);
      const menuLabels = () => menuItems().map((item) => item.lastElementChild.textContent);
      rightClick(standard.querySelector('[role="heading"]'));
      rightClick(picker.rail);
      // заголовок сервера for-web: значок сервера (Avatar) — тоже не эмодзи
      const serverIcon = document.createElement("img");
      serverIcon.src = emoji("twemoji", "1f600");
      const serverHeader = document.createElement("div");
      serverHeader.style.cssText = "position:absolute;left:0;top:0;width:100%;height:40px;display:flex";
      serverHeader.append(Object.assign(document.createElement("div"), { style: "width:24px;height:24px" }));
      serverHeader.firstChild.append(serverIcon);
      picker.gridList.prepend(serverHeader);
      rightClick(serverIcon);
      serverHeader.remove();
      await check("окно эмодзи: на пустом месте и на заголовке сервера своего меню нет", !emojiMenu());
      picker.grid.scrollTop = 0;
      await frame();
      await frame();
      const joyCell = () =>
        Array.from(standard.querySelectorAll(".arachnid-emoji-cell:not([hidden])")).find((cell) => cell.firstChild.alt === "😂");
      const joyAllowed = rightClick(joyCell().firstChild);
      await check(
        "меню эмодзи: «Скачать изображение» и «Добавить в избранное»",
        !joyAllowed &&
          menuLabels().length === 2 &&
          DOWNLOAD_LABELS.includes(menuLabels()[0]) &&
          ["Добавить в избранное", "Add to Favorites"].includes(menuLabels()[1]),
        menuLabels(),
      );
      menuItems()[1]?.click();
      await frame();
      const favoritesBlock = picker.grid.querySelector("[data-arachnid-emoji-favorites]");
      const favoriteCells = (block) => Array.from(block?.querySelectorAll(".arachnid-emoji-cell") ?? []);
      await check(
        "меню эмодзи: эмодзи в «Избранном» над сеткой, в колонке — кнопка",
        !emojiMenu() &&
          favoritesBlock &&
          !favoritesBlock.hidden &&
          favoriteCells(favoritesBlock).map((cell) => cell.firstChild.alt).join() === "😂" &&
          Boolean(favoritesBlock.compareDocumentPosition(picker.gridList) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          railButtons().length === 10,
        { cells: favoriteCells(favoritesBlock).length, buttons: railButtons().length },
      );
      const pickedBefore = picker.picked.length;
      favoriteCells(favoritesBlock)[0]?.click();
      await frame();
      await check(
        "меню эмодзи: щелчок по избранному — выбор в for-web",
        picker.picked.length === pickedBefore + 1 && picker.picked.at(-1) === "😂",
        picker.picked,
      );
      rightClick(joyCell().firstChild);
      const unfavoriteLabel = menuLabels()[1];
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await check(
        "меню эмодзи: у избранного — «Убрать из избранного», Escape закрывает меню",
        ["Убрать из избранного", "Remove from Favorites"].includes(unfavoriteLabel) && !emojiMenu(),
        unfavoriteLabel,
      );

      // команда сохранения проверяет, что ей передали картинку (окно
      // «Сохранить как» в проверке не открыть)
      const notImage = await invoke("image_save", {
        name: "e2e",
        data: Array.from(new TextEncoder().encode("<!DOCTYPE html><html></html>")),
      }).then(
        () => "сохранено",
        (error) => String(error?.message ?? error),
      );
      await check("«Скачать изображение»: клиент сохраняет только картинки", /не картинка/.test(notImage), notImage);

      // меню сообщения for-web: правый щелчок по эмодзи — пункт первым
      const chat = chatEmojiMock();
      document.body.append(chat.base);
      const onEmoji = await chatDownloadItem(chat, chat.image);
      const onText = await chatDownloadItem(chat, chat.words);
      await check(
        "меню сообщения: на эмодзи — «Скачать изображение» первым пунктом, на тексте — нет",
        onEmoji?.first && DOWNLOAD_LABELS.includes(onEmoji.label) && onEmoji.glyph === "download" && onEmoji.divider && onText === null,
        { onEmoji, onText },
      );
      chat.base.remove();

      // закрыть и открыть снова — новое окно тоже получает разделы и
      // избранное
      picker.base.remove();
      await frame();
      const again = emojiPicker();
      document.getElementById("floating").append(again.base);
      const reopened = await waitFor(() => again.rail.querySelector(".arachnid-emoji-rail-button"), 5000, 50);
      await check("окно эмодзи: открытое заново тоже дополнено", Boolean(reopened));
      const againFavorites = again.grid.querySelector("[data-arachnid-emoji-favorites]");
      const kept = favoriteCells(againFavorites).map((cell) => cell.firstChild.alt).join();
      rightClick(favoriteCells(againFavorites)[0]);
      menuItems()[1]?.click();
      await frame();
      const againButtons = await waitFor(
        () => again.rail.querySelectorAll(".arachnid-emoji-rail-button:not([hidden])").length === 10,
        3000,
        50,
      );
      await check(
        "меню эмодзи: избранное сохраняется и убирается из меню",
        kept === "😂" && againFavorites.hidden && favoriteCells(againFavorites).length === 0 && againButtons,
        { kept, hidden: againFavorites?.hidden },
      );
      again.base.remove();

      // шторка выбора набора, как её строит FloatingSelect for-web
      const packs = ["fluent-3d", "fluent-color", "fluent-flat", "mutant", "noto", "twemoji"];
      const motion = document.createElement("div");
      const menu = document.createElement("div");
      let selected = 0;
      menu.addEventListener("click", () => selected++);
      for (const pack of packs) {
        const item = document.createElement("mdui-menu-item");
        item.setAttribute("value", pack);
        item.textContent = pack;
        menu.append(item);
      }
      motion.append(menu);
      document.getElementById("floating").append(motion);

      const row = (pack) => menu.querySelector(`[value="${pack}"] > [data-arachnid-emoji-pack]`)?.shadowRoot;
      const ready = await waitFor(() => packs.every((pack) => row(pack)?.querySelector(".label, button")), 5000, 50);
      await check("шторка: у каждого набора есть состояние", ready);
      await check("шторка: Twemoji встроен", /Built-in|Встроен/.test(row("twemoji")?.textContent ?? ""), row("twemoji")?.textContent);
      await check("шторка: текст пунктов не изменился", menu.querySelector('[value="mutant"]').textContent === "mutant");

      const sizes = await waitFor(async () => (await invoke("emoji_packs")).sizes === "ready", 30000);
      await check("размеры наборов получены с GitHub", sizes);
      await waitFor(() => /\d/.test(row("mutant")?.textContent ?? ""), 3000, 50);
      await check("шторка: размер Mutant Remix", /\d/.test(row("mutant")?.textContent ?? ""), row("mutant")?.textContent);

      // Fluent Color и Flat в Windows 11 — эмодзи шрифта Segoe UI Emoji:
      // если шрифт их рисует, скачивать нечего, а Fluent 3D в шрифте нет
      const system = (await invoke("emoji_packs")).packs.filter((pack) => pack.system).map((pack) => pack.id);
      await check("Fluent 3D не считается системным", !system.includes("fluent-3d"), system);
      if (system.includes("fluent-color")) {
        const shown = /In system|В системе/.test(row("fluent-color")?.textContent ?? "");
        const noButton = !row("fluent-color")?.querySelector("button");
        await check("шторка: Fluent Color «В системе», без кнопки скачивания", shown && noButton, row("fluent-color")?.textContent);
        const drawn = await fetched(emoji("fluent-color", "1f469-200d-1f4bb"));
        await check("картинку системного набора нарисовал клиент", drawn.source === "system" && drawn.png, drawn);
        const flag = await fetched(emoji("fluent-color", "1f1f7-1f1fa"));
        await check("флаг системного набора — с сервера, растром", flag.source === "network" && flag.png, flag);
      } else {
        await check("в шрифте Windows нет эмодзи Fluent — системные проверки пропущены", true, system);
      }

      row("mutant").querySelector("button").click();
      await check("кнопка не выбирает набор", selected === 0, selected);

      let ringSeen = false;
      let progressSeen = false;
      const installed = await waitFor(
        async () => {
          if (row("mutant")?.querySelector(".ring")) ringSeen = true;
          const state = await packState("mutant");
          if (state.download?.total && state.download.received > 0) progressSeen = true;
          if (state.error) return state;
          return state.installed ? state : null;
        },
        180000,
        // GitHub отдаёт набор за доли секунды — опрашивать чаще, чтобы застать ход
        20,
      );
      await check("Mutant Remix скачан", installed?.installed, installed);
      await check("ход скачивания виден (received/total)", progressSeen);
      await check("шторка: кольцо загрузки показано", ringSeen);
      await waitFor(() => /Downloaded|Скачан/.test(row("mutant")?.textContent ?? ""), 3000, 50);
      await check("шторка: «Скачан»", /Downloaded|Скачан/.test(row("mutant")?.textContent ?? ""), row("mutant")?.textContent);

      const downloaded = await fetched(emoji("mutant", "1f600"));
      await check("картинку скачанного набора отдал клиент", downloaded.source === "downloaded" && downloaded.png, downloaded);
      const workerDownloaded = await workerFetch(emoji("mutant", "1f602"));
      await check("и на запрос service worker", workerDownloaded.source === "downloaded", workerDownloaded);

      row("mutant").querySelector("button").click();
      const removed = await waitFor(async () => !(await packState("mutant")).installed, 10000);
      await check("Mutant Remix удалён кнопкой шторки", removed);
      const afterDelete = await fetched(emoji("mutant", "1f600"));
      await check(
        "после удаления картинки идут с сервера, растром",
        afterDelete.source === "network" && afterDelete.png,
        afterDelete,
      );
      await check("кнопки не выбирали набор", selected === 0, selected);

      // Цена задачи главного потока не растёт с числом показанных эмодзи.
      // С картинками SVG каждая — отдельный документ со своим планировщиком,
      // и Blink обходит их все после каждой задачи: после ~1100 эмодзи пустая
      // задача стоила 6,5 мс вместо 0,01. Растровые картинки этого не делают.
      const hop = async (count) => {
        const channel = new MessageChannel();
        const start = performance.now();
        for (let i = 0; i < count; i++) {
          await new Promise((resolve) => {
            channel.port1.onmessage = resolve;
            channel.port2.postMessage(0);
          });
        }
        return (performance.now() - start) / count;
      };
      const stems = [];
      for (let code = 0x1f300; code <= 0x1f64f; code++) stems.push(code.toString(16));
      for (let code = 0x1f680; code <= 0x1f6ff; code++) stems.push(code.toString(16));
      for (let code = 0x1f900; code <= 0x1f9ff; code++) stems.push(code.toString(16));
      for (const hand of ["1f44b", "1f44d", "1f44e", "1f44f", "1f64c", "1f64f", "1f590", "270c", "1f91e", "1f918"]) {
        for (const tone of ["1f3fb", "1f3fc", "1f3fd", "1f3fe", "1f3ff"]) stems.push(`${hand}-${tone}`);
      }
      // мс на пустую задачу до картинок и после каждой порции; время порции
      const hops = { before: await hop(300), batches: [] };
      const holder = document.createElement("div");
      holder.style.cssText = "position:fixed;left:0;top:0;width:32px;height:32px;overflow:hidden";
      document.body.append(holder);
      let loaded = 0;
      for (const [from, to] of [[0, 400], [400, 800], [800, stems.length]]) {
        const started = performance.now();
        await Promise.all(
          stems.slice(from, to).map(
            (stem) =>
              new Promise((resolve) => {
                const img = new Image(32, 32);
                let settled = false;
                const done = (ok) => {
                  if (settled) return;
                  settled = true;
                  if (ok) loaded++;
                  img.remove();
                  resolve();
                };
                img.onload = () => done(true);
                img.onerror = () => done(false);
                setTimeout(() => done(false), 10000);
                img.src = emoji("twemoji", stem);
                holder.append(img);
              }),
          ),
        );
        const ms = Math.round(performance.now() - started);
        hops.batches.push({ loaded, ms, hop: await hop(300) });
      }
      holder.remove();
      const after = hops.batches.at(-1).hop;
      await check("показано больше 1000 эмодзи", loaded > 1000, loaded);
      await check("задача страницы не дорожает после 1000 эмодзи (мс на задачу)", after < 1, hops, {
        measured: true,
      });
      return next();
    }

    if (step === 4) {
      const origin = location.origin;
      const gif = `${origin}/e2e/cat.gif`;
      const page = `${origin}/e2e/page`;
      const favorites = async () => (await invoke("favorite_gifs_list")).favorites;
      const failed = (error) => ({ failed: error });

      const listing = await invoke("favorite_gifs_list");
      await check(
        "избранные GIF: сначала пусто, превью — из файлов клиента",
        listing.favorites.length === 0 && listing.base.endsWith("/favorite-gifs/"),
        listing,
      );
      const direct = await invoke("favorite_gifs_resolve", { url: gif }).catch(failed);
      await check("ссылка на GIF: файл — она сама", direct.media === gif && direct.kind === "image", direct);
      const found = await invoke("favorite_gifs_resolve", { url: page }).catch(failed);
      await check("страница с og:image: найдена её GIF", found.media === gif && found.kind === "image", found);
      const plain = await invoke("favorite_gifs_resolve", { url: `${origin}/e2e/plain` }).then(
        (value) => ({ value }),
        (error) => error,
      );
      await check("страница без GIF не принимается", typeof plain?.message === "string" && !plain.value, plain);
      // как media1.tenor.com/m/…: тому, кто предпочитает HTML, — страница
      const negotiated = `${origin}/e2e/negotiated.gif`;
      const asMedia = await invoke("favorite_gifs_resolve", { url: negotiated }).catch(failed);
      const bytes = await invoke("favorite_gifs_download", { url: negotiated }).then(
        (buffer) => new TextDecoder().decode(buffer.slice(0, 4)),
        (error) => ({ failed: error }),
      );
      await check(
        "ссылка на GIF, которую сайт отдаёт браузеру страницей, — запрошена как файл",
        asMedia.media === negotiated && asMedia.kind === "image" && bytes === "GIF8",
        { asMedia, bytes },
      );

      const picker = gifPicker();
      document.getElementById("floating").append(picker.base);
      const category = await waitFor(() => picker.grid.querySelector(":scope > .arachnid-gifs-category"), 5000, 50);
      await check(
        "окно GIF: «Избранное» — первая плитка категорий",
        category && picker.grid.firstElementChild === category,
        picker.grid.firstElementChild?.className,
      );
      category?.click();
      const view = picker.container.querySelector(":scope > .arachnid-gifs-view");
      await check(
        "плитка открывает избранное вместо окна Gifbox",
        view && !view.hidden && getComputedStyle(picker.stack).display === "none",
        { view: Boolean(view), hidden: view?.hidden },
      );

      // «+»: ссылка, описание, превью
      async function addByLink(url, description) {
        view.querySelector(".arachnid-gifs-bar > :last-child").click();
        const dialog = await waitFor(() => document.querySelector(".arachnid-gifs-dialog"), 2000, 50);
        const [link, about] = dialog.querySelectorAll(".arachnid-gifs-field");
        const confirm = dialog.querySelector(".arachnid-gifs-dialog-actions > :last-child");
        link.value = url;
        link.dispatchEvent(new Event("input", { bubbles: true }));
        about.value = description;
        await waitFor(() => !confirm.disabled || dialog.querySelector("[data-error]"), 20000, 100);
        const state = {
          ready: !confirm.disabled,
          shown: Boolean(dialog.querySelector(".arachnid-gifs-dialog-preview img")),
          status: dialog.querySelector(".arachnid-gifs-dialog-preview").textContent,
        };
        confirm.click();
        await waitFor(() => !dialog.isConnected, 10000, 50);
        return state;
      }
      const first = await addByLink(page, "Рыжий кот машет лапой");
      await check("окно «+»: по ссылке на страницу видна сама GIF", first.ready && first.shown, first);
      const one = await waitFor(async () => {
        const list = await favorites();
        return list.length === 1 && list[0].preview > 0 ? list : null;
      }, 10000);
      const cat = one?.[0];
      await check(
        "GIF добавлена: ссылка, файл, размеры, описание и превью",
        cat?.url === page &&
          cat.media === gif &&
          cat.kind === "image" &&
          cat.width === 60 &&
          cat.height === 40 &&
          cat.description === "Рыжий кот машет лапой",
        cat,
      );
      const previewSrc = cat ? `${listing.base}${cat.id}.webp?v=${cat.preview}` : "";
      const preview = await fetch(previewSrc).then(
        async (response) => ({
          status: response.status,
          type: response.headers.get("content-type"),
          size: (await response.arrayBuffer()).byteLength,
        }),
        (error) => ({ error: String(error) }),
      );
      await check(
        "превью — WebP в несколько килобайт",
        preview.status === 200 && preview.type === "image/webp" && preview.size > 0 && preview.size < 16384,
        preview,
        { measured: true },
      );

      const second = await addByLink(`${gif}?pes`, "Пёс");
      await check("окно «+»: ссылка прямо на GIF", second.ready && second.shown, second);
      const two = await waitFor(async () => {
        const list = await favorites();
        return list.length === 2 && list.every((item) => item.preview > 0) ? list : null;
      }, 10000);
      await check("новая GIF — первой", two?.[0].url === `${gif}?pes` && two[1].url === page, two);

      const grid = view.querySelector(".arachnid-gifs-grid");
      const tileOf = (id) => grid.querySelector(`.arachnid-gifs-tile[data-id="${id}"]`);
      await waitFor(() => grid.querySelectorAll(".arachnid-gifs-tile").length === 2, 3000, 50);
      const still = tileOf(cat.id)?.querySelector(".arachnid-gifs-still");
      await waitFor(() => still?.complete, 3000, 50);
      await check("плитка показывает превью", still?.naturalWidth === 60, still?.naturalWidth);

      const search = view.querySelector(".arachnid-gifs-bar .arachnid-gifs-field");
      const searchFor = async (value) => {
        search.value = value;
        search.dispatchEvent(new Event("input", { bubbles: true }));
        await frame();
        return Array.from(grid.querySelectorAll(".arachnid-gifs-tile"), (tile) => tile.dataset.id);
      };
      const byWords = await searchFor("лапой КОТ");
      const byLink = await searchFor("pes");
      const none = await searchFor("кот пёс");
      const emptyShown = !view.querySelector(".arachnid-gifs-empty").hidden;
      await searchFor("");
      await check(
        "поиск: каждое слово — в описании или ссылке",
        byWords.join() === cat.id && byLink.join() === two[0].id && none.length === 0 && emptyShown,
        { byWords, byLink, none, emptyShown },
      );

      // перетаскивание: первую GIF — на место второй
      const pointer = (target, type, x, y) =>
        target.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, isPrimary: true, clientX: x, clientY: y }),
        );
      const center = (element) => {
        const rect = element.getBoundingClientRect();
        return [rect.left + rect.width / 2, rect.top + rect.height / 2];
      };
      const [fromX, fromY] = center(tileOf(cat.id));
      const [toX, toY] = center(tileOf(two[0].id));
      pointer(tileOf(cat.id), "pointerdown", fromX, fromY);
      pointer(document.body, "pointermove", (fromX + toX) / 2, (fromY + toY) / 2);
      pointer(document.body, "pointermove", toX, toY);
      pointer(document.body, "pointerup", toX, toY);
      const moved = await waitFor(async () => {
        const list = await favorites();
        return list[0]?.id === cat.id ? list : null;
      }, 3000);
      await check("перетаскивание меняет порядок", moved, (await favorites()).map((item) => item.url));

      // щелчок отправляет ссылку в открытый канал
      const channel = "01J2E2E0000000000000000000";
      history.pushState(null, "", `/app/channel/${channel}`);
      localStorage.setItem("auth", JSON.stringify({ session: { token: "e2e-session" } }));
      await frame();
      const [sendX, sendY] = center(tileOf(cat.id));
      pointer(tileOf(cat.id), "pointerdown", sendX, sendY);
      pointer(tileOf(cat.id), "pointerup", sendX, sendY);
      const sent = await waitFor(async () => {
        const list = await (await fetch("/e2e/sent")).json();
        return list.length > 0 ? list : null;
      }, 5000);
      const message = sent?.[0];
      await check(
        "щелчок отправляет ссылку через API Stoat в открытый канал",
        sent?.length === 1 &&
          message.path === `/api/channels/${channel}/messages` &&
          message.body.content === page &&
          !message.body.replies &&
          message.token === "e2e-session" &&
          /^[0-9A-HJKMNP-TV-Z]{26}$/.test(message.idempotency ?? ""),
        sent,
      );
      const counted = await waitFor(async () => (await favorites()).find((item) => item.id === cat.id)?.sent === 1, 3000);
      await check("отправка засчитана", counted, await favorites());
      localStorage.removeItem("auth");
      history.pushState(null, "", "/app/");

      // избранное ищется только в избранном: в результатах Gifbox его нет
      view.querySelector(".arachnid-gifs-bar > :first-child").click();
      await check("«Назад» возвращает окно Gifbox", view.hidden && getComputedStyle(picker.stack).display !== "none");
      const masonry = picker.search("кот");
      const video = await waitFor(() => masonry.querySelector("video[data-arachnid-gifs]"), 3000, 50);
      await sleep(300);
      await check(
        "в результатах Gifbox нет избранного, их видео не играют сами",
        video &&
          !video.autoplay &&
          picker.stack.querySelector(".arachnid-gifs-tile, .arachnid-gifs-row") === null &&
          picker.stack.textContent.indexOf("избранного") === -1 &&
          picker.stack.textContent.indexOf("From Favorites") === -1,
        { video: Boolean(video), autoplay: video?.autoplay, tiles: picker.stack.querySelectorAll(".arachnid-gifs-tile").length },
      );

      // меню избранного: «Убрать из избранного» — последний пункт
      picker.input.value = "";
      picker.categories();
      await frame();
      category.click();
      await waitFor(() => tileOf(two[0].id), 3000, 50);
      const [menuX, menuY] = center(tileOf(two[0].id));
      tileOf(two[0].id).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: menuX, clientY: menuY }),
      );
      const favoritesMenu = document.querySelector(".arachnid-gifs-menu");
      const items = favoritesMenu ? favoritesMenu.querySelectorAll(".arachnid-gifs-menu-item") : [];
      await check("меню избранного: пять пунктов", items.length === 5, items.length);
      items[items.length - 1]?.click();
      const left = await waitFor(async () => {
        const list = await favorites();
        return list.length === 1 ? list : null;
      }, 3000);
      const gone = await fetch(`${listing.base}${two[0].id}.webp`).then((response) => response.status);
      await check("GIF убрана вместе с превью", left?.[0].id === cat.id && gone === 404, { left, gone });

      // раздел «Плагины» в настройках, как их строит for-web
      // (UserSettings.tsx, Sidebar.tsx): группы с заголовками — «Настройки
      // пользователя», «Stoat», «Настройки клиента» с «Внешним видом»
      // (значок palette) и «ПК» — и последняя группа без заголовка; значки —
      // svg, как в 0.17, и шрифтом Material Symbols, как в for-web main;
      // рядом — колонка страницы
      const sidebarLink = (icon, label) =>
        icon.startsWith("<")
          ? `<a class="button">${icon}<div><span>${label}</span></div></a>`
          : `<a class="button"><span class="material-symbols-outlined">${icon}</span><div><span>${label}</span></div></a>`;
      const sidebarGroup = (title, links) =>
        `<div class="e2e-group">${title ? `<span class="e2e-group-title">${title}</span>` : ""}<div class="e2e-list">${links.join("")}</div></div>`;
      const svgIcon = '<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>';
      const settingsPage = document.createElement("div");
      settingsPage.innerHTML = `<div class="settings_sidebar"><div><div class="content"><div class="e2e-column">
<div class="e2e-prepend">${sidebarLink("arrow_back", "Back")}<div></div></div>
${sidebarGroup("User Settings", [sidebarLink(svgIcon, "Profile"), sidebarLink(svgIcon, "Sessions")])}
${sidebarGroup("Stoat", [sidebarLink(svgIcon, "My Bots"), sidebarLink(svgIcon, "Feedback")])}
${sidebarGroup("Client Settings", [
  sidebarLink("mic", "Voice"),
  sidebarLink('<svg viewBox="0 0 24 24"><path d="M0 0"/><circle/><circle/><circle/><circle/></svg>', "Appearance"),
  sidebarLink("notifications", "Notifications"),
  sidebarLink("language", "Language"),
  sidebarLink("desktop_windows", "Desktop"),
])}
${sidebarGroup("", [
  sidebarLink("campaign", "What's New"),
  sidebarLink("memory", "Source Code"),
  sidebarLink("science", "Advanced"),
  sidebarLink("coffee", "Donate"),
  sidebarLink("logout", "Log Out"),
])}
<div class="e2e-append"><span>Stoat for Desktop 1.3.0</span></div>
</div></div></div></div><div><div class="settings_cont"><div></div></div></div>`;
      document.body.append(settingsPage);

      // группы боковой панели: «Мои боты» — у пользователя, «Обратная
      // связь» — между «Исходным кодом» и «Расширенными», «Stoat» скрыта, у
      // последней группы — заголовок «О программе», перед ней — «О клиенте»
      // со ссылками на репозиторий клиента
      const groupLabels = (group) =>
        group ? [...group.lastElementChild.querySelectorAll(":scope > a.button")].map((link) => link.lastElementChild.textContent) : [];
      const groups = () => [...settingsPage.querySelector(".e2e-column").children];
      const clientGroup = await waitFor(() => settingsPage.querySelector('[data-arachnid-category="client"]'), 3000, 50);
      const aboutGroup = groups().at(-2);
      const arranged = {
        user: groupLabels(groups()[1]).join(),
        stoatHidden: groups()[2].hasAttribute("data-arachnid-hidden"),
        about: groupLabels(aboutGroup).join(),
        aboutTitle: aboutGroup.firstElementChild.textContent,
        aboutTitleClass: aboutGroup.firstElementChild.className,
        clientBefore: aboutGroup.previousElementSibling === clientGroup,
        clientTitle: clientGroup?.firstElementChild.textContent,
        client: groupLabels(clientGroup).join(),
      };
      const opened = [];
      const realOpen = window.open;
      window.open = (url, target) => {
        opened.push([url, target]);
        return null;
      };
      for (const link of clientGroup?.lastElementChild.children ?? []) link.click();
      await waitFor(() => opened.length === 3, 3000, 50);
      window.open = realOpen;
      // ещё один проход скрипта ничего не повторяет
      settingsPage.querySelector(".e2e-append").append(document.createElement("span"));
      await frame();
      await frame();
      arranged.groups = groups().length;
      arranged.opened = opened.map(([url]) => url);
      await check(
        "настройки: группы боковой панели переставлены, «О программе» и «О клиенте» на месте",
        arranged.user === "Profile,Sessions,My Bots" &&
          arranged.stoatHidden &&
          arranged.about === "What's New,Source Code,Feedback,Advanced,Donate,Log Out" &&
          ["О программе", "About"].includes(arranged.aboutTitle) &&
          arranged.aboutTitleClass === "e2e-group-title" &&
          arranged.clientBefore &&
          ["О клиенте", "About the Client"].includes(arranged.clientTitle) &&
          groupLabels(clientGroup).length === 3 &&
          arranged.groups === 7 &&
          opened.length === 3 &&
          opened.every(([url, target]) => url.startsWith("https://github.com/sssHpion007/") && target === "_blank") &&
          arranged.opened[1].endsWith("/releases") &&
          arranged.opened[2].endsWith("/issues"),
        arranged,
      );
      // «Внешний вид», как его строит for-web: заголовок страницы (Text с
      // Breadcrumbs) — первый в колонке, за ним блок страницы с приветствием и
      // «Colours». «Папка тем» и «QuickCSS» — справа напротив заголовка, пока
      // открыта эта страница
      const settingsColumn = settingsPage.querySelector(".settings_cont > div");
      const pageTitle = document.createElement("span");
      pageTitle.style.cssText = "font-size:22px";
      pageTitle.innerHTML = "<div><span>Appearance</span></div>";
      const appearancePage = document.createElement("div");
      appearancePage.innerHTML = "<div><div>Welcome to the new appearance menu! Pick a theme.</div><div><span>Colours</span></div></div>";
      settingsColumn.append(pageTitle, appearancePage);
      const appearanceActions = await waitFor(() => pageTitle.querySelector('[data-arachnid-appearance="actions"]'), 3000, 50);
      const titleBox = pageTitle.getBoundingClientRect();
      const actionsBox = appearanceActions?.getBoundingClientRect();
      const appearanceHeader = {
        labels: [...(appearanceActions?.querySelectorAll(".arachnid-button") ?? [])].map((button) => button.lastChild.textContent),
        right: actionsBox ? Math.round(titleBox.right - actionsBox.right) : null,
        sameRow: actionsBox ? Math.abs(pageTitle.firstElementChild.getBoundingClientRect().top + pageTitle.firstElementChild.getBoundingClientRect().height / 2 - (actionsBox.top + actionsBox.height / 2)) < 2 : null,
        inPage: appearancePage.querySelectorAll(".arachnid-button").length,
        picker: Boolean(appearancePage.querySelector('[data-arachnid-appearance="picker"] .arachnid-collapse')),
      };
      // переход на другую страницу: for-web сразу меняет заголовок, страница
      // уходит после анимации
      pageTitle.firstElementChild.firstElementChild.textContent = "Notifications";
      appearanceHeader.leftOnNavigate = await waitFor(() => !pageTitle.querySelector(".arachnid-button"), 3000, 50);
      appearancePage.remove();
      pageTitle.remove();
      await check(
        "«Внешний вид»: «Папка тем» и «QuickCSS» справа напротив заголовка",
        ["Папка тем,QuickCSS", "Themes Folder,QuickCSS"].includes(appearanceHeader.labels.join()) &&
          appearanceHeader.right === 0 &&
          appearanceHeader.sameRow &&
          appearanceHeader.inPage === 0 &&
          appearanceHeader.picker &&
          appearanceHeader.leftOnNavigate,
        appearanceHeader,
      );

      const pluginsEntry = await waitFor(() => settingsPage.querySelector('a.button[data-arachnid-entry="plugins"]'), 3000, 50);
      pluginsEntry?.click();
      const qolRow = await waitFor(
        () =>
          [...settingsPage.querySelectorAll("[data-arachnid-panel] .arachnid-item")].find(
            (item) => item.querySelector(".arachnid-item-title")?.textContent === "Quality of Life",
          ),
        3000,
        50,
      );
      const panelText = settingsPage.querySelector("[data-arachnid-panel]")?.textContent ?? "";
      await check(
        "раздел «Плагины»: без «null» и «undefined»",
        qolRow && !/\b(null|undefined)\b/.test(panelText),
        panelText.slice(0, 400),
      );
      // папка плагинов — напротив заголовка, автор клиента и QoL — _sssHpion007
      const pluginsHeader = settingsPage.querySelector("[data-arachnid-panel] > .arachnid-page-header");
      const headerTitle = pluginsHeader?.querySelector(".arachnid-title")?.getBoundingClientRect();
      const headerButton = pluginsHeader?.querySelector(".arachnid-button")?.getBoundingClientRect();
      const qolDescription = qolRow?.querySelector(".arachnid-item-description")?.textContent ?? "";
      const pluginsLayout = {
        header: Boolean(pluginsHeader && headerTitle && headerButton),
        sameRow: headerTitle && headerButton ? Math.abs(headerTitle.top + headerTitle.height / 2 - (headerButton.top + headerButton.height / 2)) < 2 : null,
        right: headerButton ? Math.round(pluginsHeader.getBoundingClientRect().right - headerButton.right) : null,
        bottomButtons: settingsPage.querySelectorAll("[data-arachnid-panel] > .arachnid-buttons").length,
        cardAuthor: settingsPage.querySelector("[data-arachnid-panel] .arachnid-card")?.textContent.includes("_sssHpion007"),
        qolAuthor: qolDescription.includes("_sssHpion007"),
      };
      await check(
        "раздел «Плагины»: папка напротив заголовка, автор — _sssHpion007",
        pluginsLayout.header &&
          pluginsLayout.sameRow &&
          pluginsLayout.right === 0 &&
          pluginsLayout.bottomButtons === 0 &&
          pluginsLayout.cardAuthor &&
          pluginsLayout.qolAuthor,
        pluginsLayout,
      );
      const gear = qolRow && [...qolRow.querySelectorAll(".arachnid-icon-button")].find((button) => button.textContent === "settings");
      gear?.click();
      const qolDialog = await waitFor(() => document.querySelector('[data-arachnid-plugin-settings="builtin:qol"]'), 3000, 50);
      const qolInputs = qolDialog ? [...qolDialog.querySelectorAll("[data-arachnid-setting]")] : [];
      const qolInput = (name) => qolInputs.find((input) => input.dataset.arachnidSetting === name);
      await check(
        "«Quality of Life»: шестерёнка открывает окно с настройкой каждой части",
        qolInputs.map((input) => `${input.dataset.arachnidSetting}=${input.checked}`).join() ===
          "interface=true,emoji_picker=true,favorite_gifs=true,gifs_open_favorites=false,hotkeys=false" &&
          !qolInput("gifs_open_favorites").disabled &&
          qolDialog.querySelectorAll(".arachnid-setting-hint").length === 5,
        qolInputs.map((input) => [input.dataset.arachnidSetting, input.checked, input.disabled]),
      );

      // настройки действуют сразу: избранное в открытом окне GIF
      qolInput("favorite_gifs")?.click();
      const switchedOff = await waitFor(
        () =>
          !picker.grid.querySelector(".arachnid-gifs-category") &&
          !picker.container.querySelector(".arachnid-gifs-view") &&
          getComputedStyle(picker.stack).display !== "none",
        3000,
        50,
      );
      await check(
        "выключенное избранное уходит из открытого окна GIF, «Открывать на избранном» недоступно",
        switchedOff && qolInput("gifs_open_favorites").disabled && picker.input.dataset.arachnidGifs === undefined,
        { switchedOff, disabled: qolInput("gifs_open_favorites")?.disabled },
      );
      qolInput("favorite_gifs")?.click();
      qolInput("gifs_open_favorites")?.click();
      const tileBack = await waitFor(() => picker.grid.querySelector(":scope > .arachnid-gifs-category"), 3000, 50);
      await check(
        "включённое избранное возвращается в открытое окно, не переключая его",
        tileBack && !picker.container.querySelector(".arachnid-gifs-view:not([hidden])"),
      );
      const savedQol = await pluginInfo("builtin:qol");
      const opensFavorites = gifPicker();
      document.getElementById("floating").append(opensFavorites.base);
      const openedView = await waitFor(
        () => opensFavorites.container.querySelector(":scope > .arachnid-gifs-view:not([hidden])"),
        3000,
        50,
      );
      await check(
        "«Открывать окно GIF сразу на избранном»: новое окно — сразу избранное",
        openedView && getComputedStyle(opensFavorites.stack).display === "none" && savedQol?.values.gifs_open_favorites === "1",
        savedQol?.values,
      );
      opensFavorites.base.remove();

      // подсветка кнопок for-web — md-ripple (Lit): стили shadow root из
      // elementStyles класса, у ::before переход opacity 15 мс
      class E2eRipple extends HTMLElement {
        static elementStyles = (() => {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync('.surface::before { content: ""; position: absolute; inset: 0; transition: opacity 15ms linear; }');
          return [sheet];
        })();
        constructor() {
          super();
          const root = this.attachShadow({ mode: "open" });
          root.adoptedStyleSheets = [...E2eRipple.elementStyles];
          const surface = document.createElement("div");
          surface.className = "surface";
          root.append(surface);
        }
      }
      customElements.define("md-ripple", E2eRipple);
      const earlyRipple = document.createElement("md-ripple");
      document.body.append(earlyRipple);
      const rippleTransition = (element) =>
        getComputedStyle(element.shadowRoot.querySelector(".surface"), "::before").transitionDuration;
      await waitFor(() => rippleTransition(earlyRipple) === "0s", 2000, 50);
      const lateRipple = document.createElement("md-ripple");
      document.body.append(lateRipple);
      await check(
        "подсветка при наведении (md-ripple) — без перехода, который оставлял её на части кнопки",
        rippleTransition(earlyRipple) === "0s" && rippleTransition(lateRipple) === "0s",
        { early: rippleTransition(earlyRipple), late: rippleTransition(lateRipple) },
      );

      // Меню браузера (WebView2: «Обновить», «Печать»…) там, где у for-web
      // нет своего: только в полях ввода и при выделенном тексте
      const plainText = document.createElement("div");
      plainText.textContent = "просто текст";
      const plainField = document.createElement("input");
      const editableText = document.createElement("div");
      editableText.contentEditable = "true";
      editableText.textContent = "редактируемый";
      const menuArea = document.createElement("div");
      menuArea.append(plainText, plainField, editableText);
      document.body.append(menuArea);
      getSelection().removeAllRanges();
      const browserMenu = { plain: rightClick(plainText), field: rightClick(plainField), editable: rightClick(editableText) };
      getSelection().selectAllChildren(plainText);
      browserMenu.selected = rightClick(plainText);
      getSelection().removeAllRanges();
      await check(
        "меню браузера скрыто везде, кроме полей ввода и выделенного текста",
        !browserMenu.plain && browserMenu.field && browserMenu.editable && browserMenu.selected,
        browserMenu,
      );

      // Профиль (ProfileJoined for-web): плитка «Joined» — полоса «Участник
      // с» во всю ширину в конце профиля, даты со значками Stoat и сервера;
      // одинокая квадратная плитка в ряду — во всю ширину
      const profileServer = document.createElement("div");
      profileServer.setAttribute("aria-label", "Тестовый сервер");
      profileServer.innerHTML = '<div><a href="/server/01E2E"><img src="/icons/e2e-wide" alt=""></a></div>';
      document.body.append(profileServer);
      const profileTile = (title) =>
        `<div style="aspect-ratio:1/1;overflow:hidden;display:flex;flex-direction:column"><span>${title}</span></div>`;
      const profilePortal = document.createElement("div");
      profilePortal.innerHTML = `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;width:340px">
        <div style="grid-column:1/3;height:120px"></div>
        ${profileTile("Roles")}${profileTile("Badges")}${profileTile("Status")}
        <div style="aspect-ratio:1/1;overflow:hidden;display:flex;flex-direction:column"><span>Joined</span><span><div>Stoat</div></span><span>12 Mar 2023</span><span><div>Тестовый сервер</div></span><span>05 Jan 2024</span></div>
        <div style="grid-column:1/3;height:60px"></div>
      </div>`;
      document.getElementById("floating").append(profilePortal);
      const profileGrid = profilePortal.firstElementChild;
      const [, , , statusTile, joinedTile, bioTile] = profileGrid.children;
      const joinedFormat = new Intl.DateTimeFormat(/^ru\b/i.test(navigator.language) ? "ru" : undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      const joinedDates = () =>
        Array.from(joinedTile.querySelectorAll(".arachnid-joined-date"), (date) => ({
          // за значком (картинкой или буквой в кружке) — текст даты
          text: date.lastChild?.textContent ?? "",
          icon: date.querySelector("img")?.src ?? null,
        }));
      await waitFor(() => joinedTile.querySelector(".arachnid-joined"), 3000, 50);
      const joinedSeen = {
        dates: joinedDates(),
        width: Math.round(joinedTile.getBoundingClientRect().width),
        belowBio: joinedTile.getBoundingClientRect().top > bioTile.getBoundingClientRect().top,
        hidden: Array.from(joinedTile.querySelectorAll(":scope > span"), (span) => getComputedStyle(span).display),
        lone: statusTile.hasAttribute("data-arachnid-lone") && Math.round(statusTile.getBoundingClientRect().width) === 340,
      };
      await check(
        "профиль: «Joined» — полоса во всю ширину в конце, даты со значком сервера, одинокая плитка во всю ширину",
        joinedSeen.dates.length === 2 &&
          joinedSeen.dates[0].text === joinedFormat.format(new Date(2023, 2, 12)) &&
          joinedSeen.dates[1].text === joinedFormat.format(new Date(2024, 0, 5)) &&
          joinedSeen.dates[1].icon === new URL("/icons/e2e-wide", location.href).href &&
          joinedSeen.width === 340 &&
          joinedSeen.belowBio &&
          joinedSeen.hidden.every((display) => display === "none") &&
          joinedSeen.lone,
        joinedSeen,
      );
      // Solid обновляет текст скрытых узлов — полоса следует за ним
      joinedTile.children[2].textContent = "13 Mar 2023";
      const joinedUpdated = await waitFor(
        () => joinedDates()[0]?.text === joinedFormat.format(new Date(2023, 2, 13)),
        3000,
        50,
      );
      await check("профиль: полоса «Участник с» следует за датой for-web", joinedUpdated, joinedDates());

      qolInput("interface")?.click();
      const interfaceOff = await waitFor(
        () =>
          !document.getElementById("arachnid-interface-style") &&
          rippleTransition(earlyRipple) === "0.015s" &&
          rightClick(plainText) &&
          !joinedTile.hasAttribute("data-arachnid-joined") &&
          !joinedTile.querySelector(".arachnid-joined") &&
          !statusTile.hasAttribute("data-arachnid-lone"),
        3000,
        50,
      );
      qolInput("interface")?.click();
      const interfaceOn = await waitFor(
        () =>
          document.getElementById("arachnid-interface-style") &&
          rippleTransition(earlyRipple) === "0s" &&
          !rightClick(plainText) &&
          joinedTile.querySelector(".arachnid-joined") &&
          statusTile.hasAttribute("data-arachnid-lone"),
        3000,
        50,
      );
      menuArea.remove();
      profilePortal.remove();
      profileServer.remove();
      await check("«Исправление деталей интерфейса» выключается и включается сразу", interfaceOff && interfaceOn, {
        ripple: rippleTransition(earlyRipple),
      });
      earlyRipple.remove();
      lateRipple.remove();

      // «Улучшенное меню эмодзи» выключено — в меню сообщения нет пункта
      // «Скачать изображение»
      const chatToggle = chatEmojiMock();
      document.body.append(chatToggle.base);
      qolInput("emoji_picker")?.click();
      const downloadOff = await waitFor(async () => (await chatDownloadItem(chatToggle, chatToggle.image)) === null, 3000, 50);
      qolInput("emoji_picker")?.click();
      const downloadOn = await waitFor(async () => (await chatDownloadItem(chatToggle, chatToggle.image)) !== null, 3000, 50);
      chatToggle.base.remove();
      await check("«Улучшенное меню эмодзи»: пункт в меню сообщения выключается и включается сразу", downloadOff && downloadOn, {
        downloadOff,
        downloadOn,
      });
      // «Горячие клавиши»: пункт сразу после «ПК» — только с настройкой,
      // раздел назначает и убирает сочетания, нажатое сочетание жмёт кнопку
      // карточки звонка, боковые кнопки мыши не листают страницы
      const hotkeysEntry = () => settingsPage.querySelector('a.button[data-arachnid-entry="hotkeys"]');
      const desktopLink = [...settingsPage.querySelectorAll("a.button")].find((link) =>
        link.querySelector(".material-symbols-outlined")?.textContent === "desktop_windows",
      );
      const sideUp = () => {
        const event = new MouseEvent("mouseup", { button: 3, bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const hotkeysOff = { entry: !hotkeysEntry(), active: (await invoke("hotkeys_overview")).active, side: sideUp() };
      qolInput("hotkeys")?.click();
      const hotkeysPlaced = await waitFor(() => hotkeysEntry() && desktopLink?.nextElementSibling === hotkeysEntry(), 3000, 50);
      const hotkeysActive = await waitFor(async () => (await invoke("hotkeys_overview")).active, 3000, 50);
      hotkeysEntry()?.click();
      const hotkeyRows = await waitFor(
        () => settingsPage.querySelectorAll('[data-arachnid-content-page="hotkeys"] [data-arachnid-panel] [data-arachnid-hotkey]').length,
        3000,
        50,
      );
      await invoke("hotkeys_set", { action: "toggle_mute", code: "ctrl+shift+key:120" });
      await invoke("hotkeys_set", { action: "toggle_deafen", code: "mouse:x1" });
      window.__arachnidDesktop.hotkeysChanged();
      const muteKeys = await waitFor(
        () => settingsPage.querySelector('[data-arachnid-hotkey="toggle_mute"] .arachnid-keys')?.textContent,
        3000,
        50,
      );
      settingsPage.querySelector('[data-arachnid-hotkey="toggle_deafen"] .arachnid-icon-button')?.click();
      const hotkeyState = { cleared: await waitFor(async () => !(await invoke("hotkeys_overview")).bindings.toggle_deafen, 3000, 50) };
      settingsPage.querySelector('[data-arachnid-hotkey="disconnect"] .arachnid-button')?.click();
      hotkeyState.recording = await waitFor(
        async () =>
          (await invoke("hotkeys_overview")).recording === "disconnect" &&
          settingsPage.querySelector('[data-arachnid-hotkey="disconnect"]')?.hasAttribute("data-recording"),
        3000,
        50,
      );
      settingsPage.querySelector('[data-arachnid-hotkey="disconnect"] .arachnid-button')?.click();
      hotkeyState.cancelled = await waitFor(async () => (await invoke("hotkeys_overview")).recording === null, 3000, 50);

      const callBar = document.createElement("div");
      const callPresses = [];
      for (const symbol of ["mic_off", "headset", "camera_video", "screen_share", "call_end"]) {
        const callButton = document.createElement("button");
        const symbolSpan = document.createElement("span");
        symbolSpan.textContent = symbol;
        callButton.append(symbolSpan);
        callButton.disabled = symbol === "camera_video";
        callButton.addEventListener("click", () => callPresses.push(symbol));
        callBar.append(callButton);
      }
      document.getElementById("floating").append(callBar);
      for (const action of ["toggle_mute", "toggle_camera", "disconnect", "toggle_window"]) window.__arachnidDesktop.hotkey(action);
      await frame();
      callBar.remove();
      hotkeyState.side = sideUp();

      qolInput("hotkeys")?.click();
      hotkeyState.removed = await waitFor(
        async () =>
          !hotkeysEntry() &&
          !settingsPage.querySelector('[data-arachnid-content-page="hotkeys"]') &&
          !(await invoke("hotkeys_overview")).active,
        3000,
        50,
      );
      hotkeyState.sideAfter = sideUp();
      await invoke("hotkeys_set", { action: "toggle_mute", code: null });
      Object.assign(hotkeyState, { hotkeysOff, hotkeysPlaced: Boolean(hotkeysPlaced), hotkeysActive, hotkeyRows, muteKeys, presses: callPresses.join() });
      await check(
        "«Горячие клавиши»: пункт после «ПК» с настройкой, сочетания назначаются, действие жмёт кнопку звонка",
        hotkeysOff.entry &&
          !hotkeysOff.active &&
          !hotkeysOff.side &&
          hotkeysPlaced &&
          hotkeysActive &&
          hotkeyRows === 6 &&
          muteKeys === "CtrlShiftF9" &&
          hotkeyState.cleared &&
          hotkeyState.recording &&
          hotkeyState.cancelled &&
          callPresses.join() === "mic_off,call_end" &&
          hotkeyState.side &&
          hotkeyState.removed &&
          !hotkeyState.sideAfter,
        hotkeyState,
      );

      qolDialog?.querySelector(".arachnid-dialog-actions > :last-child")?.click();
      await invoke("extensions_reset_plugin", { file: "builtin:qol" });

      // выбор в окне настроек плагина-папки виден сразу, без повторного открытия
      const folderRow = [...settingsPage.querySelectorAll("[data-arachnid-panel] .arachnid-item")].find(
        (item) => item.querySelector(".arachnid-item-title")?.textContent === "E2E Folder",
      );
      const folderGear = folderRow && [...folderRow.querySelectorAll(".arachnid-icon-button")].find((button) => button.textContent === "settings");
      folderGear?.click();
      const folderDialog = await waitFor(() => document.querySelector(`[data-arachnid-plugin-settings="${FOLDER}"]`), 3000, 50);
      const modeSelect = folderDialog?.querySelector(".arachnid-select");
      const modeShown = () => modeSelect?.querySelector(".arachnid-select-value")?.textContent;
      const modeBefore = modeShown();
      modeSelect?.click();
      const modeOption = await waitFor(
        () => [...document.querySelectorAll(".arachnid-select-menu .arachnid-select-item")].find((item) => item.textContent === "Второй"),
        3000,
        50,
      );
      modeOption?.click();
      const modeAfter = modeShown();
      const modeSaved = await waitFor(async () => (await pluginInfo(FOLDER))?.values.mode === "two", 3000, 50);
      await check(
        "настройки плагина: выбранный вариант виден сразу и сохранён",
        modeBefore === "Первый" && modeAfter === "Второй" && modeSelect.isConnected && modeSaved,
        { modeBefore, modeAfter, connected: modeSelect?.isConnected, modeSaved },
      );
      folderDialog?.querySelector(".arachnid-dialog-actions > :last-child")?.click();
      await invoke("extensions_reset_plugin", { file: FOLDER });
      settingsPage.remove();

      picker.base.remove();

      // имя сессии: вход for-web (stoat-api: fetch, тело — строка JSON)
      const login = (body) =>
        fetch(`${origin}/api/auth/session/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).then((response) => response.json());
      await login({ email: "e2e@example.com", password: "секрет", friendly_name: "Stoat for Web (edge-chromium on Windows 10)" });
      await login({ mfa_ticket: "ticket", mfa_response: { totp_code: "123456" }, friendly_name: "Stoat for Web (Unknown Device)" });
      await login({ email: "e2e@example.com", password: "секрет", friendly_name: "Мой ноутбук" });
      const logins = await (await fetch("/e2e/logins")).json();
      await check(
        "вход: сессия сразу называется «Arachnid Client», остальное в запросе то же",
        logins.length === 3 &&
          logins[0].friendly_name === "Arachnid Client" &&
          logins[0].email === "e2e@example.com" &&
          logins[0].password === "секрет" &&
          logins[1].friendly_name === "Arachnid Client" &&
          logins[1].mfa_response?.totp_code === "123456" &&
          logins[2].friendly_name === "Мой ноутбук",
        logins,
      );
      return finish();
    }
  } catch (error) {
    await log(`исключение: ${error?.stack || error}`);
    return finish(error);
  }
})();
