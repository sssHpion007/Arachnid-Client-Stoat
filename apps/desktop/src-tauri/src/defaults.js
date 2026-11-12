// Значения по умолчанию Arachnid Client для настроек самого веб-клиента.
//
// Набор эмодзи (`appearance:unicode_emoji`) for-web хранит не на сервере, а
// в браузерном хранилище: localforage → IndexedDB `localforage`, хранилище
// `@<id пользователя>`, ключ `settings` (components/state/index.tsx). Его
// значение по умолчанию — fluent-3d, у Arachnid Client — Twemoji.
//
// for-web читает настройки аккаунта один раз — при входе в него (в том числе
// при переключении аккаунтов, без перезагрузки страницы), — а записывает,
// только когда они меняются. Поэтому значение записывается туда же, где его
// хранит for-web, и до того, как он его прочитает:
//
// * аккаунты, у которых уже есть хранилище, — при загрузке страницы. Скрипт
//   выполняется до скриптов страницы, и его запрос открытия базы встаёт в
//   очередь раньше запроса localforage. IndexedDB выполняет открытия по
//   очереди, а транзакции с общим хранилищем — в порядке создания, поэтому
//   for-web читает настройки уже после записи;
// * новый аккаунт (первый вход, добавленный аккаунт) — в момент, когда
//   localforage создаёт его хранилище: в той же транзакции обновления базы,
//   так что for-web сразу читает настройки с Twemoji;
// * Twemoji ставится, только если набор не выбран (нет настроек или нет
//   ключа) или стоит прежний вариант по умолчанию fluent-3d. Отметка
//   `arachnid:defaults:<id>` в localStorage не даёт повторить это: выбранный
//   потом в настройках набор, в том числе fluent-3d, остаётся;
// * базу и хранилища скрипт не создаёт — это делает сам for-web.
//
// Скрипт выполняется после bridge.js и только там, где он создал
// window.__arachnidDesktop (страница веб-клиента из config.toml).
(() => {
  "use strict";

  if (!window.__arachnidDesktop || !window.indexedDB) return;

  /** Версия набора значений: при новых значениях отметка сравнивается с ней */
  const VERSION = 1;
  const DATABASE = "localforage";
  const SETTINGS = "settings";
  const EMOJI_KEY = "appearance:unicode_emoji";
  const EMOJI_PACK = "twemoji";
  /** Значение for-web по умолчанию (Settings.ts) */
  const WEB_DEFAULT_PACK = "fluent-3d";
  /** Хранилище аккаунта: `@` и id пользователя (ULID) */
  const ACCOUNT_STORE = /^@([0-9A-Za-z]+)$/;

  const marker = (userId) => `arachnid:defaults:${userId}`;

  function applied(userId) {
    try {
      return Number(localStorage.getItem(marker(userId))) >= VERSION;
    } catch {
      // без localStorage отметку не поставить — значения не трогаются
      return true;
    }
  }

  function markApplied(userId) {
    try {
      localStorage.setItem(marker(userId), String(VERSION));
    } catch {
      // без отметки значения проверятся при следующем запуске
    }
  }

  /** Настройки с набором эмодзи Arachnid Client или null, если менять нечего */
  function withDefaults(settings) {
    const current = settings && typeof settings === "object" ? settings : {};
    const pack = current[EMOJI_KEY];
    if (pack !== undefined && pack !== WEB_DEFAULT_PACK) return null;
    return { ...current, [EMOJI_KEY]: EMOJI_PACK };
  }

  /** Ошибка записи не должна отменять транзакцию for-web */
  function quiet(request) {
    request.onerror = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
  }

  // ── новые аккаунты ──
  // Хранилище создаётся в транзакции обновления базы, которую открывает
  // localforage; запись в нём завершится вместе с ней, до любого чтения.
  const createObjectStore = IDBDatabase.prototype.createObjectStore;
  IDBDatabase.prototype.createObjectStore = function (name, ...rest) {
    const store = createObjectStore.call(this, name, ...rest);
    const userId = this.name === DATABASE ? ACCOUNT_STORE.exec(String(name))?.[1] : undefined;
    if (userId && store.keyPath === null) {
      try {
        quiet(store.put(withDefaults(null), SETTINGS));
        store.transaction.addEventListener("complete", () => markApplied(userId));
      } catch {
        // хранилище остаётся пустым: for-web возьмёт свои значения
      }
    }
    return store;
  };

  // ── аккаунты, у которых хранилище уже есть ──
  const request = indexedDB.open(DATABASE);
  // базы ещё нет (клиент ни разу не открывался): её создаст сам for-web
  request.onupgradeneeded = () => request.transaction.abort();
  request.onerror = (event) => event.preventDefault();
  request.onsuccess = () => {
    const db = request.result;
    // localforage добавляет хранилища сменой версии — не мешать ей
    db.onversionchange = () => db.close();

    const accounts = [];
    for (const name of db.objectStoreNames) {
      const userId = ACCOUNT_STORE.exec(name)?.[1];
      if (userId && !applied(userId)) accounts.push({ name, userId });
    }
    if (!accounts.length) {
      db.close();
      return;
    }

    const transaction = db.transaction(
      accounts.map((account) => account.name),
      "readwrite",
    );
    for (const { name } of accounts) {
      const store = transaction.objectStore(name);
      const read = store.get(SETTINGS);
      read.onsuccess = () => {
        const next = withDefaults(read.result);
        if (next) quiet(store.put(next, SETTINGS));
      };
      quiet(read);
    }
    transaction.oncomplete = () => {
      db.close();
      for (const { userId } of accounts) markApplied(userId);
    };
    transaction.onabort = () => db.close();
  };
})();
