// Надёжная загрузка истории чата: часть встроенного плагина «Quality of
// Life» (выполняется вместе с emoji.js, gifs.js и hotkeys.js), настройка
// `history`.
//
// for-web подгружает историю запросом GET /channels/<id>/messages
// (stoat-api, через fetch) и, пока запрос не завершился, больше ничего не
// подгружает: заглушки над и под сообщениями ждут его конца. У этого
// запроса нет тайм-аута — повисший запрос (обрыв связи, сон компьютера,
// смена сети) останавливает подгрузку навсегда, до перехода в другой канал.
// А отказ сервера for-web сразу повторяет, пока заглушка видна, и при
// ограничении частоты запросов (429) получает отказ за отказом.
//
// Эта часть оборачивает fetch и доводит такие запросы до ответа сама; for-web
// получает ответ немного позже и ничего не замечает:
//
// * запрос вместе с телом ответа не дольше RESPONSE_TIMEOUT_MS — иначе он
//   отменяется и повторяется; так же повторяются ошибки сети и ответы
//   502/503/504 — через RETRY_DELAYS_MS, потом for-web получает ошибку;
// * ограничение частоты у Stoat — на канал (корзина `channels/<id>`, общая с
//   отметкой прочтения и другими запросами канала). Ответ 429 говорит, через
//   сколько миллисекунд корзина освободится (`X-RateLimit-Reset-After`, в
//   теле — `retry_after`): запрос ждёт и повторяется. Отклонённые запросы
//   корзину не расходуют. Если ответ сообщил, что запросов не осталось
//   (`X-RateLimit-Remaining: 0`), следующие запросы истории канала ждут
//   освобождения сразу, не получая отказа.
//
// Остальные запросы проходят как есть; запрос со своим AbortSignal — тоже:
// его отменяет тот, кто отправил. Выключенная настройка действует на
// следующие запросы.
(() => {
  "use strict";

  const pageFetch = window.fetch;
  if (typeof pageFetch !== "function") return;

  /** Запрос истории: …/channels/<id>/messages (адрес API может быть с путём) */
  const HISTORY_PATH = /\/channels\/([0-9A-Za-z]+)\/messages$/;
  /** Сколько ждать ответа вместе с телом */
  const RESPONSE_TIMEOUT_MS = 15000;
  /** Паузы перед повторами после тайм-аута, ошибки сети или 502/503/504 */
  const RETRY_DELAYS_MS = [1000, 3000, 10000];
  /** Ответы, которые стоит повторить: сервер или шлюз временно недоступны */
  const RETRY_STATUSES = new Set([502, 503, 504]);
  /** Сколько раз подряд ждать освобождения корзины после 429 */
  const RATE_LIMIT_RETRIES = 5;
  /** Ожидание корзины, если сервер не сказал сколько, и предел ожидания */
  const RATE_LIMIT_DEFAULT_MS = 1000;
  const RATE_LIMIT_MAX_MS = 60000;
  /** Ответы без тела: Response с телом для них не создаётся */
  const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

  let active = plugin.settings.history !== false;
  /** Канал → когда (Date.now) его корзина освободится */
  const blockedUntil = new Map();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Канал запроса истории, который можно доводить; иначе null */
  function historyChannel(input, init) {
    // stoat-api передаёт адрес строкой и свои параметры, без AbortSignal
    if (typeof input !== "string" && !(input instanceof URL)) return null;
    if (init?.signal) return null;
    if (String(init?.method ?? "GET").toUpperCase() !== "GET") return null;
    let url;
    try {
      url = new URL(String(input), location.href);
    } catch {
      return null;
    }
    return HISTORY_PATH.exec(url.pathname)?.[1] ?? null;
  }

  /** Через сколько мс освободится корзина — по заголовку или телу ответа 429 */
  function resetDelay(response, body) {
    const header = response.headers.get("X-RateLimit-Reset-After");
    let delay = header === null ? NaN : Number(header);
    if (!Number.isFinite(delay) && response.status === 429) {
      try {
        delay = Number(JSON.parse(new TextDecoder().decode(body)).retry_after);
      } catch {
        delay = NaN;
      }
    }
    return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, RATE_LIMIT_MAX_MS) : null;
  }

  function block(channel, delay) {
    const until = Date.now() + delay;
    if (until > (blockedUntil.get(channel) ?? 0)) blockedUntil.set(channel, until);
  }

  /** Одна попытка: ответ и тело целиком, не дольше RESPONSE_TIMEOUT_MS */
  async function attempt(input, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESPONSE_TIMEOUT_MS);
    try {
      const response = await Reflect.apply(pageFetch, window, [
        input,
        { ...init, signal: controller.signal },
      ]);
      const body = await response.arrayBuffer();
      return { response, body };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ответ для for-web: тело уже прочитано, поэтому Response собирается заново */
  function rebuilt(response, body) {
    return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  async function reliableFetch(channel, input, init) {
    let failures = 0;
    let limited = 0;
    for (;;) {
      const wait = (blockedUntil.get(channel) ?? 0) - Date.now();
      if (wait > 0) await sleep(wait);

      let result;
      try {
        result = await attempt(input, init);
      } catch (error) {
        if (failures >= RETRY_DELAYS_MS.length) throw error;
        console.warn("[Arachnid] история чата: запрос не завершился, повтор", error);
        await sleep(RETRY_DELAYS_MS[failures++]);
        continue;
      }

      const { response, body } = result;
      const delay = resetDelay(response, body);
      if (response.status === 429 && limited < RATE_LIMIT_RETRIES) {
        limited++;
        block(channel, delay ?? RATE_LIMIT_DEFAULT_MS);
        console.warn("[Arachnid] история чата: ограничение частоты запросов, ожидание", delay);
        continue;
      }
      if (response.ok && response.headers.get("X-RateLimit-Remaining") === "0" && delay !== null) {
        block(channel, delay);
      }
      if (RETRY_STATUSES.has(response.status) && failures < RETRY_DELAYS_MS.length) {
        console.warn("[Arachnid] история чата: сервер недоступен, повтор", response.status);
        await sleep(RETRY_DELAYS_MS[failures++]);
        continue;
      }
      return rebuilt(response, body);
    }
  }

  window.fetch = function fetch(input, init) {
    const channel = active ? historyChannel(input, init) : null;
    if (channel === null) return Reflect.apply(pageFetch, window, arguments);
    return reliableFetch(channel, input, init);
  };

  plugin.onSettingsChange((values) => {
    active = values.history !== false;
  });
})();
