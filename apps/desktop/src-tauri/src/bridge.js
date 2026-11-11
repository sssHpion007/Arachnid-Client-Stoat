// Мост веб-клиента Stoat (for-web) к оболочке.
//
// for-web сам умеет работать внутри настольного приложения: если есть
// `window.native` и `window.desktopConfig`, он показывает свою рамку окна,
// раздел настроек «ПК» и версии оболочки. Официальный Stoat for Desktop
// (Electron) отдаёт их из preload-скрипта (`src/world/window.ts`,
// `src/world/config.ts`); здесь тот же договор поверх команд Tauri.
//
// Скрипт выполняется до скриптов страницы при каждой загрузке. Значения
// трёх констант ниже Rust подставляет при создании окна (desktop.rs).
(() => {
  "use strict";

  /** Origin веб-клиента из config.toml */
  const appOrigin = __ARACHNID_ORIGIN__;
  /** Настройки «ПК» на момент создания окна (`DesktopConfig`) */
  const initialConfig = __ARACHNID_CONFIG__;
  /** `{ desktop, tauri, webview, os, platform }` */
  const versions = __ARACHNID_VERSIONS__;

  const internals = window.__TAURI_INTERNALS__;
  // только сам веб-клиент: другие страницы окно и так не открывает
  if (!internals || location.origin !== appOrigin || window.native) return;

  const invoke = (command, args) => internals.invoke(command, args);

  // ───────────────────────────── настройки ─────────────────────────────
  // desktopConfig.get() синхронный: for-web читает его при отрисовке.
  // Скрипт после перезагрузки страницы получает те же данные, что и при
  // создании окна, поэтому последнее состояние хранится в sessionStorage
  // вкладки: оно переживает перезагрузку, но не перезапуск клиента.
  const STORAGE_KEY = "arachnid:desktop-config";
  let config = initialConfig;
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) config = { ...initialConfig, ...JSON.parse(saved) };
  } catch {
    // хранилище недоступно — остаются данные из Rust
  }

  function replaceConfig(next) {
    config = next;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      // не критично: после перезагрузки возьмутся данные из Rust
    }
    applySpellcheck();
  }

  // ───────────────────────── проверка орфографии ─────────────────────────
  // У WebView2 нет переключателя проверки орфографии (в Electron это
  // session.setSpellCheckerEnabled), поэтому выключенная настройка
  // применяется через атрибут spellcheck: поле ввода for-web просит проверку
  // явно (`spellcheck: "true"` в TextEditor2), и отменить её можно только у
  // самих полей. Исходные значения запоминаются, чтобы вернуть их при
  // включении без перезагрузки.
  const EDITABLE = "textarea, input, [contenteditable]:not([contenteditable='false'])";
  const original = new Map();
  let observer = null;

  function suppress(element) {
    if (element.getAttribute("spellcheck") === "false") return;
    if (!original.has(element)) original.set(element, element.getAttribute("spellcheck"));
    element.setAttribute("spellcheck", "false");
  }

  function suppressWithin(root) {
    if (root.matches(EDITABLE)) suppress(root);
    for (const element of root.querySelectorAll(EDITABLE)) suppress(element);
  }

  function restore() {
    for (const [element, value] of original) {
      if (!element.isConnected) continue;
      if (value === null) element.removeAttribute("spellcheck");
      else element.setAttribute("spellcheck", value);
    }
    original.clear();
  }

  function startSuppressing() {
    if (observer) return;
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          // страница могла снова включить проверку у поля
          if (record.target.matches(EDITABLE)) suppress(record.target);
        } else {
          for (const node of record.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) suppressWithin(node);
          }
        }
      }
      // удалённые поля больше не нужно возвращать
      for (const element of original.keys()) if (!element.isConnected) original.delete(element);
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["spellcheck", "contenteditable"],
    });
    suppressWithin(document.documentElement);
  }

  function applySpellcheck() {
    if (config.spellchecker) {
      observer?.disconnect();
      observer = null;
      restore();
    } else if (document.documentElement) {
      startSuppressing();
    } else {
      document.addEventListener("readystatechange", applySpellcheck, { once: true });
    }
  }

  // ───────────────────────────── window.native ─────────────────────────────
  // Выбор экрана для демонстрации (onceScreenPicker) не передаётся: for-web
  // проверяет его наличие, и без него WebView2 показывает системный выбор.
  window.native = Object.freeze({
    versions: Object.freeze({
      // for-web выводит их через запятую под версией оболочки
      electron: () => `Tauri ${versions.tauri}`,
      node: () => versions.os,
      chrome: () => `WebView ${versions.webview}`,
      desktop: () => versions.desktop,
    }),
    minimise: () => void invoke("native_minimise"),
    maximise: () => void invoke("native_maximise"),
    close: () => void invoke("native_close"),
  });

  // ─────────────────────────── window.desktopConfig ───────────────────────────
  window.desktopConfig = Object.freeze({
    get: () => config,
    set(patch) {
      replaceConfig({ ...config, ...patch });
      void invoke("desktop_config_set", { patch });
    },
    getAutostart: () => invoke("desktop_autostart_get"),
    setAutostart: (value) => invoke("desktop_autostart_set", { value: Boolean(value) }),
  });

  // Rust сообщает об изменениях, сделанных не со страницы (окно развернули
  // кнопкой системы, перетаскиванием к краю экрана и т. п.).
  Object.defineProperty(window, "__arachnidDesktop", {
    value: Object.freeze({ update: replaceConfig }),
  });

  applySpellcheck();

  // ───────────────────────────── меню трея ─────────────────────────────
  // Подписи как в Stoat for Desktop; на русской системе — по-русски.
  const russian = /^ru\b/i.test(navigator.language || "");
  void invoke("set_tray_labels", {
    labels: russian
      ? { version: "Версия", show: "Показать приложение", hide: "Скрыть приложение", quit: "Выйти из приложения" }
      : { version: "Version", show: "Show App", hide: "Hide App", quit: "Quit App" },
  });

  // ───────────────────────── перетаскивание окна ─────────────────────────
  // Рамка for-web помечает области стилем `-webkit-app-region: drag`, как в
  // Electron. WebView2 понимает его сам (области заголовка окна); на других
  // системах окно перетаскивается по нажатию в такой области.
  if (versions.platform === "windows") return;

  function appRegion(target) {
    let node = target instanceof Element ? target : target?.parentElement;
    for (; node; node = node.parentElement) {
      const value =
        node.style.getPropertyValue("-webkit-app-region") ||
        getComputedStyle(node).getPropertyValue("-webkit-app-region");
      if (value === "drag" || value === "no-drag") return value;
    }
    return null;
  }

  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || appRegion(event.target) !== "drag") return;
    event.preventDefault();
    if (event.detail === 2) void invoke("native_maximise");
    else void invoke("plugin:window|start_dragging");
  });
})();
