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
// 3. выбранный вручную набор остаётся; шторка выбора набора получает кнопки,
//    Mutant Remix скачивается и удаляется кнопками шторки.
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
      return finish();
    }
  } catch (error) {
    await log(`исключение: ${error?.stack || error}`);
    return finish(error);
  }
})();
