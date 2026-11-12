// Значения по умолчанию Arachnid Client для настроек самого веб-клиента.
//
// Набор эмодзи (`appearance:unicode_emoji`) for-web хранит не на сервере, а
// в браузерном хранилище: localforage → IndexedDB `localforage`, хранилище
// `@<id пользователя>`, ключ `settings` (components/state/index.tsx). Его
// значение по умолчанию — fluent-3d, у Arachnid Client — Twemoji.
//
// Значение записывается туда же, где его хранит for-web, один раз на
// пользователя и до того, как for-web прочитает настройки:
//
// * скрипт выполняется до скриптов страницы, и его запрос открытия базы
//   встаёт в очередь раньше запроса localforage. IndexedDB выполняет
//   открытия по очереди, а транзакции с общим хранилищем — в порядке
//   создания, поэтому for-web читает настройки уже после записи;
// * Twemoji ставится, только если набор не выбран (нет настроек или нет
//   ключа) или стоит прежний вариант по умолчанию fluent-3d. Отметка
//   `arachnid:defaults:<id>` в localStorage не даёт повторить это: выбранный
//   потом в настройках набор, в том числе fluent-3d, остаётся;
// * базу и хранилище скрипт не создаёт. Хранилище пользователя появляется
//   при первом входе в аккаунт — тогда Twemoji включится со следующего
//   запуска клиента.
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

  /** Пользователь текущей сессии — из копии `auth`, которую for-web держит в localStorage */
  function currentUser() {
    try {
      const auth = JSON.parse(localStorage.getItem("auth") ?? "null");
      const id = auth?.session?.userId;
      return typeof id === "string" && id ? id : null;
    } catch {
      return null;
    }
  }

  const userId = currentUser();
  if (!userId) return;
  const marker = `arachnid:defaults:${userId}`;
  try {
    if (Number(localStorage.getItem(marker)) >= VERSION) return;
  } catch {
    return;
  }

  /** Настройки с набором эмодзи Arachnid Client или null, если менять нечего */
  function withDefaults(settings) {
    const current = settings && typeof settings === "object" ? settings : {};
    const pack = current[EMOJI_KEY];
    if (pack !== undefined && pack !== WEB_DEFAULT_PACK) return null;
    return { ...current, [EMOJI_KEY]: EMOJI_PACK };
  }

  const request = indexedDB.open(DATABASE);
  // базы ещё нет (клиент ни разу не открывался): её создаст сам for-web
  request.onupgradeneeded = () => request.transaction.abort();
  request.onerror = (event) => event.preventDefault();
  request.onsuccess = () => {
    const db = request.result;
    // localforage добавляет хранилища сменой версии — не мешать ей
    db.onversionchange = () => db.close();
    const storeName = `@${userId}`;
    if (!db.objectStoreNames.contains(storeName)) {
      db.close();
      return;
    }

    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const read = store.get(SETTINGS);
    read.onsuccess = () => {
      const next = withDefaults(read.result);
      if (next) store.put(next, SETTINGS);
    };
    transaction.oncomplete = () => {
      db.close();
      try {
        localStorage.setItem(marker, String(VERSION));
      } catch {
        // без отметки значения проверятся при следующем запуске
      }
    };
    transaction.onabort = () => db.close();
  };
})();
