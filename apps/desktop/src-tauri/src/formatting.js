// Меню форматирования: часть встроенного плагина «Quality of Life»
// (выполняется вместе с emoji.js, gifs.js, hotkeys.js, history.js и
// player.js), настройки `format_menu`, `live_formatting` и
// `colored_text_font`.
//
// * Над выделенным текстом в поле сообщения (и в поле правки сообщения)
//   появляется меню: жирный, курсив, зачёркнутый, спойлер, код, цитата и
//   цвет текста. Включённое у выделения форматирование подсвечено; нажатие
//   снимает его.
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

  /** Кнопки меню; "|" — разделитель */
  const BUTTONS = [
    { kind: "bold", icon: "format_bold" },
    { kind: "italic", icon: "format_italic" },
    { kind: "strike", icon: "format_strikethrough" },
    "|",
    { kind: "spoiler", icon: "visibility_off" },
    { kind: "code", icon: "code" },
    { kind: "quote", icon: "format_quote" },
    "|",
    { kind: "color", icon: "palette" },
  ];

  /** Цвета палитры: читаются и на тёмной, и на светлой теме */
  const SWATCHES = [
    "#e5534b", "#f0883e", "#e3b341", "#57ab5a", "#39c5cf", "#539bf5", "#b083f0", "#e275ad",
    "#ff938a", "#ffb77c", "#f8e3a1", "#8ddb8c", "#96d0ff", "#c9d1ff", "#dcbdfb", "#adbac7",
  ];

  const MARKS = { bold: "**", italic: "*", strike: "~~", spoiler: "||", code: "`" };

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

  /** Стили, которые бывают у слова внутри цветного куска, — в порядке вложенности */
  const STYLES = ["bold", "italic", "strike"];
  const STYLE_TEX = { bold: "textbf", italic: "textit", strike: "sout" };
  const TEX_STYLE = { textbf: "bold", textit: "italic", sout: "strike", texttt: "code" };
  const STYLE_MARK = { bold: "**", italic: "*", strike: "~~", code: "`" };
  const TEX_SYMBOLS = { textbackslash: "\\", textasciicircum: "^", textasciitilde: "~" };

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

  /** Куски → тело формулы: слово с пробелом после него — свой \textsf */
  function segmentsTex(segments) {
    const words = [];
    for (const { text: value, styles } of segments) {
      for (const word of value.match(/\S+\s*|\s+/g) ?? []) {
        // пробел в начале куска — к предыдущему слову
        if (!word.trim() && words.length) {
          words[words.length - 1] = words.at(-1).replace(/\}+$/, (end) => word + end);
          continue;
        }
        let tex = escapeTex(word);
        for (const style of STYLES.filter((style) => styles.includes(style)).reverse()) {
          tex = `\\${STYLE_TEX[style]}{${tex}}`;
        }
        words.push(`\\${styles.includes("code") ? "texttt" : "textsf"}{${tex}}`);
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
        if (tex[index] === "{") {
          const end = closingBrace(tex, index);
          const close = end < 0 ? tex.length : end;
          const style = TEX_STYLE[name];
          out.push(...texSegments(tex.slice(index + 1, close), style ? [...styles, style] : styles));
          index = close + 1;
        }
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
        const marks = (styles.includes("code") ? ["code"] : styles).map((style) => STYLE_MARK[style]).join("");
        if (!marks || !value.trim()) return value;
        const lead = /^\s*/.exec(value)[0];
        const trail = /\s*$/.exec(value)[0];
        return `${lead}${marks}${value.trim()}${[...marks].reverse().join("")}${trail}`;
      })
      .join("");
  }

  const colorTex = (color, segments) => `$$\\color{${color}}\\small${segmentsTex(segments)}$$`;

  /** Цветные куски текста: [{ from, to, color, contentFrom, contentTo }] */
  function colorSpans(doc) {
    const spans = [];
    const start = /\$\$\\color\{([^{}$]+)\}(?:\\small)?/g;
    for (let match; (match = start.exec(doc)); ) {
      const contentFrom = match.index + match[0].length;
      const close = doc.indexOf("$$", contentFrom);
      if (close < 0) break;
      spans.push({ from: match.index, to: close + 2, color: match[1], contentFrom, contentTo: close });
      start.lastIndex = close + 2;
    }
    return spans;
  }

  const spanAt = (doc, from, to) => colorSpans(doc).find((span) => span.from <= from && to <= span.to);
  const spanSegments = (doc, span) => texSegments(doc.slice(span.contentFrom, span.contentTo));

  /** То, что в формуле не работает: упоминания, каналы, свои эмодзи, ссылки */
  const KEEP_OUT = /<[@#%][^>\s]+>|:[A-Za-z0-9_]+:|https?:\/\/\S+/g;

  function colorLine(line, color) {
    const parts = [];
    let last = 0;
    for (const match of line.matchAll(KEEP_OUT)) {
      parts.push([line.slice(last, match.index), true], [match[0], false]);
      last = match.index + match[0].length;
    }
    parts.push([line.slice(last), true]);
    return parts
      .map(([part, colored]) => {
        if (!colored || !part.trim()) return part;
        const lead = /^\s*/.exec(part)[0];
        const trail = /\s*$/.exec(part)[0];
        return `${lead}${colorTex(color, markdownSegments(part.trim()))}${trail}`;
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

  /** Включено ли форматирование kind у выделения */
  function isActive(doc, from, to, kind) {
    [from, to] = trimmed(doc, from, to);
    if (kind === "quote") {
      return doc
        .slice(lineStart(doc, from), lineEnd(doc, Math.max(from, to - 1)))
        .split("\n")
        .every((line) => line.startsWith(">"));
    }
    const span = spanAt(doc, from, to);
    if (kind === "color") return Boolean(span);
    if (span && STYLES.includes(kind)) {
      return spanSegments(doc, span).every((segment) => !segment.text.trim() || segment.styles.includes(kind));
    }
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

  function toggleQuote(doc, from, to) {
    const start = lineStart(doc, from);
    const end = lineEnd(doc, Math.max(from, to - 1));
    const lines = doc.slice(start, end).split("\n");
    const quoted = lines.every((line) => line.startsWith(">"));
    const insert = lines.map((line) => (quoted ? line.replace(/^> ?/, "") : `> ${line}`)).join("\n");
    return { from: start, to: end, insert, anchor: start, head: start + insert.length };
  }

  /** Жирный, курсив, зачёркнутый у цветного куска — командами KaTeX у всех слов */
  function toggleTex(doc, span, kind) {
    const segments = spanSegments(doc, span);
    const on = segments.every((segment) => !segment.text.trim() || segment.styles.includes(kind));
    const next = segments.map(({ text: value, styles }) => ({
      text: value,
      styles: on ? styles.filter((style) => style !== kind) : styles.includes(kind) ? styles : [...styles, kind],
    }));
    const insert = colorTex(span.color, merge(next));
    return { from: span.from, to: span.to, insert, anchor: span.from, head: span.from + insert.length };
  }

  /** Правка, которая красит выделение в color (`#rrggbb`) или снимает цвет (null) */
  function paint(doc, from, to, color) {
    [from, to] = trimmed(doc, from, to);
    // разметка вокруг выделения (**…**, *…*, ~~…~~) уходит в формулу: снаружи
    // формулы она на цвет не действует
    for (let mark; color; from -= mark.length, to += mark.length) {
      mark = ["**", "~~", "*"].find((m) => doc.slice(from - m.length, from) === m && doc.slice(to, to + m.length) === m);
      if (!mark) break;
    }
    const touched = colorSpans(doc).filter((span) => span.from < Math.max(to, from + 1) && span.to > from);
    if (touched.length) {
      // затронутые цветные куски перекрашиваются или теряют цвет целиком
      const start = Math.min(from, touched[0].from);
      const end = Math.max(to, touched.at(-1).to);
      let insert = "";
      let at = start;
      for (const span of touched) {
        insert += doc.slice(at, span.from);
        insert += color
          ? `$$\\color{${color}}${doc.slice(span.from, span.to).replace(/^\$\$\\color\{[^{}$]+\}/, "")}`
          : segmentsMarkdown(spanSegments(doc, span));
        at = span.to;
      }
      insert += doc.slice(at, end);
      return { from: start, to: end, insert, anchor: start, head: start + insert.length };
    }
    if (!color || from === to) return null;
    const insert = doc
      .slice(from, to)
      .split("\n")
      .map((line) => colorLine(line, color))
      .join("\n");
    return { from, to, insert, anchor: from, head: from + insert.length };
  }

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
.cm-content .arachnid-live-color,
.cm-content .arachnid-live-color .md-code,
.cm-content .md-code:has(.arachnid-live-color) {
  font-family: inherit;
  padding: 0;
  background: none;
}
.cm-content .md-code:has(.arachnid-live-color) { color: inherit; }
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
    // ссылки, упоминания, каналы и время — без разметки (https://a.b/_c_)
    for (const match of doc.matchAll(/https?:\/\/\S+|<[@#%:a-zA-Z][^\s>]*>/g)) {
      mask(match.index, match.index + match[0].length);
    }
    for (const match of masked.matchAll(/(?<!\\)`([^`\n]+)`/g)) {
      const from = match.index;
      const to = from + match[0].length;
      pieces.push({ from, to, hide: [[from, from + 1], [to - 1, to]], marks: [] });
      mask(from, to);
    }
    for (const span of colorSpans(masked)) {
      pieces.push(colorPiece(doc, span));
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
    // цитата: «> » в начале строки
    for (const match of masked.matchAll(/^> ?/gm)) {
      const end = lineEnd(doc, match.index);
      pieces.push({ from: match.index, to: end, hide: [[match.index, match.index + match[0].length]], marks: [] });
    }
    return pieces;
  }

  /** Цвет KaTeX → безопасный для CSS (имя или #hex) */
  const cssColor = (color) => (/^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(color) ? color : "inherit");
  const LIVE_STYLES = {
    bold: "font-weight:bold",
    italic: "font-style:italic",
    strike: "text-decoration:line-through",
    code: "font-family:var(--fonts-monospace,monospace)",
  };

  /** Цветной кусок: команды KaTeX прячутся, текст красится */
  function colorPiece(doc, span) {
    const hide = [[span.from, span.contentFrom], [span.contentTo, span.to]];
    const marks = [];
    const stack = [];
    const base = `color:${cssColor(span.color)}`;
    const style = () => [base, ...[...new Set(stack.filter(Boolean))].map((name) => LIVE_STYLES[name])].join(";");
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
  // (цветной текст: \color + \textsf, \text…), в сообщениях рисуется
  // шрифтом и размером чата, а не шрифтом KaTeX. Только в этом клиенте —
  // у остальных она как была.

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
/* \\sout — строка текста вместо столбика KaTeX с чертой поверх */
.katex.${PLAIN_CLASS} :is(.vlist-t, .vlist-r, .vlist, .vlist > span, .vlist > span > span) {
  display: inline !important;
  position: static !important;
  height: auto !important;
  margin: 0 !important;
  vertical-align: baseline !important;
}
.katex.${PLAIN_CLASS} :is(.pstrut, .stretchy, .vlist-s) { display: none !important; }
.katex.${PLAIN_CLASS} .vlist:has(> span > .sout) { text-decoration: line-through; }
.katex.${PLAIN_CLASS} .katex-html .texttt { font-family: var(--fonts-monospace, monospace) !important; }
.katex.${PLAIN_CLASS} .textbf { font-weight: 600; }
.katex.${PLAIN_CLASS} .textit { font-style: italic; }
`;

  let plainOn = plugin.settings.colored_text_font !== false;

  /** В формуле только текст: части строки — текст, пробелы и подпорки KaTeX */
  function textOnly(formula) {
    const bases = formula.querySelectorAll(":scope > .katex-html > .base");
    return (
      bases.length > 0 &&
      [...bases].every((base) =>
        [...base.children].every(
          (part) => part.classList.contains("strut") || part.classList.contains("mspace") || part.matches(".mord.text"),
        ),
      )
    );
  }

  function markFormulas(root) {
    const formulas = root.matches?.(".katex") ? [root] : root.querySelectorAll?.(".katex") ?? [];
    for (const formula of formulas) if (textOnly(formula)) formula.classList.add(PLAIN_CLASS);
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
    for (const formula of document.querySelectorAll(`.${PLAIN_CLASS}`)) formula.classList.remove(PLAIN_CLASS);
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
  align-items: center;
  gap: 2px;
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
.${PALETTE_CLASS} input[type="color"] {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}
`;

  let active = plugin.settings.format_menu !== false;
  /** Редактор, у которого открыто меню (фокус может уйти в окно цвета) */
  let editor = null;
  let menu = null;
  let palette = null;
  /** Последний выбранный цвет — полоска под значком палитры */
  let lastColor = SWATCHES[0];
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
      if (button === "|") {
        const separator = document.createElement("span");
        separator.dataset.separator = "";
        element.append(separator);
        continue;
      }
      const control = document.createElement("button");
      control.type = "button";
      control.dataset.kind = button.kind;
      control.append(icon(button.icon));
      element.append(control);
    }
    // кнопки не забирают фокус у поля — выделение остаётся
    element.addEventListener("mousedown", (event) => event.preventDefault());
    element.addEventListener("click", (event) => {
      const control = event.target.closest("button[data-kind]");
      if (!control) return;
      const kind = control.dataset.kind;
      if (kind === "color") return palette ? closePalette() : openPalette(control);
      closePalette();
      edit((doc, from, to) => toggle(doc, from, to, kind));
    });
    return element;
  }

  /** Подписи — на языке интерфейса при каждом показе */
  function label() {
    for (const control of menu.querySelectorAll("button[data-kind]")) {
      const tip = text[control.dataset.kind];
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
    for (const control of menu.querySelectorAll("button[data-kind]")) {
      const on = isActive(current.doc, current.from, current.to, control.dataset.kind);
      control.setAttribute("aria-pressed", String(on));
    }
    place();
  }

  /** Меню над выделением (под ним, если сверху нет места) */
  function place() {
    const range = getSelection()?.rangeCount ? getSelection().getRangeAt(0) : null;
    const rects = range ? [...range.getClientRects()].filter((rect) => rect.width || rect.height) : [];
    const area = editor.contentDOM.getBoundingClientRect();
    const first = rects[0] ?? area;
    const last = rects.at(-1) ?? area;
    const left = Math.min(...rects.map((rect) => rect.left), first.left);
    const right = Math.max(...rects.map((rect) => rect.right), first.right);
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

  // ─────────────────────────────── палитра ───────────────────────────────

  function selectedColor() {
    const current = selection();
    const span = current && spanAt(current.doc, ...trimmed(current.doc, current.from, current.to));
    return span?.color.toLowerCase() ?? null;
  }

  function choose(color) {
    if (color) lastColor = color;
    closePalette();
    edit((doc, from, to) => paint(doc, from, to, color));
  }

  function action(iconName, caption, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = "";
    button.append(icon(iconName), caption);
    button.addEventListener("click", onClick);
    return button;
  }

  function openPalette(anchor) {
    const current = selection();
    if (!current) return;
    palette = document.createElement("div");
    palette.className = PALETTE_CLASS;
    const title = document.createElement("div");
    title.dataset.title = "";
    title.textContent = text.color;
    const swatches = document.createElement("div");
    swatches.dataset.swatches = "";
    const chosen = selectedColor();
    for (const color of SWATCHES) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.dataset.swatch = "";
      swatch.title = color;
      swatch.style.setProperty("--swatch", color);
      swatch.setAttribute("aria-pressed", String(color === chosen));
      swatch.addEventListener("click", () => choose(color));
      swatches.append(swatch);
    }
    // свой цвет — системное окно выбора цвета
    const native = document.createElement("input");
    native.type = "color";
    native.value = chosen && /^#[0-9a-f]{6}$/.test(chosen) ? chosen : lastColor;
    native.addEventListener("change", () => choose(native.value));
    const custom = action("colorize", text.customColor, () => native.click());
    const none = action("format_color_reset", text.noColor, () => choose(null));
    none.disabled = !isActive(current.doc, current.from, current.to, "color");
    const actions = document.createElement("div");
    actions.dataset.actions = "";
    actions.append(custom, none, native);
    palette.append(title, swatches, actions);
    palette.addEventListener("mousedown", (event) => event.preventDefault());
    document.body.append(palette);
    menu.dataset.palette = "";
    placePalette(anchor);
  }

  function placePalette(anchor = menu?.querySelector('[data-kind="color"]')) {
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
    palette?.remove();
    palette = null;
    if (menu) delete menu.dataset.palette;
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
