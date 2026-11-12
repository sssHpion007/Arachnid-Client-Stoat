// Скачивание и удаление наборов эмодзи прямо в шторке выбора набора
// («Настройки» → «Внешний вид» → «Emoji Pack»), см. emoji_packs.rs.
//
// Шторку рисует for-web (FloatingSelect в AppearanceMenu.tsx): она
// открывается в `#floating`, пункты — `mdui-menu-item` со значением набора
// (атрибут `value`). Скрипт узнаёт её по пунктам — ровно наборы
// UNICODE_EMOJI_PACKS — и добавляет каждому пункту справа, в слот `end-icon`
// пункта mdui:
//
// * Twemoji — «Встроен»: он лежит в самом клиенте;
// * не скачанный набор — размер и кнопку «Скачать»;
// * во время скачивания — кольцо с процентами и «Отмена»;
// * скачанный — «Скачан» и «Удалить»;
// * после ошибки — «Ошибка» (причина во всплывающей подсказке) и «Повторить».
//
// Выбор набора остаётся за for-web: щелчок по пункту выбирает набор, щелчок
// по кнопке — только скачивает или удаляет (событие дальше пункта не идёт).
// Не скачанный набор, как и в браузере, грузится картинками с сервера Stoat.
//
// Добавленное живёт в теневом DOM: текст пункта (по нему for-web подписывает
// поле выбора) и стили for-web не меняются.
//
// Скрипт выполняется после bridge.js и только там, где он создал
// window.__arachnidDesktop (страница веб-клиента из config.toml).
(() => {
  "use strict";

  const desktop = window.__arachnidDesktop;
  const internals = window.__TAURI_INTERNALS__;
  if (!desktop || !internals) return;

  const invoke = (command, args) => internals.invoke(command, args);

  /** UNICODE_EMOJI_PACKS в UnicodeEmoji.tsx */
  const PACKS = ["fluent-3d", "fluent-color", "fluent-flat", "mutant", "noto", "twemoji"];

  const russian = /^ru\b/i.test(navigator.language || "");
  const text = russian
    ? {
        builtin: "Встроен",
        builtinHint: "Встроен в клиент: показывается сразу, без загрузки с сервера",
        installed: "Скачан",
        installedHint: (size) => `Скачан (${size}): показывается сразу, без загрузки с сервера`,
        availableHint: (size) =>
          size ? `Скачать (${size}): набор будет показываться сразу, без загрузки с сервера` : "Скачать",
        failed: "Ошибка",
        download: "Скачать",
        retry: "Повторить",
        cancel: "Отменить скачивание",
        remove: "Удалить",
        progress: (received, total) => `Скачано ${received} из ${total}`,
        kb: "КБ",
        mb: "МБ",
        failure: {
          network: (code) => (code ? `Нет связи с GitHub (ошибка ${code})` : "Нет связи с GitHub"),
          status: (code) => `Сервер ответил ${code}`,
          missing: () => "Набора нет на сервере загрузки",
          corrupt: () => "Файл пришёл повреждённым, попробуйте ещё раз",
          io: (_, message) => `Не удалось сохранить файл: ${message}`,
          unsupported: () => "Скачивание наборов есть только в Windows",
        },
      }
    : {
        builtin: "Built-in",
        builtinHint: "Built into the client: shows instantly, without loading from the server",
        installed: "Downloaded",
        installedHint: (size) => `Downloaded (${size}): shows instantly, without loading from the server`,
        availableHint: (size) =>
          size ? `Download (${size}): the pack will show instantly, without loading from the server` : "Download",
        failed: "Error",
        download: "Download",
        retry: "Retry",
        cancel: "Cancel download",
        remove: "Delete",
        progress: (received, total) => `Downloaded ${received} of ${total}`,
        kb: "KB",
        mb: "MB",
        failure: {
          network: (code) => (code ? `Cannot reach GitHub (error ${code})` : "Cannot reach GitHub"),
          status: (code) => `The server responded with ${code}`,
          missing: () => "The pack is missing on the download server",
          corrupt: () => "The file arrived damaged, please try again",
          io: (_, message) => `Could not save the file: ${message}`,
          unsupported: () => "Downloading packs is only available on Windows",
        },
      };

  const sizeFormat = new Intl.NumberFormat(russian ? "ru" : "en", { maximumFractionDigits: 1 });
  function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return `${sizeFormat.format(bytes / (1024 * 1024))} ${text.mb}`;
    return `${sizeFormat.format(Math.max(1, Math.round(bytes / 1024)))} ${text.kb}`;
  }

  function failureText(failure) {
    const describe = text.failure[failure?.kind] ?? text.failure.network;
    return describe(failure?.code, failure?.message ?? "");
  }

  // Значки Material Symbols (Apache 2.0), viewBox 0 -960 960 960: шрифт
  // значков for-web в теневой DOM не попадает.
  const ICONS = {
    download:
      "M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z",
    delete:
      "M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z",
    close:
      "m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z",
    refresh:
      "M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z",
  };

  const SVG = "http://www.w3.org/2000/svg";
  function svg(tag, attributes, ...children) {
    const element = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    element.append(...children);
    return element;
  }
  const icon = (name) =>
    svg("svg", { viewBox: "0 -960 960 960", "aria-hidden": "true" }, svg("path", { d: ICONS[name] }));

  // Цвета — переменные Material 3 for-web: подходят к любой теме.
  const STYLE = `
:host { display: inline-flex; align-items: center; margin-inline-start: 12px; }
.row { display: inline-flex; align-items: center; gap: 4px; min-height: 40px; }
.label {
  font-family: inherit; font-size: 0.75rem; line-height: 1rem; font-weight: 500;
  letter-spacing: 0.03125rem; white-space: nowrap; color: var(--md-sys-color-on-surface-variant);
}
.label.error { color: var(--md-sys-color-error); }
button {
  all: unset; box-sizing: border-box; display: inline-grid; place-items: center;
  width: 40px; height: 40px; border-radius: 50%; cursor: pointer;
  color: var(--md-sys-color-on-surface-variant);
}
button:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
button:active { background: color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent); }
button:focus-visible { outline: 2px solid var(--md-sys-color-primary); outline-offset: -2px; }
button.primary { color: var(--md-sys-color-primary); }
svg { width: 24px; height: 24px; fill: currentColor; }
.ring { width: 24px; height: 24px; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-width: 3; }
.ring .track { stroke: color-mix(in srgb, var(--md-sys-color-primary) 24%, transparent); }
.ring .value { stroke: var(--md-sys-color-primary); stroke-linecap: round; transition: stroke-dashoffset 0.2s linear; }
.ring.indeterminate { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;
  /** Длина окружности кольца загрузки (r = 9) */
  const RING = 2 * Math.PI * 9;

  // ─────────────────────────────── состояние ───────────────────────────────
  /** Последний ответ emoji_packs */
  let overview = null;
  let request = null;
  let stale = false;

  function refresh() {
    if (request) {
      // ответ на идущий запрос уже устарел: спросить ещё раз после него
      stale = true;
      return;
    }
    request = invoke("emoji_packs")
      .then(
        (next) => {
          overview = next;
          render();
        },
        (error) => console.warn("[Arachnid] наборы эмодзи не получены", error),
      )
      .finally(() => {
        request = null;
        if (stale) {
          stale = false;
          refresh();
        }
      });
  }

  function command(name, id) {
    invoke(name, { id }).then(
      (next) => {
        overview = next;
        render();
      },
      (error) => {
        console.warn(`[Arachnid] ${name}:`, error);
        refresh();
      },
    );
  }

  // ─────────────────────────────── пункты ───────────────────────────────
  /** Пункты открытой шторки: набор → элементы */
  const rows = new Map();

  function packOf(item) {
    const value = item.getAttribute("value") ?? item.value;
    return PACKS.includes(value) ? value : null;
  }

  function createRow(item, id) {
    const host = document.createElement("span");
    host.slot = "end-icon";
    host.dataset.arachnidEmojiPack = id;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    const box = document.createElement("span");
    box.className = "row";
    shadow.append(style, box);

    // кнопки не выбирают набор: for-web выбирает его по щелчку, всплывшему
    // от пункта, а mdui — по Enter и пробелу на пункте. Щелчок по подписи
    // выбирает набор, как и по остальному пункту.
    for (const type of ["click", "pointerdown", "mousedown", "keydown"]) {
      host.addEventListener(type, (event) => {
        if (!event.composedPath().some((node) => node instanceof HTMLButtonElement)) return;
        if (type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
        event.stopPropagation();
      });
    }
    item.append(host);
    return { id, item, host, box, state: null };
  }

  function button(name, label, onClick, primary) {
    const element = document.createElement("button");
    element.type = "button";
    element.title = label;
    element.setAttribute("aria-label", label);
    if (primary) element.className = "primary";
    element.append(icon(name));
    element.addEventListener("click", (event) => {
      event.preventDefault();
      onClick();
    });
    return element;
  }

  function label(content, hint, error) {
    const element = document.createElement("span");
    element.className = error ? "label error" : "label";
    element.textContent = content;
    if (hint) element.title = hint;
    return element;
  }

  function ring(received, total) {
    const ratio = total ? Math.min(1, received / total) : null;
    const value = svg("circle", { class: "value", cx: "12", cy: "12", r: "9" });
    value.setAttribute("stroke-dasharray", String(RING));
    value.setAttribute("stroke-dashoffset", String(RING * (1 - (ratio ?? 0.25))));
    const element = svg(
      "svg",
      {
        class: ratio === null ? "ring indeterminate" : "ring",
        viewBox: "0 0 24 24",
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
      },
      svg("circle", { class: "track", cx: "12", cy: "12", r: "9" }),
      value,
    );
    if (ratio !== null) element.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    return element;
  }

  /** Что показать у набора: ключ состояния и элементы */
  function view(row, pack) {
    const run = (name) => () => command(name, row.id);
    if (pack.builtin) {
      return ["builtin", [label(text.builtin, text.builtinHint)]];
    }
    const job = pack.download;
    if (job) {
      const percent = job.total ? Math.min(100, Math.floor((job.received / job.total) * 100)) : null;
      const hint = job.total ? text.progress(formatSize(job.received), formatSize(job.total)) : "";
      const status = label(percent === null ? formatSize(job.received) : `${percent}%`, hint);
      return [
        `download:${percent ?? job.received}`,
        [ring(job.received, job.total), status, button("close", text.cancel, run("emoji_pack_cancel"))],
      ];
    }
    if (pack.installed) {
      const size = formatSize(pack.size ?? 0);
      return [
        "installed",
        [label(text.installed, text.installedHint(size)), button("delete", text.remove, run("emoji_pack_delete"))],
      ];
    }
    if (!overview.supported) {
      return ["unsupported", []];
    }
    if (pack.error) {
      const reason = failureText(pack.error);
      return [
        `error:${reason}`,
        [label(text.failed, reason, true), button("refresh", `${text.retry}: ${reason}`, run("emoji_pack_download"), true)],
      ];
    }
    const size = pack.size ? formatSize(pack.size) : "";
    return [
      `available:${size}`,
      [label(size, text.availableHint(size)), button("download", text.availableHint(size), run("emoji_pack_download"), true)],
    ];
  }

  function render() {
    if (!overview) return;
    for (const [id, row] of rows) {
      if (!row.host.isConnected) {
        rows.delete(id);
        continue;
      }
      const pack = overview.packs.find((entry) => entry.id === id);
      if (!pack) continue;
      const [state, children] = view(row, pack);
      // перерисовка только при изменении: кнопка под курсором остаётся той же
      if (state === row.state) continue;
      // фокус на кнопке переходит к новой кнопке того же набора
      const focused = row.host.shadowRoot.activeElement !== null;
      row.state = state;
      row.box.replaceChildren(...children);
      if (focused) row.box.querySelector("button")?.focus();
    }
  }

  // ─────────────────────────────── обход ───────────────────────────────
  function scan() {
    const root = document.getElementById("floating");
    if (!root) return;
    const items = [...root.querySelectorAll("mdui-menu-item")];
    const found = items.map((item) => [item, packOf(item)]).filter(([, id]) => id);
    if (found.length !== PACKS.length) return;
    const menu = found[0][0].parentElement;
    if (!found.every(([item]) => item.parentElement === menu)) return;
    if (new Set(found.map(([, id]) => id)).size !== PACKS.length) return;

    let added = false;
    for (const [item, id] of found) {
      if (item.querySelector(":scope > [data-arachnid-emoji-pack]")) continue;
      rows.get(id)?.host.remove();
      rows.set(id, createRow(item, id));
      added = true;
    }
    if (!added) return;
    // шторка открылась: показать, что известно, и спросить свежее
    render();
    refresh();
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

  desktop.subscribe((type) => {
    if (type === "emoji-packs" && rows.size) refresh();
  });

  function start() {
    // шторки for-web открываются только в #floating (index.html)
    const root = document.getElementById("floating") ?? document.body;
    new MutationObserver(queueScan).observe(root, { childList: true, subtree: true });
    queueScan();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
