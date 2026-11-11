// Разбор Markdown сообщений Stoat — тот же конвейер unified, что в
// браузерном клиенте (packages/client/components/markdown в for-web):
// remark-parse + remark-breaks + remark-gfm + remark-math, плагины Stoat
// (упоминания, каналы, эмодзи, спойлеры, метки времени, ссылки),
// remark-rehype, KaTeX и подсветка кода lowlight.
//
// Результат — дерево hast. DOM из него строит ui/markdown.js: никакого
// HTML-текста в webview не попадает, только узлы из белого списка.
//
// Сборка: см. ui/vendor/README.md (раздел markdown.js).

import emojiRegex from "emoji-regex";
import LinkifyIt from "linkify-it";
import { all } from "lowlight";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";

// ─────────── регулярные выражения (stoat.js lib/regex.ts, UnicodeEmoji.tsx) ───────────

const RE_CUSTOM_EMOJI = /:([ABCDEFGHJKMNPQRSTVWXYZ\d]{26}):/g;
const RE_CHANNELS = /<#([ABCDEFGHJKMNPQRSTVWXYZ\d]{26})>/g;
const RE_MENTION =
  /(<@[ABCDEFGHJKMNPQRSTVWXYZ\d]{26}>|@everyone|@online|<%[ABCDEFGHJKMNPQRSTVWXYZ\d]{26}>)/;
const RE_TIMESTAMP = /<t:([0-9]+)(?::(\w))?>/g;

const UNICODE_EMOJI_REGIONAL_INDICATORS =
  "\u{1f1e6}|\u{1f1e7}|\u{1f1e8}|\u{1f1e9}|\u{1f1ea}|\u{1f1eb}|\u{1f1ec}|\u{1f1ed}|\u{1f1ee}|\u{1f1ef}|\u{1f1f0}|\u{1f1f1}|\u{1f1f2}|\u{1f1f3}|\u{1f1f4}|\u{1f1f5}|\u{1f1f6}|\u{1f1f7}|\u{1f1f8}|\u{1f1f9}|\u{1f1fa}|\u{1f1fb}|\u{1f1fc}|\u{1f1fd}|\u{1f1fe}|\u{1f1ff}";
const UNICODE_EMOJI_MIN_PACK = "\uE0E0".codePointAt(0);
const UNICODE_EMOJI_MAX_PACK = "\uE0E6".codePointAt(0);
const UNICODE_ZWNJ = "\u200C";
const RE_UNICODE_EMOJI = new RegExp(
  `([\uE0E0-\uE0E6]?(?:${emojiRegex().source}|(?:${UNICODE_ZWNJ}?(?:${UNICODE_EMOJI_REGIONAL_INDICATORS}))))`,
  "g",
);
const UNICODE_EMOJI_PUA_PACK = {
  "\uE0E0": "fluent-3d",
  "\uE0E1": "fluent-3d",
  "\uE0E2": "fluent-flat",
  "\uE0E3": "mutant",
  "\uE0E4": "noto",
  "\uE0E6": "twemoji",
};
const RE_UNICODE_EMOJI_REGIONAL_INDICATOR = new RegExp(`^(?:${UNICODE_EMOJI_REGIONAL_INDICATORS})$`);
const isRegionalIndicator = (emoji) => RE_UNICODE_EMOJI_REGIONAL_INDICATOR.test(emoji);

const RE_ANY_EMOJI = new RegExp(RE_CUSTOM_EMOJI.source + "|" + RE_UNICODE_EMOJI.source, "g");

// ─────────── sanitise.ts ───────────

const RE_RECURSIVE = /(^(?:[>*+-][^\S\r\n]*){4})(?:[>][^\S\r\n]*|[*+-]+\s)+(.*$)/gm;
const RE_BLOCKQUOTE = /^(?:[^\S\r\n]*>[^\n]+\n?)+/gm;
const RE_HTML_TAGS = /^(?:<\/?[a-zA-Z0-9]+>)(?:.*$)/gm;
const RE_EMPTY_LINE = /^\s*?$/gm;
const RE_PLUS = /^\s*\+(?:$|[^+])/gm;
const RE_CODEBLOCK_EMPTY_LINE_FIX = /(?<=`{3}[\s\S]*)\n\u200B\n(?=[\s\S]*`{3})/gm;
const RE_SPOILER_URL = /(https?:\/\/[\w_.~!*''();:@&=+$,/?#[%-]+)\|\|/;

function sanitise(content) {
  return content
    .replace(RE_RECURSIVE, (_, m0, m1) => m0 + m1)
    .replace(RE_HTML_TAGS, "\u200B$&")
    .replace(RE_PLUS, "\u200B$&")
    .replace(RE_EMPTY_LINE, "\n\u200B\n")
    .replace(RE_CODEBLOCK_EMPTY_LINE_FIX, "")
    .replace(RE_BLOCKQUOTE, "$&\n")
    .replace(RE_SPOILER_URL, "$1 ||");
}

/** \u200B → <br>, как remarkInsertBreaks. */
function remarkInsertBreaks() {
  return (tree) => {
    function recurse(element) {
      if (element.type === "text" && element.value === "\u200B") {
        return { type: "element", tagName: "br", properties: {}, children: [] };
      }
      return { ...element, children: element.children?.map((child) => recurse(child)) };
    }
    return recurse(tree);
  };
}

// ─────────── плагины remark (plugins/*.tsx) ───────────

/** Разбить текстовые узлы регулярным выражением (общая часть всех плагинов). */
function splitText(tree, build, options = {}) {
  visit(tree, "text", (node, idx, parent) => {
    // текст уже внутри ссылки (`[текст](url)`, автоссылка GFM) не
    // превращаем в ещё одну ссылку: вложенный <a> в <a> недопустим
    if (options.outsideLinks && (parent.type === "link" || parent.type === "linkReference")) return;
    const nodes = build(node.value)?.filter((item) => item.type !== "text" || item.value);
    if (!nodes) return;
    parent.children.splice(idx, 1, ...nodes);
    return idx + nodes.length;
  });
}

const remarkMentions = () => (tree) =>
  splitText(tree, (value) => {
    const elements = value.split(RE_MENTION);
    if (elements.length === 1) return null;
    return elements.map((part, index) =>
      index % 2
        ? part.startsWith("<@")
          ? { type: "mention", mentions: "user:" + part.substring(2, part.length - 1) }
          : part === "@everyone"
            ? { type: "mention", mentions: "everyone" }
            : part === "@online"
              ? { type: "mention", mentions: "online" }
              : { type: "mention", mentions: "role:" + part.substring(2, part.length - 1) }
        : { type: "text", value: part },
    );
  });

const remarkTimestamps = () => (tree) =>
  splitText(tree, (value) => {
    const elements = value.split(RE_TIMESTAMP);
    if (elements.length === 1) return null;
    const nodes = [{ type: "text", value: elements.shift() }];
    for (let i = 0; i < elements.length / 3; i++) {
      nodes.push({ type: "timestamp", format: elements[i * 3 + 1], unix: parseInt(elements[i * 3], 10) });
      nodes.push({ type: "text", value: elements[i * 3 + 2] });
    }
    return nodes;
  });

const remarkChannels = (options) => (tree) =>
  splitText(tree, (value) => {
    const elements = value.split(RE_CHANNELS);
    if (elements.length === 1) return null;
    return elements.map((part, index) =>
      index % 2 ? { type: "link", url: `${options.origin}/channel/${part}`, children: [] } : { type: "text", value: part },
    );
  }, { outsideLinks: true });

function parseUnicodeEmoji(str) {
  const selector = str[0].codePointAt(0);
  const strip = (text) =>
    text.startsWith(UNICODE_ZWNJ) && isRegionalIndicator(text.substring(1)) ? text.substring(1) : text;
  if (selector && selector >= UNICODE_EMOJI_MIN_PACK && selector <= UNICODE_EMOJI_MAX_PACK) {
    return { str: strip(str.substring(1)), pack: UNICODE_EMOJI_PUA_PACK[str[0]] };
  }
  return { str: strip(str) };
}

const remarkUnicodeEmoji = () => (tree) =>
  splitText(tree, (value) => {
    const elements = value.split(RE_UNICODE_EMOJI);
    if (elements.length === 1) return null;
    const nodes = [{ type: "text", value: elements.shift() }];
    for (let i = 0; i < elements.length / 2; i++) {
      nodes.push({ type: "unicodeEmoji", ...parseUnicodeEmoji(elements[i * 2]) });
      nodes.push({ type: "text", value: elements[i * 2 + 1] });
    }
    return nodes;
  });

const remarkCustomEmoji = () => (tree) =>
  splitText(tree, (value) => {
    const elements = value.split(RE_CUSTOM_EMOJI);
    if (elements.length === 1) return null;
    const nodes = [{ type: "text", value: elements.shift() }];
    for (let i = 0; i < elements.length / 2; i++) {
      nodes.push({ type: "customEmoji", id: elements[i * 2] });
      nodes.push({ type: "text", value: elements[i * 2 + 1] });
    }
    return nodes;
  });

/** Спойлеры `||…||`, в том числе через несколько абзацев (plugins/spoiler.tsx). */
const remarkSpoiler = () => (tree) => {
  const tNodes = tree.children;
  let spillover;
  let spoilerStart = -1;
  let spoilerText;

  visit(tree, "paragraph", (node, tIdx) => {
    for (let i = 0, s, sl; i < node.children.length; ++i) {
      const child = node.children[i];
      if (child.type === "text") {
        const spoilers = child.value.split("||");
        if (spoilers.length === 1) continue;
        node.children.splice(i, 1);

        for (s = 1, sl = spoilers.length; s < sl; ++s) {
          if (spoilerStart !== -1) {
            const sText = spoilers[s - 1];
            const elements = node.children.splice(spoilerStart, i - spoilerStart);
            const inject = [
              {
                type: "spoiler",
                children: [
                  ...(spoilerText ? [{ type: "text", value: spoilerText }] : []),
                  ...(spillover || []),
                  ...elements,
                  ...(sText && (spillover || i !== spoilerStart) ? [{ type: "text", value: spoilers[s - 1] }] : []),
                ],
              },
              ...(spoilers[s] ? [{ type: "text", value: spoilers[s] }] : []),
            ];
            node.children.splice(spoilerStart, 0, ...inject);
            i = spoilerStart + inject.length - 1;
            spoilerStart = -1;
            spillover = null;
          } else {
            if (spoilers[s - 1]) node.children.splice(i++, 0, { type: "text", value: spoilers[s - 1] });
            spoilerStart = i;
            spoilerText = spoilers[s];
          }
        }
      }
    }

    if (spoilerStart !== -1) {
      if (!spillover) spillover = [];
      spillover.push(...node.children.splice(spoilerStart));
      spoilerStart = 0;
    }

    if (spillover && tIdx === tNodes.length - 1) {
      node.children.push(...(spoilerText ? [{ type: "text", value: spoilerText }] : []), ...spillover);
    }
  });
};

const linkify = new LinkifyIt({ fuzzyLink: false });

const remarkLinkify = () => (tree) =>
  splitText(tree, (value) => {
    const links = linkify.match(value);
    if (links === null) return null;
    return [
      { type: "text", value: value.slice(0, links[0].index) },
      ...links.flatMap((link, idx) => [
        { type: "link", url: link.url, title: link.text, children: [{ type: "text", value: link.text }] },
        { type: "text", value: value.slice(link.lastIndex, links[idx + 1]?.index ?? value.length) },
      ]),
    ];
  }, { outsideLinks: true });

const remarkHtmlToText = () => (tree) => {
  visit(tree, "html", (node) => {
    node.type = "text";
  });
};

// ─────────── узлы Stoat → hast ───────────

const handlers = {
  unicodeEmoji: (h, node) => ({
    type: "element",
    tagName: "unicodeEmoji",
    children: [],
    properties: { str: node.str, pack: node.pack },
  }),
  customEmoji: (h, node) => ({ type: "element", tagName: "customEmoji", children: [], properties: { id: node.id } }),
  mention: (h, node) => ({ type: "element", tagName: "mention", children: [], properties: { mentions: node.mentions } }),
  timestamp: (h, node) => ({
    type: "element",
    tagName: "timestamp",
    children: [],
    properties: { format: node.format, unix: node.unix },
  }),
  spoiler: (h, node) => ({
    type: "element",
    tagName: "spoiler",
    children: h.all({ type: "paragraph", children: node.children }),
    properties: {},
  }),
};

// ─────────── конвейеры (index.tsx) ───────────

const base = () =>
  unified().use(remarkParse).use(remarkBreaks).use(remarkGfm).use(remarkMath, { singleDollarTextMath: false });

const pipelines = new Map();

/** Полный конвейер сообщений (htmlPipeline). */
function fullPipeline(origin) {
  return base()
    .use(remarkMentions)
    .use(remarkTimestamps)
    .use(remarkChannels, { origin })
    .use(remarkUnicodeEmoji)
    .use(remarkCustomEmoji)
    .use(remarkSpoiler)
    .use(remarkLinkify)
    .use(remarkHtmlToText)
    .use(remarkRehype, { handlers })
    .use(remarkInsertBreaks)
    .use(rehypeKatex, {
      maxSize: 10,
      maxExpand: 2,
      trust: false,
      strict: false,
      output: "html",
      errorColor: "var(--md-sys-color-error)",
    })
    .use(rehypeHighlight, { languages: all });
}

/** Упрощённый конвейер ответов и списка изменений (replyPipeline). */
function replyPipeline() {
  return unified()
    .use(remarkParse)
    .use(remarkBreaks)
    .use(remarkGfm)
    .use(remarkMentions)
    .use(remarkUnicodeEmoji)
    .use(remarkCustomEmoji)
    .use(remarkSpoiler)
    .use(remarkLinkify)
    .use(remarkRehype, {
      handlers: {
        unicodeEmoji: handlers.unicodeEmoji,
        customEmoji: handlers.customEmoji,
        mention: handlers.mention,
        spoiler: handlers.spoiler,
      },
    })
    .use(remarkInsertBreaks);
}

function pipeline(mode, origin) {
  const key = mode === "full" ? "full:" + origin : "simple";
  if (!pipelines.has(key)) pipelines.set(key, mode === "full" ? fullPipeline(origin) : replyPipeline());
  return pipelines.get(key);
}

/** Только эмодзи (emoji/util.ts). */
function isOnlyEmoji(text) {
  return text.replaceAll(RE_ANY_EMOJI, "").trim().length === 0;
}

/** Размер «крупных» эмодзи для первого абзаца (injectEmojiSize). */
function emojiSize(content) {
  if (!isOnlyEmoji(content)) return null;
  RE_ANY_EMOJI.lastIndex = 0;
  RE_ANY_EMOJI.exec(content);
  return RE_ANY_EMOJI.exec(content) ? "medium" : "large";
}

/**
 * Разобрать текст в дерево hast.
 * @param {string} content исходный Markdown
 * @param {{ mode?: "full" | "simple", origin?: string, disallowBigEmoji?: boolean }} options
 */
export function parse(content, options = {}) {
  const mode = options.mode || "full";
  const origin = options.origin || "https://stoat.chat";
  const file = new VFile();
  file.value = sanitise(content || "");
  const processor = pipeline(mode, origin);
  const tree = processor.runSync(processor.parse(file), file);
  if (mode === "full" && !options.disallowBigEmoji) {
    const first = tree.children && tree.children[0];
    const size = first && first.properties ? emojiSize(content || "") : null;
    if (size) first.properties.emojiSize = size;
  }
  return tree;
}

export { isOnlyEmoji, RE_CUSTOM_EMOJI, RE_UNICODE_EMOJI };
