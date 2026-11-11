// Обрезка картинок перед загрузкой (ImageCropper.tsx, cropProcessor.ts и
// CropProcess.tsx браузерного клиента). Рамка двигается и тянется за
// маркеры; в режиме пропорций держит соотношение сторон, у аватара —
// круглая. Результат кодируется в исходном формате и проверяется на
// предельный размер для своего тега.

"use strict";

/** Форматы, которые принимает выбор картинок (ALLOWED_IMAGE_TYPES). */
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const CROP_MIN_SIZE = 32; // px на экране
const CROP_STAGE_HEIGHT = 420;

/** Обрезанный файл больше разрешённого (CropSizeError). */
class CropSizeError extends Error {
  constructor(actualSize, maxSize) {
    super(`Cropped file (${actualSize} bytes) exceeds max size (${maxSize} bytes)`);
    this.name = "CropSizeError";
    this.actualSize = actualSize;
    this.maxSize = maxSize;
  }
}

/** Анимированный WebP (чанки ANIM/ANMF) обрезать нельзя — потеряется анимация. */
async function isAnimatedWebP(blob) {
  const bytes = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const text = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length < 12 || text(0, 4) !== "RIFF" || text(8, 4) !== "WEBP") return false;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = text(offset, 4);
    const size = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
    if (type === "ANIM" || type === "ANMF") return true;
    offset += 8 + size + (size & 1);
  }
  return false;
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load image"));
    img.src = src;
  });
}

/** Blob → выбранный файл в виде, который понимает upload_file. */
function blobToPicked(blob, name) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || "");
      resolve({ name, type: blob.type, size: blob.size, data: data.slice(data.indexOf(",") + 1), preview: data });
    };
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

/** Вырезать `rect` (в пикселях исходника) и закодировать в формат исходника. */
async function cropImage(img, rect, source, maxSize) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.w));
  canvas.height = Math.max(1, Math.round(rect.h));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas is unavailable");
  context.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("toBlob failed"))), source.type || "image/png"),
  );
  if (maxSize && blob.size > maxSize) throw new CropSizeError(blob.size, maxSize);
  return blobToPicked(blob, source.name);
}

/**
 * Область обрезки. Возвращает { node, crop(), displayWidth() }.
 * `mode` — "ratio" (фиксированные пропорции) или "freeform".
 */
function imageCropper({ src, source, ratio = 1, ratioLabel = null, circularMask = false, allowModeToggle = true, maxSize = 0 }) {
  let mode = "ratio";
  let display = { w: 0, h: 0 };
  let rect = { x: 0, y: 0, w: 0, h: 0 };
  let drag = null;

  const stage = h("div", { class: "cropper-stage" });
  stage.style.height = CROP_STAGE_HEIGHT + "px";
  const base = h("img", { class: "cropper-base", src, alt: "", draggable: "false" });
  const mask = h("img", { class: "cropper-mask hidden", src, alt: "", draggable: "false" });
  const grid = h("div", { class: "cropper-grid" });
  const box = h("div", { class: "cropper-box hidden" }, [grid]);
  stage.append(base, mask, box);

  const circle = () => circularMask && mode !== "freeform";

  const handles = () => (mode === "ratio" ? (circularMask ? ["rad"] : ["ne", "nw", "se", "sw"]) : ["n", "s", "e", "w", "ne", "nw", "se", "sw"]);

  const initialRect = (w, height) => {
    if (mode !== "ratio") return { x: 0, y: 0, w, h: height };
    let cw = w;
    let ch = w / ratio;
    if (ch > height) {
      ch = height;
      cw = height * ratio;
    }
    return { x: (w - cw) / 2, y: (height - ch) / 2, w: cw, h: ch };
  };

  const clamp = (r) => {
    let { x, y, w, h: height } = r;
    if (mode === "ratio") {
      const maxW = Math.min(display.w, display.h * ratio);
      const minW = Math.min(CROP_MIN_SIZE, display.w, display.h * ratio);
      w = Math.max(minW, Math.min(w, maxW));
      height = w / ratio;
    } else {
      w = Math.max(Math.min(CROP_MIN_SIZE, display.w), Math.min(w, display.w));
      height = Math.max(Math.min(CROP_MIN_SIZE, display.h), Math.min(height, display.h));
    }
    x = Math.max(0, Math.min(x, display.w - w));
    y = Math.max(0, Math.min(y, display.h - height));
    return { x, y, w, h: height };
  };

  const resize = (start, handle, dx, dy) => {
    const { x, y, w, h: height } = start;
    const left = handle.includes("w");
    const right = handle.includes("e") || handle === "rad";
    const top = handle.includes("n") || handle === "rad";
    const bottom = handle.includes("s");
    let nx = x;
    let ny = y;
    let nw = w;
    let nh = height;
    if (left) {
      nx = x + dx;
      nw = w - dx;
    } else if (right) nw = w + dx;
    if (top) {
      ny = y + dy;
      nh = height - dy;
    } else if (bottom) nh = height + dy;

    if (mode === "ratio") {
      const byWidth = left || right;
      const byHeight = top || bottom;
      if (byWidth && !byHeight) {
        nh = nw / ratio;
        if (top) ny = y + height - nh;
      } else if (byHeight && !byWidth) {
        nw = nh * ratio;
        if (left) nx = x + w - nw;
      } else {
        if (Math.abs(dx) > Math.abs(dy) * ratio) nh = nw / ratio;
        else nw = nh * ratio;
        if (top) ny = y + height - nh;
        if (left) nx = x + w - nw;
      }
    }
    nw = Math.max(CROP_MIN_SIZE, nw);
    nh = Math.max(CROP_MIN_SIZE, mode === "ratio" ? nw / ratio : nh);
    nx = Math.max(0, Math.min(nx, display.w - nw));
    ny = Math.max(0, Math.min(ny, display.h - nh));
    return { x: nx, y: ny, w: nw, h: nh };
  };

  const paint = () => {
    if (!display.w) return;
    box.style.left = rect.x + "px";
    box.style.top = rect.y + "px";
    box.style.width = rect.w + "px";
    box.style.height = rect.h + "px";
    box.classList.toggle("circle", circle());
    grid.style.clipPath = circle() ? `circle(${rect.w / 2}px)` : "";
    mask.style.clipPath = circle()
      ? `circle(${rect.w / 2}px at ${rect.x + rect.w / 2}px ${rect.y + rect.h / 2}px)`
      : `inset(${rect.y}px ${display.w - (rect.x + rect.w)}px ${display.h - (rect.y + rect.h)}px ${rect.x}px)`;
  };

  const buildHandles = () => {
    box.querySelectorAll(".cropper-handle").forEach((node) => node.remove());
    for (const id of handles()) {
      const handle = h("div", { class: "cropper-handle " + id });
      handle.addEventListener("pointerdown", (event) => startDrag(event, id));
      box.append(handle);
    }
  };

  const startDrag = (event, kind) => {
    event.preventDefault();
    event.stopPropagation();
    event.target.setPointerCapture && event.target.setPointerCapture(event.pointerId);
    drag = { kind, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startRect: Object.assign({}, rect) };
  };

  box.addEventListener("pointerdown", (event) => startDrag(event, "move"));

  const onMove = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const start = drag.startRect;
    rect = drag.kind === "move" ? clamp(Object.assign({}, start, { x: start.x + dx, y: start.y + dy })) : clamp(resize(start, drag.kind, dx, dy));
    paint();
  };
  const onUp = (event) => {
    if (drag && event.pointerId === drag.pointerId) drag = null;
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);

  base.addEventListener("load", () => {
    const natW = base.naturalWidth;
    const natH = base.naturalHeight;
    const scale = Math.min(stage.clientWidth / natW, stage.clientHeight / natH, 1);
    display = { w: natW * scale, h: natH * scale };
    stage.style.width = display.w + "px";
    stage.style.height = display.h + "px";
    for (const image of [base, mask]) {
      image.style.width = display.w + "px";
      image.style.height = display.h + "px";
    }
    rect = initialRect(display.w, display.h);
    mask.classList.remove("hidden");
    box.classList.remove("hidden");
    buildHandles();
    paint();
  });
  base.addEventListener("error", () => stage.append(h("div", { class: "cropper-error", text: t("Couldn't load this image.") })));

  const node = h("div", { class: "cropper" }, [stage]);
  if (allowModeToggle) {
    node.append(
      h("div", { class: "cropper-modes" }, [
        choiceRow(
          [
            { id: "ratio", label: ratioLabel || t("Fixed ratio") },
            { id: "freeform", label: t("Freeform") },
          ],
          mode,
          (next) => {
            mode = next;
            if (display.w) {
              rect = initialRect(display.w, display.h);
              buildHandles();
              paint();
            }
          },
        ),
      ]),
    );
  }

  return {
    node,
    displayWidth: () => display.w,
    dispose() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    },
    async crop() {
      if (!display.w) throw new Error("nothing to crop yet");
      const img = await loadImageElement(src);
      const scale = img.naturalWidth / display.w;
      return cropImage(img, { x: rect.x * scale, y: rect.y * scale, w: rect.w * scale, h: rect.h * scale }, source, maxSize);
    },
  };
}

/** Окно «Обрезать» (CropModal). Возвращает обрезанный файл или null. */
function cropModal(file, options, maxSize) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      cropper.dispose();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const cropper = imageCropper({
      src: url,
      source: { name: file.name, type: file.type },
      ratio: options.ratio,
      ratioLabel: options.ratioLabel,
      circularMask: options.circularMask,
      allowModeToggle: options.allowModeToggle !== false,
      maxSize,
    });
    const error = h("p", { class: "cropper-message hidden" });
    const box = openModal({
      title: options.dialogTitle || t("Crop image"),
      body: h("div", { class: "form-stack" }, [cropper.node, error]),
      actions: [
        { label: t("Cancel"), onclick: closeModal },
        {
          label: t("Crop"),
          primary: true,
          onclick: async () => {
            try {
              const cropped = await cropper.crop();
              finish(cropped);
              closeModal();
            } catch (problem) {
              // окно остаётся открытым: можно уменьшить рамку и попробовать снова
              error.textContent =
                problem instanceof CropSizeError
                  ? t("Cropped image is too large — try a smaller crop area (max. {0})", [humanSize(problem.maxSize)])
                  : t("An error occurred while processing the image: {0}", [problem.message || String(problem)]);
              error.style.maxWidth = cropper.displayWidth() + "px";
              error.classList.remove("hidden");
            }
          },
        },
      ],
      onClose: () => finish(null),
    });
    box.classList.add("cropper-modal");
  });
}

/**
 * Выбрать картинку и, если нужно, обрезать (cropProcess). GIF и
 * анимированный WebP загружаются как есть. Слишком большие файлы
 * отклоняются с сообщением о пределе для тега.
 */
function pickImage(options = {}, maxSize = 0) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept: ALLOWED_IMAGE_TYPES.join(",") });
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file || !ALLOWED_IMAGE_TYPES.includes(file.type)) return resolve(null);
      try {
        const keep = file.type === "image/gif" || (file.type === "image/webp" && (await isAnimatedWebP(file).catch(() => false)));
        if (keep || !options.ratio) {
          if (maxSize && file.size > maxSize) throw new Error(t("File is too large (max. {0})", [humanSize(maxSize)]));
          return resolve(await blobToPicked(file, file.name));
        }
        resolve(await cropModal(file, options, maxSize));
      } catch (error) {
        toast(describe(error), "error");
        resolve(null);
      }
    };
    input.click();
  });
}
