// Форматирование выделенного текста в разметке Stoat (то, что потом войдёт в
// клиент). Чистые функции: текст поля + выделение → одна правка
// { from, to, insert, anchor, head } (как транзакция CodeMirror).
//
// Разметка for-web: **жирный**, *курсив*, ~~зачёркнутый~~, ||спойлер||,
// `код`, «> » — цитата. Цвета в разметке нет — цветной текст делается
// KaTeX, который for-web показывает у всех: $$\color{#e5534b}\textsf{текст}$$.

export const MARKS = {
  bold: "**",
  italic: "*",
  strike: "~~",
  spoiler: "||",
  code: "`",
};

// ───────────────────────────── KaTeX ─────────────────────────────
// Цветной кусок: $$\color{#e5534b}\small\textsf{Привет, }\allowbreak\textsf{мир}$$
// \small — размер как у текста чата (KaTeX сам крупнее на 21%), слова —
// отдельными \textsf через \allowbreak, иначе длинный цветной текст не
// переносится на новую строку.

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
const escapeTex = (text) => text.replace(/[\\{}$%&#_^~]/g, (char) => TEX_ESCAPES[char]);

/** Стили куска текста — в порядке вложенности команд KaTeX */
const STYLES = ["bold", "italic", "strike"];
const STYLE_TEX = { bold: "textbf", italic: "textit", strike: "sout" };
const TEX_STYLE = { textbf: "bold", textit: "italic", sout: "strike", texttt: "code" };
const STYLE_MARK = { bold: "**", italic: "*", strike: "~~", code: "`" };

/** Разметка → куски [{ text, styles }] (жирный, курсив, зачёркнутый, код) */
function markdownSegments(text, styles = []) {
  const out = [];
  const pattern = /\*\*(.+?)\*\*|~~(.+?)~~|\*(.+?)\*|`([^`]+)`|[^*~`]+|[*~`]/g;
  for (const [match, bold, strike, italic, code] of text.matchAll(pattern)) {
    if (bold != null) out.push(...markdownSegments(bold, [...styles, "bold"]));
    else if (strike != null) out.push(...markdownSegments(strike, [...styles, "strike"]));
    else if (italic != null) out.push(...markdownSegments(italic, [...styles, "italic"]));
    else if (code != null) out.push({ text: code, styles: [...styles, "code"] });
    else out.push({ text: match, styles });
  }
  return merge(out);
}

const sameStyles = (a, b) => a.length === b.length && a.every((style) => b.includes(style));

/** Соседние куски с одинаковыми стилями — в один */
function merge(segments) {
  const out = [];
  for (const segment of segments) {
    const last = out.at(-1);
    if (last && sameStyles(last.styles, segment.styles)) last.text += segment.text;
    else if (segment.text) out.push({ text: segment.text, styles: [...segment.styles] });
  }
  return out;
}

/** Куски → тело цветного KaTeX: слово (с пробелом после него) — свой \textsf */
function segmentsTex(segments) {
  const words = [];
  for (const { text, styles } of segments) {
    for (const word of text.match(/\S+\s*|\s+/g) ?? []) {
      const code = styles.includes("code");
      let tex = escapeTex(word);
      for (const style of STYLES.filter((style) => styles.includes(style)).reverse()) {
        tex = `\\${STYLE_TEX[style]}{${tex}}`;
      }
      tex = `\\${code ? "texttt" : "textsf"}{${tex}}`;
      // пробел, оставшийся после слова, — к предыдущему слову
      if (!word.trim() && words.length) words[words.length - 1] = words.at(-1).replace(/\}+$/, (end) => word + end);
      else words.push(tex);
    }
  }
  return words.join("\\allowbreak");
}

const TEX_SYMBOLS = { textbackslash: "\\", textasciicircum: "^", textasciitilde: "~" };

/** Тело KaTeX → куски [{ text, styles }] */
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
        const style = TEX_STYLE[name];
        out.push(...texSegments(tex.slice(index + 1, end < 0 ? tex.length : end), style ? [...styles, style] : styles));
        index = end < 0 ? tex.length : end + 1;
      }
      continue;
    }
    if (char !== "{" && char !== "}") out.push({ text: char, styles });
    index += 1;
  }
  return merge(out);
}

/** Куски → разметка: пробелы по краям — снаружи **…** */
function segmentsMarkdown(segments) {
  return segments
    .map(({ text, styles }) => {
      const marks = (styles.includes("code") ? ["code"] : styles).map((style) => STYLE_MARK[style]).join("");
      if (!marks || !text.trim()) return text;
      const lead = /^\s*/.exec(text)[0];
      const trail = /\s*$/.exec(text)[0];
      const closing = [...marks].reverse().join("");
      return `${lead}${marks}${text.trim()}${closing}${trail}`;
    })
    .join("");
}

/** Индекс закрывающей скобки к `{` на месте open (с учётом \{ \}) */
function closingBrace(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

const colorTex = (color, segments) => `$$\\color{${color}}\\small${segmentsTex(segments)}$$`;

/** Цветные куски текста: [{ from, to, color, contentFrom, contentTo }] */
export function colorSpans(doc) {
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

const spanAt = (doc, from, to) =>
  colorSpans(doc).find((span) => span.from <= from && to <= span.to && from < span.to && to > span.from);

const spanSegments = (doc, span) => texSegments(doc.slice(span.contentFrom, span.contentTo));

// То, что в KaTeX не превратить, — упоминания, каналы, свои эмодзи и
// ссылки — остаётся снаружи цветных кусков
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
    .map(([text, colored]) => {
      if (!colored || !text.trim()) return text;
      const lead = /^\s*/.exec(text)[0];
      const trail = /\s*$/.exec(text)[0];
      const body = text.slice(lead.length, text.length - trail.length);
      return `${lead}${colorTex(color, markdownSegments(body))}${trail}`;
    })
    .join("");
}

// ───────────────────────────── разметка ─────────────────────────────

/** Сколько подряд символов char стоит слева от at и справа от at2 */
function runs(doc, at, at2, char) {
  let left = 0;
  while (doc[at - 1 - left] === char) left += 1;
  let right = 0;
  while (doc[at2 + right] === char) right += 1;
  return Math.min(left, right);
}

/** Выделение без пробелов по краям: «** жирный**» разметка не примет */
function trimmed(doc, from, to) {
  while (from < to && /\s/.test(doc[from])) from += 1;
  while (to > from && /\s/.test(doc[to - 1])) to -= 1;
  return [from, to];
}

/** Включено ли форматирование kind у выделения (для подсветки кнопок) */
export function isActive(doc, from, to, kind) {
  [from, to] = trimmed(doc, from, to);
  if (kind === "quote") {
    const lines = doc.slice(lineStart(doc, from), to).split("\n");
    return lines.every((line) => line.startsWith(">"));
  }
  if (kind === "color") return Boolean(spanAt(doc, from, to));
  const span = spanAt(doc, from, to);
  if (span && (kind === "bold" || kind === "italic" || kind === "strike")) {
    return spanSegments(doc, span).every((segment) => !segment.text.trim() || segment.styles.includes(kind));
  }
  const mark = MARKS[kind];
  const selected = doc.slice(from, to);
  if (mark === "*") {
    const around = runs(doc, from, to, "*");
    const inside = /^\*+/.exec(selected)?.[0].length ?? 0;
    return around % 2 === 1 || (around === 0 && inside % 2 === 1 && selected.endsWith("*".repeat(inside)));
  }
  if (mark === "**") {
    const around = runs(doc, from, to, "*");
    return around >= 2 || (selected.startsWith("**") && selected.endsWith("**") && selected.length > 4);
  }
  return (
    (doc.slice(from - mark.length, from) === mark && doc.slice(to, to + mark.length) === mark) ||
    (selected.length > mark.length * 2 && selected.startsWith(mark) && selected.endsWith(mark))
  );
}

const lineStart = (doc, at) => doc.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (doc, at) => {
  const end = doc.indexOf("\n", at);
  return end < 0 ? doc.length : end;
};

/** Переключить форматирование kind (bold … quote) у выделения */
export function toggle(doc, from, to, kind) {
  if (kind === "quote") return toggleQuote(doc, from, to);
  [from, to] = trimmed(doc, from, to);
  const span = spanAt(doc, from, to);
  if (span) {
    if (kind === "bold" || kind === "italic" || kind === "strike") return toggleTex(doc, span, kind);
    // спойлер и код — вокруг всего цветного куска
    [from, to] = [span.from, span.to];
  }
  const mark = MARKS[kind];
  if (from === to) return { from, to, insert: mark + mark, anchor: from + mark.length, head: from + mark.length };
  const selected = doc.slice(from, to);
  const active = isActive(doc, from, to, kind) && (mark !== "*" || runs(doc, from, to, "*") !== 2);
  if (active) {
    // разметка снаружи выделения
    if (doc.slice(from - mark.length, from) === mark && doc.slice(to, to + mark.length) === mark) {
      return {
        from: from - mark.length,
        to: to + mark.length,
        insert: selected,
        anchor: from - mark.length,
        head: to - mark.length,
      };
    }
    // разметка выделена вместе с текстом
    const inner = selected.slice(mark.length, selected.length - mark.length);
    return { from, to, insert: inner, anchor: from, head: from + inner.length };
  }
  // каждая строка отдельно: разметка не переходит через строки
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
  const insert = lines
    .map((line) => (quoted ? line.replace(/^> ?/, "") : `> ${line}`))
    .join("\n");
  return { from: start, to: end, insert, anchor: start, head: start + insert.length };
}

function toggleTex(doc, span, kind) {
  const segments = spanSegments(doc, span);
  const on = segments.every((segment) => !segment.text.trim() || segment.styles.includes(kind));
  const next = segments.map(({ text, styles }) => ({
    text,
    styles: on ? styles.filter((style) => style !== kind) : styles.includes(kind) ? styles : [...styles, kind],
  }));
  const insert = colorTex(span.color, merge(next));
  return { from: span.from, to: span.to, insert, anchor: span.from, head: span.from + insert.length };
}

/** Покрасить выделение в color (`#rrggbb`) или убрать цвет (color = null) */
export function paint(doc, from, to, color) {
  [from, to] = trimmed(doc, from, to);
  const touched = colorSpans(doc).filter((span) => span.from < Math.max(to, from + 1) && span.to > from);
  if (touched.length) {
    // перекрасить или снять цвет с затронутых кусков целиком
    const start = Math.min(from, touched[0].from);
    const end = Math.max(to, touched.at(-1).to);
    let insert = "";
    let at = start;
    for (const span of touched) {
      insert += doc.slice(at, span.from);
      insert += color
        ? doc.slice(span.from, span.to).replace(/^\$\$\\color\{[^{}$]+\}/, `$$$$\\color{${color}}`)
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

/** Применить правку к строке (для превью) */
export const apply = (doc, change) => doc.slice(0, change.from) + change.insert + doc.slice(change.to);
