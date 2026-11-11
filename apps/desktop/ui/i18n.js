// Языки интерфейса (Languages.ts и Locale.ts браузерного клиента Stoat).
//
// Строки интерфейса — английские msgid каталогов for-web, перевод лежит в
// i18n/<язык>.json (собирает scripts/i18n_catalogs.py из .po-файлов
// for-web и своих строк). t("Reset {0}'s token?", [name]) возвращает
// перевод с подставленными значениями; поддерживается ICU-разметка
// lingui: {0}, {count, plural, one {…} other {…}} и {x, select, …}.
// Подключается в <head>: переводы нужны до первой отрисовки.

"use strict";

(() => {
  const KEY = "stoat.ui.locale";

  /**
   * Языки в порядке браузерного клиента: название, флаг, файл каталога,
   * языковой тег для дат, письмо справа налево, отметка «проверено».
   */
  const LANGUAGES = {
    en: { display: "English (Traditional)", emoji: "🇬🇧", file: "en", tag: "en-GB" },
    "en-US": { display: "English (Simplified)", emoji: "🇺🇸", file: "en-US", tag: "en-US" },
    ar: { display: "عربي", emoji: "🇸🇦", file: "ar", rtl: true, verified: true },
    as: { display: "অসমীয়া", emoji: "🇮🇳", file: "as" },
    az: { display: "Azərbaycan dili", emoji: "🇦🇿", file: "az" },
    be: { display: "Беларуская", emoji: "🇧🇾", file: "be" },
    bg: { display: "Български", emoji: "🇧🇬", file: "bg" },
    bn: { display: "বাংলা", emoji: "🇧🇩", file: "bn" },
    br: { display: "Brezhoneg", emoji: "🏳️", file: "br", verified: true },
    ca: { display: "Català", emoji: "🇪🇸", file: "ca" },
    ceb: { display: "Bisaya", emoji: "🇵🇭", file: "ceb" },
    ckb: { display: "کوردی", emoji: "🏳️", file: "ckb", tag: "ku", rtl: true },
    cs: { display: "Čeština", emoji: "🇨🇿", file: "cs" },
    da: { display: "Dansk", emoji: "🇩🇰", file: "da" },
    de: { display: "Deutsch", emoji: "🇩🇪", file: "de", verified: true },
    el: { display: "Ελληνικά", emoji: "🇬🇷", file: "el" },
    es: { display: "Español", emoji: "🇪🇸", file: "es" },
    "es-419": { display: "Español (América Latina)", emoji: "🇪🇸", file: "es-419" },
    et: { display: "eesti", emoji: "🇪🇪", file: "et", verified: true },
    fi: { display: "suomi", emoji: "🇫🇮", file: "fi" },
    fil: { display: "Filipino", emoji: "🇵🇭", file: "fil" },
    fr: { display: "Français", emoji: "🇫🇷", file: "fr", verified: true },
    ga: { display: "Gaeilge", emoji: "🇮🇪", file: "ga" },
    hi: { display: "हिन्दी", emoji: "🇮🇳", file: "hi" },
    hr: { display: "Hrvatski", emoji: "🇭🇷", file: "hr" },
    hu: { display: "Magyar", emoji: "🇭🇺", file: "hu", verified: true },
    hy: { display: "հայերեն", emoji: "🇦🇲", file: "hy" },
    id: { display: "Bahasa Indonesia", emoji: "🇮🇩", file: "id" },
    is: { display: "Íslenska", emoji: "🇮🇸", file: "is" },
    it: { display: "Italiano", emoji: "🇮🇹", file: "it" },
    ja: { display: "日本語", emoji: "🇯🇵", file: "ja" },
    ko: { display: "한국어", emoji: "🇰🇷", file: "ko" },
    lb: { display: "Lëtzebuergesch", emoji: "🇱🇺", file: "lb" },
    lt: { display: "Lietuvių", emoji: "🇱🇹", file: "lt" },
    lv: { display: "Latviešu", emoji: "🇱🇻", file: "lv", verified: true },
    mk: { display: "Македонски", emoji: "🇲🇰", file: "mk" },
    ms: { display: "Bahasa Melayu", emoji: "🇲🇾", file: "ms" },
    "nb-NO": { display: "Norsk bokmål", emoji: "🇳🇴", file: "nb-NO", tag: "nb" },
    nl: { display: "Nederlands", emoji: "🇳🇱", file: "nl" },
    fa: { display: "فارسی", emoji: "🇮🇷", file: "fa", rtl: true, verified: true },
    pl: { display: "Polski", emoji: "🇵🇱", file: "pl" },
    "pt-BR": { display: "Português (do Brasil)", emoji: "🇧🇷", file: "pt-BR" },
    "pt-PT": { display: "Português (Portugal)", emoji: "🇵🇹", file: "pt-PT" },
    ro: { display: "Română", emoji: "🇷🇴", file: "ro" },
    ru: { display: "Русский", emoji: "🇷🇺", file: "ru", verified: true },
    sk: { display: "Slovensky", emoji: "🇸🇰", file: "sk" },
    sl: { display: "Slovenščina", emoji: "🇸🇮", file: "sl" },
    sq: { display: "Shqip", emoji: "🇦🇱", file: "sq" },
    sr: { display: "Српски", emoji: "🇷🇸", file: "sr" },
    si: { display: "සිංහල", emoji: "🇱🇰", file: "si" },
    sv: { display: "Svenska", emoji: "🇸🇪", file: "sv", verified: true },
    ta: { display: "தமிழ்", emoji: "🇮🇳", file: "ta" },
    th: { display: "ไทย", emoji: "🇹🇭", file: "th" },
    tr: { display: "Türkçe", emoji: "🇹🇷", file: "tr" },
    ur: { display: "اردو", emoji: "🇵🇰", file: "ur", rtl: true },
    uk: { display: "Українська", emoji: "🇺🇦", file: "uk", verified: true },
    vec: { display: "Vèneto", emoji: "🏳️", file: "vec", tag: "it" },
    vi: { display: "Tiếng Việt", emoji: "🇻🇳", file: "vi" },
    "zh-Hans": { display: "简体中文", emoji: "🇨🇳", file: "zh-Hans" },
    "zh-Hant": { display: "繁體中文", emoji: "🇹🇼", file: "zh-Hant" },
    tokipona: { display: "Toki Pona", emoji: "🙂", file: "tokipona", tag: "en-GB" },
    esperanto: { display: "Esperanto", emoji: "🏳️", file: "eo", tag: "eo" },
    owo: { display: "OwO", emoji: "😸", file: "owo", tag: "en-GB" },
    pr: { display: "Pirate", emoji: "🏴‍☠️", file: "pr", tag: "en-GB" },
    bottom: { display: "Bottom", emoji: "🥺", file: "bottom", tag: "en-GB" },
    leet: { display: "1337", emoji: "💾", file: "leet", tag: "en-GB" },
    enchantment: { display: "Enchantment Table", emoji: "🪄", file: "enchantment", tag: "en-GB" },
    piglatin: { display: "Pig Latin", emoji: "🐖", file: "piglatin", tag: "en-GB" },
  };

  const DATE_FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];
  const TIME_FORMATS = ["HH:mm", "h:mm A"];

  /** Язык системы, если он есть в списке (browserPreferredLanguage). */
  function preferredLanguage() {
    const wanted = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "ru"]).filter(Boolean);
    for (const lang of wanted) if (LANGUAGES[lang]) return lang;
    for (const lang of wanted) {
      const base = lang.split("-")[0];
      if (LANGUAGES[base]) return base;
    }
    return null;
  }

  function read() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
    } catch {
      saved = {};
    }
    const language = LANGUAGES[saved.language] ? saved.language : preferredLanguage() || "ru";
    // формат даты по умолчанию — как принято в языке (у английского США — американский)
    const dateFormat = DATE_FORMATS.includes(saved.dateFormat) ? saved.dateFormat : language === "en-US" ? "MM/DD/YYYY" : "DD/MM/YYYY";
    const timeFormat = TIME_FORMATS.includes(saved.timeFormat) ? saved.timeFormat : language === "en-US" ? "h:mm A" : "HH:mm";
    return { language, dateFormat, timeFormat };
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      /* без хранилища выбор действует до перезапуска */
    }
  }

  let current = read();
  let catalog = {};

  // ─────────────────────────── ICU ───────────────────────────

  /** Разбор ICU-сообщения в дерево: строки и {имя[, вид, варианты]}. */
  function parse(text) {
    let index = 0;
    function nodes(stopAtBrace) {
      const out = [];
      let buffer = "";
      while (index < text.length) {
        const char = text[index];
        if (char === "'" && text[index + 1] === "'") {
          buffer += "'";
          index += 2;
        } else if (char === "{") {
          if (buffer) out.push(buffer);
          buffer = "";
          index += 1;
          out.push(argument());
        } else if (char === "}" && stopAtBrace) {
          break;
        } else {
          buffer += char;
          index += 1;
        }
      }
      if (buffer) out.push(buffer);
      return out;
    }
    function word() {
      let value = "";
      while (index < text.length && /\s/.test(text[index])) index += 1;
      while (index < text.length && !/[\s,{}]/.test(text[index])) value += text[index++];
      while (index < text.length && /\s/.test(text[index])) index += 1;
      return value;
    }
    function argument() {
      const name = word();
      if (text[index] === "}") {
        index += 1;
        return { name };
      }
      index += 1; // ,
      const kind = word();
      let offset = 0;
      const options = {};
      if (text[index] === ",") index += 1;
      while (index < text.length && text[index] !== "}") {
        let key = word();
        if (key.startsWith("offset:")) {
          offset = Number(key.slice(7)) || 0;
          continue;
        }
        if (text[index] !== "{") break;
        index += 1;
        options[key] = nodes(true);
        index += 1; // }
        while (index < text.length && /\s/.test(text[index])) index += 1;
      }
      index += 1; // }
      return { name, kind, options, offset };
    }
    return nodes(false);
  }

  const parsed = new Map();
  let pluralRules = null;

  function render(tree, values, hash) {
    let out = "";
    for (const node of tree) {
      if (typeof node === "string") {
        out += hash === undefined ? node : node.replace(/#/g, hash);
        continue;
      }
      const value = values ? values[node.name] : undefined;
      if (!node.kind) {
        out += value === undefined || value === null ? "{" + node.name + "}" : String(value);
      } else if (node.kind === "plural" || node.kind === "selectordinal") {
        const number = Number(value) || 0;
        const exact = node.options["=" + number];
        let branch = exact;
        if (!branch) {
          const rule = (pluralRules || new Intl.PluralRules("en")).select(number - node.offset);
          branch = node.options[rule] || node.options.other || [];
        }
        out += render(branch, values, formatNumber(number - node.offset));
      } else if (node.kind === "select") {
        out += render(node.options[String(value)] || node.options.other || [], values, hash);
      } else {
        out += value === undefined ? "" : String(value);
      }
    }
    return out;
  }

  function formatNumber(number) {
    try {
      return new Intl.NumberFormat(tag()).format(number);
    } catch {
      return String(number);
    }
  }

  /** Перевести строку (английский msgid for-web) и подставить значения. */
  function t(msgid, values) {
    const source = Object.prototype.hasOwnProperty.call(catalog, msgid) && catalog[msgid] ? catalog[msgid] : msgid;
    if (!values && source.indexOf("{") === -1) return source.replace(/''/g, "'");
    let tree = parsed.get(source);
    if (!tree) {
      tree = parse(source);
      parsed.set(source, tree);
    }
    return render(tree, values || {});
  }

  /**
   * Перевод с элементами внутри (как <Trans> с компонентами в lingui):
   * `<0/>` заменяется узлом `parts[0]`, `<1>текст</1>` — результатом
   * `parts[1](текст)`. Возвращает массив строк и узлов DOM.
   */
  function rich(msgid, values, parts) {
    const text = t(msgid, values);
    const out = [];
    const tag = /<(\d+)\/>|<(\d+)>([\s\S]*?)<\/\2>/g;
    let last = 0;
    let match;
    while ((match = tag.exec(text))) {
      if (match.index > last) out.push(text.slice(last, match.index));
      const index = Number(match[1] !== undefined ? match[1] : match[2]);
      const part = parts ? parts[index] : null;
      if (match[1] !== undefined) {
        if (part !== null && part !== undefined) out.push(typeof part === "function" ? part("") : part);
      } else {
        out.push(typeof part === "function" ? part(match[3]) : match[3]);
      }
      last = tag.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  // ─────────────────────────── даты ───────────────────────────

  function tag() {
    const entry = LANGUAGES[current.language];
    return (entry && entry.tag) || current.language;
  }

  const pad = (value) => String(value).padStart(2, "0");

  /** Дата в выбранном формате (L в dayjs браузерного клиента). */
  function date(value, format = current.dateFormat) {
    if (!value) return "";
    const day = pad(value.getDate());
    const month = pad(value.getMonth() + 1);
    const year = value.getFullYear();
    if (format === "MM/DD/YYYY") return `${month}/${day}/${year}`;
    if (format === "YYYY-MM-DD") return `${year}-${month}-${day}`;
    return `${day}/${month}/${year}`;
  }

  /** Время в выбранном формате (LT). */
  function time(value, format = current.timeFormat) {
    if (!value) return "";
    if (format === "h:mm A") {
      const hours = value.getHours();
      return `${hours % 12 || 12}:${pad(value.getMinutes())} ${hours < 12 ? "AM" : "PM"}`;
    }
    return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
  }

  /** «12 марта 2026 г.» — формат LL. */
  function longDate(value) {
    if (!value) return "";
    try {
      return value.toLocaleDateString(tag(), { day: "numeric", month: "long", year: "numeric" });
    } catch {
      return date(value);
    }
  }

  /** «3 дня назад» — формат relative у dayjs в браузерном клиенте. */
  function relative(value) {
    if (!value || Number.isNaN(value.getTime())) return "";
    const seconds = (value.getTime() - Date.now()) / 1000;
    const steps = [
      ["year", 31536000],
      ["month", 2592000],
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
    ];
    let format;
    try {
      format = new Intl.RelativeTimeFormat(tag(), { numeric: "auto" });
    } catch {
      format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    }
    for (const [unit, size] of steps) {
      if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
    }
    return format.format(0, "second");
  }

  // ─────────────────────────── загрузка ───────────────────────────

  /** Перевести разметку страницы: data-i18n, data-i18n-title, data-i18n-placeholder. */
  function translateDocument(root = document) {
    for (const node of root.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
    for (const node of root.querySelectorAll("[data-i18n-title]")) {
      node.title = t(node.dataset.i18nTitle);
      node.setAttribute("aria-label", node.title);
    }
    for (const node of root.querySelectorAll("[data-i18n-placeholder]")) node.placeholder = t(node.dataset.i18nPlaceholder);
  }

  function applyDocument() {
    const entry = LANGUAGES[current.language];
    document.documentElement.lang = tag();
    document.documentElement.dir = entry && entry.rtl ? "rtl" : "ltr";
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => translateDocument(), { once: true });
    } else {
      translateDocument();
    }
  }

  async function load(language) {
    const entry = LANGUAGES[language] || LANGUAGES.ru;
    try {
      const response = await fetch(`i18n/${entry.file}.json`);
      catalog = response.ok ? await response.json() : {};
    } catch {
      catalog = {};
    }
    parsed.clear();
    try {
      pluralRules = new Intl.PluralRules(tag());
    } catch {
      pluralRules = new Intl.PluralRules("en");
    }
    applyDocument();
  }

  function changed() {
    window.dispatchEvent(new CustomEvent("arachnid-locale"));
  }

  window.I18N = {
    LANGUAGES,
    DATE_FORMATS,
    TIME_FORMATS,
    t,
    rich,
    number: formatNumber,
    date,
    time,
    longDate,
    relative,
    tag,
    translateDocument,
    preferredLanguage,
    /** Каталог выбранного языка загружен. */
    ready: load(current.language),
    get() {
      return Object.assign({}, current);
    },
    /** Сменить язык: загрузить каталог и перерисовать интерфейс. */
    async setLanguage(language) {
      if (!LANGUAGES[language]) return;
      current.language = language;
      save();
      await load(language);
      changed();
    },
    setDateFormat(format) {
      if (!DATE_FORMATS.includes(format)) return;
      current.dateFormat = format;
      save();
      changed();
    },
    setTimeFormat(format) {
      if (!TIME_FORMATS.includes(format)) return;
      current.timeFormat = format;
      save();
      changed();
    },
  };
  window.t = t;
})();
