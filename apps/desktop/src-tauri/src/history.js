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
// получает ответ позже и ничего не замечает:
//
// * нет ответа за RETRY_MS — тот же запрос отправляется ещё раз, а прежний
//   продолжает ждать: берётся первый ответ, остальные отменяются (ждут
//   одновременно не больше MAX_PARALLEL). Ошибки сети и ответы 502/503/504
//   тоже повторяются через RETRY_MS — пока ответ не придёт или пользователь
//   не уйдёт в другой канал;
// * ограничение частоты у Stoat — на канал (корзина `channels/<id>`, общая с
//   отметкой прочтения и другими запросами канала). Ответ 429 говорит, через
//   сколько миллисекунд корзина освободится (`X-RateLimit-Reset-After`, в
//   теле — `retry_after`): запрос ждёт и повторяется. Отклонённые запросы
//   корзину не расходуют. Если ответ сообщил, что запросов не осталось
//   (`X-RateLimit-Remaining: 0`), следующие запросы истории канала ждут
//   освобождения сразу, не получая отказа;
// * пока запрос открытого канала ждёт дольше NOTICE_DELAY_MS, вверху ленты
//   чата — надпись «Подождите…» (со временем до повтора, если он назначен);
// * подгрузка не застревает. Заглушку for-web замечает наблюдателем
//   пересечений (IntersectionObserver), а он сообщает только о переменах:
//   заглушка уже была видна, когда for-web снова стал готов подгружать
//   (смена канала с восстановлением прокрутки, прокрутка во время запроса),
//   — и подгрузка стоит, пока заглушку не прокрутить из виду и обратно. Если
//   заглушка видна, а запроса нет дольше STUCK_MS, она на кадр сдвигается
//   за край ленты (transform — без перестройки страницы) и возвращается:
//   наблюдатель видит её появление, и for-web подгружает как обычно.
//
// * лента не прыгает при подгрузке. Получив сообщения, for-web добавляет их
//   и, если их в ленте больше 150, убирает лишние с другого конца, а потом
//   возвращает прокрутку на место (scrollTo по сообщению-якорю). Лента for-web
//   отсчитывает прокрутку от низа (column-reverse), поэтому, когда при
//   подгрузке вверх убираются новые сообщения снизу, место прокрутки в
//   пикселях меняется на всю их высоту. Если в этот момент лента ещё едет
//   (плавная прокрутка колесом, инерция тачпада, перетаскивание полосы
//   прокрутки), поправка теряется: лента перелетает вверх на высоту убранного,
//   видит заглушку, подгружает ещё и улетает дальше. for-web ждёт остановки
//   только у прокрутки касанием (ListView2, для iOS); здесь ответ на
//   подгрузку (запрос с before или after) отдаётся for-web, когда лента
//   SCROLL_SETTLE_MS не прокручивалась и кнопка мыши в ней не нажата (не
//   дольше SCROLL_HOLD_MAX_MS). Пока лента стоит, ответ не ждёт. Если лента
//   всё же прыгнула после подгрузки, это записывается в журнал клиента
//   (watchJump).
//
// Остальные запросы проходят как есть; запрос со своим AbortSignal — тоже:
// его отменяет тот, кто отправил. Выключенная настройка действует на
// следующие запросы.
(() => {
  "use strict";

  const pageFetch = window.fetch;
  if (typeof pageFetch !== "function") return;

  const i18n = window.__arachnidI18n;
  const text = i18n.text("history");

  /** Запрос истории: …/channels/<id>/messages (адрес API может быть с путём) */
  const HISTORY_PATH = /\/channels\/([0-9A-Za-z]+)\/messages$/;
  /** Открытый канал — в адресе for-web: …/channel/<id>[/<сообщение>] */
  const CHANNEL_PATH = /\/channel\/([0-9A-Z]{26})(?:\/|$)/;
  /** Id сообщения (ULID) — id корня сообщения в ленте for-web */
  const MESSAGE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
  /** Через сколько мс без ответа отправить запрос ещё раз и пауза перед повтором */
  const RETRY_MS = 5000;
  /** Сколько попыток одного запроса могут ждать ответа одновременно */
  const MAX_PARALLEL = 3;
  /** Ответы, которые стоит повторить: сервер или шлюз временно недоступны */
  const RETRY_STATUSES = new Set([502, 503, 504]);
  /** Ожидание корзины, если сервер не сказал сколько, и предел ожидания */
  const RATE_LIMIT_DEFAULT_MS = 1000;
  const RATE_LIMIT_MAX_MS = 60000;
  /** Ответы без тела: Response с телом для них не создаётся */
  const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
  /** Через сколько мс ожидания показать «Подождите…» */
  const NOTICE_DELAY_MS = 1000;
  /** Как часто проверять надпись и заглушки */
  const TICK_MS = 250;
  /** Сколько заглушка должна быть видна без запроса, чтобы её показать заново */
  const STUCK_MS = 1000;
  /** Сколько мс лента должна не прокручиваться, чтобы отдать подгрузку */
  const SCROLL_SETTLE_MS = 200;
  /** Дольше этого подгрузка остановки ленты не ждёт */
  const SCROLL_HOLD_MAX_MS = 15000;
  /** Как часто проверять, отпущена ли кнопка мыши */
  const PRESS_POLL_MS = 50;
  /** Сколько мс после отдачи подгрузки следить, не прыгнула ли лента */
  const JUMP_WATCH_MS = 1000;

  let active = plugin.settings.history !== false;
  /** Канал → когда (Date.now) его корзина освободится */
  const blockedUntil = new Map();
  /** Запросы истории, которые ждут ответа: { channel, opened, since, retryAt } */
  const pending = new Set();
  /** Каналы, чья подгрузка пришла и ждёт остановки ленты: канал → сколько */
  const holding = new Map();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const openChannel = () => CHANNEL_PATH.exec(location.pathname)?.[1] ?? null;

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

  /**
   * Попытки одного запроса: первая сразу, следующая — каждые RETRY_MS без
   * ответа (прежние ждут дальше, самая старая отменяется сверх MAX_PARALLEL).
   * Итог — первый ответ с телом ({ result }) или ошибка, когда ждать больше
   * некого ({ error }); остальные попытки отменяются.
   */
  function race(input, init) {
    return new Promise((resolve) => {
      const running = new Set();
      let done = false;
      let timer = 0;
      const finish = (outcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const controller of running) controller.abort();
        resolve(outcome);
      };
      const launch = () => {
        if (running.size >= MAX_PARALLEL) {
          const oldest = running.values().next().value;
          running.delete(oldest);
          oldest.abort();
        }
        const controller = new AbortController();
        running.add(controller);
        // мимо HTTP-кэша: иначе Chromium держит одинаковые запросы, пока не
        // ответит первый, и повтор ждёт вместе с повисшим
        const options = { ...init, cache: "no-store", signal: controller.signal };
        Reflect.apply(pageFetch, window, [input, options])
          .then(async (response) => ({ response, body: await response.arrayBuffer() }))
          .then(
            (result) => {
              if (running.delete(controller)) finish({ result });
            },
            (error) => {
              if (running.delete(controller) && running.size === 0) finish({ error });
            },
          );
        timer = setTimeout(launch, RETRY_MS);
      };
      launch();
    });
  }

  /** Ответ для for-web: тело уже прочитано, поэтому Response собирается заново */
  function rebuilt(response, body) {
    return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /** Пауза перед повтором: надпись показывает, сколько осталось */
  async function pause(job, ms) {
    job.retryAt = Date.now() + ms;
    notice.update();
    await sleep(ms);
    job.retryAt = 0;
  }

  /** Пользователь ушёл в другой канал — ответ for-web уже не нужен */
  const abandoned = (job) => openChannel() !== job.opened;

  async function settle(job, input, init) {
    let limited = false;
    for (;;) {
      const wait = (blockedUntil.get(job.channel) ?? 0) - Date.now();
      if (wait > 0) await pause(job, wait);
      if (limited && abandoned(job)) throw new DOMException("канал закрыт", "AbortError");

      const { result, error } = await race(input, init);
      if (!result) {
        console.warn("[Arachnid] история чата: запрос не завершился, повтор", error);
        await pause(job, RETRY_MS);
        if (abandoned(job)) throw error;
        continue;
      }

      const { response, body } = result;
      const delay = resetDelay(response, body);
      if (response.status === 429) {
        limited = true;
        block(job.channel, delay ?? RATE_LIMIT_DEFAULT_MS);
        console.warn("[Arachnid] история чата: ограничение частоты запросов, ожидание", delay);
        continue;
      }
      if (RETRY_STATUSES.has(response.status) && !abandoned(job)) {
        console.warn("[Arachnid] история чата: сервер недоступен, повтор", response.status);
        await pause(job, RETRY_MS);
        if (!abandoned(job)) continue;
      }
      if (response.ok && response.headers.get("X-RateLimit-Remaining") === "0" && delay !== null) {
        block(job.channel, delay);
      }
      return rebuilt(response, body);
    }
  }

  // ───────────────────────── подгрузка без прыжков ─────────────────────────

  /** Когда (performance.now) лента чата прокручивалась последний раз */
  let lastScroll = -Infinity;
  /** Нажата ли кнопка мыши в ленте: тянут полосу прокрутки или выделяют */
  let pressed = false;

  const inChat = (target) => target instanceof Element && target.closest(".app_body main") !== null;

  addEventListener(
    "scroll",
    (event) => {
      if (inChat(event.target)) lastScroll = performance.now();
    },
    { capture: true, passive: true },
  );
  addEventListener(
    "pointerdown",
    (event) => {
      if (event.button === 0 && inChat(event.target)) pressed = true;
    },
    { capture: true, passive: true },
  );
  for (const type of ["pointerup", "pointercancel"]) {
    addEventListener(type, () => (pressed = false), { capture: true, passive: true });
  }
  /** Когда пользователь последний раз крутил колесо, нажимал клавишу или кнопку мыши */
  let lastInput = -Infinity;
  for (const type of ["wheel", "keydown", "pointerdown"]) {
    addEventListener(type, () => (lastInput = performance.now()), { capture: true, passive: true });
  }
  // отпустили кнопку за окном — pointerup мог не прийти
  addEventListener("pointermove", (event) => event.buttons === 0 && (pressed = false), { capture: true, passive: true });
  addEventListener("blur", () => (pressed = false));

  /** Подгрузка к уже показанным сообщениям: запрос с before или after */
  function isPaging(input) {
    try {
      const { searchParams } = new URL(String(input), location.href);
      return searchParams.has("before") || searchParams.has("after");
    } catch {
      return false;
    }
  }

  /** Дождаться, пока лента остановится (см. начало файла) */
  async function untilSettled(job) {
    const started = performance.now();
    for (;;) {
      const now = performance.now();
      if (!active || abandoned(job) || now - started >= SCROLL_HOLD_MAX_MS) return;
      const quiet = now - lastScroll;
      if (!pressed && quiet >= SCROLL_SETTLE_MS) return;
      await sleep(pressed ? PRESS_POLL_MS : Math.max(PRESS_POLL_MS, SCROLL_SETTLE_MS - quiet));
    }
  }

  /** Сообщение ленты ближе всех к её середине или null */
  function middleMessage(scroller) {
    const view = scroller.getBoundingClientRect();
    const middle = view.top + view.height / 2;
    let found = null;
    let best = Infinity;
    for (const element of scroller.querySelectorAll("[id]")) {
      if (!MESSAGE_ID.test(element.id)) continue;
      const box = element.getBoundingClientRect();
      if (box.bottom < view.top || box.top > view.bottom) continue;
      const distance = Math.abs((box.top + box.bottom) / 2 - middle);
      if (distance < best) {
        best = distance;
        found = element;
      }
    }
    return found;
  }

  /**
   * Проверка: подгрузка не сдвинула ленту. for-web добавляет сообщения сразу
   * после ответа и возвращает прокрутку на место — сообщение посередине
   * ленты остаётся где было. Если без колеса, клавиш и щелчков оно за
   * JUMP_WATCH_MS уехало дальше высоты ленты, это прыжок: он попадает в
   * журнал клиента (scroll_report), чтобы было видно, при каких условиях.
   */
  function watchJump(heldMs) {
    const scroller = chatScroller();
    const reference = scroller && middleMessage(scroller);
    if (!reference) return;
    const offset = () => scroller.getBoundingClientRect().top;
    const start = {
      at: performance.now(),
      top: reference.getBoundingClientRect().top - offset(),
      scrollTop: scroller.scrollTop,
      height: scroller.scrollHeight,
    };
    const step = () => {
      const now = performance.now();
      if (now - start.at > JUMP_WATCH_MS || lastInput > start.at || !scroller.isConnected) return;
      // for-web создаёт элементы сообщений заново — искать по id
      const element = document.getElementById(reference.id);
      const shift = element ? element.getBoundingClientRect().top - offset() - start.top : 0;
      if (Math.abs(shift) <= scroller.clientHeight) {
        requestAnimationFrame(step);
        return;
      }
      const detail = JSON.stringify({
        shift: Math.round(shift),
        view: scroller.clientHeight,
        scrollTop: [Math.round(start.scrollTop), Math.round(scroller.scrollTop)],
        scrollHeight: [start.height, scroller.scrollHeight],
        afterMs: Math.round(now - start.at),
        heldMs,
      });
      console.warn("[Arachnid] история чата: лента прыгнула после подгрузки", detail);
      if (window.__arachnidDesktop) {
        void window.__TAURI_INTERNALS__?.invoke("scroll_report", { detail }).catch(() => {});
      }
    };
    requestAnimationFrame(step);
  }

  async function reliableFetch(channel, input, init) {
    const job = { channel, opened: openChannel(), since: Date.now(), retryAt: 0 };
    pending.add(job);
    let response;
    try {
      response = await settle(job, input, init);
    } finally {
      pending.delete(job);
      notice.update();
    }
    if (!isPaging(input)) return response;
    // ответ уже пришёл: «Подождите…» не нужна, а заглушку не показывать заново
    holding.set(channel, (holding.get(channel) ?? 0) + 1);
    const held = performance.now();
    try {
      await untilSettled(job);
    } finally {
      const left = holding.get(channel) - 1;
      if (left > 0) holding.set(channel, left);
      else holding.delete(channel);
    }
    if (!abandoned(job) && job.opened === channel) watchJump(Math.round(performance.now() - held));
    return response;
  }

  window.fetch = function fetch(input, init) {
    const channel = active ? historyChannel(input, init) : null;
    if (channel === null) return Reflect.apply(pageFetch, window, arguments);
    return reliableFetch(channel, input, init);
  };

  // ─────────────────────────── надпись «Подождите…» ───────────────────────────
  // Вверху ленты чата (main for-web), поверх сообщений, как плашка «Новые
  // сообщения»: держатель нулевой высоты, чат не сдвигается. Под плашкой
  // «сейчас играет» плеера, если она есть.

  const STYLE_ID = "arachnid-history-style";
  const STYLE = `
.arachnid-wait-anchor {
  position: relative;
  z-index: 10;
  flex-shrink: 0;
  height: 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.arachnid-wait {
  position: absolute;
  top: var(--gap-md, 8px);
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100% - 16px);
  padding: 8px 16px;
  border-radius: var(--borderRadius-full, 999px);
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.35);
  font-size: 14px;
  line-height: 18px;
  white-space: nowrap;
  animation: arachnid-wait-in 0.2s ease-out;
}
main:has(> .ap-now-anchor) > .arachnid-wait-anchor > .arachnid-wait {
  top: calc(48px + 2 * var(--gap-md, 8px));
}
.arachnid-wait-spinner {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: arachnid-wait-spin 0.8s linear infinite;
}
@keyframes arachnid-wait-spin {
  to {
    transform: rotate(1turn);
  }
}
@keyframes arachnid-wait-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .arachnid-wait,
  .arachnid-wait-spinner {
    animation: none;
  }
}
`;

  const notice = (() => {
    let anchor = null;
    let label = null;

    function element() {
      if (!anchor) {
        if (!document.getElementById(STYLE_ID)) {
          const style = document.createElement("style");
          style.id = STYLE_ID;
          style.textContent = STYLE;
          document.head.append(style);
        }
        anchor = document.createElement("div");
        anchor.className = "arachnid-wait-anchor";
        const pill = document.createElement("div");
        pill.className = "arachnid-wait";
        pill.setAttribute("role", "status");
        const spinner = document.createElement("span");
        spinner.className = "arachnid-wait-spinner";
        label = document.createElement("span");
        pill.append(spinner, label);
        anchor.append(pill);
      }
      return anchor;
    }

    /** Что показать: подпись или null — ничего */
    function message() {
      const channel = openChannel();
      if (!channel) return null;
      const now = Date.now();
      let retryAt = 0;
      let waiting = false;
      for (const job of pending) {
        if (job.channel !== channel) continue;
        if (job.retryAt > now) retryAt = retryAt ? Math.min(retryAt, job.retryAt) : job.retryAt;
        if (now - job.since >= NOTICE_DELAY_MS) waiting = true;
      }
      if (!waiting) return null;
      return retryAt ? text.retry(Math.ceil((retryAt - now) / 1000)) : text.loading;
    }

    function update() {
      const wanted = active ? message() : null;
      const chat = wanted ? document.querySelector(".app_body main") : null;
      if (!chat) {
        anchor?.remove();
        return;
      }
      element();
      if (label.textContent !== wanted) label.textContent = wanted;
      if (chat.firstElementChild !== anchor && anchor.parentElement !== chat) chat.prepend(anchor);
    }

    function remove() {
      anchor?.remove();
      document.getElementById(STYLE_ID)?.remove();
      anchor = null;
      label = null;
    }

    return { update, remove };
  })();

  // ─────────────────────────── застрявшая подгрузка ───────────────────────────
  // Лента for-web (ListView2): прокручиваемый элемент > div > div > [заглушка
  // сверху], список сообщений, [заглушка снизу]. Заглушки — блоки без
  // указателя (pointer-events: none) с мерцающими «сообщениями».

  /** Прокручиваемая лента открытого чата или null */
  function chatScroller() {
    const chat = document.querySelector(".app_body main");
    if (!chat) return null;
    let message = null;
    for (const element of chat.querySelectorAll("[id]")) {
      if (MESSAGE_ID.test(element.id)) {
        message = element;
        break;
      }
    }
    for (let node = message?.parentElement; node && node !== chat; node = node.parentElement) {
      if (/^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) return node;
    }
    return null;
  }

  /** Заглушка, которую видно в ленте, или null */
  function visibleSkeleton(scroller) {
    const list = scroller.firstElementChild?.firstElementChild;
    if (!list) return null;
    const view = scroller.getBoundingClientRect();
    for (const child of list.children) {
      if (getComputedStyle(child).pointerEvents !== "none") continue;
      const box = child.getBoundingClientRect();
      if (box.height > 0 && box.bottom > view.top && box.top < view.bottom) return child;
    }
    return null;
  }

  /** Показать заглушку наблюдателю for-web заново: кадр за краем ленты */
  function reveal(skeleton) {
    const previous = skeleton.style.transform;
    skeleton.style.transform = "translateX(-200vw)";
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        skeleton.style.transform = previous;
      }),
    );
  }

  const watch = (() => {
    let timer = 0;
    /** С какого времени заглушка видна без запроса */
    let stuckSince = 0;
    /** Раньше этого времени заглушку заново не показывать */
    let nextReveal = 0;

    function tick() {
      notice.update();
      const channel = openChannel();
      const loading = holding.has(channel) || [...pending].some((job) => job.channel === channel);
      const scroller = channel && !loading && document.visibilityState === "visible" ? chatScroller() : null;
      const skeleton = scroller ? visibleSkeleton(scroller) : null;
      if (!skeleton) {
        stuckSince = 0;
        nextReveal = 0;
        return;
      }
      const now = Date.now();
      stuckSince ||= now;
      if (now - stuckSince < STUCK_MS || now < nextReveal) return;
      // если for-web и после этого не подгрузит (нельзя читать историю),
      // следующая попытка — через RETRY_MS
      nextReveal = now + RETRY_MS;
      reveal(skeleton);
    }

    function start() {
      if (active && !timer) timer = setInterval(tick, TICK_MS);
    }

    function stop() {
      clearInterval(timer);
      timer = 0;
      stuckSince = 0;
      nextReveal = 0;
    }

    return { start, stop };
  })();

  watch.start();

  plugin.onSettingsChange((values) => {
    active = values.history !== false;
    if (active) watch.start();
    else {
      watch.stop();
      notice.remove();
    }
  });

  // подпись — на языке интерфейса Stoat
  i18n.onChange(() => notice.update());
})();
