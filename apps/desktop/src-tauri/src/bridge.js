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

  // ─────────────────────────── темы и QuickCSS ───────────────────────────
  // Темы из папки themes/ и quickcss.css (extensions.rs): по элементу <style>
  // на каждую, в конце документа, чтобы перекрывать стили клиента. Через
  // элементы, а не adoptedStyleSheets: так их видно в инструментах
  // разработчика, как у Avia Client.
  const styleNodes = new Map();
  let stylesPushed = false;

  function mountStyles() {
    const root = document.documentElement;
    if (!root) return;
    // appendChild переносит уже вставленный элемент в конец
    for (const node of styleNodes.values()) root.appendChild(node);
  }

  function setStyles(styles) {
    const next = new Map();
    for (const { id, css } of styles) {
      let node = styleNodes.get(id);
      if (!node) {
        node = document.createElement("style");
        node.dataset.arachnidStyle = id;
      }
      if (node.textContent !== css) node.textContent = css;
      next.set(id, node);
    }
    for (const [id, node] of styleNodes) if (!next.has(id)) node.remove();
    styleNodes.clear();
    for (const [id, node] of next) styleNodes.set(id, node);
    mountStyles();
  }

  // стили нужны до первой отрисовки клиента; <head> и <body> парсер
  // добавит позже, поэтому после разбора документа стили снова в конец
  void invoke("extensions_styles").then(
    (styles) => {
      if (!stylesPushed) setStyles(styles);
    },
    () => {},
  );
  document.addEventListener("DOMContentLoaded", mountStyles, { once: true });

  // ─────────────────────────────── события ───────────────────────────────
  // Раздел «Плагины» и выбор темы (settings.js) узнают отсюда, что темы,
  // плагины или пункты AviaMenu изменились.
  const listeners = new Set();

  function emit(type) {
    for (const listener of listeners) {
      try {
        listener(type);
      } catch (error) {
        console.error("[Arachnid]", error);
      }
    }
  }

  // ───────────────────────── меню плагинов (AviaMenu) ─────────────────────────
  // Плагины Avia Client добавляют свои пункты (ключ API, звуки, переключатели)
  // через window.AviaMenu (avia_core/menu.js). Здесь тот же объект с теми же
  // проверками; пункты показываются в разделе «Плагины» и в меню трея
  // («Действия плагинов»): Rust получает их список, а при выборе пункта
  // вызывает runMenuItem.
  const menuHandlers = new Map(); // id действия → onClick
  const menuActions = []; // AviaMenu.register: { id, name }
  const menuGroups = []; // AviaMenu.submenuregister: { id, name, items: [{ id, name }] }
  let menuSyncQueued = false;

  /** Копия пунктов: сначала действия, затем группы, как в меню Avia */
  function menuEntries() {
    return [
      ...menuActions.map(({ id, name }) => ({ id, name })),
      ...menuGroups.map(({ id, name, items }) => ({
        id,
        name,
        items: items.map((item) => ({ id: item.id, name: item.name })),
      })),
    ];
  }

  function syncMenu() {
    if (menuSyncQueued) return;
    menuSyncQueued = true;
    // плагин обычно регистрирует несколько пунктов подряд: отправляем один раз
    setTimeout(() => {
      menuSyncQueued = false;
      void invoke("set_plugin_menu", { entries: menuEntries() });
      emit("menu");
    }, 0);
  }

  const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
  const menuIdTaken = (id) => menuHandlers.has(id) || menuGroups.some((group) => group.id === id);
  const menuError = (method, message, item) => console.error(`[AviaMenu] ${method}: ${message}`, item);

  const AviaMenu = Object.freeze({
    register(item) {
      if (!item || typeof item !== "object") return menuError("register", "item must be an object", item);
      if (!nonEmpty(item.id)) return menuError("register", "item.id must be a non-empty string", item);
      if (!nonEmpty(item.name)) return menuError("register", "item.name must be a non-empty string", item);
      if (typeof item.onClick !== "function") return menuError("register", "item.onClick must be a function", item);
      const id = item.id.trim();
      if (menuIdTaken(id)) return menuError("register", `id '${id}' is already registered`, item);
      menuActions.push({ id, name: item.name });
      menuHandlers.set(id, item.onClick);
      syncMenu();
    },
    submenuregister(item) {
      if (!item || typeof item !== "object") return menuError("submenuregister", "item must be an object", item);
      if (!nonEmpty(item.id)) return menuError("submenuregister", "item.id must be a non-empty string", item);
      if (!nonEmpty(item.name)) return menuError("submenuregister", "item.name must be a non-empty string", item);
      const id = item.id.trim();
      if (menuIdTaken(id)) return menuError("submenuregister", `id '${id}' is already registered`, item);
      menuGroups.push({ id, name: item.name, items: [] });
      syncMenu();
    },
    submenu(item) {
      if (!item || typeof item !== "object") return menuError("submenu", "item must be an object", item);
      if (!nonEmpty(item.parent)) return menuError("submenu", "item.parent must be a non-empty string", item);
      if (!nonEmpty(item.id)) return menuError("submenu", "item.id must be a non-empty string", item);
      if (!nonEmpty(item.name)) return menuError("submenu", "item.name must be a non-empty string", item);
      if (typeof item.onClick !== "function") return menuError("submenu", "item.onClick must be a function", item);
      const group = menuGroups.find((entry) => entry.id === item.parent.trim());
      if (!group) return menuError("submenu", `no submenuregister found with id '${item.parent.trim()}'`, item);
      const id = item.id.trim();
      if (menuIdTaken(id)) return menuError("submenu", `id '${id}' is already registered`, item);
      group.items.push({ id, name: item.name });
      menuHandlers.set(id, item.onClick);
      syncMenu();
    },
    updatesubmenu(item) {
      if (!item || typeof item !== "object") return menuError("updatesubmenu", "item must be an object", item);
      if (!nonEmpty(item.parent)) return menuError("updatesubmenu", "item.parent must be a non-empty string", item);
      if (!nonEmpty(item.id)) return menuError("updatesubmenu", "item.id must be a non-empty string", item);
      const group = menuGroups.find((entry) => entry.id === item.parent.trim());
      const entry = group?.items.find((child) => child.id === item.id.trim());
      if (!entry) return menuError("updatesubmenu", `no submenu item found with id '${item.id.trim()}'`, item);
      if (nonEmpty(item.text)) entry.name = item.text.trim();
      syncMenu();
    },
    unregister(item) {
      if (!item || !nonEmpty(item.id)) return menuError("unregister", "item.id must be a non-empty string", item);
      const id = item.id.trim();
      const action = menuActions.findIndex((entry) => entry.id === id);
      const group = menuGroups.findIndex((entry) => entry.id === id);
      if (action !== -1) {
        menuActions.splice(action, 1);
        menuHandlers.delete(id);
      } else if (group !== -1) {
        for (const child of menuGroups[group].items) menuHandlers.delete(child.id);
        menuGroups.splice(group, 1);
      } else {
        const parent = menuGroups.findIndex((entry) => entry.items.some((child) => child.id === id));
        if (parent === -1) return;
        const items = menuGroups[parent].items;
        items.splice(items.findIndex((child) => child.id === id), 1);
        menuHandlers.delete(id);
        // как у Avia: группа без пунктов исчезает
        if (items.length === 0) menuGroups.splice(parent, 1);
      }
      syncMenu();
    },
  });
  Object.defineProperty(window, "AviaMenu", { value: AviaMenu });

  function runMenuItem(id) {
    const handler = menuHandlers.get(id);
    if (!handler) return;
    try {
      handler();
    } catch (error) {
      console.error(`[AviaMenu] ${id}:`, error);
    }
  }

  // меню от прошлой загрузки страницы больше не действует
  syncMenu();

  // ───────────────────────────── API плагинов ─────────────────────────────
  // Плагин-папка (plugins/<id>/plugin.toml) выполняется как тело функции с
  // объектом `plugin` (extensions.rs, folder_plugin_script): хранилище,
  // настройки из раздела «Плагины», файлы своей папки, запросы к адресам из
  // [permissions] network и нативный модуль WebAssembly. Права проверяет
  // Rust; здесь — только удобная обёртка над командами. Описание для
  // авторов — docs/extensions.md.
  const pluginSettings = new Map(); // id → { values, listeners }

  /** Ошибка команды ({ kind, message }) — как обычная ошибка JavaScript */
  const pluginError = (error) => {
    const wrapped = new Error(typeof error?.message === "string" ? error.message : String(error));
    if (typeof error?.kind === "string") wrapped.kind = error.kind;
    return wrapped;
  };

  /** Путь внутри папки плагина — частями, как в адресе */
  const assetPath = (path) =>
    String(path)
      .split("/")
      .filter((part) => part !== "" && part !== ".")
      .map(encodeURIComponent)
      .join("/");

  function pluginApi(info) {
    const id = info.id;
    const state = { values: Object.freeze({ ...info.settings }), listeners: new Set() };
    pluginSettings.set(id, state);
    const call = (command, args) =>
      invoke(command, { plugin: id, ...args }).catch((error) => {
        throw pluginError(error);
      });
    return Object.freeze({
      id,
      apiVersion: info.apiVersion,
      manifest: Object.freeze({
        name: info.name,
        version: info.version,
        author: info.author,
        description: info.description,
      }),
      /** Значения настроек из plugin.toml: флажок — boolean, число — number */
      get settings() {
        return state.values;
      },
      onSettingsChange(listener) {
        if (typeof listener !== "function") throw new TypeError("listener must be a function");
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      storage: Object.freeze({
        get: (key) => call("plugin_storage_get", { key: String(key) }),
        // null удаляет ключ, как и delete
        set: (key, value) => call("plugin_storage_set", { key: String(key), value: value ?? null }),
        delete: (key) => call("plugin_storage_set", { key: String(key), value: null }),
      }),
      /** Адрес файла из папки плагина (картинки, звуки, шрифты) */
      asset: (path) => info.assetBase + assetPath(path),
      /** Адреса, к которым пользователь разрешил запросы */
      network: Object.freeze([...info.network]),
      fetch(url, options = {}) {
        const request = {
          url: String(url),
          method: options.method,
          // Headers, массив пар или объект — одним объектом
          headers: Object.fromEntries(new Headers(options.headers ?? {})),
          body: options.body ?? undefined,
          responseType: options.responseType ?? "text",
        };
        return call("plugin_fetch", { request });
      },
      native: Object.freeze({
        available: Boolean(info.native),
        call: (name, input = null) => call("plugin_native_call", { function: String(name), input }),
      }),
    });
  }

  function pluginSettingsChanged(id, values) {
    const state = pluginSettings.get(id);
    if (!state) return;
    state.values = Object.freeze({ ...values });
    for (const listener of state.listeners) {
      try {
        listener(state.values);
      } catch (error) {
        console.error(`[${id}]`, error);
      }
    }
  }

  // Rust сообщает об изменениях, сделанных не со страницы: окно развернули
  // кнопкой системы или перетаскиванием к краю экрана, сохранили тему,
  // выбрали тему или плагин в трее. settings.js подписывается на события.
  Object.defineProperty(window, "__arachnidDesktop", {
    value: Object.freeze({
      update: replaceConfig,
      setStyles(styles) {
        stylesPushed = true;
        setStyles(styles);
      },
      runMenuItem,
      pluginMenu: menuEntries,
      // объект `plugin` для плагина-папки и новые значения его настроек
      plugin: pluginApi,
      pluginSettingsChanged,
      extensionsChanged: () => emit("extensions"),
      // quickcss.css изменили в другой программе / «Изменить QuickCSS» в трее
      quickCssChanged: () => emit("quickcss"),
      openQuickCss: () => emit("open-quickcss"),
      // скачивание, удаление и ход загрузки наборов эмодзи (emoji_packs.rs)
      emojiPacksChanged: () => emit("emoji-packs"),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
  });

  applySpellcheck();

  // ───────────────────────────── имя сессии ─────────────────────────────
  // for-web называет сессию при входе сам — «Stoat for Web (edge-chromium on
  // Windows 10)» (Controller.ts): это поле friendly_name запроса
  // POST /auth/session/login (и его повтора с кодом MFA). Под этим именем
  // сессия и видна в «Сессиях» Stoat. Мост ставит в этом поле «Arachnid
  // Client», поэтому сессия сразу создаётся с нужным именем. Запрос уходит
  // через fetch (stoat-api), поэтому мост, который выполняется раньше
  // скриптов страницы, оборачивает fetch; остальные запросы проходят как
  // есть. Имя, которое задано не for-web, не меняется.
  const SESSION_NAME = "Arachnid Client";
  const GENERATED_NAME = /^(Stoat|Revolt) for Web\b/;
  const LOGIN_PATH = /\/auth\/session\/login$/;
  const pageFetch = window.fetch;

  /** Параметры запроса входа с именем сессии; другие запросы — те же */
  function namedLogin(input, init) {
    if (typeof init?.body !== "string" || String(init.method ?? "GET").toUpperCase() !== "POST") return init;
    let url;
    try {
      url = new URL(input instanceof Request ? input.url : String(input), location.href);
    } catch {
      return init;
    }
    if (!LOGIN_PATH.test(url.pathname)) return init;
    let data;
    try {
      data = JSON.parse(init.body);
    } catch {
      return init;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) return init;
    const name = data.friendly_name;
    if (typeof name === "string" && !GENERATED_NAME.test(name)) return init;
    return { ...init, body: JSON.stringify({ ...data, friendly_name: SESSION_NAME }) };
  }

  if (typeof pageFetch === "function") {
    window.fetch = function fetch(input, init) {
      const args = arguments.length > 1 ? [input, namedLogin(input, init)] : [input];
      return Reflect.apply(pageFetch, window, args);
    };
  }

  // ───────────────────────────── меню трея ─────────────────────────────
  // Подписи как в Stoat for Desktop; на русской системе — по-русски.
  const russian = /^ru\b/i.test(navigator.language || "");
  void invoke("set_tray_labels", {
    labels: russian
      ? {
          version: "Версия",
          show: "Показать приложение",
          hide: "Скрыть приложение",
          quit: "Выйти из приложения",
          extensions: "Расширения",
          themes: "Темы",
          plugins: "Плагины",
          defaultTheme: "Stoat (по умолчанию)",
          noPlugins: "Плагинов нет",
          openFolder: "Открыть папку",
          quickCss: "Изменить QuickCSS",
          pluginActions: "Действия плагинов",
        }
      : {
          version: "Version",
          show: "Show App",
          hide: "Hide App",
          quit: "Quit App",
          extensions: "Extensions",
          themes: "Themes",
          plugins: "Plugins",
          defaultTheme: "Stoat (default)",
          noPlugins: "No plugins",
          openFolder: "Open Folder",
          quickCss: "Edit QuickCSS",
          pluginActions: "Plugin Actions",
        },
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
