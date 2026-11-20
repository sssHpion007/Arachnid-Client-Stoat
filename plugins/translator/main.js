// Переводчик сообщений Stoat (for-web).
//
// Кнопка в панели сообщения (рядом с «Ответить» и реакциями) и пункт в меню
// сообщения переводят текст сообщения на месте; повторное нажатие
// возвращает оригинал. Переводятся только текстовые узлы разметки Markdown:
// эмодзи, упоминания, ссылки-адреса, код, формулы и время остаются как
// есть, поэтому форматирование и обработчики for-web не теряются.
//
// Язык перевода по умолчанию — язык интерфейса Stoat: for-web хранит его в
// IndexedDB (localforage, хранилище `@<id пользователя>`, ключ `locale`).

"use strict";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const OWN = "arachnid-translator";

// значок translate из Material Icons (outlined), как остальные значки for-web
const TRANSLATE_ICON =
  "m12.87 15.07-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7 1.62-4.33L19.12 17h-3.24z";
// начала контуров значков for-web, по которым узнаются кнопки и пункты меню
const ICON = {
  reply: "M10 9V5l-7 7",
  unread: "M22 6.98V16",
  copy: "M16 1H4c-1.1",
};

const TEXT = {
  ru: {
    translate: "Перевести",
    original: "Показать оригинал",
    mark: "(переведено)",
    source: "Исходный язык",
    same: "Сообщение уже на этом языке",
    failed: "Не удалось перевести",
    network: "Сервис перевода недоступен",
    limit: "Сервис перевода ограничил запросы, попробуйте позже",
    deeplKey: "Укажите ключ DeepL API в настройках плагина",
    deeplBadKey: "Ключ DeepL API не подошёл",
    deeplQuota: "Лимит символов DeepL исчерпан",
    deeplLanguage: "DeepL не переводит на этот язык",
  },
  en: {
    translate: "Translate",
    original: "Show original",
    mark: "(translated)",
    source: "Source language",
    same: "The message is already in this language",
    failed: "Translation failed",
    network: "The translation service is unavailable",
    limit: "The translation service is rate limiting requests, try again later",
    deeplKey: "Set the DeepL API key in the plugin settings",
    deeplBadKey: "The DeepL API key was rejected",
    deeplQuota: "The DeepL character quota is used up",
    deeplLanguage: "DeepL can't translate into this language",
  },
};

// ─────────────────────────────── язык ───────────────────────────────

// шуточные языки for-web переводчики не знают
const NO_TRANSLATION = new Set(["tokipona", "owo", "pr", "bottom", "leet", "piglatin", "enchantment", "dev"]);

/** Код языка for-web или браузера → код из списка настроек плагина */
function normalizeLanguage(code) {
  if (typeof code !== "string") return null;
  const raw = code.trim().replace(/_/g, "-").toLowerCase();
  if (!raw || NO_TRANSLATION.has(raw)) return null;
  if (raw === "esperanto") return "eo";
  const [base, ...rest] = raw.split("-");
  const region = rest.join("-");
  switch (base) {
    case "zh":
      return /hant|tw|hk|mo/.test(region) ? "zh-Hant" : "zh-Hans";
    case "pt":
      return region === "pt" ? "pt-PT" : "pt-BR";
    case "no":
    case "nn":
    case "nb":
      return "nb";
    case "tl":
    case "fil":
      return "fil";
    case "iw":
      return "he";
    case "in":
      return "id";
    default:
      return /^[a-z]{2,3}$/.test(base) ? base : null;
  }
}

/** Язык интерфейса из хранилища for-web (или null) */
function storedLocale() {
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

let clientLanguage = normalizeLanguage(navigator.language) ?? "en";

/** Язык клиента: выбранный в Stoat, иначе язык системы */
async function refreshClientLanguage() {
  const stored = normalizeLanguage(await storedLocale().catch(() => null));
  const system = [...(navigator.languages ?? []), navigator.language].map(normalizeLanguage).find(Boolean);
  clientLanguage = stored ?? system ?? "en";
  return clientLanguage;
}

const text = () => (clientLanguage === "ru" ? TEXT.ru : TEXT.en);

/** Язык, на который переводить: из настроек или язык клиента */
async function targetLanguage() {
  const chosen = String(plugin.settings.language ?? "auto");
  const client = await refreshClientLanguage();
  return chosen === "auto" ? client : chosen;
}

/** Совпадает ли определённый сервисом язык с языком перевода */
function sameLanguage(detected, target) {
  const language = normalizeLanguage(detected);
  if (!language) return false;
  if (language.startsWith("zh") || target.startsWith("zh")) return language === target;
  return language.split("-")[0] === target.split("-")[0];
}

// ─────────────────────────────── сервисы ───────────────────────────────

class TranslatorError extends Error {
  constructor(key, detail) {
    super(detail ? `${key}: ${detail}` : key);
    this.key = key;
    this.detail = detail ?? "";
  }
}

async function send(url, options) {
  try {
    return await plugin.fetch(url, options);
  } catch (error) {
    throw new TranslatorError("network", error?.message);
  }
}

function parseJson(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new TranslatorError("failed", `HTTP ${response.status}`);
  }
}

function checkStatus(response) {
  if (response.status === 429) throw new TranslatorError("limit");
  if (response.status >= 200 && response.status < 300) return;
  // переадресацию клиент не выполняет: куда она ведёт — подсказка к ошибке
  const location = Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === "location")?.[1];
  let target = "";
  try {
    target = location ? ` → ${new URL(location).host}` : "";
  } catch {
    target = "";
  }
  throw new TranslatorError("failed", `HTTP ${response.status}${target}`);
}

/** Тексты частями: не больше `count` штук и `size` единиц по мерке `measure` */
function chunks(items, count, size, measure) {
  const result = [];
  let current = [];
  let total = 0;
  items.forEach((item, index) => {
    const length = measure(item);
    if (current.length && (current.length >= count || total + length > size)) {
      result.push(current);
      current = [];
      total = 0;
    }
    current.push(index);
    total += length;
  });
  if (current.length) result.push(current);
  return result;
}

/** Текст → HTML: сервисы ниже разбирают запрос как HTML */
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** HTML ответа → текст (разбор в <template>: скрипты и картинки не оживают) */
function htmlText(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.textContent ?? "";
}

const GOOGLE_KEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";
const GOOGLE_CODES = { "zh-Hans": "zh-CN", "zh-Hant": "zh-TW", "pt-BR": "pt", nb: "no", fil: "tl" };

/**
 * Перевод одной части от Google. Текст из нескольких предложений Google
 * может вернуть парами «<i>оригинал</i> <b>перевод</b>» — тогда берутся
 * только переводы.
 */
function googleText(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const sentences = template.content.querySelectorAll("b");
  if (!sentences.length) return template.content.textContent ?? "";
  return [...sentences]
    .map((sentence) => sentence.textContent.trim())
    .join(" ")
    .replace(/\s+/g, " ");
}

/**
 * Google Переводчик: translateHtml с открытым ключом встроенного перевода
 * страниц Chrome — тот же адрес, что у расширения Translate Web Pages.
 * Части сообщения — элементами одного запроса.
 */
async function google(texts, target) {
  const tl = GOOGLE_CODES[target] ?? target;
  const results = new Array(texts.length);
  for (const group of chunks(texts, 100, 5000, (item) => item.length)) {
    const response = await send("https://translate-pa.googleapis.com/v1/translateHtml", {
      method: "POST",
      headers: { "Content-Type": "application/json+protobuf", "X-Goog-API-Key": GOOGLE_KEY },
      body: JSON.stringify([[group.map((index) => escapeHtml(texts[index])), "auto", tl], "te"]),
    });
    checkStatus(response);
    const data = parseJson(response);
    const translations = Array.isArray(data?.[0]) ? data[0] : [];
    if (translations.length !== group.length) throw new TranslatorError("failed", "response");
    group.forEach((index, position) => {
      const detected = Array.isArray(data[1]) ? data[1][position] : null;
      results[index] = {
        text: googleText(String(translations[position] ?? "")),
        lang: typeof detected === "string" ? detected : Array.isArray(detected) ? detected[0] ?? null : null,
      };
    });
  }
  return results;
}

const MICROSOFT_CODES = { "pt-BR": "pt", "pt-PT": "pt-pt", sr: "sr-Cyrl" };

/** Microsoft Translator: адрес встроенного перевода Edge, без ключа */
async function microsoft(texts, target) {
  const to = MICROSOFT_CODES[target] ?? target;
  const url = `https://edge.microsoft.com/translate/translatetext?isEnterpriseClient=false&to=${encodeURIComponent(to)}`;
  const results = new Array(texts.length);
  for (const group of chunks(texts, 100, 40000, (item) => item.length)) {
    const response = await send(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(group.map((index) => escapeHtml(texts[index]))),
    });
    checkStatus(response);
    const data = parseJson(response);
    if (!Array.isArray(data) || data.length !== group.length) throw new TranslatorError("failed", "response");
    group.forEach((index, position) => {
      const item = data[position];
      const translatedText = item?.translations?.[0]?.text;
      results[index] = {
        text: typeof translatedText === "string" ? htmlText(translatedText) : texts[index],
        lang: item?.detectedLanguage?.language ?? null,
      };
    });
  }
  return results;
}

const DEEPL_CODES = {
  ar: "AR", bg: "BG", cs: "CS", da: "DA", de: "DE", el: "EL", en: "EN-US", es: "ES", et: "ET", fi: "FI",
  fr: "FR", he: "HE", hu: "HU", id: "ID", it: "IT", ja: "JA", ko: "KO", lt: "LT", lv: "LV", nb: "NB",
  nl: "NL", pl: "PL", "pt-BR": "PT-BR", "pt-PT": "PT-PT", ro: "RO", ru: "RU", sk: "SK", sl: "SL",
  sv: "SV", th: "TH", tr: "TR", uk: "UK", vi: "VI", "zh-Hans": "ZH-HANS", "zh-Hant": "ZH-HANT",
};

/** DeepL API: ключ из настроек, у бесплатного ключа окончание `:fx` */
async function deepl(texts, target) {
  const key = String(plugin.settings.deepl_key ?? "").trim();
  if (!key) throw new TranslatorError("deeplKey");
  const targetLang = DEEPL_CODES[target];
  if (!targetLang) throw new TranslatorError("deeplLanguage");
  const host = key.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
  const results = new Array(texts.length);
  for (const group of chunks(texts, 50, 100000, (item) => item.length)) {
    const response = await send(`https://${host}/v2/translate`, {
      method: "POST",
      headers: { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: group.map((index) => texts[index]), target_lang: targetLang }),
    });
    if (response.status === 401 || response.status === 403) throw new TranslatorError("deeplBadKey");
    if (response.status === 456) throw new TranslatorError("deeplQuota");
    checkStatus(response);
    const data = parseJson(response);
    const translations = Array.isArray(data?.translations) ? data.translations : [];
    if (translations.length !== group.length) throw new TranslatorError("failed", "response");
    group.forEach((index, position) => {
      const item = translations[position];
      results[index] = {
        text: String(item?.text ?? texts[index]),
        lang: typeof item?.detected_source_language === "string" ? item.detected_source_language : null,
      };
    });
  }
  return results;
}

const SERVICES = {
  google: { name: "Google Translate", translate: google },
  microsoft: { name: "Microsoft Translator", translate: microsoft },
  deepl: { name: "DeepL", translate: deepl },
};

const currentService = () => (Object.hasOwn(SERVICES, plugin.settings.service) ? plugin.settings.service : "google");

// переводы частей сообщений: повторный показ и сообщения, которые for-web
// отрисовал заново, обходятся без сети
const cache = new Map();
const CACHE_LIMIT = 4000;
const cacheKey = (service, target, item) => `${service}\u0001${target}\u0001${item}`;

async function translateTexts(service, texts, target, offline) {
  const missing = [...new Set(texts.filter((item) => !cache.has(cacheKey(service, target, item))))];
  if (missing.length) {
    if (offline) return null;
    const results = await SERVICES[service].translate(missing, target);
    missing.forEach((item, index) => {
      cache.set(cacheKey(service, target, item), results[index]);
    });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  return texts.map((item) => cache.get(cacheKey(service, target, item)));
}

// ─────────────────────────────── сообщение ───────────────────────────────

const BLOCK = "p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, hr";
const BLOCK_IN_DIV = BLOCK.split(", ")
  .map((tag) => `div > ${tag}`)
  .join(", ");
const TEXT_BLOCK = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote";
// не переводятся: код, время, картинки, упоминания (div), формулы
const SKIP_TAGS = new Set([
  "CODE", "PRE", "KBD", "SAMP", "TIME", "IMG", "PICTURE", "VIDEO", "AUDIO", "CANVAS",
  "BUTTON", "INPUT", "TEXTAREA", "SELECT", "SCRIPT", "STYLE", "DIV",
]);
const ICONISH = "svg, img:not(.emoji), div, [aria-hidden='true'], [class*='material-symbols']";
const URL_ONLY = /^\s*(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+\s*$/i;
const LETTER = /\p{L}/u;

function messageRoot(node) {
  for (let element = node instanceof Element ? node : node?.parentElement; element; element = element.parentElement) {
    if (ULID.test(element.id)) return element;
    if (element === document.body) break;
  }
  return null;
}

/**
 * Текст сообщения в разметке for-web: блок BreakText (Message.tsx) —
 * div с word-break: break-word, в котором блоки Markdown. Встраивания с
 * Markdown идут после него и word-break не задают.
 */
function contentOf(root) {
  const seen = new Set();
  for (const block of root.querySelectorAll(BLOCK_IN_DIV)) {
    const box = block.parentElement;
    if (seen.has(box)) continue;
    seen.add(box);
    if (box === root || box.closest(".Toolbar")) continue;
    if (getComputedStyle(box).wordBreak !== "break-word") continue;
    return box;
  }
  return null;
}

function skipped(element) {
  if (element.namespaceURI !== HTML_NS) return true;
  if (SKIP_TAGS.has(element.tagName)) return true;
  if (element.getAttribute("aria-hidden") === "true" || element.getAttribute("translate") === "no") return true;
  for (const name of element.classList) {
    if (name.startsWith(OWN) || name.startsWith("material-symbols")) return true;
    if (name === "notranslate" || name === "emoji" || name.startsWith("katex") || name.startsWith("math")) return true;
  }
  // ссылки на каналы и серверы, @everyone: значок и подпись — целиком
  if ((element.tagName === "A" || element.tagName === "SPAN") && element.querySelector(ICONISH)) return true;
  return false;
}

/** Текстовые узлы сообщения, которые стоит переводить */
function collect(box) {
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return node !== box && skipped(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
      const value = node.data;
      return LETTER.test(value) && !URL_ONLY.test(value) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const segments = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.data;
    const lead = value.match(/^\s*/)[0];
    const trail = value.slice(lead.length).match(/\s*$/)[0];
    segments.push({ node, original: value, lead, trail, core: value.slice(lead.length, value.length - trail.length) });
  }
  return segments;
}

// ─────────────────────────────── перевод ───────────────────────────────

const translated = new Map(); // id сообщения → { service, target }
const applied = new WeakMap(); // блок текста → { segments, mark }
const busy = new Set();

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = null;
  for (const [value, count] of counts) if (!best || count > counts.get(best)) best = value;
  return best;
}

function languageName(code) {
  if (!code) return "";
  try {
    return new Intl.DisplayNames([clientLanguage], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function apply(box, segments, results, service) {
  segments.forEach((segment, index) => {
    const value = String(results[index]?.text ?? "").trim();
    segment.translated = value ? segment.lead + value + segment.trail : segment.original;
    segment.node.data = segment.translated;
  });
  const last = segments[segments.length - 1].node.parentElement;
  const host = last?.closest(TEXT_BLOCK);
  const mark = document.createElement("span");
  mark.className = `${OWN}-mark`;
  mark.textContent = text().mark;
  const source = mostCommon(results.map((result) => result?.lang));
  mark.title = [source ? `${text().source}: ${languageName(source)}` : "", SERVICES[service].name]
    .filter(Boolean)
    .join(" · ");
  (host && box.contains(host) ? host : box).append(mark);
  applied.set(box, { segments, mark });
}

/** Стоит ли перевод: for-web мог заменить разметку текста целиком */
function isApplied(box) {
  const state = applied.get(box);
  if (!state) return false;
  if (state.mark.isConnected && state.segments.every((segment) => segment.node.isConnected)) return true;
  state.mark.remove();
  applied.delete(box);
  return false;
}

function restore(box) {
  if (!isApplied(box)) return;
  const state = applied.get(box);
  for (const segment of state.segments) {
    if (segment.node.data === segment.translated) segment.node.data = segment.original;
  }
  state.mark.remove();
  applied.delete(box);
}

/** Короткое сообщение под текстом (ошибка, «уже на этом языке») */
function note(box, message, error) {
  box.querySelector(`:scope > .${OWN}-note`)?.remove();
  const element = document.createElement("div");
  element.className = `${OWN}-note`;
  if (error) element.dataset.error = "";
  element.textContent = message;
  box.append(element);
  setTimeout(() => element.remove(), 6000);
}

function describe(error) {
  const strings = text();
  if (error instanceof TranslatorError) {
    const message = strings[error.key] ?? strings.failed;
    return error.detail && (error.key === "failed" || error.key === "network") ? `${message} (${error.detail})` : message;
  }
  return `${strings.failed} (${error?.message ?? error})`;
}

async function toggle(id) {
  if (busy.has(id)) return;
  const root = document.getElementById(id);
  const box = root && contentOf(root);
  if (!box) return;

  if (translated.has(id)) {
    translated.delete(id);
    restore(box);
    refreshButtons(id);
    watch();
    return;
  }

  const segments = collect(box);
  if (!segments.length) return;
  busy.add(id);
  box.setAttribute(`data-${OWN}-busy`, "");
  refreshButtons(id);
  try {
    const service = currentService();
    const target = await targetLanguage();
    const results = await translateTexts(
      service,
      segments.map((segment) => segment.core),
      target,
      false,
    );
    // пока шёл запрос, for-web мог отрисовать сообщение заново
    if (!box.isConnected || segments.some((segment) => segment.node.data !== segment.original)) return;
    if (results.every((result) => sameLanguage(result?.lang, target))) {
      note(box, text().same, false);
      return;
    }
    apply(box, segments, results, service);
    translated.set(id, { service, target });
    watch();
  } catch (error) {
    console.warn("[translator]", error);
    if (box.isConnected) note(box, describe(error), true);
  } finally {
    busy.delete(id);
    box.removeAttribute(`data-${OWN}-busy`);
    refreshButtons(id);
  }
}

/**
 * for-web отрисовывает сообщения заново (прокрутка, смена канала): у
 * переведённых перевод ставится снова из кэша. Изменённый текст — уже
 * другое сообщение: остаётся оригинал.
 */
async function reapply() {
  for (const [id, { service, target }] of translated) {
    const root = document.getElementById(id);
    const box = root && contentOf(root);
    if (!box || isApplied(box) || busy.has(id)) continue;
    const segments = collect(box);
    const results = segments.length
      ? await translateTexts(service, segments.map((segment) => segment.core), target, true)
      : null;
    if (!box.isConnected || isApplied(box)) continue;
    if (!results) {
      translated.delete(id);
    } else {
      apply(box, segments, results, service);
    }
    refreshButtons(id);
  }
  watch();
}

let reapplyQueued = false;
const pageObserver = new MutationObserver(() => {
  if (reapplyQueued) return;
  reapplyQueued = true;
  requestAnimationFrame(() => {
    reapplyQueued = false;
    void reapply();
  });
});
let watching = false;

/** Следить за страницей, только пока есть переведённые сообщения */
function watch() {
  if (translated.size && !watching) {
    pageObserver.observe(document.body, { childList: true, subtree: true });
    watching = true;
  } else if (!translated.size && watching) {
    pageObserver.disconnect();
    watching = false;
  }
}

// ─────────────────────────────── кнопка ───────────────────────────────

function icon(template, size) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const name of ["width", "height", "class", "style"]) {
    const value = template?.getAttribute(name);
    if (value !== null && value !== undefined) svg.setAttribute(name, value);
  }
  if (!svg.hasAttribute("width")) svg.setAttribute("width", String(size));
  if (!svg.hasAttribute("height")) svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", TRANSLATE_ICON);
  svg.append(path);
  return svg;
}

const hasIcon = (element, start) => element.querySelector(`path[d^="${start}"]`) !== null;

function syncButton(button, id) {
  const active = translated.has(id);
  button.toggleAttribute("data-active", active);
  button.toggleAttribute("data-busy", busy.has(id));
  button.setAttribute("aria-label", active ? text().original : text().translate);
}

function refreshButtons(id) {
  const root = document.getElementById(id);
  const button = root?.querySelector(`:scope > .Toolbar > .${OWN}-tool`);
  if (button) syncButton(button, id);
}

/** Кнопка в панели сообщения: по образцу соседних, после реакций */
function ensureButton(root) {
  const toolbar = root.querySelector(":scope > .Toolbar");
  if (!toolbar) return;
  let button = toolbar.querySelector(`:scope > .${OWN}-tool`);
  const box = contentOf(root);
  if (!box || !collect(box).length) {
    button?.remove();
    return;
  }
  if (!button) {
    const sample = [...toolbar.children].find((child) => child.tagName === "DIV" && child.querySelector("svg"));
    if (!sample) return;
    button = document.createElement("div");
    button.className = `${sample.className} ${OWN}-tool`.trim();
    button.setAttribute("role", "button");
    button.append(document.createElement("md-ripple"), icon(sample.querySelector("svg"), 20));
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = messageRoot(button)?.id;
      if (id) void toggle(id);
    });
    const react = [...toolbar.children].find((child) => child.querySelector("svg circle[cx='15.5']"));
    const reply = [...toolbar.children].find((child) => hasIcon(child, ICON.reply));
    const anchor = react ?? reply;
    if (anchor) anchor.after(button);
    else toolbar.prepend(button);
  }
  syncButton(button, root.id);
}

// панель for-web показывает при наведении на сообщение (Container.tsx)
let hovered = null;
document.addEventListener(
  "pointerover",
  (event) => {
    const root = messageRoot(event.target);
    if (root === hovered) return;
    hovered = root;
    if (root) ensureButton(root);
  },
  { capture: true, passive: true },
);

// ─────────────────────────────── меню ───────────────────────────────

// меню сообщения открывают правый щелчок по сообщению и «⋮» в панели
let opened = { id: null, time: 0 };
function rememberMessage(event) {
  const id = messageRoot(event.target)?.id;
  if (!id) return;
  opened = { id, time: performance.now() };
  void refreshClientLanguage();
}
document.addEventListener("contextmenu", rememberMessage, true);
document.addEventListener(
  "click",
  (event) => {
    if (event.target instanceof Element && event.target.closest(".Toolbar")) rememberMessage(event);
  },
  true,
);

/** Пункт «Перевести» после «Копировать текст» (MessageContextMenu for-web) */
function addMenuItem(node, id) {
  const unread = node.querySelector(`path[d^="${ICON.unread}"]`)?.closest("a");
  if (!unread?.parentElement || unread.parentElement.querySelector(`.${OWN}-item`)) return false;
  const root = document.getElementById(id);
  const box = root && contentOf(root);
  if (!box || !collect(box).length) return true;
  const next = unread.nextElementSibling;
  const sample = next?.tagName === "A" && hasIcon(next, ICON.copy) ? next : unread;
  const item = sample.cloneNode(true);
  item.removeAttribute("href");
  item.removeAttribute("id");
  item.classList.add(`${OWN}-item`);
  const svg = item.querySelector("svg");
  if (svg) svg.replaceWith(icon(svg, 16));
  const label = [...item.querySelectorAll("span")].find((span) => span.getAttribute("aria-hidden") !== "true") ?? item;
  label.textContent = translated.has(id) ? text().original : text().translate;
  // меню for-web закрывается само по любому щелчку
  item.addEventListener("click", () => void toggle(id));
  sample.after(item);
  return true;
}

function watchMenus(floating) {
  new MutationObserver((records) => {
    if (!opened.id || performance.now() - opened.time > 1500) return;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (addMenuItem(node, opened.id)) {
          opened = { id: null, time: 0 };
          return;
        }
      }
    }
  }).observe(floating, { childList: true, subtree: true });
}

// меню и окна for-web выводит в #floating
const floating = document.getElementById("floating");
if (floating) {
  watchMenus(floating);
} else {
  const waiting = new MutationObserver(() => {
    const element = document.getElementById("floating");
    if (!element) return;
    waiting.disconnect();
    watchMenus(element);
  });
  waiting.observe(document.documentElement, { childList: true, subtree: true });
}

void refreshClientLanguage();
