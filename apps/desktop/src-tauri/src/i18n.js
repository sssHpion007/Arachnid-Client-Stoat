// Переводы Arachnid Client: подписи клиента и плагинов на языке интерфейса
// Stoat. Словари — locales/<язык>.json (desktop.rs подставляет их все);
// чего нет в словаре языка, берётся из английского.
//
// Язык интерфейса for-web хранит в IndexedDB (localforage, хранилище
// `@<id пользователя>`, ключ `locale`); пока его нет — первый язык браузера,
// как у for-web. Хранилище перечитывается при возврате в окно, переходах в
// настройках и их закрытии (settings.js): после смены языка подписи
// обновляются без перезагрузки.

(() => {
  "use strict";

  if (window.__arachnidI18n) return;

  /** { "<язык>": { "<раздел>": { ключ: строка | { … } } } } */
  const LOCALES = __ARACHNID_LOCALES__;
  const BASE = "en";
  /** Подстановки `{0}`, `{1}`… */
  const PLACEHOLDERS = /\{(\d+)\}/g;
  const HAS_PLACEHOLDER = /\{\d+\}/;

  /** Строка с подстановками: `{n}` — n-й аргумент */
  const format = (template, args) =>
    String(template).replace(PLACEHOLDERS, (match, index) => (index < args.length ? String(args[index]) : match));

  /**
   * Словарь языка поверх английского. Строки, у которых в английском есть
   * подстановки, становятся функциями: `text.author(name)`.
   */
  function compile(base, own) {
    const result = {};
    for (const [key, value] of Object.entries(base)) {
      const mine = own?.[key];
      if (value && typeof value === "object") {
        result[key] = compile(value, mine && typeof mine === "object" ? mine : undefined);
        continue;
      }
      const text = typeof mine === "string" ? mine : value;
      result[key] = HAS_PLACEHOLDER.test(value) ? (...args) => format(text, args) : text;
    }
    return Object.freeze(result);
  }

  const compiled = new Map();
  function dictionary(code) {
    if (!compiled.has(code)) compiled.set(code, compile(LOCALES[BASE], LOCALES[code]));
    return compiled.get(code);
  }

  /** Первый язык браузера — язык for-web, пока в хранилище ничего нет */
  const preferred = () => navigator.languages?.[0] || navigator.language || BASE;

  let language = preferred();

  /**
   * Код из `available`, подходящий к языку `code`: тот же код, иначе тот же
   * язык без региона (`pt-BR` → `pt`); null — подходящего нет.
   */
  function pick(available, code = language) {
    const wanted = String(code ?? "").replace(/_/g, "-").toLowerCase();
    const list = Array.from(available ?? [], String);
    const exact = list.find((candidate) => candidate.toLowerCase() === wanted);
    if (exact) return exact;
    const base = wanted.split("-")[0];
    return list.find((candidate) => candidate.toLowerCase() === base) ?? null;
  }

  /** Язык словаря клиента */
  const locale = () => pick(Object.keys(LOCALES)) ?? BASE;

  /** Язык для Intl (даты, числа): язык интерфейса, если Intl его знает */
  function intl() {
    try {
      if (Intl.DateTimeFormat.supportedLocalesOf([language]).length) return language;
    } catch {
      // шуточные языки for-web (owo, pr…) — не коды BCP 47
    }
    return locale();
  }

  /**
   * Подписи раздела словаря на текущем языке: `text.plugins`,
   * `text.author(name)`. Язык берётся при каждом обращении.
   */
  const text = (section) =>
    new Proxy(Object.create(null), {
      get: (_, key) => (typeof key === "string" ? dictionary(locale())[section]?.[key] : undefined),
    });

  /** Раздел словаря целиком — обычным объектом (для команд Rust) */
  const messages = (section) => dictionary(locale())[section];

  /**
   * Текст ошибки команды: по коду (`{ code, args }`) — из раздела `errors`,
   * без кода или без перевода — сообщение как есть.
   */
  function errorText(error) {
    const code = typeof error?.code === "string" ? error.code : null;
    const template = code ? dictionary(locale()).errors?.[code] : undefined;
    if (typeof template === "function") return template(...(Array.isArray(error.args) ? error.args : []));
    if (typeof template === "string") return template;
    return String(error?.message ?? error ?? "");
  }

  /** Язык интерфейса из хранилища for-web (или null) */
  function storedLanguage() {
    let session = null;
    try {
      session = JSON.parse(localStorage.getItem("auth") ?? "null")?.session ?? null;
    } catch {
      session = null;
    }
    if (typeof session?.userId !== "string" || typeof indexedDB === "undefined") return Promise.resolve(null);
    const storeName = `@${session.userId}`;
    return new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open("localforage");
      } catch {
        resolve(null);
        return;
      }
      // базы ещё нет — не создавать её за for-web
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        const done = (value) => {
          db.close();
          resolve(value);
        };
        if (!db.objectStoreNames.contains(storeName)) {
          done(null);
          return;
        }
        try {
          const get = db.transaction(storeName, "readonly").objectStore(storeName).get("locale");
          get.onsuccess = () => done(typeof get.result?.lang === "string" ? get.result.lang : null);
          get.onerror = () => done(null);
        } catch {
          done(null);
        }
      };
    });
  }

  const listeners = new Set();
  let reading = null;

  /** Перечитать язык интерфейса; если он сменился — сообщить подписчикам */
  function refresh() {
    reading ??= storedLanguage()
      .catch(() => null)
      .then((stored) => {
        const next = stored ?? preferred();
        if (next === language) return language;
        language = next;
        for (const listener of listeners) {
          try {
            listener(language);
          } catch (error) {
            console.error("[Arachnid] смена языка", error);
          }
        }
        return language;
      })
      .finally(() => (reading = null));
    return reading;
  }

  /** Подписаться на смену языка; возвращает отписку */
  function onChange(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  void refresh();
  window.addEventListener("focus", () => void refresh());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });

  Object.defineProperty(window, "__arachnidI18n", {
    value: Object.freeze({
      /** Язык интерфейса Stoat (код for-web или браузера) */
      language: () => language,
      locale,
      intl,
      pick,
      format,
      text,
      messages,
      errorText,
      refresh,
      onChange,
    }),
  });
})();
