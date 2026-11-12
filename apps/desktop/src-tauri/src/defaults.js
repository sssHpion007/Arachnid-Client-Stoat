// Значения по умолчанию Arachnid Client для настроек самого веб-клиента.
//
// Набор эмодзи (`appearance:unicode_emoji`) for-web хранит не на сервере, а
// в браузерном хранилище localforage — IndexedDB `localforage`, ключ
// `settings`. Его значение по умолчанию — fluent-3d, у Arachnid Client —
// Twemoji. Хранилище (object store) зависит от версии for-web:
//
// * `keyvaluepairs` — хранилище localforage по умолчанию, одно на все данные.
//   Так хранят выпущенные версии for-web (stoat-for-web-v0.16.x — то, что
//   открывается на stoat.chat/app; components/state/index.tsx);
// * `@<id пользователя>` — по хранилищу на аккаунт; так хранит for-web после
//   переключения аккаунтов (da8dd844, «Multi-user account switching»), ещё
//   не выпущенного.
//
// Скрипт поддерживает обе: что из них есть у открытого инстанса, то и
// обрабатывается.
//
// for-web читает настройки один раз — при загрузке страницы (и при
// переключении аккаунта), — а записывает, только когда они меняются. Поэтому
// значение записывается туда же, где его хранит for-web, и до того, как он
// его прочитает:
//
// * в хранилища, которые уже есть, — при загрузке страницы. Скрипт
//   выполняется до скриптов страницы, и его запрос открытия базы встаёт в
//   очередь раньше запроса localforage. IndexedDB выполняет открытия по
//   очереди, а транзакции с общим хранилищем — в порядке создания, поэтому
//   for-web читает настройки уже после записи;
// * в новое хранилище (первый запуск, новый аккаунт) — в момент, когда
//   localforage его создаёт: в той же транзакции обновления базы, так что
//   for-web сразу читает настройки с Twemoji;
// * Twemoji ставится, только если набор не выбран (нет настроек или нет
//   ключа) или стоит значение for-web по умолчанию fluent-3d. Отметка
//   `arachnid:defaults:<хранилище>` в localStorage не даёт повторить это:
//   выбранный потом в настройках набор, в том числе fluent-3d, остаётся;
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
  /**
   * Хранилища настроек for-web: общее хранилище localforage (выпущенные
   * версии) или хранилище аккаунта — `@` и id пользователя (ULID)
   */
  const SETTINGS_STORE = /^(?:keyvaluepairs|@[0-9A-Za-z]+)$/;

  const marker = (store) => `arachnid:defaults:${store}`;

  function applied(store) {
    try {
      return Number(localStorage.getItem(marker(store))) >= VERSION;
    } catch {
      // без localStorage отметку не поставить — значения не трогаются
      return true;
    }
  }

  function markApplied(store) {
    try {
      localStorage.setItem(marker(store), String(VERSION));
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

  // ── новые хранилища ──
  // Хранилище создаётся в транзакции обновления базы, которую открывает
  // localforage; запись в нём завершится вместе с ней, до любого чтения.
  const createObjectStore = IDBDatabase.prototype.createObjectStore;
  IDBDatabase.prototype.createObjectStore = function (name, ...rest) {
    const store = createObjectStore.call(this, name, ...rest);
    const storeName = String(name);
    if (this.name === DATABASE && SETTINGS_STORE.test(storeName) && store.keyPath === null) {
      try {
        quiet(store.put(withDefaults(null), SETTINGS));
        store.transaction.addEventListener("complete", () => markApplied(storeName));
      } catch {
        // хранилище остаётся пустым: for-web возьмёт свои значения
      }
    }
    return store;
  };

  // ── хранилища, которые уже есть ──
  const request = indexedDB.open(DATABASE);
  // базы ещё нет (клиент ни разу не открывался): её создаст сам for-web
  request.onupgradeneeded = () => request.transaction.abort();
  request.onerror = (event) => event.preventDefault();
  request.onsuccess = () => {
    const db = request.result;
    // localforage добавляет хранилища сменой версии — не мешать ей
    db.onversionchange = () => db.close();

    const stores = [...db.objectStoreNames].filter(
      (name) => SETTINGS_STORE.test(name) && !applied(name),
    );
    if (!stores.length) {
      db.close();
      return;
    }

    const transaction = db.transaction(stores, "readwrite");
    for (const name of stores) {
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
      for (const name of stores) markApplied(name);
    };
    transaction.onabort = () => db.close();
  };
})();
