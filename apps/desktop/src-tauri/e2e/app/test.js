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
// 3. выбранный вручную набор остаётся; окно выбора эмодзи получает разделы,
//    и его прокрутка не заставляет клиент искать окно по всему документу;
//    шторка выбора набора получает кнопки, Mutant Remix скачивается и
//    удаляется кнопками шторки.
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
  async function check(name, ok, details) {
    results.push({ step, name, ok: Boolean(ok), details });
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
      const body = await response.text();
      return {
        status: response.status,
        source: source(response.headers.get("server-timing")),
        svg: body.trimStart().startsWith("<svg"),
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
   * видимые. В сетке — строка заголовка «Default» и 1785 стандартных эмодзи.
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
    const railList = h("div", "position:relative;height:0");
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
    let turn = 0;
    /** Перерисовка, как при прокрутке: Show keyed for-web пересоздаёт картинки */
    function render() {
      turn++;
      const first = Math.floor(grid.scrollTop / 40);
      const cells = [];
      for (let row = first; row < Math.min(rows, first + 18); row++) {
        for (let column = 0; column < columns; column++) {
          const img = h("img", "width:100%;height:100%");
          img.className = "emoji";
          img.alt = String.fromCodePoint(0x1f600 + ((row + column + turn) % 40));
          img.src = emoji("twemoji", codes[(row * columns + column + turn) % codes.length]);
          const cell = h("div", `position:absolute;width:40px;height:40px;transform:translate(${column * 40}px, ${row * 40}px)`, img);
          cells.push(cell);
        }
      }
      gridList.replaceChildren(...cells);
    }
    render();
    return { base, input, rail, grid, render };
  }
  const packState = async (id) => (await invoke("emoji_packs")).packs.find((pack) => pack.id === id);

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
      await check("запрос страницы отдал клиент", page.source === "builtin" && page.svg, page);

      const fresh = await settings();
      await check(
        "первый запуск: набор эмодзи Twemoji",
        fresh?.["appearance:unicode_emoji"] === "twemoji",
        fresh,
      );

      const overview = await invoke("emoji_packs");
      await check("emoji_packs: скачивание поддерживается", overview.supported, overview.sizes);

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
      await check("форма с fe0f (❤️) из встроенного набора", heart.source === "builtin" && heart.svg, heart);

      await localforage.setItem("settings", {
        "appearance:unicode_emoji": "fluent-3d",
        "appearance:compact_mode": true,
      });
      localStorage.removeItem("arachnid:defaults:keyvaluepairs");
      return next();
    }

    if (step === 2) {
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

      // окно выбора эмодзи
      const picker = emojiPicker();
      document.getElementById("floating").append(picker.base);
      const railButtons = () => picker.rail.querySelectorAll(".arachnid-emoji-rail-button");
      const enhanced = await waitFor(() => railButtons().length > 0, 5000, 50);
      await check("окно эмодзи: разделы в колонке", enhanced && railButtons().length === 9, railButtons().length);

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

      const flags = picker.rail.querySelector('.arachnid-emoji-rail-button[title="Flags"], .arachnid-emoji-rail-button[title="Флаги"]');
      flags.click();
      await frame();
      picker.render();
      await waitFor(() => flags.hasAttribute("data-active"), 2000, 50);
      await check("окно эмодзи: переход к флагам и подсветка раздела", flags.hasAttribute("data-active"), picker.grid.scrollTop);

      // закрыть и открыть снова — новое окно тоже получает разделы
      picker.base.remove();
      await frame();
      const again = emojiPicker();
      document.getElementById("floating").append(again.base);
      const reopened = await waitFor(() => again.rail.querySelector(".arachnid-emoji-rail-button"), 5000, 50);
      await check("окно эмодзи: открытое заново тоже дополнено", Boolean(reopened));
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
        await check("картинку системного набора нарисовал клиент", drawn.source === "system" && drawn.svg, drawn);
        const flag = await fetched(emoji("fluent-color", "1f1f7-1f1fa"));
        await check("флаг системного набора — с сервера", flag.source === null, flag);
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
        100,
      );
      await check("Mutant Remix скачан", installed?.installed, installed);
      await check("ход скачивания виден (received/total)", progressSeen);
      await check("шторка: кольцо загрузки показано", ringSeen);
      await waitFor(() => /Downloaded|Скачан/.test(row("mutant")?.textContent ?? ""), 3000, 50);
      await check("шторка: «Скачан»", /Downloaded|Скачан/.test(row("mutant")?.textContent ?? ""), row("mutant")?.textContent);

      const downloaded = await fetched(emoji("mutant", "1f600"));
      await check("картинку скачанного набора отдал клиент", downloaded.source === "downloaded" && downloaded.svg, downloaded);
      const workerDownloaded = await workerFetch(emoji("mutant", "1f602"));
      await check("и на запрос service worker", workerDownloaded.source === "downloaded", workerDownloaded);

      row("mutant").querySelector("button").click();
      const removed = await waitFor(async () => !(await packState("mutant")).installed, 10000);
      await check("Mutant Remix удалён кнопкой шторки", removed);
      const afterDelete = await fetched(emoji("mutant", "1f600"));
      await check("после удаления картинки идут с сервера", afterDelete.source === null, afterDelete);
      await check("кнопки не выбирали набор", selected === 0, selected);

      // ВРЕМЕННО: цена задачи главного потока после многих картинок эмодзи
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
      const hops = { before: await hop(300) };
      const holder = document.createElement("div");
      holder.style.cssText = "position:fixed;left:0;top:0;width:32px;height:32px;overflow:hidden";
      document.body.append(holder);
      let loaded = 0;
      for (const [from, to] of [[0, 400], [400, 800], [800, stems.length]]) {
        await Promise.all(
          stems.slice(from, to).map(
            (stem) =>
              new Promise((resolve) => {
                const img = new Image(32, 32);
                const done = (ok) => {
                  if (ok) loaded++;
                  img.remove();
                  resolve();
                };
                img.onload = () => done(true);
                img.onerror = () => done(false);
                setTimeout(() => done(false), 5000);
                img.src = emoji("twemoji", stem);
                holder.append(img);
              }),
          ),
        );
        hops[loaded] = await hop(300);
      }
      holder.remove();
      await check("ВРЕМЕННО: мс на задачу после картинок эмодзи", true, hops);
      return finish();
    }
  } catch (error) {
    await log(`исключение: ${error?.stack || error}`);
    return finish(error);
  }
})();
