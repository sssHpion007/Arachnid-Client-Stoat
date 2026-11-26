// Превью меню форматирования: поле ввода (вместо CodeMirror for-web —
// textarea), меню над выделением, палитра и сообщения, нарисованные почти
// как у for-web (разметка + KaTeX).
import katex from "./node_modules/katex/dist/katex.mjs";
import { apply, isActive, paint, toggle } from "./format.js";

const input = document.getElementById("input");
const mirror = document.getElementById("mirror");
const toolbar = document.getElementById("toolbar");
const palette = document.getElementById("palette");
const messages = document.getElementById("messages");

const BUTTONS = [
  { kind: "bold", icon: "format_bold", tip: "Жирный" },
  { kind: "italic", icon: "format_italic", tip: "Курсив" },
  { kind: "strike", icon: "format_strikethrough", tip: "Зачёркнутый" },
  "|",
  { kind: "spoiler", icon: "visibility_off", tip: "Спойлер" },
  { kind: "code", icon: "code", tip: "Код" },
  { kind: "quote", icon: "format_quote", tip: "Цитата" },
  "|",
  { kind: "color", icon: "palette", tip: "Цвет текста" },
];

// подобраны так, чтобы читались и на тёмной, и на светлой теме
const SWATCHES = [
  "#e5534b", "#f0883e", "#e3b341", "#57ab5a", "#39c5cf", "#539bf5", "#b083f0", "#e275ad",
  "#ff938a", "#ffb77c", "#f8e3a1", "#8ddb8c", "#96d0ff", "#c9d1ff", "#dcbdfb", "#adbac7",
];

const state = { menu: "1", palette: "a", render: "katex", lastColor: "#e5534b", saved: null };

// ───────────────────────────── варианты ─────────────────────────────
for (const group of document.querySelectorAll(".segmented")) {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    for (const other of group.children) other.setAttribute("aria-pressed", String(other === button));
    state[group.dataset.option] = button.dataset.value;
    document.body.dataset[group.dataset.option] = button.dataset.value;
    hidePalette();
    buildToolbar();
    refresh();
  });
}
document.body.dataset.render = state.render;

// ───────────────────────────── сообщения ─────────────────────────────
const escapeHtml = (text) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

/** Разметка Stoat в HTML — упрощённо, только для превью */
function renderMarkdown(source) {
  const holes = [];
  const hole = (html) => `\u0000${holes.push(html) - 1}\u0000`;
  let text = source
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
      let html = katex.renderToString(tex, {
        throwOnError: false,
        maxSize: 10,
        maxExpand: 2,
        trust: false,
        strict: false,
        output: "html",
      });
      if (tex.startsWith("\\color")) html = html.replace('class="katex"', 'class="katex arachnid-colored"');
      return hole(html);
    })
    .replace(/`([^`\n]+)`/g, (_, code) => hole(`<code>${escapeHtml(code)}</code>`));
  text = escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/\|\|(.+?)\|\|/g, '<span class="spoiler">$1</span>')
    .replace(/&#60;@[^&]+&#62;/g, '<span style="color:var(--md-sys-color-primary)">@Друг</span>');
  // цитаты: подряд идущие строки «> …»
  text = text.replace(/(?:^|\n)((?:&#62; ?.*(?:\n|$))+)/g, (match, block) => {
    const inner = block.replace(/&#62; ?/g, "").replace(/\n$/, "");
    return `${match.startsWith("\n") ? "\n" : ""}<blockquote>${inner}</blockquote>`;
  });
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => holes[index]);
}

function addMessage(author, source) {
  const message = document.createElement("div");
  message.className = "message";
  message.innerHTML = `<div class="avatar">${author[0]}</div><div><div class="author">${author}</div><div class="content">${renderMarkdown(source)}</div></div>`;
  messages.append(message);
  messages.scrollTop = messages.scrollHeight;
}

messages.addEventListener("click", (event) => event.target.closest(".spoiler")?.classList.toggle("shown"));

addMessage("Анна", "Выделите кусок своего сообщения — сверху появится меню. Работает **жирный**, *курсив*, ~~зачёркнутый~~, ||спойлер||, `код` и цитата.");
addMessage(
  "Борис",
  "А вот цветной текст: $$\\color{#e5534b}\\small\\textsf{красный, }\\allowbreak\\textsf{\\textbf{жирный }}\\allowbreak\\textsf{и }\\allowbreak\\textsf{обычный}$$ и снова $$\\color{#539bf5}\\small\\textsf{синий}$$.",
);
addMessage(
  "Анна",
  "Длинный цветной текст переносится по словам: $$\\color{#57ab5a}\\small\\textsf{Это }\\allowbreak\\textsf{довольно }\\allowbreak\\textsf{длинное }\\allowbreak\\textsf{предложение, }\\allowbreak\\textsf{которое }\\allowbreak\\textsf{не }\\allowbreak\\textsf{влезает }\\allowbreak\\textsf{в }\\allowbreak\\textsf{одну }\\allowbreak\\textsf{строку }\\allowbreak\\textsf{чата }\\allowbreak\\textsf{и }\\allowbreak\\textsf{переходит }\\allowbreak\\textsf{на }\\allowbreak\\textsf{следующую.}$$",
);

input.value = "Привет! Это **моё** сообщение, выделите любое слово";

// ───────────────────────────── поле ввода ─────────────────────────────
function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

input.addEventListener("input", () => {
  autosize();
  refresh();
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (input.value.trim()) addMessage("Вы", input.value);
    input.value = "";
    autosize();
    refresh();
  }
  if (event.key === "Escape") hideAll();
});
document.addEventListener("selectionchange", () => {
  if (document.activeElement === input) refresh();
});
input.addEventListener("blur", () => {
  // фокус ушёл в палитру (поле HEX) — меню остаётся
  // палитра открыта (поле HEX, системное окно цвета) — меню остаётся
  setTimeout(() => {
    if (palette.hidden && document.activeElement !== input) hideAll();
  });
});

/** Прямоугольник выделения в поле: зеркальный div с тем же текстом */
function selectionRect() {
  const { selectionStart: from, selectionEnd: to, value } = input;
  mirror.textContent = value.slice(0, from);
  const mark = document.createElement("span");
  mark.textContent = value.slice(from, to) || "\u200b";
  mirror.append(mark, document.createTextNode(value.slice(to) || " "));
  mirror.scrollTop = input.scrollTop;
  const rects = [...mark.getClientRects()];
  const shift = input.scrollTop;
  const first = rects[0];
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  return { top: first.top - shift, left, right };
}

// ───────────────────────────── меню ─────────────────────────────
function buildToolbar() {
  toolbar.dataset.variant = state.menu;
  toolbar.replaceChildren(
    ...BUTTONS.map((button) => {
      if (button === "|") {
        const separator = document.createElement("span");
        separator.className = "separator";
        return separator;
      }
      const element = document.createElement("button");
      element.type = "button";
      element.dataset.kind = button.kind;
      element.dataset.tip = button.tip;
      element.setAttribute("aria-label", button.tip);
      element.innerHTML = `<span class="material-symbols-outlined">${button.icon}</span>`;
      if (button.kind === "color") element.classList.add("color-button");
      return element;
    }),
  );
  toolbar.style.setProperty("--last-color", state.lastColor);
}

// кнопки меню не забирают фокус у поля — выделение остаётся
toolbar.addEventListener("mousedown", (event) => event.preventDefault());
toolbar.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-kind]");
  if (!button) return;
  if (button.dataset.kind === "color") return palette.hidden ? showPalette(button) : hidePalette();
  hidePalette();
  edit((doc, from, to) => toggle(doc, from, to, button.dataset.kind));
});

function edit(change) {
  const { selectionStart: from, selectionEnd: to } = state.saved ?? {
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
  };
  const result = change(input.value, from, to);
  if (!result) return;
  // через историю поля: Ctrl+Z отменяет
  input.focus();
  input.setSelectionRange(result.from, result.to);
  document.execCommand("insertText", false, result.insert);
  input.setSelectionRange(result.anchor, result.head);
  state.saved = null;
  autosize();
  refresh();
}

function refresh() {
  const { selectionStart: from, selectionEnd: to, value } = input;
  if (from === to || document.activeElement !== input) {
    if (palette.hidden) toolbar.hidden = true;
    return;
  }
  for (const button of toolbar.querySelectorAll("button[data-kind]")) {
    button.setAttribute("aria-pressed", String(isActive(value, from, to, button.dataset.kind)));
  }
  toolbar.hidden = false;
  const rect = selectionRect();
  const width = toolbar.offsetWidth;
  const center = (rect.left + rect.right) / 2;
  const left = Math.max(8, Math.min(innerWidth - width - 8, center - width / 2));
  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${rect.top - toolbar.offsetHeight - 8}px`;
  if (!palette.hidden) placePalette();
}

function hideAll() {
  toolbar.hidden = true;
  hidePalette();
}

// ───────────────────────────── палитра ─────────────────────────────
function swatchButton(color) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "swatch";
  button.title = color;
  button.style.setProperty("--swatch", color);
  button.setAttribute("aria-pressed", String(color === currentColor()));
  button.addEventListener("click", () => choose(color));
  return button;
}

function currentColor() {
  const match = /\$\$\\color\{(#[0-9a-f]{6})\}/i.exec(input.value.slice(input.selectionStart, input.selectionEnd));
  return match?.[1].toLowerCase() ?? null;
}

function action(icon, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "palette-action";
  button.innerHTML = `<span class="material-symbols-outlined">${icon}</span>${label}`;
  button.addEventListener("click", onClick);
  return button;
}

function choose(color) {
  if (color) {
    state.lastColor = color;
    toolbar.style.setProperty("--last-color", color);
  }
  hidePalette();
  edit((doc, from, to) => paint(doc, from, to, color));
}

function showPalette(anchor) {
  state.saved = { selectionStart: input.selectionStart, selectionEnd: input.selectionEnd };
  const title = document.createElement("div");
  title.className = "palette-title";
  title.textContent = "Цвет текста";
  const swatches = document.createElement("div");
  swatches.className = "swatches";
  const noColor = action("format_color_reset", "Без цвета", () => choose(null));
  noColor.disabled = !isActive(input.value, input.selectionStart, input.selectionEnd, "color");
  if (noColor.disabled) noColor.style.opacity = "0.4";

  if (state.palette === "a") {
    swatches.append(...SWATCHES.map(swatchButton));
    const native = document.createElement("input");
    native.type = "color";
    native.value = state.lastColor;
    const custom = action("colorize", "Свой цвет", () => native.click());
    native.addEventListener("change", () => choose(native.value));
    const actions = document.createElement("div");
    actions.className = "palette-actions";
    actions.append(custom, noColor, native);
    palette.replaceChildren(title, swatches, actions);
  } else {
    swatches.append(...SWATCHES.slice(0, 8).map(swatchButton));
    palette.replaceChildren(title, swatches, picker(), noColor);
    noColor.style.alignSelf = "flex-start";
  }
  toolbar.dataset.palette = "";
  palette.hidden = false;
  placePalette(anchor);
}

function placePalette(anchor = toolbar.querySelector(".color-button")) {
  const rect = anchor.getBoundingClientRect();
  const bar = toolbar.getBoundingClientRect();
  const left = Math.max(8, Math.min(innerWidth - palette.offsetWidth - 8, rect.left + rect.width / 2 - palette.offsetWidth / 2));
  palette.style.left = `${left}px`;
  palette.style.top = `${bar.top - palette.offsetHeight - 8}px`;
}

function hidePalette() {
  palette.hidden = true;
  delete toolbar.dataset.palette;
  state.saved = null;
}

document.addEventListener("mousedown", (event) => {
  if (!palette.hidden && !palette.contains(event.target) && !toolbar.contains(event.target)) hidePalette();
});
palette.addEventListener("mousedown", (event) => {
  if (!event.target.matches("input")) event.preventDefault();
});

/** Вариант Б: свой цвет без системного окна */
function picker() {
  const hsv = hexToHsv(state.lastColor);
  const root = document.createElement("div");
  root.className = "picker";
  root.innerHTML = `
    <div class="sv"><span class="knob"></span></div>
    <div class="hue"><span class="knob"></span></div>
    <div class="picker-row">
      <span class="picker-sample"></span>
      <input class="hex" maxlength="7" spellcheck="false" />
      <button type="button" class="apply">Применить</button>
    </div>`;
  const [sv, hue] = root.querySelectorAll(".sv, .hue");
  const sample = root.querySelector(".picker-sample");
  const hex = root.querySelector(".hex");
  const paintPicker = (fromHex = false) => {
    const color = hsvToHex(hsv);
    sv.style.setProperty("--hue", hsv.h);
    sv.firstElementChild.style.left = `${hsv.s * 100}%`;
    sv.firstElementChild.style.top = `${(1 - hsv.v) * 100}%`;
    sv.firstElementChild.style.background = color;
    hue.firstElementChild.style.left = `${(hsv.h / 360) * 100}%`;
    hue.firstElementChild.style.background = `hsl(${hsv.h} 100% 50%)`;
    sample.style.background = color;
    if (!fromHex) hex.value = color;
  };
  const drag = (element, onMove) => {
    element.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        const rect = element.getBoundingClientRect();
        onMove(
          Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / rect.width)),
          Math.max(0, Math.min(1, (moveEvent.clientY - rect.top) / rect.height)),
        );
        paintPicker();
      };
      move(event);
      element.addEventListener("pointermove", move);
      element.addEventListener("pointerup", () => element.removeEventListener("pointermove", move), { once: true });
    });
  };
  drag(sv, (x, y) => Object.assign(hsv, { s: x, v: 1 - y }));
  drag(hue, (x) => (hsv.h = Math.round(x * 360)));
  hex.addEventListener("input", () => {
    if (/^#[0-9a-f]{6}$/i.test(hex.value)) {
      Object.assign(hsv, hexToHsv(hex.value));
      paintPicker(true);
    }
  });
  hex.addEventListener("keydown", (event) => {
    if (event.key === "Enter") choose(hsvToHex(hsv));
  });
  root.querySelector(".apply").addEventListener("click", () => choose(hsvToHex(hsv)));
  paintPicker();
  return root;
}

function hexToHsv(hex) {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  return { h: Math.round((h * 60 + 360) % 360), s: max ? delta / max : 0, v: max };
}

function hsvToHex({ h, s, v }) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${[f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
}

buildToolbar();
autosize();
