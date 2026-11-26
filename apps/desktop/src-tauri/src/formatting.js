// Меню форматирования: часть встроенного плагина «Quality of Life»
// (выполняется вместе с emoji.js, gifs.js, hotkeys.js, history.js и
// player.js), настройки `format_menu`, `live_formatting` и
// `colored_text_font`.
//
// * Над выделенным текстом в поле сообщения (и в поле правки сообщения)
//   появляется меню: жирный, курсив, зачёркнутый, спойлер, код, заголовок
//   (окно с уровнями 1–6), цитата и цвет текста. Включённое у выделения
//   форматирование подсвечено; нажатие снимает его.
// * Стрелка в конце меню раскрывает остальное (состояние — в localStorage):
//   выделение цветом (\colorbox), подчёркнутый (\underline), размер, ссылка
//   [текст](адрес), время <t:…:f>, блок кода с языком, списки (маркированный,
//   нумерованный, задачи), разделитель *** и таблица GFM.
// * Кнопки пишут разметку for-web: **жирный**, *курсив*, ~~зачёркнутый~~,
//   ||спойлер||, `код`, «> » в начале строк — цитата. Разметка не переходит
//   через строки, поэтому многострочное выделение размечается построчно.
// * Цвета в разметке Stoat нет, но for-web показывает у всех формулы KaTeX —
//   цветной текст пишется формулой:
//   $$\color{#e5534b}\small\textsf{Привет, }\allowbreak\textsf{мир}$$.
//   \small — размер как у текста чата (KaTeX сам крупнее на 21%); каждое слово
//   — свой \textsf через \allowbreak, иначе длинный цветной текст не
//   переносится на новую строку. Жирный, курсив, зачёркнутый и код внутри
//   выделения становятся командами KaTeX (\textbf, \textit, \sout, \texttt),
//   а упоминания, каналы, свои эмодзи и ссылки остаются снаружи формулы: в
//   ней они не работают. «Без цвета» возвращает обычную разметку.
// * Поле ввода for-web — CodeMirror 6 (TextEditor2). Правка идёт транзакцией
//   редактора: попадает в его историю (Ctrl+Z отменяет), выделение остаётся
//   на тексте. Редактор находится так же, как EditorView.findFromDOM: по
//   ссылке, которую CodeMirror оставляет на элементе .cm-content (cmView до
//   версии 6.39, cmTile после).
// * Настройка `live_formatting` — форматирование прямо в поле ввода: символы
//   разметки спрятаны, цветной текст виден цветом (см. раздел ниже).
// * Настройка `colored_text_font` — цветной текст в сообщениях шрифтом и
//   размером чата (см. раздел ниже).
(() => {
  "use strict";

  const i18n = window.__arachnidI18n;
  const text = i18n.text("formatting");

  const STYLE_ID = "arachnid-format-style";
  const MENU_CLASS = "arachnid-format-menu";
  const PALETTE_CLASS = "arachnid-format-palette";
  /** Отступ меню от выделения и от краёв окна, px */
  const GAP = 8;

  /** Кнопки меню; "|" — разделитель; extra — видны, когда меню развёрнуто стрелкой */
  const BUTTONS = [
    { kind: "bold", icon: "format_bold" },
    { kind: "italic", icon: "format_italic" },
    { kind: "strike", icon: "format_strikethrough" },
    "|",
    { kind: "spoiler", icon: "visibility_off" },
    { kind: "code", icon: "code" },
    "|",
    { kind: "heading", icon: "title" },
    { kind: "quote", icon: "format_quote" },
    "|",
    { kind: "color", icon: "palette" },
    { kind: "highlight", icon: "format_ink_highlighter", extra: true },
    { kind: "underline", icon: "format_underlined", extra: true },
    { kind: "size", icon: "format_size", extra: true },
    { separator: true, extra: true },
    { kind: "link", icon: "link", extra: true },
    { kind: "time", icon: "schedule", extra: true },
    { separator: true, extra: true },
    { kind: "codeblock", icon: "code_blocks", extra: true },
    { kind: "bullets", icon: "format_list_bulleted", extra: true },
    { kind: "numbers", icon: "format_list_numbered", extra: true },
    { kind: "tasks", icon: "checklist", extra: true },
    { kind: "divider", icon: "horizontal_rule", extra: true },
    { kind: "table", icon: "table", extra: true },
    { kind: "more", icon: "chevron_right" },
  ];
  /** Кнопки, которые открывают окно под собой */
  const POPUP_KINDS = ["color", "highlight", "size", "heading", "link", "time", "codeblock"];

  /** Цвета палитры: читаются и на тёмной, и на светлой теме */
  const SWATCHES = [
    "#e5534b", "#f0883e", "#e3b341", "#57ab5a", "#39c5cf", "#539bf5", "#b083f0", "#e275ad",
    "#ff938a", "#ffb77c", "#f8e3a1", "#8ddb8c", "#96d0ff", "#c9d1ff", "#dcbdfb", "#adbac7",
  ];
  /**
   * Цвета выделения (фона): яркие и тёмные. KaTeX у for-web (0.16.22) не
   * принимает полупрозрачные цвета, поэтому цвет текста на фоне без своего
   * цвета подбирается сам — светлый или тёмный (см. contrastText).
   */
  const HIGHLIGHTS = [
    "#e5534b", "#f0883e", "#e3b341", "#57ab5a", "#39c5cf", "#539bf5", "#b083f0", "#e275ad",
    "#6e2622", "#6b3a14", "#5f4a12", "#24502a", "#14535a", "#1f4273", "#47307a", "#6a2850",
  ];
  /** Размеры текста KaTeX: \small — обычный (как текст чата) */
  const SIZES = ["footnotesize", "small", "large", "Large", "huge"];
  const BASE_SIZE = "small";
  const SIZE_LABELS = {
    footnotesize: "sizeSmaller",
    small: "sizeNormal",
    large: "sizeLarge",
    Large: "sizeLarger",
    huge: "sizeHuge",
  };
  /** Размер относительно текста чата: в поле ввода и при «обычном шрифте» */
  const SIZE_EM = { footnotesize: 0.8, small: 1, large: 1.2, Large: 1.44, huge: 2.07 };
  /** Языки в окне «Блок кода» (имена highlight.js, которым подсвечивает for-web) */
  const LANGUAGES = [
    "js", "ts", "python", "rust", "json", "html", "css", "bash",
    "csharp", "cpp", "java", "go", "sql", "yaml", "diff", "lua",
  ];
  /** Форматы времени <t:…:f> for-web ("" — без буквы: дата и время) */
  const TIME_FORMATS = [
    { format: "t", label: "formatTime", options: { hour: "2-digit", minute: "2-digit" } },
    { format: "T", label: "formatTimeSeconds", options: { hour: "2-digit", minute: "2-digit", second: "2-digit" } },
    { format: "D", label: "formatDate", options: { day: "numeric", month: "long", year: "numeric" } },
    {
      format: "",
      label: "formatDateTime",
      options: { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" },
    },
    {
      format: "F",
      label: "formatFull",
      options: { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" },
    },
    { format: "R", label: "formatRelative" },
  ];

  const MARKS = { bold: "**", italic: "*", strike: "~~", spoiler: "||", code: "`" };
  /** Уровни заголовков в окне «Заголовок» (# … ######) */
  const HEADINGS = [1, 2, 3, 4, 5, 6];
  const QUOTE_PREFIX = "(?:[ \\t]*>[ \\t]?)*";
  const LIST_PREFIX = "(?:[ \\t]*(?:[-*][ \\t]+\\[[ xX]\\]|[-*]|\\d+[.)])[ \\t]+)";
  /** Начало строки: цитата «> », пункт списка, затем заголовок «# » ($1 — до решёток, $2 — решётки) */
  const HEADING = new RegExp(`^(${QUOTE_PREFIX}${LIST_PREFIX}?)(#{1,6})[ \\t]+`);
  /** Разметка начала строки — цитата, пункт списка, заголовок: остаётся вне формулы */
  const LINE_PREFIX = new RegExp(`^${QUOTE_PREFIX}${LIST_PREFIX}?(?:#{1,6}[ \\t]+)?`);
  const LIST_MARKERS = {
    bullets: /^[ \t]*[-*][ \t]+(?!\[[ xX]\][ \t])/,
    tasks: /^[ \t]*[-*][ \t]+\[[ xX]\][ \t]+/,
    numbers: /^[ \t]*\d+[.)][ \t]+/,
  };

  // ─────────────────────────────── KaTeX ───────────────────────────────

  const TEX_ESCAPES = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    $: "\\$",
    "%": "\\%",
    "&": "\\&",
    "#": "\\#",
    _: "\\_",
    "^": "\\textasciicircum{}",
    "~": "\\textasciitilde{}",
  };
  const escapeTex = (value) => value.replace(/[\\{}$%&#_^~]/g, (char) => TEX_ESCAPES[char]);

  /**
   * Стили слова в формуле. Жирный, курсив и подчёркнутый — внутри \textsf,
   * выделение — \colorbox вокруг него, зачёркнутый — \sout снаружи всего:
   * KaTeX у for-web (0.16.22) не пускает \sout в текст (\textsf, \colorbox).
   * Выделение хранится стилем "bg:#rrggbb".
   */
  const STYLES = ["bold", "italic", "underline", "strike"];
  const STYLE_TEX = { bold: "textbf", italic: "textit", underline: "underline", strike: "sout" };
  const TEX_STYLE = { textbf: "bold", textit: "italic", underline: "underline", sout: "strike", texttt: "code" };
  const STYLE_MARK = { bold: "**", italic: "*", strike: "~~", code: "`" };
  const TEX_SYMBOLS = { textbackslash: "\\", textasciicircum: "^", textasciitilde: "~" };
  /** Стили, которых нет в разметке Stoat: с ними текст остаётся формулой */
  const TEX_ONLY = (style) => style === "underline" || style.startsWith("bg:");

  const backgroundOf = (styles) => styles.find((style) => style.startsWith("bg:"))?.slice(3) ?? null;
  const withBackground = (styles, color) => [
    ...styles.filter((style) => !style.startsWith("bg:")),
    ...(color ? [`bg:${color}`] : []),
  ];

  /** Цвет текста на фоне color (#rgb / #rrggbb), когда своего цвета нет */
  function contrastText(color) {
    let hex = color.replace("#", "");
    if (hex.length === 3) hex = [...hex].map((char) => char + char).join("");
    const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
    if ([r, g, b].some(Number.isNaN)) return "#ffffff";
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? "#1b1b21" : "#ffffff";
  }

  const sameStyles = (a, b) => a.length === b.length && a.every((style) => b.includes(style));

  /** Соседние куски [{ text, styles }] с одинаковыми стилями — в один */
  function merge(segments) {
    const out = [];
    for (const segment of segments) {
      const last = out.at(-1);
      if (last && sameStyles(last.styles, segment.styles)) last.text += segment.text;
      else if (segment.text) out.push({ text: segment.text, styles: [...segment.styles] });
    }
    return out;
  }

  /** Разметка → куски [{ text, styles }] (жирный, курсив, зачёркнутый, код) */
  function markdownSegments(value, styles = []) {
    const out = [];
    const pattern = /\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|~~(.+?)~~|\*(.+?)\*|`([^`]+)`|[^*~`]+|[*~`]/g;
    for (const [match, both, bold, strike, italic, code] of value.matchAll(pattern)) {
      if (both != null) out.push(...markdownSegments(both, [...styles, "bold", "italic"]));
      else if (bold != null) out.push(...markdownSegments(bold, [...styles, "bold"]));
      else if (strike != null) out.push(...markdownSegments(strike, [...styles, "strike"]));
      else if (italic != null) out.push(...markdownSegments(italic, [...styles, "italic"]));
      else if (code != null) out.push({ text: code, styles: [...styles, "code"] });
      else out.push({ text: match, styles });
    }
    return merge(out);
  }

  /**
   * Куски → тело формулы: слово с пробелом после него — свой \textsf.
   * color — цвет всего куска: без него текст на фоне получает свой цвет.
   */
  function segmentsTex(segments, color) {
    const words = [];
    for (const { text: value, styles } of segments) {
      for (const word of value.match(/\S+\s*|\s+/g) ?? []) {
        // пробел в начале куска — к предыдущему слову
        if (!word.trim() && words.length) {
          words[words.length - 1] = words.at(-1).replace(/\}+$/, (end) => word + end);
          continue;
        }
        let tex = escapeTex(word);
        for (const style of ["underline", "italic", "bold"]) {
          if (styles.includes(style)) tex = `\\${STYLE_TEX[style]}{${tex}}`;
        }
        tex = `\\${styles.includes("code") ? "texttt" : "textsf"}{${tex}}`;
        const background = backgroundOf(styles);
        if (background) {
          if (!color) tex = `\\textcolor{${contrastText(background)}}{${tex}}`;
          tex = `\\colorbox{${background}}{${tex}}`;
        }
        if (styles.includes("strike")) tex = `\\sout{${tex}}`;
        words.push(tex);
      }
    }
    return words.join("\\allowbreak");
  }

  /** Индекс скобки, закрывающей `{` на месте open (\{ и \} не считаются) */
  function closingBrace(value, open) {
    let depth = 0;
    for (let index = open; index < value.length; index++) {
      const char = value[index];
      if (char === "\\") index += 1;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) return index;
    }
    return -1;
  }

  /** Тело формулы → куски [{ text, styles }] */
  function texSegments(tex, styles = []) {
    const out = [];
    for (let index = 0; index < tex.length; ) {
      const char = tex[index];
      if (char === "\\") {
        const command = /^\\([a-zA-Z]+)\s*/.exec(tex.slice(index));
        if (!command) {
          out.push({ text: tex[index + 1] ?? "", styles });
          index += 2;
          continue;
        }
        index += command[0].length;
        const name = command[1];
        if (name in TEX_SYMBOLS) {
          out.push({ text: TEX_SYMBOLS[name], styles });
          if (tex.startsWith("{}", index)) index += 2;
          continue;
        }
        if (tex[index] !== "{") continue;
        let inner = styles;
        if (name === "colorbox" || name === "textcolor") {
          // первый аргумент — цвет: фон куска или цвет текста на фоне
          const end = closingBrace(tex, index);
          if (end < 0) break;
          if (name === "colorbox") inner = withBackground(styles, tex.slice(index + 1, end).trim());
          index = end + 1;
          while (tex[index] === " ") index += 1;
          if (tex[index] !== "{") continue;
        } else if (TEX_STYLE[name]) {
          inner = [...styles, TEX_STYLE[name]];
        }
        const end = closingBrace(tex, index);
        const close = end < 0 ? tex.length : end;
        out.push(...texSegments(tex.slice(index + 1, close), inner));
        index = close + 1;
        continue;
      }
      if (char !== "{" && char !== "}") out.push({ text: char, styles });
      index += 1;
    }
    return merge(out);
  }

  /** Куски → разметка; пробелы по краям — снаружи **…** */
  function segmentsMarkdown(segments) {
    return segments
      .map(({ text: value, styles }) => {
        const marks = (styles.includes("code") ? ["code"] : styles)
          .map((style) => STYLE_MARK[style] ?? "")
          .join("");
        if (!marks || !value.trim()) return value;
        const lead = /^\s*/.exec(value)[0];
        const trail = /\s*$/.exec(value)[0];
        return `${lead}${marks}${value.trim()}${[...marks].reverse().join("")}${trail}`;
      })
      .join("");
  }

  /**
   * Кусок { color, size } с текстом segments: формула, если есть что-то,
   * чего нет в разметке Stoat (цвет, размер, подчёркнутый, выделение), иначе
   * обычная разметка.
   */
  function spanText({ color, size }, segments) {
    const tex = color || size !== BASE_SIZE || segments.some((segment) => segment.styles.some(TEX_ONLY));
    if (!tex) return segmentsMarkdown(segments);
    return `$$${color ? `\\color{${color}}` : ""}\\${size}${segmentsTex(segments, color)}$$`;
  }

  /**
   * Формулы, которые пишет меню: [{ from, to, color, size, contentFrom, contentTo }].
   * Начало — \color и/или размер, за ними слова (\textsf, \texttt, \colorbox,
   * \sout); цветной текст первых версий меню — \color без размера.
   */
  function texSpans(doc) {
    const spans = [];
    const start = new RegExp(
      `\\$\\$(?:\\\\color\\{([^{}$]+)\\})?(?:\\\\(${SIZES.join("|")})(?![a-zA-Z]))?(?=\\\\(?:textsf|texttt|colorbox|sout)\\{)`,
      "g",
    );
    for (let match; (match = start.exec(doc)); ) {
      if (match[0] === "$$") {
        start.lastIndex = match.index + 2;
        continue;
      }
      const contentFrom = match.index + match[0].length;
      const close = doc.indexOf("$$", contentFrom);
      if (close < 0) break;
      spans.push({
        from: match.index,
        to: close + 2,
        color: match[1] ?? null,
        size: match[2] ?? BASE_SIZE,
        contentFrom,
        contentTo: close,
      });
      start.lastIndex = close + 2;
    }
    return spans;
  }

  const spanAt = (doc, from, to) => texSpans(doc).find((span) => span.from <= from && to <= span.to);
  const spanSegments = (doc, span) => texSegments(doc.slice(span.contentFrom, span.contentTo));
  const spanProps = (span) => ({ color: span.color, size: span.size });

  /** То, что в формуле не работает: упоминания, каналы, свои эмодзи, ссылки */
  const KEEP_OUT = /<[@#%][^>\s]+>|<t:\d+(?::\w)?>|:[A-Za-z0-9_]+:|\[[^\]\n]*\]\([^)\s]*\)|https?:\/\/\S+/g;

  /** Строка текста → формулы с change(props, segments) → [props, segments] */
  function texLine(line, change) {
    const parts = [];
    let last = 0;
    for (const match of line.matchAll(KEEP_OUT)) {
      parts.push([line.slice(last, match.index), true], [match[0], false]);
      last = match.index + match[0].length;
    }
    parts.push([line.slice(last), true]);
    return parts
      .map(([part, styled]) => {
        if (!styled || !part.trim()) return part;
        const lead = /^\s*/.exec(part)[0];
        const trail = /\s*$/.exec(part)[0];
        const [props, segments] = change({ color: null, size: BASE_SIZE }, markdownSegments(part.trim()));
        return `${lead}${spanText(props, merge(segments))}${trail}`;
      })
      .join("");
  }

  // ────────────────────────────── разметка ──────────────────────────────

  /** Сколько одинаковых символов char стоит и слева от from, и справа от to */
  function runs(doc, from, to, char) {
    let left = 0;
    while (doc[from - 1 - left] === char) left += 1;
    let right = 0;
    while (doc[to + right] === char) right += 1;
    return Math.min(left, right);
  }

  /** Выделение без пробелов по краям: «** жирный**» разметка не примет */
  function trimmed(doc, from, to) {
    while (from < to && /\s/.test(doc[from])) from += 1;
    while (to > from && /\s/.test(doc[to - 1])) to -= 1;
    return [from, to];
  }

  const lineStart = (doc, at) => doc.lastIndexOf("\n", at - 1) + 1;
  const lineEnd = (doc, at) => {
    const end = doc.indexOf("\n", at);
    return end < 0 ? doc.length : end;
  };
  /** Строки выделения целиком: { start, end, lines } */
  function linesOf(doc, from, to) {
    const start = lineStart(doc, from);
    const end = lineEnd(doc, Math.max(from, to - 1));
    return { start, end, lines: doc.slice(start, end).split("\n") };
  }
  /** Правка строк выделения: выделение — все строки */
  const lineChange = (start, end, insert) => ({ from: start, to: end, insert, anchor: start, head: start + insert.length });
  const quoteOf = (line) => new RegExp(`^${QUOTE_PREFIX}`).exec(line)[0];
  const hasText = (line) => Boolean(line.slice(quoteOf(line).length).trim());

  /** Ссылка [текст](адрес), в которой выделение: { from, to, label, url } */
  function linkAt(doc, from, to) {
    for (const match of doc.matchAll(/\[([^\]\n]*)\]\(([^)\s]*)\)/g)) {
      const end = match.index + match[0].length;
      if (match.index <= from && to <= end) return { from: match.index, to: end, label: match[1], url: match[2] };
    }
    return null;
  }

  /** Время <t:…>, в котором выделение: { from, to, seconds, format } */
  function timeAt(doc, from, to) {
    for (const match of doc.matchAll(/<t:(\d+)(?::(\w))?>/g)) {
      const end = match.index + match[0].length;
      if (match.index <= from && to <= end) {
        return { from: match.index, to: end, seconds: Number(match[1]), format: match[2] ?? "" };
      }
    }
    return null;
  }

  /** Блок кода, внутри которого выделение: { start, end, language } (строки ``` включительно) */
  function codeBlockAt(doc, from, to) {
    let open = null;
    let at = 0;
    for (const line of doc.split("\n")) {
      const end = at + line.length;
      if (!open) {
        const fence = /^```([\w#+.-]*)[ \t]*$/.exec(line);
        if (fence) open = { start: at, contentFrom: end + 1, language: fence[1] };
      } else if (/^```[ \t]*$/.test(line)) {
        if (open.contentFrom <= from && to <= at) return { start: open.start, end, language: open.language };
        open = null;
      }
      at = end + 1;
    }
    return null;
  }

  /** Включено ли форматирование kind у выделения */
  function isActive(doc, from, to, kind) {
    [from, to] = trimmed(doc, from, to);
    if (kind === "quote") return linesOf(doc, from, to).lines.every((line) => line.startsWith(">"));
    if (kind === "heading") return headingLevels(doc, from, to).some(Boolean);
    if (kind in LIST_MARKERS) {
      const lines = linesOf(doc, from, to).lines.filter(hasText);
      return lines.length > 0 && lines.every((line) => LIST_MARKERS[kind].test(line.slice(quoteOf(line).length)));
    }
    if (kind === "codeblock") return Boolean(codeBlockAt(doc, from, to));
    if (kind === "link") return Boolean(linkAt(doc, from, to));
    if (kind === "time") return Boolean(timeAt(doc, from, to));
    if (kind === "divider" || kind === "table" || kind === "more") return false;
    const span = spanAt(doc, from, to);
    if (kind === "color") return Boolean(span?.color);
    if (kind === "size") return Boolean(span) && span.size !== BASE_SIZE;
    if (kind === "highlight") return Boolean(span) && spanSegments(doc, span).some((segment) => backgroundOf(segment.styles));
    if (span && STYLES.includes(kind)) {
      return spanSegments(doc, span).every((segment) => !segment.text.trim() || segment.styles.includes(kind));
    }
    if (kind === "underline") return false;
    const mark = MARKS[kind];
    const selected = doc.slice(from, to);
    if (kind === "italic") {
      const around = runs(doc, from, to, "*");
      const inside = /^\*+/.exec(selected)?.[0].length ?? 0;
      return around % 2 === 1 || (around === 0 && inside % 2 === 1 && selected.endsWith("*".repeat(inside)));
    }
    if (kind === "bold") {
      return runs(doc, from, to, "*") >= 2 || (selected.length > 4 && selected.startsWith("**") && selected.endsWith("**"));
    }
    return (
      (doc.slice(from - mark.length, from) === mark && doc.slice(to, to + mark.length) === mark) ||
      (selected.length > mark.length * 2 && selected.startsWith(mark) && selected.endsWith(mark))
    );
  }

  /**
   * Правка, которая переключает форматирование kind у выделения:
   * { from, to, insert, anchor, head } — что заменить и что потом выделить.
   */
  function toggle(doc, from, to, kind) {
    if (kind === "quote") return toggleQuote(doc, from, to);
    if (kind in LIST_MARKERS) return toggleList(doc, from, to, kind);
    if (kind === "divider") return insertDivider(doc, from, to);
    if (kind === "table") return makeTable(doc, from, to);
    if (kind === "underline") {
      const on = isActive(doc, from, to, "underline");
      return restyle(doc, from, to, (props, segments) => [props, toggleStyle(segments, "underline", on)], !on);
    }
    [from, to] = trimmed(doc, from, to);
    const span = spanAt(doc, from, to);
    if (span) {
      if (STYLES.includes(kind)) return toggleTex(doc, span, kind);
      // спойлер и код — вокруг всего цветного куска
      [from, to] = [span.from, span.to];
    }
    const mark = MARKS[kind];
    if (from === to) return null;
    const selected = doc.slice(from, to);
    const active = isActive(doc, from, to, kind) && (kind !== "italic" || runs(doc, from, to, "*") !== 2);
    if (active) {
      if (doc.slice(from - mark.length, from) === mark && doc.slice(to, to + mark.length) === mark) {
        return {
          from: from - mark.length,
          to: to + mark.length,
          insert: selected,
          anchor: from - mark.length,
          head: to - mark.length,
        };
      }
      const inner = selected.slice(mark.length, selected.length - mark.length);
      return { from, to, insert: inner, anchor: from, head: from + inner.length };
    }
    const insert = selected
      .split("\n")
      .map((line) => {
        const [a, b] = trimmed(line, 0, line.length);
        return a === b ? line : `${line.slice(0, a)}${mark}${line.slice(a, b)}${mark}${line.slice(b)}`;
      })
      .join("\n");
    const single = !selected.includes("\n");
    return {
      from,
      to,
      insert,
      anchor: single ? from + mark.length : from,
      head: single ? to + mark.length : from + insert.length,
    };
  }

  /** Уровни заголовков у непустых строк выделения (0 — не заголовок) */
  function headingLevels(doc, from, to) {
    return linesOf(doc, from, to)
      .lines.filter(hasText)
      .map((line) => HEADING.exec(line)?.[2].length ?? 0);
  }

  /** Общий уровень заголовка у строк выделения; 0 — нет или разные */
  function headingLevel(doc, from, to) {
    const levels = headingLevels(doc, from, to);
    return levels.length && levels.every((level) => level === levels[0]) ? levels[0] : 0;
  }

  /**
   * Заголовок уровня level у строк выделения; тот же уровень ещё раз или
   * level = 0 — обычный текст. Цитата «> » и пункт списка остаются перед решётками.
   */
  function toggleHeading(doc, from, to, level) {
    [from, to] = trimmed(doc, from, to);
    if (level && headingLevel(doc, from, to) === level) level = 0;
    const { start, end, lines } = linesOf(doc, from, to);
    const insert = lines
      .map((line) => {
        const prefix = new RegExp(`^${QUOTE_PREFIX}${LIST_PREFIX}?`).exec(line)[0];
        const rest = line.slice(prefix.length).replace(/^#{1,6}[ \t]+/, "");
        return rest.trim() && level ? `${prefix}${"#".repeat(level)} ${rest}` : prefix + rest;
      })
      .join("\n");
    if (insert === doc.slice(start, end)) return null;
    return lineChange(start, end, insert);
  }

  function toggleQuote(doc, from, to) {
    const { start, end, lines } = linesOf(doc, from, to);
    const quoted = lines.every((line) => line.startsWith(">"));
    const insert = lines.map((line) => (quoted ? line.replace(/^> ?/, "") : `> ${line}`)).join("\n");
    return lineChange(start, end, insert);
  }

  /** Список kind (bullets, numbers, tasks) у строк выделения; включённый — снимается */
  function toggleList(doc, from, to, kind) {
    [from, to] = trimmed(doc, from, to);
    const on = isActive(doc, from, to, kind);
    const { start, end, lines } = linesOf(doc, from, to);
    let number = 0;
    const insert = lines
      .map((line) => {
        if (!hasText(line)) return line;
        const quote = quoteOf(line);
        const rest = line.slice(quote.length).replace(new RegExp(`^${LIST_PREFIX}`), "");
        if (on) return quote + rest;
        number += 1;
        const marker = kind === "bullets" ? "- " : kind === "tasks" ? "- [ ] " : `${number}. `;
        return `${quote}${marker}${rest}`;
      })
      .join("\n");
    return lineChange(start, end, insert);
  }

  /** Разделитель (***) строкой после строк выделения; --- под текстом стал бы заголовком */
  function insertDivider(doc, from, to) {
    const { end, lines } = linesOf(doc, from, to);
    const insert = `\n${quoteOf(lines.at(-1))}***`;
    return { from: end, to: end, insert, anchor: from, head: to };
  }

  /**
   * Строки выделения → таблица: первая строка — заголовки, ячейки делятся
   * табуляцией (как при вставке из таблиц), «;» или «|».
   */
  function makeTable(doc, from, to) {
    [from, to] = trimmed(doc, from, to);
    if (from === to) return null;
    const { start, end, lines } = linesOf(doc, from, to);
    const quote = quoteOf(lines[0]);
    const rows = lines
      .filter(hasText)
      .map((line) => line.slice(quoteOf(line).length).trim().replace(/^\||\|$/g, "").split(/\t|;|\|/).map((cell) => cell.trim()));
    const columns = Math.max(...rows.map((row) => row.length));
    if (rows.length === 1) rows.push([]);
    const row = (cells) => `${quote}| ${Array.from({ length: columns }, (_, at) => cells[at] ?? "").join(" | ")} |`;
    const insert = [row(rows[0]), `${quote}|${" --- |".repeat(columns)}`, ...rows.slice(1).map(row)].join("\n");
    return lineChange(start, end, insert);
  }

  /** Блок кода на языке language вокруг строк выделения; null — убрать блок */
  function toggleCodeBlock(doc, from, to, language) {
    [from, to] = trimmed(doc, from, to);
    const block = codeBlockAt(doc, from, to);
    if (block) {
      const inner = doc.slice(lineEnd(doc, block.start) + 1, lineStart(doc, block.end));
      const body = inner.endsWith("\n") ? inner.slice(0, -1) : inner;
      const insert = language == null ? body : `\`\`\`${language}\n${body}\n\`\`\``;
      return lineChange(block.start, block.end, insert);
    }
    if (language == null) return null;
    const { start, end } = linesOf(doc, from, to);
    return lineChange(start, end, `\`\`\`${language}\n${doc.slice(start, end)}\n\`\`\``);
  }

  /** Ссылка на url у выделения; пустой url — убрать ссылку, оставить текст */
  function setLink(doc, from, to, url) {
    [from, to] = trimmed(doc, from, to);
    const link = linkAt(doc, from, to);
    if (link) {
      const insert = url ? `[${link.label}](${url})` : link.label;
      return { from: link.from, to: link.to, insert, anchor: link.from, head: link.from + insert.length };
    }
    if (!url || from === to) return null;
    const label = doc.slice(from, to).replace(/[[\]]/g, "\\$&");
    const insert = `[${label}](${url})`;
    return { from, to, insert, anchor: from, head: from + insert.length };
  }

  /** Время <t:секунды:формат> вместо выделения (или вместо прежнего времени) */
  function setTime(doc, from, to, seconds, format) {
    [from, to] = trimmed(doc, from, to);
    const time = timeAt(doc, from, to);
    if (time) [from, to] = [time.from, time.to];
    const insert = `<t:${seconds}${format ? `:${format}` : ""}>`;
    return { from, to, insert, anchor: from, head: from + insert.length };
  }

  /** Стиль kind у всех кусков: on — снять, иначе добавить */
  const toggleStyle = (segments, kind, on) =>
    segments.map(({ text: value, styles }) => ({
      text: value,
      styles: on ? styles.filter((style) => style !== kind) : styles.includes(kind) ? styles : [...styles, kind],
    }));

  /** Жирный, курсив, зачёркнутый у формулы — командами KaTeX у всех слов */
  function toggleTex(doc, span, kind) {
    const segments = spanSegments(doc, span);
    const on = segments.every((segment) => !segment.text.trim() || segment.styles.includes(kind));
    const insert = spanText(spanProps(span), merge(toggleStyle(segments, kind, on)));
    return { from: span.from, to: span.to, insert, anchor: span.from, head: span.from + insert.length };
  }

  /**
   * Правка формул у выделения: change(props, segments) → [props, segments].
   * Затронутые формулы меняются целиком; если формул нет и create — текст
   * выделения становится формулой (разметка вокруг — тоже: снаружи формулы
   * она на неё не действует).
   */
  function restyle(doc, from, to, change, create) {
    [from, to] = trimmed(doc, from, to);
    for (let mark; create; from -= mark.length, to += mark.length) {
      mark = ["**", "~~", "*"].find((m) => doc.slice(from - m.length, from) === m && doc.slice(to, to + m.length) === m);
      if (!mark) break;
    }
    const touched = texSpans(doc).filter((span) => span.from < Math.max(to, from + 1) && span.to > from);
    if (touched.length) {
      const start = Math.min(from, touched[0].from);
      const end = Math.max(to, touched.at(-1).to);
      let insert = "";
      let at = start;
      for (const span of touched) {
        insert += doc.slice(at, span.from);
        const [props, segments] = change(spanProps(span), spanSegments(doc, span));
        insert += spanText(props, merge(segments));
        at = span.to;
      }
      insert += doc.slice(at, end);
      return { from: start, to: end, insert, anchor: start, head: start + insert.length };
    }
    if (!create || from === to) return null;
    let at = from;
    const insert = doc
      .slice(from, to)
      .split("\n")
      .map((line) => {
        // «> », «- », «# » в начале строки — разметка строки, не текст
        const prefix = at === lineStart(doc, at) ? LINE_PREFIX.exec(line)[0] : "";
        at += line.length + 1;
        return prefix + texLine(line.slice(prefix.length), change);
      })
      .join("\n");
    return { from, to, insert, anchor: from, head: from + insert.length };
  }

  /** Цвет текста color (`#rrggbb`) у выделения; null — снять цвет */
  const paint = (doc, from, to, color) => restyle(doc, from, to, (props, segments) => [{ ...props, color }, segments], Boolean(color));

  /** Выделение цветом (фон) у выделения; null — снять */
  const highlight = (doc, from, to, color) =>
    restyle(
      doc,
      from,
      to,
      (props, segments) => [props, segments.map((segment) => ({ ...segment, styles: withBackground(segment.styles, color) }))],
      Boolean(color),
    );

  /** Размер текста у выделения; \small — обычный */
  const resize = (doc, from, to, size) =>
    restyle(doc, from, to, (props, segments) => [{ ...props, size }, segments], size !== BASE_SIZE);

  // ─────────────────────────────── редактор ───────────────────────────────

  /** EditorView редактора с элементом .cm-content (как EditorView.findFromDOM) */
  function editorOf(content) {
    const view = content?.cmView?.rootView?.view ?? content?.cmTile?.root?.view ?? null;
    return view?.state && typeof view.dispatch === "function" ? view : null;
  }

  /** EditorView поля ввода, в котором стоит фокус; null — фокус не в редакторе */
  const focusedEditor = () => editorOf(document.activeElement?.closest?.(".cm-content"));

  /** Выделение редактора: { view, from, to, doc } или null, если выделения нет */
  function selection() {
    // фокус может быть в окне цвета — тогда у редактора, где открыто меню
    const view = focusedEditor() ?? (palette ? editor : null);
    if (!view) return null;
    const { from, to } = view.state.selection.main;
    if (from === to) return null;
    return { view, from, to, doc: view.state.doc.toString() };
  }

  /** Применить правку к редактору одной транзакцией */
  function edit(make) {
    const current = selection();
    if (!current) return;
    const change = make(current.doc, current.from, current.to);
    if (!change) return;
    current.view.dispatch({
      changes: { from: change.from, to: change.to, insert: change.insert },
      selection: { anchor: change.anchor, head: change.head },
      userEvent: "input.format",
      scrollIntoView: true,
    });
    current.view.focus();
    schedule();
  }

  // ─────────────────────── форматирование в поле ввода ───────────────────────
  // Настройка `live_formatting`: текст в поле выглядит как в сообщении.
  // for-web уже рисует жирный, курсив, зачёркнутый, код и спойлер в поле
  // (подсветка разметки CodeMirror), но оставляет символы разметки. Эта часть
  // прячет их декорациями редактора (Decoration.replace — текст поля не
  // меняется), а цветной текст показывает цветом вместо формулы. Символы
  // видны снова, пока курсор стоит в размеченном куске или рядом с ним, —
  // чтобы их можно было править; поле без фокуса показывает всё готовым.
  //
  // Расширение добавляется в редактор for-web (StateEffect.appendConfig) и
  // должно быть из того же экземпляра CodeMirror, что и редактор: класс
  // EditorView — конструктор самого редактора, StateEffect — класс эффекта,
  // который он создаёт (EditorView.scrollIntoView), а Decoration — класс
  // декораций, которые редактор for-web уже показывает (подсказка в пустом
  // поле, эмодзи, упоминания).

  const LIVE_STYLE_ID = "arachnid-live-format-style";
  const LIVE_CSS = `
/* цветной текст в поле — без оформления кода, которым for-web выделяет
   формулы (.md-code со своим цветом и фоном): цвет и стиль — у декорации */
.cm-content .arachnid-live-color,
.cm-content .arachnid-live-color :is(.md-code, *),
.cm-content .md-code:has(.arachnid-live-color) {
  font-family: inherit;
  color: inherit;
  padding: 0;
  background: none;
}
/* команда KaTeX вроде \\textasciitilde{} видна символом: свой текст скрыт
   нулевым размером, символ — размером шрифта поля */
@property --arachnid-live-size {
  syntax: "<length>";
  inherits: true;
  initial-value: 0px;
}
.cm-content { --arachnid-live-size: 1em; }
.cm-content .arachnid-live-symbol { font-size: 0; }
.cm-content .arachnid-live-symbol::before {
  content: attr(data-symbol);
  font-size: var(--arachnid-live-size);
}
`;

  let liveOn = plugin.settings.live_formatting !== false;
  /** Классы CodeMirror страницы — после первой встречи с редактором */
  let cm = null;
  /** Редакторы, в которые уже добавлено расширение */
  const extended = new WeakSet();
  /** Декорации цвета по стилю (и символу): { "color:#e5534b;font-weight:bold": Decoration } */
  const colorMarks = new Map();

  const isDecorationClass = (value) =>
    typeof value === "function" &&
    ["mark", "replace", "widget", "set"].every((name) => typeof value[name] === "function");

  /** Класс Decoration из декорации value (у неё класс-наследник) */
  function decorationClass(value) {
    for (let type = value?.constructor; type && type !== Object; type = Object.getPrototypeOf(type)) {
      if (isDecorationClass(type)) return type;
    }
    return null;
  }

  /** Первая декорация в наборе (RangeSet) */
  function firstDecoration(set) {
    try {
      return typeof set?.iter === "function" ? set.iter().value : null;
    } catch {
      return null;
    }
  }

  /**
   * Класс Decoration — из декораций, которые редактор показывает или хранит
   * в своих дополнениях (у подсказки пустого поля набор есть всегда).
   */
  function findDecoration(view) {
    const EditorView = view.constructor;
    const instances = [];
    // дополнения (ViewPlugin) отдают декорации функцией от редактора:
    // view.plugin(дополнение) — их экземпляры тоже просматриваются
    const probe = new Proxy(view, {
      get(target, key) {
        if (key === "plugin") {
          return (spec) => {
            const instance = target.plugin(spec);
            if (instance) instances.push(instance);
            return instance;
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    for (const facet of [EditorView.decorations, EditorView.outerDecorations].filter(Boolean)) {
      for (const source of view.state.facet(facet)) {
        let set = source;
        try {
          if (typeof source === "function") set = source(probe);
        } catch {
          continue;
        }
        const type = decorationClass(firstDecoration(set));
        if (type) return type;
      }
    }
    for (const instance of instances) {
      for (const value of Object.values(instance)) {
        const type = decorationClass(firstDecoration(value));
        if (type) return type;
      }
    }
    return null;
  }

  function codemirror(view) {
    if (cm) return cm;
    const EditorView = view.constructor;
    const StateEffect = EditorView.scrollIntoView?.(0)?.constructor;
    const Decoration = findDecoration(view);
    if (!Decoration || typeof StateEffect?.appendConfig?.of !== "function") return null;
    cm = { EditorView, StateEffect, Decoration, hidden: Decoration.replace({}) };
    return cm;
  }

  /** Добавить расширение в редактор; false — классы CodeMirror ещё не найдены */
  function extend(view) {
    if (!view || extended.has(view)) return true;
    const classes = codemirror(view);
    if (!classes) return false;
    view.dispatch({
      effects: classes.StateEffect.appendConfig.of(classes.EditorView.decorations.of(liveDecorations)),
    });
    extended.add(view);
    return true;
  }

  /** Добавить расширение во все редакторы на странице */
  function extendAll() {
    for (const content of document.querySelectorAll(".cm-content")) extend(editorOf(content));
  }

  /** То же на следующем кадре: не посреди обновления редактора, раз за кадр */
  let extendFrame = 0;
  function scheduleExtend() {
    if (extendFrame) return;
    extendFrame = requestAnimationFrame(() => {
      extendFrame = 0;
      if (liveOn) extendAll();
    });
  }

  /** Перерисовать декорации во всех редакторах (настройку переключили) */
  function refreshEditors() {
    for (const content of document.querySelectorAll(".cm-content")) {
      const view = editorOf(content);
      if (view && extended.has(view)) view.dispatch({});
    }
  }

  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** Разметка в одну строку: маркер, затем не пробел … не пробел, маркер */
  const DELIMITERS = ["***", "**", "~~", "||", "*"].map((mark) => {
    const m = escapeRegExp(mark);
    return new RegExp(`(?<!\\\\)${m}(?=[^\\s*])([^\\n]*?[^\\s\\\\])${m}`, "g");
  });
  // _курсив_ — только не внутри слова (snake_case)
  DELIMITERS.push(/(?<![\\\p{L}\p{N}_])_(?=\S)([^\n]*?[^\s\\])_(?![\p{L}\p{N}_])/gu);

  /**
   * Размеченные куски поля: [{ from, to, hide: [[from, to]…], marks: [[from, to, style]…] }].
   * Найденные маркеры закрываются в копии текста, чтобы не попасть в
   * следующие правила; код и формулы закрываются целиком.
   */
  function parseLive(doc) {
    const pieces = [];
    let masked = doc;
    const mask = (from, to) => {
      masked = masked.slice(0, from) + "\0".repeat(to - from) + masked.slice(to);
    };
    // ссылка [текст](адрес): видна текстом ссылки
    for (const match of doc.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
      const from = match.index;
      const to = from + match[0].length;
      const labelEnd = from + 1 + match[1].length;
      pieces.push({ from, to, hide: [[from, from + 1], [labelEnd, to]], marks: [] });
      mask(from, from + 1);
      mask(labelEnd, to);
    }
    // адреса, упоминания, каналы и время — без разметки (https://a.b/_c_)
    for (const match of masked.matchAll(/https?:\/\/\S+|<[@#%:a-zA-Z][^\s>]*>/g)) {
      mask(match.index, match.index + match[0].length);
    }
    for (const match of masked.matchAll(/(?<!\\)`([^`\n]+)`/g)) {
      const from = match.index;
      const to = from + match[0].length;
      pieces.push({ from, to, hide: [[from, from + 1], [to - 1, to]], marks: [] });
      mask(from, to);
    }
    for (const span of texSpans(masked)) {
      pieces.push(texPiece(doc, span));
      mask(span.from, span.to);
    }
    // прочие формулы KaTeX — как есть
    for (const match of masked.matchAll(/\$\$[^\n]+?\$\$/g)) mask(match.index, match.index + match[0].length);
    for (const pattern of DELIMITERS) {
      pattern.lastIndex = 0;
      for (const match of masked.matchAll(pattern)) {
        const from = match.index;
        const to = from + match[0].length;
        const size = (match[0].length - match[1].length) / 2;
        pieces.push({ from, to, hide: [[from, from + size], [to - size, to]], marks: [] });
        mask(from, from + size);
        mask(to - size, to);
      }
    }
    // заголовок: «# » в начале строки (после цитаты и пункта списка)
    for (const match of masked.matchAll(new RegExp(`^(${QUOTE_PREFIX}${LIST_PREFIX}?)(#{1,6}[ \\t]+)(?=\\S)`, "gm"))) {
      const from = match.index + match[1].length;
      const end = lineEnd(doc, match.index);
      pieces.push({ from, to: end, hide: [[from, from + match[2].length]], marks: [] });
    }
    // цитата: «> » в начале строки
    for (const match of masked.matchAll(/^> ?/gm)) {
      const end = lineEnd(doc, match.index);
      pieces.push({ from: match.index, to: end, hide: [[match.index, match.index + match[0].length]], marks: [] });
    }
    return pieces;
  }

  /** Цвет KaTeX → безопасный для CSS (имя или #hex) */
  const cssColor = (color) => (/^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(color) ? color : "inherit");

  /** Стиль текста формулы в поле: цвет и размер куска, стили слова */
  function liveStyle(span, styles) {
    const set = new Set(styles);
    const rules = [];
    if (span.color) rules.push(`color:${cssColor(span.color)}`);
    if (span.size !== BASE_SIZE) rules.push(`font-size:${SIZE_EM[span.size] ?? 1}em`);
    if (set.has("bold")) rules.push("font-weight:bold");
    if (set.has("italic")) rules.push("font-style:italic");
    if (set.has("code")) rules.push("font-family:var(--fonts-monospace,monospace)");
    const lines = [set.has("underline") && "underline", set.has("strike") && "line-through"].filter(Boolean);
    if (lines.length) rules.push(`text-decoration:${lines.join(" ")}`);
    const background = backgroundOf([...set]);
    if (background) {
      rules.push(`background-color:${cssColor(background)}`);
      if (!span.color) rules.push(`color:${contrastText(background)}`);
    }
    return rules.join(";");
  }

  /** Формула меню: команды KaTeX прячутся, текст виден со своим цветом и стилем */
  function texPiece(doc, span) {
    const hide = [[span.from, span.contentFrom], [span.contentTo, span.to]];
    const marks = [];
    // стили открытых скобок: имя стиля, "bg:#…" или null
    const stack = [];
    const style = () => liveStyle(span, stack.filter(Boolean));
    const visible = (from, to) => {
      const current = style();
      const last = marks.at(-1);
      if (last && last[1] === from && last[2] === current && !last[3]) last[1] = to;
      else marks.push([from, to, current]);
    };
    for (let index = span.contentFrom; index < span.contentTo; ) {
      const char = doc[index];
      if (char === "\\") {
        const command = /^\\([a-zA-Z]+)\s*/.exec(doc.slice(index, span.contentTo));
        if (!command) {
          // \{ \} \$ \% … — виден сам символ
          hide.push([index, index + 1]);
          if (index + 1 < span.contentTo) visible(index + 1, index + 2);
          index += 2;
          continue;
        }
        const end = index + command[0].length;
        if (command[1] in TEX_SYMBOLS) {
          // \textbackslash{} и подобные — видны своим символом (через CSS)
          const close = doc.startsWith("{}", end) ? end + 2 : end;
          marks.push([index, close, style(), TEX_SYMBOLS[command[1]]]);
          index = close;
          continue;
        }
        if ((command[1] === "colorbox" || command[1] === "textcolor") && doc[end] === "{") {
          // \colorbox{#цвет}{ — прячется вместе с цветом, текст внутри — на фоне
          const argEnd = closingBrace(doc, end);
          if (argEnd < 0 || argEnd >= span.contentTo || doc[argEnd + 1] !== "{") {
            hide.push([index, end]);
            index = end;
            continue;
          }
          hide.push([index, argEnd + 2]);
          stack.push(command[1] === "colorbox" ? `bg:${doc.slice(end + 1, argEnd).trim()}` : null);
          index = argEnd + 2;
          continue;
        }
        if (doc[end] === "{") {
          hide.push([index, end + 1]);
          stack.push(TEX_STYLE[command[1]] ?? null);
          index = end + 1;
          continue;
        }
        hide.push([index, end]);
        index = end;
        continue;
      }
      if (char === "{" || char === "}") {
        hide.push([index, index + 1]);
        if (char === "{") stack.push(null);
        else stack.pop();
        index += 1;
        continue;
      }
      visible(index, index + 1);
      index += 1;
    }
    return { from: span.from, to: span.to, hide, marks };
  }

  /** Декорации поля: функция от редактора, CodeMirror зовёт её при каждом обновлении */
  function liveDecorations(view) {
    const { Decoration, hidden } = cm;
    if (!liveOn) return Decoration.none;
    // курсор в куске или рядом — кусок как есть (выделение текста не мешает)
    const carets = view.hasFocus
      ? view.state.selection.ranges.filter((range) => range.empty).map((range) => range.head)
      : [];
    const ranges = [];
    for (const piece of parseLive(view.state.doc.toString())) {
      if (carets.some((caret) => caret >= piece.from && caret <= piece.to)) continue;
      for (const [from, to] of piece.hide) if (to > from) ranges.push(hidden.range(from, to));
      for (const [from, to, style, symbol] of piece.marks) {
        const key = symbol ? `${style}|${symbol}` : style;
        if (!colorMarks.has(key)) {
          const attributes = symbol ? { style, "data-symbol": symbol } : { style };
          const className = symbol ? "arachnid-live-color arachnid-live-symbol" : "arachnid-live-color";
          colorMarks.set(key, Decoration.mark({ class: className, attributes }));
        }
        ranges.push(colorMarks.get(key).range(from, to));
      }
    }
    return Decoration.set(ranges, true);
  }

  /** Новые редакторы (поле правки, другой канал) — сразу с расширением */
  const editorWatcher = new MutationObserver((records) => {
    const added = (node) => node.nodeType === 1 && (node.matches(".cm-content") || node.querySelector(".cm-content"));
    if (records.some((record) => [...record.addedNodes].some(added))) scheduleExtend();
  });

  // классы CodeMirror ищутся заново, пока не найдены (поле было не пустым)
  function onEditorFocus(event) {
    if (event.target.closest?.(".cm-content")) scheduleExtend();
  }

  function startLive() {
    if (!document.getElementById(LIVE_STYLE_ID)) {
      const style = document.createElement("style");
      style.id = LIVE_STYLE_ID;
      style.textContent = LIVE_CSS;
      document.head.append(style);
    }
    document.addEventListener("focusin", onEditorFocus, true);
    document.addEventListener("input", onEditorFocus, true);
    editorWatcher.observe(document.body, { childList: true, subtree: true });
    scheduleExtend();
    refreshEditors();
  }

  function stopLive() {
    document.removeEventListener("focusin", onEditorFocus, true);
    document.removeEventListener("input", onEditorFocus, true);
    editorWatcher.disconnect();
    // расширение остаётся в редакторах, но без декораций
    refreshEditors();
    document.getElementById(LIVE_STYLE_ID)?.remove();
  }

  // ─────────────────── цветной текст обычным шрифтом ───────────────────
  // Настройка `colored_text_font`: формула KaTeX, в которой только текст
  // (текст из меню: цвет, выделение, размер, подчёркнутый), в сообщениях
  // рисуется шрифтом и размером чата, а не шрифтом KaTeX; размеры меню —
  // относительно текста чата. Только в этом клиенте — у остальных она как была.

  const PLAIN_STYLE_ID = "arachnid-plain-katex-style";
  const PLAIN_CLASS = "arachnid-plain-katex";
  const PLAIN_CSS = `
.katex.${PLAIN_CLASS} {
  font: inherit;
  line-height: inherit;
  white-space: pre-wrap;
}
.katex.${PLAIN_CLASS} .katex-html * {
  font-family: inherit !important;
  font-size: inherit !important;
}
/* подпорки высоты формулы раздвигают строки, а тексту они не нужны */
.katex.${PLAIN_CLASS} .strut { display: none; }
/* \\sout, \\underline, \\colorbox — строка текста вместо столбика KaTeX с чертой или фоном */
.katex.${PLAIN_CLASS} :is(.vlist-t, .vlist-r, .vlist, .vlist > span, .vlist > span > span) {
  display: inline !important;
  position: static !important;
  height: auto !important;
  margin: 0 !important;
  vertical-align: baseline !important;
}
.katex.${PLAIN_CLASS} :is(.pstrut, .stretchy, .vlist-s, .underline-line) { display: none !important; }
.katex.${PLAIN_CLASS} .vlist:has(> span > .sout) { text-decoration: line-through; }
.katex.${PLAIN_CLASS} .vlist:has(> span > .underline-line) { text-decoration: underline; }
/* фон \\colorbox — у текста (цвет из --arachnid-plain-bg, см. markFormulas) */
.katex.${PLAIN_CLASS} .vlist:has(> span > .colorbox) {
  padding: 0 0.1em;
  border-radius: 3px;
  background: var(--arachnid-plain-bg);
  -webkit-box-decoration-break: clone;
}
${Object.entries({ footnotesize: 4, large: 7, Large: 8, huge: 10 })
  .map(([size, index]) => `.katex.${PLAIN_CLASS} .katex-html .sizing.size${index} { font-size: ${SIZE_EM[size]}em !important; }`)
  .join("\n")}
.katex.${PLAIN_CLASS} .katex-html .texttt { font-family: var(--fonts-monospace, monospace) !important; }
.katex.${PLAIN_CLASS} .textbf { font-weight: 600; }
.katex.${PLAIN_CLASS} .textit { font-style: italic; }
`;

  let plainOn = plugin.settings.colored_text_font !== false;

  /** Признаки математики в формуле: буквы-переменные, знаки, индексы, дроби… */
  const MATH = [
    ".mathnormal", ".mathit", ".mathbf", ".boldsymbol", ".amsrm", ".mbin", ".mrel", ".mop", ".mopen",
    ".mclose", ".mpunct", ".minner", ".msupsub", ".mfrac", ".sqrt", ".delimsizing", ".accent", ".overline",
  ].join(", ");

  /**
   * В формуле только текст: части строки — пробелы, подпорки KaTeX и текст
   * (\textsf…, в том числе внутри \sout, \underline, \colorbox) без математики.
   */
  function textOnly(formula) {
    const bases = formula.querySelectorAll(":scope > .katex-html > .base");
    const textPart = (part) =>
      part.classList.contains("mord") &&
      !part.matches(MATH) &&
      !part.querySelector(MATH) &&
      Boolean(part.matches(".text") || part.querySelector(".text"));
    return (
      bases.length > 0 &&
      [...bases].every((base) =>
        [...base.children].every((part) => part.classList.contains("strut") || part.classList.contains("mspace") || textPart(part)),
      )
    );
  }

  function markFormulas(root) {
    const formulas = root.matches?.(".katex") ? [root] : root.querySelectorAll?.(".katex") ?? [];
    for (const formula of formulas) {
      if (!textOnly(formula)) continue;
      formula.classList.add(PLAIN_CLASS);
      // фон \colorbox рисует отдельный элемент; без столбика KaTeX — фон у текста
      for (const box of formula.querySelectorAll(".stretchy.colorbox")) {
        box.closest(".vlist")?.style.setProperty("--arachnid-plain-bg", box.style.backgroundColor);
      }
    }
  }

  const formulaWatcher = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) markFormulas(node);
  });

  function startPlain() {
    if (!document.getElementById(PLAIN_STYLE_ID)) {
      const style = document.createElement("style");
      style.id = PLAIN_STYLE_ID;
      style.textContent = PLAIN_CSS;
      document.head.append(style);
    }
    formulaWatcher.observe(document.body, { childList: true, subtree: true });
    markFormulas(document.body);
  }

  function stopPlain() {
    formulaWatcher.disconnect();
    for (const formula of document.querySelectorAll(`.${PLAIN_CLASS}`)) {
      formula.classList.remove(PLAIN_CLASS);
      for (const list of formula.querySelectorAll(".vlist")) list.style.removeProperty("--arachnid-plain-bg");
    }
    document.getElementById(PLAIN_STYLE_ID)?.remove();
  }

  // ──────────────────────────────── меню ────────────────────────────────

  const CSS = `
.${MENU_CLASS}, .${PALETTE_CLASS} {
  position: fixed;
  z-index: 2147483000;
  font-family: var(--fonts-primary, Inter, sans-serif);
  animation: arachnid-format-in 0.12s ease-out;
}
@keyframes arachnid-format-in { from { opacity: 0; transform: translateY(4px); } }
.${MENU_CLASS} {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 2px;
  max-width: calc(100vw - ${GAP * 2}px);
  box-sizing: border-box;
  padding: 4px;
  border-radius: 999px;
  background: var(--md-sys-color-surface-container-high);
  box-shadow: 0 2px 6px rgb(0 0 0 / 0.35), 0 0 0 1px var(--md-sys-color-outline-variant);
}
.${MENU_CLASS} button, .${PALETTE_CLASS} button {
  border: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  background: none;
  cursor: pointer;
}
.${MENU_CLASS} button {
  position: relative;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--md-sys-color-on-surface);
}
.${MENU_CLASS} button:hover {
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
}
.${MENU_CLASS} button[aria-pressed="true"] {
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
}
.${MENU_CLASS} .material-symbols-outlined {
  font-size: 20px;
  line-height: 1;
}
.${MENU_CLASS} [data-separator] {
  flex: none;
  width: 1px;
  align-self: stretch;
  margin: 8px 4px;
  background: var(--md-sys-color-outline-variant);
}
.${MENU_CLASS}[data-wrapped] { border-radius: 24px; }
.${MENU_CLASS}:not([data-expanded]) [data-extra] { display: none; }
.${MENU_CLASS} [data-kind="more"] .material-symbols-outlined { transition: transform 0.15s; }
.${MENU_CLASS}[data-expanded] [data-kind="more"] .material-symbols-outlined { transform: rotate(180deg); }
.${MENU_CLASS} [data-kind="highlight"]::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: 6px;
  width: 16px;
  height: 3px;
  border-radius: 2px;
  transform: translateX(-50%);
  background: var(--arachnid-format-highlight);
}
.${MENU_CLASS} [data-kind="color"]::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: 6px;
  width: 16px;
  height: 3px;
  border-radius: 2px;
  transform: translateX(-50%);
  background: var(--arachnid-format-color);
}
.${MENU_CLASS}:not([data-palette]) button[data-tip]:hover::before {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 8px;
  border-radius: 4px;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 500;
  color: var(--md-sys-color-inverse-on-surface);
  background: var(--md-sys-color-inverse-surface);
  pointer-events: none;
}
.${PALETTE_CLASS} {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: 12px;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-highest);
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.5);
}
.${PALETTE_CLASS} [data-title] {
  font-size: 12px;
  font-weight: 500;
  color: var(--md-sys-color-on-surface-variant);
}
.${PALETTE_CLASS} [data-swatches] {
  display: grid;
  grid-template-columns: repeat(8, 24px);
  gap: 8px;
}
.${PALETTE_CLASS} [data-swatch] {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--swatch);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.12);
  transition: transform 0.1s;
}
.${PALETTE_CLASS} [data-swatch]:hover { transform: scale(1.15); }
.${PALETTE_CLASS} [data-swatch][aria-pressed="true"] {
  box-shadow: 0 0 0 2px var(--md-sys-color-surface-container-highest), 0 0 0 4px var(--md-sys-color-on-surface);
}
.${PALETTE_CLASS} [data-actions] { display: flex; gap: 8px; }
.${PALETTE_CLASS} [data-action] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px 0 8px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
}
.${PALETTE_CLASS} [data-action]:hover:not(:disabled) {
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 14%, transparent);
}
.${PALETTE_CLASS} [data-action]:disabled { opacity: 0.38; cursor: default; }
.${PALETTE_CLASS} [data-action] .material-symbols-outlined { font-size: 18px; line-height: 1; }
.${PALETTE_CLASS} [data-options] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 200px;
}
.${PALETTE_CLASS} [data-option] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 10px;
  border-radius: 8px;
  text-align: start;
  line-height: 1.25;
}
.${PALETTE_CLASS} [data-option]:hover,
.${PALETTE_CLASS} [data-chip]:hover {
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
}
.${PALETTE_CLASS} :is([data-option], [data-chip])[aria-pressed="true"] {
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
}
.${PALETTE_CLASS} [data-name] {
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
}
.${PALETTE_CLASS} [data-preview] { font-size: 14px; }
.${PALETTE_CLASS} [data-field] {
  min-width: 260px;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 8px;
  font: inherit;
  font-size: 14px;
  color: inherit;
  background: var(--md-sys-color-surface-container-low, transparent);
  color-scheme: dark light;
  outline: none;
}
.${PALETTE_CLASS} [data-field]:focus { border-color: var(--md-sys-color-primary, currentColor); }
.${PALETTE_CLASS} [data-chips] {
  display: grid;
  grid-template-columns: repeat(4, auto);
  gap: 4px;
}
.${PALETTE_CLASS} [data-chip] {
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  font-family: var(--fonts-monospace, monospace);
  font-size: 12px;
}
.${PALETTE_CLASS} [data-chip=""] { grid-column: 1 / -1; font-family: inherit; }
.${PALETTE_CLASS} input[type="color"] {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}
`;

  let active = plugin.settings.format_menu !== false;
  /** Редактор, у которого открыто меню (фокус может уйти в окно под кнопкой) */
  let editor = null;
  let menu = null;
  /** Открытое окно под кнопкой меню (палитра, заголовки, ссылка…); data-for — кнопка */
  let palette = null;
  /** Последний выбранный цвет — полоска под значком палитры */
  let lastColor = SWATCHES[0];
  let lastHighlight = HIGHLIGHTS[2];
  /** Меню развёрнуто стрелкой — помнится и в следующих запусках */
  const EXPANDED_KEY = "arachnid-format-expanded";
  const remembered = () => {
    try {
      return localStorage.getItem(EXPANDED_KEY) === "1";
    } catch {
      return false; // хранилище недоступно (страница без своего адреса)
    }
  };
  let expanded = remembered();
  /** Кнопка мыши нажата в редакторе: выделение ещё тянут — меню ждёт */
  let selecting = false;
  let frame = 0;

  const icon = (name) => {
    const element = document.createElement("span");
    element.className = "material-symbols-outlined";
    element.setAttribute("aria-hidden", "true");
    element.textContent = name;
    return element;
  };

  function buildMenu() {
    const element = document.createElement("div");
    element.className = MENU_CLASS;
    element.setAttribute("role", "toolbar");
    for (const button of BUTTONS) {
      if (button === "|" || button.separator) {
        const separator = document.createElement("span");
        separator.dataset.separator = "";
        if (button.extra) separator.dataset.extra = "";
        element.append(separator);
        continue;
      }
      const control = document.createElement("button");
      control.type = "button";
      control.dataset.kind = button.kind;
      if (button.extra) control.dataset.extra = "";
      control.append(icon(button.icon));
      element.append(control);
    }
    element.toggleAttribute("data-expanded", expanded);
    // кнопки не забирают фокус у поля — выделение остаётся
    element.addEventListener("mousedown", (event) => event.preventDefault());
    element.addEventListener("click", (event) => {
      const control = event.target.closest("button[data-kind]");
      if (!control) return;
      const kind = control.dataset.kind;
      if (kind === "more") {
        expanded = !expanded;
        try {
          localStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0");
        } catch {
          // не запомнится — только до перезапуска
        }
        closePalette();
        menu.toggleAttribute("data-expanded", expanded);
        label();
        place();
        return;
      }
      if (POPUP_KINDS.includes(kind)) {
        const open = palette?.dataset.for;
        closePalette();
        if (open !== kind) POPUPS[kind](control);
        return;
      }
      closePalette();
      edit((doc, from, to) => toggle(doc, from, to, kind));
    });
    return element;
  }

  /** Подписи — на языке интерфейса при каждом показе */
  function label() {
    for (const control of menu.querySelectorAll("button[data-kind]")) {
      const kind = control.dataset.kind;
      const tip = kind === "more" ? text[expanded ? "less" : "more"] : text[kind];
      control.dataset.tip = tip;
      control.setAttribute("aria-label", tip);
    }
  }

  function show(current) {
    if (!menu) {
      menu = buildMenu();
      document.body.append(menu);
    }
    if (editor !== current.view) closePalette();
    editor = current.view;
    label();
    menu.style.setProperty("--arachnid-format-color", lastColor);
    menu.style.setProperty("--arachnid-format-highlight", lastHighlight);
    for (const control of menu.querySelectorAll("button[data-kind]")) {
      const on = isActive(current.doc, current.from, current.to, control.dataset.kind);
      control.setAttribute("aria-pressed", String(on));
    }
    place();
  }

  /** Меню над выделением (под ним, если сверху нет места) */
  function place() {
    const range = getSelection()?.rangeCount ? getSelection().getRangeAt(0) : null;
    const inEditor = range && editor.contentDOM.contains(range.commonAncestorContainer);
    const rects = inEditor ? [...range.getClientRects()].filter((rect) => rect.width || rect.height) : [];
    const area = editor.contentDOM.getBoundingClientRect();
    const first = rects[0] ?? area;
    const last = rects.at(-1) ?? area;
    const left = Math.min(...rects.map((rect) => rect.left), first.left);
    const right = Math.max(...rects.map((rect) => rect.right), first.right);
    // узкое окно — меню переносится на вторую строку
    menu.toggleAttribute("data-wrapped", menu.offsetHeight > 52);
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const x = Math.max(GAP, Math.min(innerWidth - width - GAP, (left + right) / 2 - width / 2));
    let y = first.top - height - GAP;
    if (y < GAP) y = last.bottom + GAP;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    if (palette) placePalette();
  }

  function hide() {
    closePalette();
    menu?.remove();
    menu = null;
    editor = null;
  }

  /** Показать, обновить или спрятать меню — на следующем кадре, когда
   *  редактор уже прочитал выделение */
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!active || selecting) return;
      const current = selection();
      if (!current || (!palette && !current.view.hasFocus)) {
        if (!palette) hide();
        return;
      }
      show(current);
    });
  }

  // ─────────────────────────── окна под кнопками ───────────────────────────

  /** Окно под кнопкой kind меню с подписью сверху */
  function popup(kind, caption) {
    const element = document.createElement("div");
    element.className = PALETTE_CLASS;
    element.dataset.for = kind;
    const title = document.createElement("div");
    title.dataset.title = "";
    title.textContent = caption;
    element.append(title);
    // щелчок по окну не забирает фокус у поля — кроме полей ввода в окне
    element.addEventListener("mousedown", (event) => {
      if (!event.target.closest("input")) event.preventDefault();
    });
    // клавиши в полях окна — только им (не горячим клавишам страницы)
    element.addEventListener("keydown", (event) => {
      if (event.target.closest("input")) event.stopPropagation();
    });
    return element;
  }

  function openPopup(element, anchor) {
    palette = element;
    document.body.append(palette);
    menu.dataset.palette = "";
    placePalette(anchor);
  }

  function action(iconName, caption, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = "";
    button.append(icon(iconName), caption);
    button.addEventListener("click", onClick);
    return button;
  }

  function actionsRow(...buttons) {
    const row = document.createElement("div");
    row.dataset.actions = "";
    row.append(...buttons);
    return row;
  }

  /** Применить правку из окна: окно закрывается, фокус — в поле */
  function apply(make) {
    closePalette();
    edit(make);
  }

  /** Список вариантов: [{ value, label, pressed, style? }] */
  function optionList(options, onChoose) {
    const list = document.createElement("div");
    list.dataset.options = "";
    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.option = String(option.value);
      if (option.style) button.style.cssText = option.style;
      button.append(...[option.label].flat());
      button.setAttribute("aria-pressed", String(Boolean(option.pressed)));
      button.addEventListener("click", () => onChoose(option.value));
      list.append(button);
    }
    return list;
  }

  /** Цвет первой формулы у выделения (getter — color или фон) */
  function selectedSpan() {
    const current = selection();
    return current && spanAt(current.doc, ...trimmed(current.doc, current.from, current.to));
  }

  /** Сетка цветов: swatches, chosen, onChoose(color); «Свой цвет» — системное окно */
  function swatchGrid(element, colors, chosen, fallback, onChoose) {
    const swatches = document.createElement("div");
    swatches.dataset.swatches = "";
    for (const color of colors) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.dataset.swatch = "";
      swatch.title = color;
      swatch.style.setProperty("--swatch", color);
      swatch.setAttribute("aria-pressed", String(color === chosen));
      swatch.addEventListener("click", () => onChoose(color));
      swatches.append(swatch);
    }
    const native = document.createElement("input");
    native.type = "color";
    native.value = chosen && /^#[0-9a-f]{6}$/.test(chosen) ? chosen : fallback;
    native.addEventListener("change", () => onChoose(native.value));
    element.append(swatches);
    return [action("colorize", text.customColor, () => native.click()), native];
  }

  function openPalette(anchor) {
    const current = selection();
    if (!current) return;
    const element = popup("color", text.color);
    const chosen = selectedSpan()?.color?.toLowerCase() ?? null;
    const choose = (color) => {
      if (color) lastColor = color;
      apply((doc, from, to) => paint(doc, from, to, color));
    };
    const [custom, native] = swatchGrid(element, SWATCHES, chosen, lastColor, choose);
    const none = action("format_color_reset", text.noColor, () => choose(null));
    none.disabled = !isActive(current.doc, current.from, current.to, "color");
    element.append(actionsRow(custom, none, native));
    openPopup(element, anchor);
  }

  function openHighlight(anchor) {
    const current = selection();
    if (!current) return;
    const element = popup("highlight", text.highlight);
    const span = selectedSpan();
    const backgrounds = span ? spanSegments(current.doc, span).map((segment) => backgroundOf(segment.styles)) : [];
    const chosen = backgrounds.find(Boolean)?.toLowerCase() ?? null;
    const choose = (color) => {
      if (color) lastHighlight = color;
      apply((doc, from, to) => highlight(doc, from, to, color));
    };
    const [custom, native] = swatchGrid(element, HIGHLIGHTS, chosen, lastHighlight, choose);
    const none = action("format_color_reset", text.noHighlight, () => choose(null));
    none.disabled = !isActive(current.doc, current.from, current.to, "highlight");
    element.append(actionsRow(custom, none, native));
    openPopup(element, anchor);
  }

  function openSizes(anchor) {
    const current = selection();
    if (!current) return;
    const element = popup("size", text.size);
    const chosen = selectedSpan()?.size ?? BASE_SIZE;
    const options = SIZES.map((size) => ({
      value: size,
      label: text[SIZE_LABELS[size]],
      pressed: size === chosen,
      style: `font-size:${Math.round(14 * SIZE_EM[size])}px`,
    }));
    element.append(optionList(options, (size) => apply((doc, from, to) => resize(doc, from, to, size))));
    openPopup(element, anchor);
  }

  function openHeadings(anchor) {
    const current = selection();
    if (!current) return;
    const element = popup("heading", text.heading);
    const chosen = headingLevel(current.doc, current.from, current.to);
    const sizes = [20, 17, 15, 14, 13, 11];
    const options = HEADINGS.map((level) => ({
      value: level,
      label: text[`heading${level}`],
      pressed: level === chosen,
      style: `font-size:${sizes[level - 1]}px;font-weight:600`,
    }));
    const choose = (level) => apply((doc, from, to) => toggleHeading(doc, from, to, level));
    element.append(optionList(options, choose));
    const none = action("format_clear", text.noHeading, () => choose(0));
    none.disabled = !isActive(current.doc, current.from, current.to, "heading");
    element.append(actionsRow(none));
    openPopup(element, anchor);
  }

  function openLink(anchor) {
    const current = selection();
    if (!current) return;
    const element = popup("link", text.link);
    const link = linkAt(current.doc, ...trimmed(current.doc, current.from, current.to));
    const input = document.createElement("input");
    input.type = "url";
    input.dataset.field = "";
    input.placeholder = "https://";
    input.spellcheck = false;
    input.value = link?.url ?? "";
    const submit = () => {
      let url = input.value.trim();
      if (url && !/^[a-z][\w+.-]*:/i.test(url)) url = `https://${url}`;
      if (!url && !link) return closePalette();
      apply((doc, from, to) => setLink(doc, from, to, url.replace(/[\s)]/g, encodeURIComponent)));
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
    const done = action("check", text.linkApply, submit);
    const remove = action("link_off", text.noLink, () => apply((doc, from, to) => setLink(doc, from, to, "")));
    remove.disabled = !link;
    element.append(input, actionsRow(done, remove));
    openPopup(element, anchor);
    input.focus();
    input.select();
  }

  /** Как for-web покажет время в формате format (на языке интерфейса) */
  function timePreview(date, format) {
    const language = i18n.language?.() || navigator.language;
    if (format.format !== "R") return new Intl.DateTimeFormat(language, format.options).format(date);
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const units = [
      ["year", 31536000],
      ["month", 2592000],
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
      ["second", 1],
    ];
    const [unit, size] = units.find(([, length]) => Math.abs(seconds) >= length) ?? ["second", 1];
    return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(Math.round(seconds / size), unit);
  }

  /** Значение для <input type="datetime-local"> — местное время */
  const localValue = (date) =>
    new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  function openTime(anchor) {
    const current = selection();
    if (!current) return;
    const element = popup("time", text.time);
    const time = timeAt(current.doc, ...trimmed(current.doc, current.from, current.to));
    // по умолчанию — начало следующего часа
    const start = time ? new Date(time.seconds * 1000) : new Date(Math.ceil(Date.now() / 3600000) * 3600000);
    const input = document.createElement("input");
    input.type = "datetime-local";
    input.dataset.field = "";
    input.value = localValue(start);
    const date = () => (input.value ? new Date(input.value) : start);
    const options = () =>
      TIME_FORMATS.map((format) => {
        const name = document.createElement("span");
        name.dataset.name = "";
        name.textContent = text[format.label];
        const preview = document.createElement("span");
        preview.dataset.preview = "";
        preview.textContent = timePreview(date(), format);
        return { value: format.format, label: [name, preview], pressed: time?.format === format.format };
      });
    const choose = (format) => {
      const seconds = Math.floor(date().getTime() / 1000);
      if (Number.isFinite(seconds)) apply((doc, from, to) => setTime(doc, from, to, seconds, format));
    };
    let list = optionList(options(), choose);
    input.addEventListener("input", () => {
      const next = optionList(options(), choose);
      list.replaceWith(next);
      list = next;
    });
    element.append(input, list);
    openPopup(element, anchor);
  }

  function openCodeBlock(anchor) {
    const current = selection();
    if (!current) return;
    const element = popup("codeblock", text.codeblock);
    const block = codeBlockAt(current.doc, ...trimmed(current.doc, current.from, current.to));
    const chips = document.createElement("div");
    chips.dataset.chips = "";
    for (const language of ["", ...LANGUAGES]) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.dataset.chip = language;
      chip.textContent = language || text.noLanguage;
      chip.setAttribute("aria-pressed", String(block?.language === language));
      chip.addEventListener("click", () => apply((doc, from, to) => toggleCodeBlock(doc, from, to, language)));
      chips.append(chip);
    }
    const remove = action("format_clear", text.noCodeblock, () =>
      apply((doc, from, to) => toggleCodeBlock(doc, from, to, null)),
    );
    remove.disabled = !block;
    element.append(chips, actionsRow(remove));
    openPopup(element, anchor);
  }

  const POPUPS = {
    color: openPalette,
    highlight: openHighlight,
    size: openSizes,
    heading: openHeadings,
    link: openLink,
    time: openTime,
    codeblock: openCodeBlock,
  };

  function placePalette(anchor = menu?.querySelector(`[data-kind="${palette?.dataset.for}"]`)) {
    if (!palette || !anchor) return;
    const button = anchor.getBoundingClientRect();
    const bar = menu.getBoundingClientRect();
    const width = palette.offsetWidth;
    const height = palette.offsetHeight;
    const x = Math.max(GAP, Math.min(innerWidth - width - GAP, button.left + button.width / 2 - width / 2));
    let y = bar.top - height - GAP;
    if (y < GAP) y = bar.bottom + GAP;
    palette.style.left = `${x}px`;
    palette.style.top = `${y}px`;
  }

  function closePalette() {
    if (!palette) return;
    // фокус был в поле окна (ссылка, время) — обратно в редактор
    const refocus = palette.contains(document.activeElement);
    palette.remove();
    palette = null;
    if (menu) delete menu.dataset.palette;
    if (refocus) editor?.focus();
  }

  // ─────────────────────────────── события ───────────────────────────────

  function onPointerDown(event) {
    if (menu?.contains(event.target) || palette?.contains(event.target)) return;
    if (palette) closePalette();
    selecting = Boolean(event.target.closest?.(".cm-content"));
    if (selecting) hide();
  }

  function onPointerUp() {
    if (!selecting) return;
    selecting = false;
    schedule();
  }

  function onKeyDown(event) {
    if (event.key !== "Escape" || !menu) return;
    // Escape сначала закрывает палитру, затем меню, и только потом доходит
    // до for-web (отмена ответа или правки)
    event.preventDefault();
    event.stopPropagation();
    if (palette) closePalette();
    else hide();
  }

  function onFocusOut() {
    // фокус ушёл из поля (не в палитру и не в окно цвета) — меню прячется
    setTimeout(() => {
      if (!palette && !focusedEditor()) hide();
    });
  }

  function onViewport() {
    if (!menu) return;
    if (editor?.dom.isConnected) place();
    else hide();
  }

  function start() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.append(style);
    }
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusout", onFocusOut, true);
    addEventListener("scroll", onViewport, true);
    addEventListener("resize", onViewport);
  }

  function stop() {
    hide();
    document.getElementById(STYLE_ID)?.remove();
    document.removeEventListener("selectionchange", schedule);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("focusout", onFocusOut, true);
    removeEventListener("scroll", onViewport, true);
    removeEventListener("resize", onViewport);
  }

  plugin.onSettingsChange((values) => {
    const menuNext = values.format_menu !== false;
    if (menuNext !== active) {
      active = menuNext;
      if (active) start();
      else stop();
    }
    const liveNext = values.live_formatting !== false;
    if (liveNext !== liveOn) {
      liveOn = liveNext;
      if (liveOn) startLive();
      else stopLive();
    }
    const plainNext = values.colored_text_font !== false;
    if (plainNext !== plainOn) {
      plainOn = plainNext;
      if (plainOn) startPlain();
      else stopPlain();
    }
  });

  // подписи меню берутся при каждом показе; открытое меню — переподписать
  i18n.onChange(() => menu && label());

  function boot() {
    if (active) start();
    if (liveOn) startLive();
    if (plainOn) startPlain();
  }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
