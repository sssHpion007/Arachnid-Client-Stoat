// Улучшенный медиаплеер: часть встроенного плагина «Quality of Life»
// (выполняется вместе с emoji.js, gifs.js, hotkeys.js и history.js),
// настройка `media_player`.
//
// Плеер встаёт поверх элементов for-web, не заменяя их: <video>/<audio>
// остаются на месте и играют сами, у них только выключаются стандартные
// кнопки браузера. Предпросмотр видео до запуска — как у for-web
// (preload="metadata"), своего здесь нет.
//
// * Видео (вложение и видео ссылки) лежит в SizedContent — сетке, где все
//   дети в одной ячейке, поэтому слой плеера — ещё один ребёнок поверх
//   видео; размер сообщения не меняется, спойлер for-web (z-index 1)
//   остаётся выше. Полоса в духе YouTube: перемотка, пауза, громкость,
//   время, повтор, скорость, картинка в картинке, во весь экран (на весь
//   монитор: окно разворачивает Tauri). «Скачать» — в правом верхнем углу,
//   только вместе с управлением и не во весь экран. Управление видно, пока
//   мышь двигается над видео (на паузе — пока она над видео).
// * Аудио лежит в карточке под FileInfo; <audio> без controls браузер не
//   показывает, вместо него — полоса плеера, а на месте значка наушников в
//   FileInfo — обложка из самого файла; она же кнопка воспроизведения. Без
//   обложки кнопка цвета акцента.
// * Обложка читается частичными запросами (Range) — только заголовки и блок
//   с картинкой, файл целиком не скачивается: MP3 (ID3v2), FLAC, OGG Vorbis
//   и Opus, M4A, WAV. autumn отдаёт файлы частями и открывает для страниц
//   Accept-Ranges и Content-Range (CORS). Готовые обложки — в памяти, сами
//   ответы кэширует браузер; своего кэша на диске нет.
// * Правый щелчок по плееру открывает меню сообщения for-web: событие
//   пересылается самому <video>/<audio> (меню for-web встаёт у указателя).
// * Видео и аудио, которые не загрузились (оборвался ответ, загрузка встала),
//   незаметно загружаются заново — см. «надёжная загрузка». Видео по ссылке,
//   которое не отдал прокси встраиваний Stoat (January), грузится с сайта
//   напрямую; с CDN Discord — сразу напрямую (см. «прокси встраиваний»).
// * Видео, которое WebView2 не показывает (HEVC из TikTok и с телефона,
//   AVI, WMV…), клиент по нажатию ▶ незаметно перекодирует в H.264
//   (transcode.rs): пока идёт перекодирование — обычный значок загрузки.
// * GIF for-web (видео без controls) не трогаются.
//
// Выключенная настройка возвращает элементы for-web как были.
(() => {
  "use strict";

  const i18n = window.__arachnidI18n;
  const text = i18n.text("player");

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  /** Через сколько мс без движения мыши прятать управление видео */
  const HIDE_MS = 2500;
  /** Шаг перемотки стрелками, с */
  const SEEK_STEP = 5;
  /** Шаг громкости стрелками */
  const VOLUME_STEP = 0.05;
  /** Спиннер — только если ждать дольше этого, мс */
  const SPINNER_DELAY = 300;
  /** Длительность, пока она неизвестна */
  const UNKNOWN_TIME = "–:––";
  const STYLE_ID = "arachnid-player-style";

  /** Значки Material Symbols (outlined, как у for-web), viewBox 0 -960 960 960 */
  const ICONS = {
    play: "M320-203v-560l440 280-440 280Z",
    pause: "M555-200v-560h175v560H555Zm-325 0v-560h175v560H230Z",
    replay:
      "M339.5-108Q274-136 225-185t-77-114.5Q120-365 120-440h60q0 125 87.5 212.5T480-140q125 0 212.5-87.5T780-440q0-125-85-212.5T485-740h-23l73 73-41 42-147-147 147-147 41 41-78 78h23q75 0 140.5 28T735-695q49 49 77 114.5T840-440q0 75-28 140.5T735-185q-49 49-114.5 77T480-80q-75 0-140.5-28Z",
    volumeUp:
      "M560-131v-62q97-28 158.5-107.5T780-481q0-101-61-181T560-769v-62q124 28 202 125.5T840-481q0 127-78 224.5T560-131ZM120-360v-240h160l200-200v640L280-360H120Zm420 48v-337q55 17 87.5 64T660-480q0 57-33 104t-87 64Z",
    volumeDown: "M200-360v-240h160l200-200v640L360-360H200Zm420 48v-337q54 17 87 64t33 105q0 59-33 105t-87 63Z",
    volumeOff:
      "M813-56 681-188q-28 20-60.5 34.5T553-131v-62q23-7 44.5-15.5T638-231L473-397v237L273-360H113v-240h156L49-820l43-43 764 763-43 44Zm-36-232-43-43q20-34 29.5-72t9.5-78q0-103-60-184.5T553-769v-62q124 28 202 125.5T833-481q0 51-14 100t-42 93ZM643-422l-90-90v-130q47 22 73.5 66t26.5 96q0 15-2.5 29.5T643-422ZM473-592 369-696l104-104v208Z",
    repeat:
      "M280-80 120-240l160-160 42 44-86 86h464v-160h60v220H236l86 86-42 44Zm-80-450v-220h524l-86-86 42-44 160 160-160 160-42-44 86-86H260v160h-60Z",
    settings:
      "m388-80-20-126q-19-7-40-19t-37-25l-118 54-93-164 108-79q-2-9-2.5-20.5T185-480q0-9 .5-20.5T188-521L80-600l93-164 118 54q16-13 37-25t40-18l20-127h184l20 126q19 7 40.5 18.5T669-710l118-54 93 164-108 77q2 10 2.5 21.5t.5 21.5q0 10-.5 21t-2.5 21l108 78-93 164-118-54q-16 13-36.5 25.5T592-206L572-80H388Zm92-270q54 0 92-38t38-92q0-54-38-92t-92-38q-54 0-92 38t-38 92q0 54 38 92t92 38Z",
    pip: "M140-160q-24 0-42-18t-18-42v-520q0-24 18-42t42-18h680q24 0 42 18t18 42v520q0 24-18 42t-42 18H140Zm0-60h680v-520H140v520Zm0 0v-520 520Zm306-45h335v-257H446v257Zm60-60v-137h215v137H506Z",
    fullscreen:
      "M120-120v-193h60v133h133v60H120Zm527 0v-60h133v-133h60v193H647ZM120-647v-193h193v60H180v133h-60Zm660 0v-133H647v-60h193v193h-60Z",
    fullscreenExit:
      "M253-120v-133H120v-60h193v193h-60Zm394 0v-193h193v60H707v133h-60ZM120-647v-60h133v-133h60v193H120Zm527 0v-193h60v133h133v60H647Z",
    download:
      "M480-313 287-506l43-43 120 120v-371h60v371l120-120 43 43-193 193ZM220-160q-24 0-42-18t-18-42v-143h60v143h520v-143h60v143q0 24-18 42t-42 18H220Z",
    check: "M378-246 154-470l43-43 181 181 384-384 43 43-427 427Z",
    skipPrevious: "M220-240v-480h60v480h-60Zm520 0L394-480l346-240v480Z",
    skipNext: "M680-240v-480h60v480h-60Zm-460 0v-480l346 240-346 240Z",
    close: "m249-207-42-42 231-231-231-231 42-42 231 231 231-231 42 42-231 231 231 231-42 42-231-231-231 231Z",
    error:
      "M503.5-289.48q9.5-9.48 9.5-23.5t-9.48-23.52q-9.48-9.5-23.5-9.5t-23.52 9.48q-9.5 9.48-9.5 23.5t9.48 23.52q9.48 9.5 23.5 9.5t23.52-9.48ZM453-433h60v-253h-60v253Zm27.27 353q-82.74 0-155.5-31.5Q252-143 197.5-197.5t-86-127.34Q80-397.68 80-480.5t31.5-155.66Q143-709 197.5-763t127.34-85.5Q397.68-880 480.5-880t155.66 31.5Q709-817 763-763t85.5 127Q880-563 880-480.27q0 82.74-31.5 155.5Q817-252 763-197.68q-54 54.31-127 86Q563-80 480.27-80Zm.23-60Q622-140 721-239.5t99-241Q820-622 721.19-721T480-820q-141 0-240.5 98.81T140-480q0 141 99.5 240.5t241 99.5Zm-.5-340Z",
  };

  // ─────────────────────────────── обложки ───────────────────────────────

  const Covers = (() => {
    /** Сколько байт можно прочитать ради одной обложки */
    const BUDGET = 5 * 1024 * 1024;
    /** Блок чтения: заголовки соседних блоков приходят одним запросом */
    const BLOCK = 64 * 1024;
    /** Сколько готовых обложек держать в памяти */
    const KEEP = 100;

    class NoCover extends Error {}

    /** Чтение файла по адресу кусками: блоки по 64 КБ, не больше BUDGET */
    class RangeReader {
      constructor(url, signal) {
        this.url = url;
        this.signal = signal;
        this.blocks = new Map();
        this.size = Infinity;
        this.spent = 0;
      }

      /** Блоки [first, last] одним запросом */
      async load(first, last) {
        const start = first * BLOCK;
        if (start >= this.size) return;
        const end = Math.min((last + 1) * BLOCK, this.size) - 1;
        this.spent += end - start + 1;
        if (this.spent > BUDGET) throw new NoCover("budget");
        const response = await fetch(this.url, { headers: { Range: `bytes=${start}-${end}` }, signal: this.signal });
        if (response.status === 206) {
          const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(response.headers.get("Content-Range") ?? "");
          if (!range || Number(range[1]) !== start) throw new NoCover("bad range");
          if (range[2] !== "*") this.size = Number(range[2]);
          const data = new Uint8Array(await response.arrayBuffer());
          for (let i = first; i <= last && (i - first) * BLOCK < data.length; i++) {
            this.blocks.set(i, data.subarray((i - first) * BLOCK, (i - first + 1) * BLOCK));
          }
          return;
        }
        // сервер без частичных ответов: весь файл, если он не больше бюджета
        if (response.ok) {
          const length = Number(response.headers.get("Content-Length"));
          if (!(length <= BUDGET)) throw new NoCover("no ranges");
          const all = new Uint8Array(await response.arrayBuffer());
          this.size = all.length;
          for (let i = 0; i * BLOCK < all.length; i++) this.blocks.set(i, all.subarray(i * BLOCK, (i + 1) * BLOCK));
          return;
        }
        throw new NoCover(`HTTP ${response.status}`);
      }

      async block(index) {
        if (!this.blocks.has(index)) await this.load(index, index);
        return this.blocks.get(index) ?? new Uint8Array(0);
      }

      /** Байты [offset, offset + length); у конца файла — сколько есть */
      async bytes(offset, length) {
        if (length > BUDGET) throw new NoCover("too large");
        // всё недостающее — одним запросом
        const first = Math.floor(offset / BLOCK);
        const last = Math.floor((offset + Math.max(length, 1) - 1) / BLOCK);
        let missing = first;
        while (missing <= last && this.blocks.has(missing)) missing++;
        if (missing <= last && missing * BLOCK < this.size) await this.load(missing, last);
        const out = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          const position = offset + filled;
          const data = await this.block(Math.floor(position / BLOCK));
          const from = position % BLOCK;
          if (from >= data.length) break;
          const part = data.subarray(from, from + length - filled);
          out.set(part, filled);
          filled += part.length;
        }
        return filled === length ? out : out.subarray(0, filled);
      }
    }

    const ascii = (bytes, from, length) => String.fromCharCode(...bytes.subarray(from, from + length));
    const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
    const syncsafe = (b, i) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];

    /** Картинка по первым байтам: тип для Blob */
    function sniff(data, fallback) {
      if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
      if (data[0] === 0x89 && ascii(data, 1, 3) === "PNG") return "image/png";
      if (ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") return "image/webp";
      if (ascii(data, 0, 3) === "GIF") return "image/gif";
      return /^image\//.test(fallback ?? "") ? fallback : null;
    }

    /** Из нескольких картинок — передняя обложка (тип 3), иначе первая */
    const pick = (pictures) => pictures.find((picture) => picture.type === 3) ?? pictures[0] ?? null;

    // ───────────────────────────── ID3v2 ─────────────────────────────

    /** Убрать «рассинхронизацию» ID3: FF 00 → FF */
    function resync(data) {
      const out = new Uint8Array(data.length);
      let j = 0;
      for (let i = 0; i < data.length; i++) {
        out[j++] = data[i];
        if (data[i] === 0xff && data[i + 1] === 0x00) i++;
      }
      return out.subarray(0, j);
    }

    /** Конец строки ID3 в кодировке `encoding` (0/3 — один нуль, 1/2 — два) */
    function skipString(data, from, encoding) {
      if (encoding === 1 || encoding === 2) {
        for (let i = from; i + 1 < data.length; i += 2) if (data[i] === 0 && data[i + 1] === 0) return i + 2;
      } else {
        for (let i = from; i < data.length; i++) if (data[i] === 0) return i + 1;
      }
      return data.length;
    }

    async function id3(reader, offset) {
      const header = await reader.bytes(offset, 10);
      if (ascii(header, 0, 3) !== "ID3") return null;
      const version = header[3];
      const flags = header[5];
      let tag = await reader.bytes(offset + 10, syncsafe(header, 6));
      if (version < 4 && flags & 0x80) tag = resync(tag);
      let i = 0;
      if (flags & 0x40) i = version === 4 ? syncsafe(tag, 0) : u32(tag, 0) + 4;
      const pictures = [];
      let title = null;
      const idLength = version === 2 ? 3 : 4;
      const headerLength = version === 2 ? 6 : 10;
      while (i + headerLength <= tag.length && tag[i] !== 0) {
        const id = ascii(tag, i, idLength);
        const size =
          version === 2
            ? (tag[i + 3] << 16) | (tag[i + 4] << 8) | tag[i + 5]
            : version === 4
              ? syncsafe(tag, i + 4)
              : u32(tag, i + 4);
        const formatFlags = version === 4 ? tag[i + 9] : 0;
        let body = tag.subarray(i + headerLength, i + headerLength + size);
        i += headerLength + size;
        if (id !== "APIC" && id !== "PIC" && id !== "TIT2" && id !== "TT2") continue;
        if (formatFlags & 0x01) body = body.subarray(4); // длина данных
        if (formatFlags & 0x02) body = resync(body);
        const encoding = body[0];
        if (id === "TIT2" || id === "TT2") {
          title ??= id3Text(body.subarray(1), encoding);
          continue;
        }
        let at;
        let mime;
        if (id === "PIC") {
          mime = { JPG: "image/jpeg", PNG: "image/png" }[ascii(body, 1, 3).toUpperCase()];
          at = 4;
        } else {
          const end = skipString(body, 1, 0);
          mime = ascii(body, 1, end - 2);
          at = end;
        }
        const type = body[at];
        at = skipString(body, at + 1, encoding);
        pictures.push({ type, mime, data: body.subarray(at) });
      }
      return { picture: pick(pictures), title };
    }

    /** Текст кадра ID3: 0 — Latin-1, 1 — UTF-16 с BOM, 2 — UTF-16BE, 3 — UTF-8 */
    function id3Text(data, encoding) {
      const label = ["latin1", "utf-16", "utf-16be", "utf-8"][encoding] ?? "latin1";
      let text = new TextDecoder(label).decode(data);
      // несколько значений через \0 — берётся первое
      text = text.split("\0")[0].trim();
      return text || null;
    }

    // ────────────────────── FLAC и OGG (картинка FLAC) ──────────────────────

    /** Блок PICTURE (FLAC и METADATA_BLOCK_PICTURE в OGG) */
    function flacPicture(block) {
      let i = 0;
      const type = u32(block, i);
      const mimeLength = u32(block, (i += 4));
      const mime = ascii(block, (i += 4), mimeLength);
      const descriptionLength = u32(block, (i += mimeLength));
      i += 4 + descriptionLength + 16; // описание, ширина, высота, глубина, цвета
      const length = u32(block, i);
      return { type, mime, data: block.subarray(i + 4, i + 4 + length) };
    }

    async function flac(reader, offset) {
      let at = offset + 4;
      const pictures = [];
      let title = null;
      for (;;) {
        const header = await reader.bytes(at, 4);
        if (header.length < 4) break;
        const last = header[0] & 0x80;
        const type = header[0] & 0x7f;
        const length = (header[1] << 16) | (header[2] << 8) | header[3];
        if (type === 6) pictures.push(flacPicture(await reader.bytes(at + 4, length)));
        if (type === 4) title ??= comments(await reader.bytes(at + 4, length), 0).title;
        at += 4 + length;
        if (last) break;
      }
      return { picture: pick(pictures), title };
    }

    /** Второй пакет первого потока OGG — комментарии Vorbis или OpusTags */
    async function ogg(reader) {
      let at = 0;
      let serial = null;
      let packet = [];
      let packets = 0;
      for (;;) {
        const head = await reader.bytes(at, 27);
        if (head.length < 27 || ascii(head, 0, 4) !== "OggS") return null;
        const count = head[26];
        const table = await reader.bytes(at + 27, count);
        const pageSerial = u32le(head, 14);
        let data = at + 27 + count;
        at = data + table.reduce((sum, value) => sum + value, 0);
        serial ??= pageSerial;
        if (pageSerial !== serial) continue;
        for (const lacing of table) {
          if (packets === 1) packet.push(await reader.bytes(data, lacing));
          data += lacing;
          if (lacing < 255) {
            packets++;
            if (packets === 2) return vorbisComments(join(packet));
          }
        }
      }
    }

    const join = (parts) => {
      const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let i = 0;
      for (const part of parts) out.set(part, (i += part.length) - part.length);
      return out;
    };

    function base64(text) {
      const binary = atob(text.replace(/\s/g, ""));
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    }

    function vorbisComments(packet) {
      const i = ascii(packet, 0, 7) === "\x03vorbis" ? 7 : ascii(packet, 0, 8) === "OpusTags" ? 8 : -1;
      return i < 0 ? null : comments(packet, i);
    }

    /** Комментарии Vorbis (OGG, блок FLAC): картинка и TITLE */
    function comments(packet, i) {
      i += 4 + u32le(packet, i); // поставщик
      const count = u32le(packet, i);
      i += 4;
      const decoder = new TextDecoder();
      const pictures = [];
      let legacy = null;
      let legacyMime = null;
      let title = null;
      for (let n = 0; n < count && i < packet.length; n++) {
        const length = u32le(packet, i);
        const comment = packet.subarray(i + 4, i + 4 + length);
        i += 4 + length;
        const equals = comment.indexOf(0x3d);
        const key = ascii(comment, 0, equals).toUpperCase();
        if (key === "METADATA_BLOCK_PICTURE") pictures.push(flacPicture(base64(decoder.decode(comment.subarray(equals + 1)))));
        else if (key === "COVERART") legacy = base64(decoder.decode(comment.subarray(equals + 1)));
        else if (key === "COVERARTMIME") legacyMime = decoder.decode(comment.subarray(equals + 1));
        else if (key === "TITLE") title ??= decoder.decode(comment.subarray(equals + 1)).trim() || null;
      }
      const picture = pick(pictures) ?? (legacy ? { type: 3, mime: legacyMime, data: legacy } : null);
      return { picture, title };
    }

    // ───────────────────────────── MP4 / M4A ─────────────────────────────

    /** Дочерний атом `type` в [from, to): { start, end } его содержимого */
    async function atom(reader, from, to, type) {
      for (let at = from; at + 8 <= to; ) {
        const head = await reader.bytes(at, 16);
        if (head.length < 8) return null;
        let size = u32(head, 0);
        let headerLength = 8;
        if (size === 1) {
          size = u32(head, 8) * 2 ** 32 + u32(head, 12);
          headerLength = 16;
        } else if (size === 0) size = to - at;
        if (size < headerLength) return null;
        if (ascii(head, 4, 4) === type) return { start: at + headerLength, end: at + size };
        at += size;
      }
      return null;
    }

    async function mp4(reader) {
      // размер файла узнаётся из первого ответа
      await reader.bytes(0, 8);
      let list = { start: 0, end: reader.size };
      for (const type of ["moov", "udta", "meta", "ilst"]) {
        list = await atom(reader, list.start, list.end, type);
        if (!list) return null;
        if (type === "meta") list.start += 4; // версия и флаги
      }
      /** Содержимое атома data у элемента списка: тип и байты */
      const item = async (type) => {
        const entry = await atom(reader, list.start, list.end, type);
        const box = entry && (await atom(reader, entry.start, entry.end, "data"));
        if (!box) return null;
        const data = await reader.bytes(box.start, box.end - box.start);
        return { kind: u32(data, 0), data: data.subarray(8) };
      };
      const cover = await item("covr");
      const name = await item("\xa9nam");
      return {
        picture: cover && { type: 3, mime: { 13: "image/jpeg", 14: "image/png", 27: "image/bmp" }[cover.kind], data: cover.data },
        title: (name && new TextDecoder().decode(name.data).trim()) || null,
      };
    }

    // ───────────────────────────── WAV ─────────────────────────────

    async function wav(reader) {
      let title = null;
      for (let at = 12; ; ) {
        const head = await reader.bytes(at, 8);
        if (head.length < 8) return title ? { picture: null, title } : null;
        const id = ascii(head, 0, 4);
        const size = u32le(head, 4);
        if (id === "id3 " || id === "ID3 ") {
          const tags = await id3(reader, at + 8);
          return tags && { picture: tags.picture, title: tags.title ?? title };
        }
        if (id === "LIST" && size <= BLOCK) title ??= infoTitle(await reader.bytes(at + 8, size));
        at += 8 + size + (size & 1);
      }
    }

    /** Название из LIST INFO (INAM) */
    function infoTitle(list) {
      if (ascii(list, 0, 4) !== "INFO") return null;
      for (let i = 4; i + 8 <= list.length; ) {
        const size = u32le(list, i + 4);
        if (ascii(list, i, 4) === "INAM") {
          return new TextDecoder().decode(list.subarray(i + 8, i + 8 + size)).split("\0")[0].trim() || null;
        }
        i += 8 + size + (size & 1);
      }
      return null;
    }

    // ───────────────────────────── вход ─────────────────────────────

    async function extract(url, signal) {
      const reader = new RangeReader(url, signal);
      const start = await reader.bytes(0, 12);
      let tags = null;
      if (ascii(start, 0, 3) === "ID3") tags = await id3(reader, 0);
      else if (ascii(start, 0, 4) === "fLaC") tags = await flac(reader, 0);
      else if (ascii(start, 0, 4) === "OggS") tags = await ogg(reader);
      else if (ascii(start, 4, 4) === "ftyp") tags = await mp4(reader);
      else if (ascii(start, 0, 4) === "RIFF" && ascii(start, 8, 4) === "WAVE") tags = await wav(reader);
      const picture = tags?.picture;
      const type = picture?.data.length ? sniff(picture.data, picture.mime) : null;
      return {
        cover: type ? URL.createObjectURL(new Blob([picture.data], { type })) : null,
        title: tags?.title ?? null,
      };
    }

    /** Самые старые записи — вон, когда их больше KEEP */
    function remember(map, key, value, dispose) {
      map.set(key, value);
      while (map.size > KEEP) {
        const [oldest, old] = map.entries().next().value;
        map.delete(oldest);
        dispose?.(old);
      }
      return value;
    }

    function recall(map, key) {
      if (!map.has(key)) return undefined;
      const found = map.get(key);
      map.delete(key);
      map.set(key, found);
      return found;
    }

    /** Адрес файла → Promise { cover: адрес картинки (blob:) или null, title } */
    const cache = new Map();

    function info(url) {
      const found = recall(cache, url);
      if (found) return found;
      const promise = extract(url).catch((error) => {
        if (!(error instanceof NoCover)) console.warn("[Arachnid] обложка", url, error);
        return { cover: null, title: null };
      });
      return remember(cache, url, promise, (old) => old.then((tags) => tags.cover && URL.revokeObjectURL(tags.cover)));
    }

    /**
     * Имя файла. for-web берёт адреса autumn вида …/<id>/original, а autumn
     * перенаправляет их на …/<id>/<имя файла>: хватает запроса одного байта,
     * имя — в адресе ответа. У видео по ссылке (прокси january,
     * …/proxy?url=…) имя — в исходном адресе.
     */
    const names = new Map();

    function name(url) {
      const found = recall(names, url);
      if (found) return found;
      return remember(names, url, realName(url).catch(() => fileName(url)));
    }

    async function realName(url) {
      const parsed = new URL(url, location.href);
      const proxied = parsed.searchParams.get("url");
      if (proxied) return fileName(proxied);
      if (!/\/original$/.test(parsed.pathname)) return fileName(url);
      const response = await fetch(url, { headers: { Range: "bytes=0-0" } });
      void response.body?.cancel();
      return response.redirected ? fileName(response.url) : fileName(url);
    }

    return { info, name };
  })();

  // ─────────────────────────────── элементы ───────────────────────────────

  const SVG = "http://www.w3.org/2000/svg";

  function icon(name) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 -960 960 960");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", ICONS[name]);
    svg.append(path);
    return svg;
  }

  /** Заменить значок, только если он другой: замена под указателем между
   *  нажатием и отпусканием мыши съедает щелчок */
  function setIcon(element, name) {
    if (element.dataset.icon === name) return;
    element.dataset.icon = name;
    const next = icon(name);
    const old = element.querySelector(":scope > svg");
    if (old) old.replaceWith(next);
    else element.prepend(next);
  }

  function h(tag, attributes = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (value === false || value == null) continue;
      if (key === "class") element.className = value;
      else element.setAttribute(key, value === true ? "" : value);
    }
    element.append(...children.filter((child) => child != null));
    return element;
  }

  /** Кнопка со значком и подсказкой */
  function button(name, className = "") {
    const element = h("button", { type: "button", class: `ap-button ${className}`.trim() });
    setIcon(element, name);
    element.setIcon = (next) => setIcon(element, next);
    element.setTip = (tip) => {
      if (element.dataset.tip === tip) return;
      element.dataset.tip = tip;
      element.setAttribute("aria-label", tip);
    };
    return element;
  }

  /** Подпись с клавишей, как у YouTube: «Пауза (k)» */
  const withKey = (label, key) => `${label} (${key})`;

  function time(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds % 60);
    const m = Math.floor(seconds / 60) % 60;
    const hours = Math.floor(seconds / 3600);
    const pad = (n) => String(n).padStart(2, "0");
    return hours ? `${hours}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  /** «1,5×» — с десятичным разделителем языка интерфейса */
  function speedValue(value) {
    let number;
    try {
      number = new Intl.NumberFormat(i18n.intl()).format(value);
    } catch {
      number = String(value);
    }
    return `${number}×`;
  }
  const speedLabel = (value) => (value === 1 ? text.normal : speedValue(value));

  /** Скачать файл, как кнопка FileInfo for-web */
  /** Имя файла из адреса autumn: /attachments/<id>/<имя> */
  function fileName(url) {
    try {
      return decodeURIComponent(new URL(url, location.href).pathname.split("/").pop()) || "file";
    } catch {
      return "file";
    }
  }

  function download(url) {
    if (!url) return;
    const link = h("a", { href: url, download: fileName(url), target: "_blank" });
    document.body.append(link);
    link.click();
    link.remove();
  }

  // ─────────────────────────── почему видео не играет ───────────────────────────
  // WebView2 декодирует HEVC (H.265) только через «Расширения для видео HEVC»
  // из Microsoft Store, а Chrome — сам, через видеокарту: поэтому в браузере
  // такое видео (например, из TikTok) играет, а в клиенте — нет. Такое видео
  // (и форматы, которых у Chromium нет вовсе) клиент перекодирует; узнать
  // HEVC нужно и для этого, и чтобы без перекодирования (не получилось)
  // сказать, в чём дело: после ошибки кодеки файла читаются из описаний
  // дорожек MP4/MOV (stsd).

  const HEVC_STORE = "https://apps.microsoft.com/detail/9NMZLZ57R3T7";
  const HEVC = new Set(["hvc1", "hev1", "dvh1", "dvhe"]);
  /** Больше moov не читается: столько не бывает даже у часовых видео */
  const MOOV_LIMIT = 16 * 1024 * 1024;

  /** Сервер не отдал файл (ответ с ошибкой) */
  class FetchError extends Error {
    constructor(status) {
      super(String(status));
      this.status = status;
    }
  }

  /** Байты [start, start + length) файла — запросом с Range (autumn его понимает) */
  async function readRange(url, start, length) {
    const response = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
    if (!response.ok) throw new FetchError(response.status);
    const data = new Uint8Array(await response.arrayBuffer());
    return response.status === 206 ? data : data.subarray(start, start + length);
  }

  const fourcc = (data, at) => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);

  /** Типы образцов дорожек MP4/MOV (`hvc1`, `avc1`, `mp4a`…); не MP4 — пусто */
  async function sampleEntries(url) {
    let offset = 0;
    // верхние блоки: ftyp, free, mdat, moov… — moov бывает и в конце файла
    for (let box = 0; box < 32; box++) {
      const head = await readRange(url, offset, 16);
      if (head.length < 8) return [];
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      let size = view.getUint32(0);
      const type = fourcc(head, 4);
      if (box === 0 && type !== "ftyp") return [];
      if (size === 1 && head.length >= 16) size = Number(view.getBigUint64(8));
      if (type === "moov") {
        const moov = await readRange(url, offset, Math.min(size || MOOV_LIMIT, MOOV_LIMIT));
        const entries = [];
        // описание образцов: размер, «stsd», версия, число записей, размер записи, тип
        for (let at = moov.indexOf(0x73); at !== -1 && at + 20 <= moov.length; at = moov.indexOf(0x73, at + 1)) {
          if (fourcc(moov, at) === "stsd") entries.push(fourcc(moov, at + 16));
        }
        return entries;
      }
      if (size < 8) return [];
      offset += size;
    }
    return [];
  }

  /** Ответы сервера, после которых повторять бесполезно: файла нет или нельзя */
  const MISSING = (status) => status >= 400 && status < 500 && status !== 408 && status !== 429;

  /** Дорожки MP4, которые WebView2 показывает и без расширений Windows */
  const PLAYABLE = new Set(["avc1", "avc3", "mp4a", ".mp3", "Opus", "fLaC", "vp09", "av01"]);

  /** Начало файла — MP3, Ogg, FLAC или WAV: их WebView2 играет всегда */
  function playableAudio(head) {
    const text = fourcc(head, 0);
    if (text === "OggS" || text === "fLaC" || text.startsWith("ID3")) return true;
    if (text === "RIFF" && head.length >= 12) return fourcc(head, 8) === "WAVE";
    // кадр MPEG audio без тегов: синхрослово 0xFFE
    return head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
  }

  /**
   * Причина ошибки воспроизведения: "network" | "missing" | "hevc" | "format"
   * | "transient" — файл в формате, который WebView2 показывает, значит, не
   * вышла сама загрузка
   */
  async function failureOf(media) {
    if (media.error?.code === MediaError.MEDIA_ERR_NETWORK) return "network";
    try {
      const entries = await sampleEntries(media.currentSrc || media.src);
      if (entries.length && entries.every((entry) => PLAYABLE.has(entry))) return "transient";
      if (!entries.length && playableAudio(await readRange(media.currentSrc || media.src, 0, 12))) return "transient";
      // HEVC с ошибкой — даже если WebView2 говорит, что показывает его
      // (бывает чёрный экран), — надёжнее перекодировать
      return entries.some((entry) => HEVC.has(entry)) ? "hevc" : "format";
    } catch (error) {
      // сервер не отдаёт файл и отдельному запросу, или нет сети — дело не в
      // формате (запрет CORS у чужого сайта о самом файле ничего не говорит)
      if (error instanceof FetchError) return MISSING(error.status) ? "missing" : "network";
      return navigator.onLine ? "format" : "network";
    }
  }

  // ─────────────────────────── прокси встраиваний ───────────────────────────
  // Видео и аудио по ссылке for-web показывает через прокси встраиваний Stoat
  // (January): …/proxy?url=<файл>. January отдаёт файл, только скачав его
  // целиком, без частичных ответов, и на всё у него 10 секунд; не успел —
  // ответ 400, и этот ответ он помнит минуту. Большое видео (особенно с CDN
  // Discord — по ссылкам из Discord) так часто не грузится с первого раза:
  // for-web показывает ошибку, а повтор в ту же минуту получает её же.
  // Помогало переключить канал — элемент создавался заново позже.
  //
  // Поэтому файл, который прокси не отдал (ошибка или ни байта за STALL_MS),
  // грузится с сайта напрямую — как и GIF for-web. Файлы с CDN Discord —
  // сразу напрямую: он отдаёт файл частями, видео начинается сразу и
  // перематывается, не дожидаясь всего файла. Ссылки Discord подписаны
  // (`ex`, `is`, `hm`) — адрес берётся из ссылки как есть.

  /** Сайты, файлы с которых грузятся напрямую, без прокси */
  const DIRECT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
  /** Исходные адреса, которые прокси не отдал: дальше — напрямую */
  const unproxied = new Set();

  /** Исходный адрес файла за прокси January или null */
  function proxiedOriginal(src) {
    let url;
    try {
      url = new URL(src, location.href);
    } catch {
      return null;
    }
    const original = url.pathname.endsWith("/proxy") ? url.searchParams.get("url") : null;
    if (!original) return null;
    try {
      const parsed = new URL(original);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
    } catch {
      return null;
    }
  }

  /** Загружать ли файл сразу напрямую: CDN Discord или прокси его уже не отдал */
  function wantsDirect(original) {
    if (unproxied.has(original)) return true;
    try {
      return DIRECT_HOSTS.has(new URL(original).hostname);
    } catch {
      return false;
    }
  }

  // ─────────────────────────── надёжная загрузка ───────────────────────────
  // Видео и аудио иногда не загружаются с первого раза: оборвался ответ,
  // декодер видеокарты не создался, пока грузились другие видео, загрузка
  // встала без ошибки. for-web такой элемент так и оставляет сломанным — пока
  // сообщение не пересоздастся (прокрутили далеко и вернулись). Здесь файл
  // незаметно загружается заново, с того же места:
  //
  // * после ошибки — сразу и через секунду; если ошибка и тогда, выясняется
  //   её причина. Сбой сети или сервера, а также файл в формате, который
  //   WebView2 показывает (сбой загрузки или декодера), — повторы дальше, всё
  //   реже (RETRY_MS), пока не загрузится; когда сеть вернулась или нажали ▶
  //   — сразу. Файла нет (4xx) или формат не тот — дальше решает плеер;
  // * загрузка (до метаданных) или воспроизведение стоят дольше STALL_MS, не
  //   получив ни байта, — тоже заново;
  // * файл через прокси January после ошибки или не получив ни байта за
  //   STALL_MS — сразу с сайта напрямую (см. «прокси встраиваний»).
  //
  // Каждый сбой с текстом ошибки Chromium записывается в журнал клиента
  // (media_report): по нему видно, почему файл не загрузился.

  /** Повторы сразу после ошибки, мс */
  const QUICK_RETRIES_MS = [0, 1000];
  /** Дальнейшие повторы, мс; последний — и все следующие */
  const RETRY_MS = [3000, 5000, 10000, 20000, 30000];
  /** Столько загрузка может стоять без данных, мс */
  const STALL_MS = 10000;
  const WATCH_MS = 2000;

  /** Сбой загрузки — в журнал клиента */
  function reportMedia(media, event, attempts) {
    const internals = window.__TAURI_INTERNALS__;
    if (!window.__arachnidDesktop || !internals) return;
    const error = media.error;
    const detail = [
      error ? `code ${error.code}: ${error.message || "—"}` : "no error",
      `attempt ${attempts}`,
      `ready ${media.readyState}`,
      `network ${media.networkState}`,
      `t ${media.currentTime.toFixed(1)}`,
      media instanceof HTMLVideoElement ? `size ${media.videoWidth}x${media.videoHeight}` : "audio",
      navigator.onLine ? "online" : "offline",
    ].join(", ");
    const url = media.currentSrc || media.src;
    void internals.invoke("media_report", { url, event, detail }).catch(() => {});
  }

  /** Проверки зависшей загрузки всех плееров — одним таймером */
  const stallWatches = new Set();
  let stallTimer = 0;

  /**
   * Самовосстановление загрузки media. wanted() — пользователь хочет, чтобы
   * оно играло; onRetry(resume) — загрузка началась заново; onGiveUp(reason)
   * — повторять бесполезно ("missing" | "hevc" | "format").
   */
  function keepLoading(media, { wanted, onRetry, onGiveUp }) {
    /** Повторы для адреса src (новый адрес — повторы заново) */
    let attempts = 0;
    let src = media.currentSrc || media.src;
    let timer = 0;
    let last = performance.now();
    const touch = () => (last = performance.now());
    const report = (event) => reportMedia(media, event, attempts);

    function reload() {
      timer = 0;
      if (!media.isConnected) return;
      const position = media.currentTime;
      const resume = wanted();
      attempts += 1;
      touch();
      onRetry(resume);
      media.load();
      // до метаданных — позиция, с которой начнётся воспроизведение
      if (position > 0) media.currentTime = position;
      if (resume) void media.play().catch(() => {});
    }

    function later(delay) {
      clearTimeout(timer);
      timer = setTimeout(reload, delay);
    }

    /** Файл через прокси January — с сайта напрямую; `true` — адрес сменился */
    function bypass(event, force) {
      const original = proxiedOriginal(media.currentSrc || media.src);
      if (!original || (!force && !wantsDirect(original))) return false;
      unproxied.add(original);
      if (event) report(event);
      clearTimeout(timer);
      timer = 0;
      const position = media.currentTime;
      const resume = wanted();
      [src, attempts] = [original, 0];
      touch();
      if (event) onRetry(resume);
      // новый адрес — загрузка начинается заново сама
      media.src = original;
      if (position > 0) media.currentTime = position;
      if (resume) void media.play().catch(() => {});
      return true;
    }

    function onError() {
      const current = media.currentSrc || media.src;
      if (current !== src) [src, attempts] = [current, 0];
      report("error");
      if (bypass("proxy failed", true)) return;
      if (attempts < QUICK_RETRIES_MS.length) return later(QUICK_RETRIES_MS[attempts]);
      const failed = media.error;
      void failureOf(media).then((reason) => {
        if (media.error !== failed || timer) return;
        if (reason === "network" || reason === "transient") {
          const step = Math.min(attempts - QUICK_RETRIES_MS.length, RETRY_MS.length - 1);
          return later(RETRY_MS[step]);
        }
        report(`give-up ${reason}`);
        onGiveUp(reason);
      });
    }

    // загрузилось после повторов — в журнал, что помогло
    const onLoaded = () => attempts && report("recovered");

    // сеть вернулась — не ждать повтора
    const onOnline = () => timer && later(0);

    function watch(now) {
      if (timer || media.error || !media.isConnected || now - last < STALL_MS) return;
      const loading =
        media.readyState === HTMLMediaElement.HAVE_NOTHING && media.networkState === HTMLMediaElement.NETWORK_LOADING;
      const stuck = wanted() && !media.paused && media.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
      if (!loading && !stuck) return;
      if (loading && bypass("proxy stalled", true)) return;
      report(loading ? "stalled loading" : "stalled playback");
      reload();
    }

    const listeners = [
      [media, "error", onError],
      [media, "loadstart", touch],
      [media, "progress", touch],
      [media, "timeupdate", touch],
      [media, "seeking", touch],
      [media, "canplay", touch],
      [media, "loadeddata", onLoaded],
      [window, "online", onOnline],
    ];
    for (const [target, type, handler] of listeners) target.addEventListener(type, handler);
    stallWatches.add(watch);
    stallTimer ||= setInterval(() => {
      const now = performance.now();
      for (const check of stallWatches) check(now);
    }, WATCH_MS);
    // CDN Discord и файлы, которые прокси уже не отдал, — сразу напрямую;
    // иначе ошибка могла случиться до плеера
    if (!bypass(null, false) && media.error) onError();

    return {
      /** Пользователь ждёт (нажал ▶): назначенный повтор — сейчас; false — повтора нет */
      hurry() {
        if (timer) later(0);
        return Boolean(timer);
      },
      /** Загрузка не удалась, хотя ошибки не было (нет картинки), — заново */
      retry() {
        report("no picture");
        reload();
      },
      /** Сколько раз файл уже загружался заново */
      get attempts() {
        return attempts;
      },
      dispose() {
        for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
        clearTimeout(timer);
        stallWatches.delete(watch);
        if (stallWatches.size) return;
        clearInterval(stallTimer);
        stallTimer = 0;
      },
    };
  }

  // ────────────────────────────── перекодирование ──────────────────────────────
  // Задачу выполняет клиент (transcode.rs): скачивает файл и перекодирует его
  // в H.264; страница спрашивает, как идут дела, и получает адрес готового
  // файла. Без клиента (или без ffmpeg в нём) — «unavailable». Для
  // пользователя это просто загрузка: значок загрузки, затем видео.

  /** Столько секунд видео может играть без картинки, пока это не считается ошибкой */
  const NO_PICTURE_S = 0.75;
  /** Как часто спрашивать о ходе перекодирования, мс */
  const CONVERT_POLL_MS = 250;

  const TRANSCODE_FAILED = { state: "failed", code: "io" };

  /** media_transcode: { state, progress?, src?, code? } */
  async function transcode(url, start) {
    const internals = window.__TAURI_INTERNALS__;
    if (!window.__arachnidDesktop || !internals) return { state: "unavailable" };
    const name = await Covers.name(url);
    return internals.invoke("media_transcode", { url, name, start });
  }

  /** Правый щелчок по плееру — меню сообщения for-web у самого элемента */
  function forwardContextMenu(target) {
    return (event) => {
      if (event.target.closest?.(".ap-menu")) return;
      event.preventDefault();
      event.stopPropagation();
      const Kind = typeof PointerEvent === "function" && event instanceof PointerEvent ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Kind("contextmenu", event));
    };
  }

  // ─────────────────────────── полоса перемотки ───────────────────────────

  function progress(media, onDrag) {
    const buffered = h("div", { class: "ap-buffered" });
    const played = h("div", { class: "ap-played" });
    const thumb = h("div", { class: "ap-thumb" });
    const tip = h("div", { class: "ap-seek-tip" });
    const root = h(
      "div",
      { class: "ap-progress", role: "slider", "aria-label": text.seek, "aria-valuemin": "0" },
      h("div", { class: "ap-rail" }, buffered, played, thumb),
      tip,
    );
    let dragging = false;
    let dragTime = 0;

    const ratioAt = (event) => {
      const rect = root.getBoundingClientRect();
      return rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0;
    };

    function paint() {
      const current = dragging ? dragTime : media.currentTime;
      const duration = media.duration;
      const known = Number.isFinite(duration) && duration > 0;
      const ratio = known ? current / duration : 0;
      played.style.width = `${ratio * 100}%`;
      thumb.style.left = `${ratio * 100}%`;
      let end = 0;
      for (let i = 0; i < media.buffered.length; i++) {
        if (media.buffered.start(i) <= media.currentTime) end = Math.max(end, media.buffered.end(i));
      }
      buffered.style.width = known ? `${(end / duration) * 100}%` : "0";
      root.setAttribute("aria-valuemax", known ? String(Math.round(duration)) : "0");
      root.setAttribute("aria-valuenow", String(Math.round(current)));
      root.setAttribute("aria-valuetext", time(current));
    }

    function showTip(event) {
      if (!Number.isFinite(media.duration)) return;
      const ratio = ratioAt(event);
      tip.textContent = time(ratio * media.duration);
      const width = root.getBoundingClientRect().width;
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(width - half, Math.max(half, ratio * width))}px`;
    }

    root.addEventListener("pointermove", (event) => {
      showTip(event);
      if (!dragging) return;
      dragTime = ratioAt(event) * media.duration;
      paint();
    });
    root.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !Number.isFinite(media.duration)) return;
      event.preventDefault();
      root.setPointerCapture(event.pointerId);
      dragging = true;
      root.classList.add("ap-dragging");
      dragTime = ratioAt(event) * media.duration;
      paint();
      onDrag(true);
    });
    const release = () => {
      if (!dragging) return;
      dragging = false;
      root.classList.remove("ap-dragging");
      media.currentTime = dragTime;
      paint();
      onDrag(false);
    };
    root.addEventListener("pointerup", release);
    root.addEventListener("pointercancel", release);

    return { root, paint };
  }

  // ─────────────────────────────── громкость ───────────────────────────────

  function volume(media) {
    const toggle = button("volumeUp", "ap-volume-button");
    const slider = h("input", {
      type: "range",
      class: "ap-volume-slider",
      min: "0",
      max: "1",
      step: "0.01",
      "aria-label": text.volume,
    });
    const root = h("div", { class: "ap-volume" }, toggle, slider);
    let before = 1;

    function sync() {
      const level = media.muted ? 0 : media.volume;
      slider.value = String(level);
      slider.style.setProperty("--ap-level", `${level * 100}%`);
      toggle.setIcon(level === 0 ? "volumeOff" : level < 0.5 ? "volumeDown" : "volumeUp");
      toggle.setTip(withKey(level === 0 ? text.unmute : text.mute, "m"));
    }

    toggle.addEventListener("click", () => {
      if (media.muted || media.volume === 0) {
        media.muted = false;
        if (media.volume === 0) media.volume = before || 1;
      } else {
        before = media.volume;
        media.muted = true;
      }
    });
    slider.addEventListener("input", () => {
      media.volume = Number(slider.value);
      media.muted = media.volume === 0;
    });
    media.addEventListener("volumechange", sync);
    sync();
    return {
      root,
      sync,
      step(delta) {
        media.muted = false;
        media.volume = Math.min(1, Math.max(0, media.volume + delta));
      },
      toggle: () => toggle.click(),
      dispose: () => media.removeEventListener("volumechange", sync),
    };
  }

  // ─────────────────────────────── скорость ───────────────────────────────

  /** Скорость общая для всех плееров; после перезапуска — обычная */
  let speed = 1;
  const players = new Set();

  function setSpeed(value) {
    speed = value;
    for (const player of players) player.applySpeed();
    bar?.applySpeed();
  }

  /**
   * Меню скорости. У видео оно внутри плеера (и так работает во весь экран),
   * у аудио — всплывающее (popover) поверх страницы: карточка for-web
   * обрезает всё, что выходит за её края.
   */
  /**
   * Меню скорости. `spare` — кнопки, которые в узком плеере не помещаются в
   * строку управления и переезжают в начало меню: [{ icon, label, on, action }]
   * (видно только в узком плеере, см. стиль).
   */
  function speedMenu(anchorButton, menuHost, { onOpen, floating = false, spare = null }) {
    const spareList = h("div", { class: "ap-menu-spare", role: "group" });
    const title = h("div", { class: "ap-menu-title" });
    const list = h("div", { class: "ap-menu-list", role: "menu" });
    const menu = h(
      "div",
      { class: `ap-menu${floating ? " ap-floating" : ""}`, hidden: !floating, popover: floating ? "manual" : null },
      spare ? spareList : null,
      title,
      list,
    );
    (floating ? document.body : menuHost).append(menu);
    const isOpen = () => (floating ? menu.matches(":popover-open") : !menu.hidden);

    function place() {
      const rect = anchorButton.getBoundingClientRect();
      const height = menu.offsetHeight;
      const above = rect.top - 8 - height >= 8;
      menu.style.top = `${above ? rect.top - 8 - height : rect.bottom + 8}px`;
      menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
    }

    function render() {
      if (spare) {
        spareList.replaceChildren(
          ...spare().map(({ icon: name, label, on, action }) => {
            const item = h(
              "button",
              { type: "button", class: `ap-menu-item${on ? " ap-selected" : ""}`, role: "menuitem" },
              h("span", { class: "ap-menu-check" }, icon(name)),
              label,
            );
            item.addEventListener("click", () => {
              action();
              close();
            });
            return item;
          }),
        );
      }
      title.textContent = text.speed;
      list.replaceChildren(
        ...SPEEDS.map((value) => {
          const item = h(
            "button",
            {
              type: "button",
              class: `ap-menu-item${value === speed ? " ap-selected" : ""}`,
              role: "menuitemradio",
              "aria-checked": String(value === speed),
            },
            h("span", { class: "ap-menu-check" }, value === speed ? icon("check") : null),
            speedLabel(value),
          );
          item.addEventListener("click", () => {
            setSpeed(value);
            close();
          });
          return item;
        }),
      );
    }

    const outside = (event) => {
      if (!menu.contains(event.target) && !anchorButton.contains(event.target)) close();
    };
    function open() {
      render();
      if (floating) {
        menu.showPopover();
        place();
        window.addEventListener("scroll", close, true);
        window.addEventListener("resize", close);
      } else menu.hidden = false;
      anchorButton.classList.add("ap-open");
      document.addEventListener("pointerdown", outside, true);
      onOpen(true);
    }
    function close() {
      if (!isOpen()) return;
      if (floating) {
        menu.hidePopover();
        window.removeEventListener("scroll", close, true);
        window.removeEventListener("resize", close);
      } else menu.hidden = true;
      anchorButton.classList.remove("ap-open");
      document.removeEventListener("pointerdown", outside, true);
      onOpen(false);
    }
    anchorButton.addEventListener("click", () => (isOpen() ? close() : open()));
    menu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
      anchorButton.focus();
    });
    return { close, isOpen, remove: () => (close(), menu.remove()) };
  }

  /**
   * Клавиши, пока плеер в фокусе — по физическим клавишам (event.code),
   * чтобы работали и в русской раскладке. `extra` — свои клавиши видео.
   */
  function keys(media, controls, extra = {}) {
    return (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.target.closest?.("input[type=range]") && event.key.startsWith("Arrow")) return;
      // пробел и Enter на кнопке — нажатие самой кнопки
      if ((event.code === "Space" || event.key === "Enter") && event.target.closest?.("button")) return;
      const shifted = {
        Comma: () => setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]),
        Period: () => setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]),
      };
      const plain = {
        Space: controls.toggle,
        KeyK: controls.toggle,
        KeyM: controls.volume.toggle,
        ArrowLeft: () => (media.currentTime = Math.max(0, media.currentTime - SEEK_STEP)),
        ArrowRight: () => (media.currentTime = Math.min(media.duration || 0, media.currentTime + SEEK_STEP)),
        Home: () => (media.currentTime = 0),
        End: () => (media.currentTime = media.duration || 0),
        ...extra,
      };
      const action = event.shiftKey ? shifted[event.code] : plain[event.code];
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    };
  }

  const togglePlayback = (media) => {
    if (media.paused || media.ended) void media.play().catch(() => {});
    else media.pause();
  };

  // ───────────────────────────────── видео ─────────────────────────────────

  function enhanceVideo(video, menuTarget = video) {
    const host = video.parentElement;
    const before = { controls: video.controls, rate: video.playbackRate, tabindex: host.getAttribute("tabindex") };
    video.controls = false;
    host.classList.add("ap-host");
    host.tabIndex = 0;

    const bigPlay = h("button", { type: "button", class: "ap-big-play" });
    setIcon(bigPlay, "play");
    const flash = h("div", { class: "ap-flash", "aria-hidden": "true" });
    const spinner = h("div", { class: "ap-spinner", hidden: true });
    const corner = button("download", "ap-corner");
    const errorTitle = h("strong");
    const errorHint = h("span");
    const storeLink = h("a", { class: "ap-error-link", href: HEVC_STORE, target: "_blank", hidden: true });
    const errorBox = h("div", { class: "ap-error", hidden: true }, icon("error"), errorTitle, errorHint, storeLink);

    const play = button("play", "ap-first");
    const vol = volume(video);
    const now = h("span", {}, "0:00");
    const total = h("span", {}, "\u00a0/ 0:00");
    const clock = h("span", { class: "ap-time" }, now, total);
    // в узком плеере (вертикальное видео) повтор и «картинка в картинке» —
    // в меню скорости
    const repeat = button("repeat", "ap-toggle ap-spare");
    const settings = button("settings");
    const speedBadge = h("span", { class: "ap-speed-badge", hidden: true });
    settings.append(speedBadge);
    const pip = button("pip", "ap-spare");
    const full = button("fullscreen", "ap-edge");
    const overlay = h("div", { class: "ap-video" });

    let started = video.played.length > 0 || !video.paused;
    /** Причина ошибки (`failureOf`), пока она выясняется — "format" */
    let failure = "format";
    /** Исходный адрес, пока играет перекодированный файл */
    let original = null;
    /** Адрес видео, которое WebView2 не показывает: ▶ перекодирует его */
    let undecodable = null;
    /** Перекодирование идёт */
    let converting = false;
    let pollTimer = 0;
    /** Пользователь хочет, чтобы видео играло (нажал ▶ и не ставил паузу) */
    let intent = !video.paused;
    /** Видео без картинки: выясняется, почему */
    let checking = false;
    /** Видео без картинки уже загружалось заново */
    let pictureRetried = false;
    let dragging = false;
    let hovering = false;
    let hideTimer = 0;
    let spinnerTimer = 0;
    let frame = 0;

    const seek = progress(video, (on) => {
      dragging = on;
      wake();
    });
    const togglePip = () =>
      document.pictureInPictureElement === video
        ? void document.exitPictureInPicture().catch(() => {})
        : void video.requestPictureInPicture().catch(() => {});
    const menu = speedMenu(settings, overlay, {
      onOpen: () => wake(),
      spare: () => [
        {
          icon: "repeat",
          label: video.loop ? text.repeatOn : text.repeatOff,
          on: video.loop,
          action: () => ((video.loop = !video.loop), sync()),
        },
        ...(document.pictureInPictureEnabled ? [{ icon: "pip", label: text.pip, on: false, action: togglePip }] : []),
      ],
    });

    overlay.append(
      spinner,
      flash,
      bigPlay,
      errorBox,
      corner,
      h(
        "div",
        { class: "ap-bottom" },
        seek.root,
        h(
          "div",
          { class: "ap-bar" },
          play,
          vol.root,
          clock,
          h("span", { class: "ap-spacer" }),
          repeat,
          settings,
          document.pictureInPictureEnabled ? pip : null,
          full,
        ),
      ),
    );
    host.append(overlay);

    const toggle = () => {
      if (undecodable) return convert();
      // ещё загружается заново: заиграет, как только загрузится
      if (video.error && healing.hurry()) {
        intent = true;
        spinner.hidden = false;
        return;
      }
      togglePlayback(video);
    };

    // Управление видно, пока мышь над видео и двигается; на паузе — пока
    // мышь над видео. Мышь ушла — управление и «скачать» прячутся.
    function wake() {
      overlay.classList.add("ap-active");
      host.classList.remove("ap-idle");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(sleep, HIDE_MS);
    }
    function sleep() {
      if (dragging || menu.isOpen() || (hovering && video.paused)) return;
      overlay.classList.remove("ap-active");
      host.classList.toggle("ap-idle", hovering);
    }

    function showFlash(name) {
      flash.replaceChildren(icon(name));
      flash.classList.remove("ap-flashing");
      void flash.offsetWidth;
      flash.classList.add("ap-flashing");
    }

    function paintTime() {
      now.textContent = time(video.currentTime);
      total.textContent = `\u00a0/ ${time(video.duration)}`;
      seek.paint();
    }

    function sync() {
      const paused = video.paused || video.ended;
      const ended = video.ended && !video.loop;
      play.setIcon(ended ? "replay" : paused ? "play" : "pause");
      play.setTip(withKey(ended ? text.replay : paused ? text.play : text.pause, "k"));
      overlay.classList.toggle("ap-started", started);
      overlay.classList.toggle("ap-paused", paused);
      overlay.classList.toggle("ap-ended", ended);
      setIcon(bigPlay, ended ? "replay" : "play");
      bigPlay.setAttribute("aria-label", ended ? text.replay : text.play);
      repeat.classList.toggle("ap-on", video.loop);
      repeat.setAttribute("aria-pressed", String(video.loop));
      repeat.setTip(video.loop ? text.repeatOn : text.repeatOff);
      settings.setTip(text.speed);
      pip.setTip(text.pip);
      corner.setTip(text.download);
      const fullscreen = document.fullscreenElement === host;
      overlay.classList.toggle("ap-fullscreen", fullscreen);
      full.setIcon(fullscreen ? "fullscreenExit" : "fullscreen");
      full.setTip(withKey(fullscreen ? text.exitFullscreen : text.fullscreen, "f"));
      errorTitle.textContent = text.videoError;
      errorHint.textContent = { network: text.networkError, hevc: text.hevcError }[failure] ?? text.errorHint;
      storeLink.hidden = failure !== "hevc";
      storeLink.textContent = text.hevcStore;
      vol.sync();
      paintTime();
      if (hovering) wake();
    }

    // на каждом кадре — только время и полоса, без перестройки кнопок
    function tick() {
      paintTime();
      frame = video.paused ? 0 : requestAnimationFrame(tick);
    }

    const fullscreen = () => {
      if (document.fullscreenElement === host) void document.exitFullscreen().catch(() => {});
      else void host.requestFullscreen().catch(() => {});
    };

    const onKey = keys(video, { toggle, volume: vol }, {
      KeyF: fullscreen,
      ArrowUp: () => vol.step(VOLUME_STEP),
      ArrowDown: () => vol.step(-VOLUME_STEP),
    });

    const hideSpinner = () => {
      clearTimeout(spinnerTimer);
      spinner.hidden = true;
    };

    function showError() {
      errorBox.hidden = false;
      overlay.classList.add("ap-failed");
      hideSpinner();
      sync();
    }

    const currentSrc = () => video.currentSrc || video.src;

    // Загрузить не вышло. Файла нет — ошибка. Формат, которого WebView2 не
    // показывает, — видео перекодируется (если есть чем) по нажатию ▶, а если
    // ▶ уже нажат — сразу; на вид это обычная загрузка.
    async function cannotPlay(reason) {
      failure = reason === "missing" ? "network" : reason;
      if (reason === "missing" || original) return showError();
      const src = currentSrc();
      const status = await transcode(src, false).catch(() => ({ state: "unavailable" }));
      if (currentSrc() !== src) return;
      if (status.state === "unavailable") return showError();
      undecodable = src;
      overlay.classList.add("ap-undecodable");
      hideSpinner();
      follow(status);
      if (status.state === "idle" && intent) convert();
      sync();
    }

    function convert() {
      if (!undecodable || converting) return;
      intent = true;
      const src = undecodable;
      follow({ state: "queued" }, false);
      void transcode(src, true)
        .catch(() => TRANSCODE_FAILED)
        .then((status) => undecodable === src && follow(status));
    }

    // состояние задачи media_transcode; `poll` — спросить ещё раз
    function follow(status, poll = true) {
      clearTimeout(pollTimer);
      if (status.state === "done") return useConverted(status.src);
      if (status.state === "failed") {
        undecodable = null;
        converting = false;
        overlay.classList.remove("ap-busy", "ap-undecodable");
        return showError();
      }
      if (status.state === "idle") return;
      // идёт (её мог начать и плеер того же видео в другом сообщении)
      converting = true;
      overlay.classList.add("ap-busy");
      spinner.hidden = false;
      if (!poll) return;
      const src = undecodable;
      pollTimer = setTimeout(() => {
        void transcode(src, false)
          .catch(() => TRANSCODE_FAILED)
          .then((next) => undecodable === src && follow(next));
      }, CONVERT_POLL_MS);
    }

    // перекодированный файл вместо исходного
    function useConverted(src) {
      original ??= currentSrc();
      undecodable = null;
      converting = false;
      failure = "format";
      errorBox.hidden = true;
      overlay.classList.remove("ap-busy", "ap-undecodable", "ap-failed");
      video.src = src;
      if (intent) void video.play().catch(() => {});
      sync();
    }

    // Chromium, не умея декодировать дорожку видео, бывает, ошибки не даёт:
    // играет один звук без картинки (videoWidth 0) — это та же ошибка, видео
    // сразу перекодируется (▶ уже нажат). Размер кадра декодер видеокарты
    // может сообщить и позже метаданных, с первым кадром, поэтому судить
    // можно только по видео, которое уже играет.
    async function checkPicture() {
      if (checking || original || undecodable || video.paused || video.videoWidth > 0) return;
      if (video.currentTime < NO_PICTURE_S) return;
      checking = true;
      video.pause();
      spinner.hidden = false;
      const src = currentSrc();
      const entries = await sampleEntries(src).catch(() => []);
      checking = false;
      if (currentSrc() !== src) return;
      // формат, который WebView2 показывает: не создался декодер — заново, один раз
      if (!pictureRetried && entries.length && entries.every((entry) => PLAYABLE.has(entry))) {
        pictureRetried = true;
        return healing.retry();
      }
      // HEVC — для подсказки, если перекодировать не получится
      await cannotPlay(entries.some((entry) => HEVC.has(entry)) ? "hevc" : "format");
    }

    const healing = keepLoading(video, {
      wanted: () => intent,
      onRetry: (resume) => {
        if (resume) spinner.hidden = false;
      },
      onGiveUp: (reason) => void cannotPlay(reason),
    });

    const listeners = [
      [video, "play", () => ((started = true), (intent = true), sync(), (frame ||= requestAnimationFrame(tick)))],
      [
        video,
        "pause",
        () => {
          // пауза по ошибке или для проверки картинки — не пользователя
          if (!video.error && !checking) intent = false;
          sync();
        },
      ],
      [video, "ended", sync],
      [video, "loadedmetadata", sync],
      [video, "durationchange", sync],
      [video, "progress", () => seek.paint()],
      [video, "seeked", sync],
      [
        video,
        "waiting",
        () => {
          clearTimeout(spinnerTimer);
          spinnerTimer = setTimeout(() => (spinner.hidden = false), SPINNER_DELAY);
        },
      ],
      [video, "playing", hideSpinner],
      [video, "canplay", hideSpinner],
      [video, "timeupdate", checkPicture],
      [
        video,
        "click",
        () => {
          if (started) showFlash(video.paused ? "play" : "pause");
          toggle();
          host.focus({ preventScroll: true });
        },
      ],
      [video, "dblclick", fullscreen],
      [host, "pointermove", () => ((hovering = true), wake())],
      [
        host,
        "pointerleave",
        () => {
          hovering = false;
          clearTimeout(hideTimer);
          hideTimer = setTimeout(sleep, 300);
        },
      ],
      [host, "keydown", onKey],
      [document, "fullscreenchange", sync],
      [bigPlay, "click", toggle],
      [play, "click", toggle],
      [repeat, "click", () => ((video.loop = !video.loop), sync())],
      [full, "click", fullscreen],
      [pip, "click", togglePip],
      [corner, "click", () => download(original ?? currentSrc())],
      [overlay, "contextmenu", forwardContextMenu(menuTarget)],
    ];
    for (const [target, type, handler] of listeners) target.addEventListener(type, handler);

    const player = {
      media: video,
      sync,
      applySpeed() {
        video.playbackRate = speed;
        speedBadge.hidden = speed === 1;
        speedBadge.textContent = speedValue(speed);
      },
      destroy() {
        for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
        vol.dispose();
        cancelAnimationFrame(frame);
        clearTimeout(hideTimer);
        clearTimeout(spinnerTimer);
        clearTimeout(pollTimer);
        healing.dispose();
        menu.remove();
        overlay.remove();
        host.classList.remove("ap-host", "ap-idle");
        if (before.tabindex === null) host.removeAttribute("tabindex");
        else host.setAttribute("tabindex", before.tabindex);
        video.controls = before.controls;
        // играет вне чата — скорость остаётся
        if (!keep.contains(video)) video.playbackRate = before.rate;
        players.delete(player);
      },
    };
    players.add(player);
    player.applySpeed();
    sync();
    return player;
  }

  // ───────────────────────────────── аудио ─────────────────────────────────

  /** Три полоски «играет» поверх обложки */
  const equalizer = () => h("span", { class: "ap-eq", "aria-hidden": "true" }, h("i"), h("i"), h("i"));

  function enhanceAudio(audio, menuTarget = audio) {
    const card = audio.parentElement;
    const info = audio.previousElementSibling;
    // значок наушников FileInfo — первый ребёнок, svg solid-icons
    const headphones = info?.firstElementChild instanceof SVGElement ? info.firstElementChild : null;
    const before = { controls: audio.controls, rate: audio.playbackRate };
    audio.controls = false;
    card.classList.add("ap-audio-card");

    // обложка — она же кнопка воспроизведения
    const art = h(
      "button",
      { type: "button", class: "ap-cover" },
      h("span", { class: "ap-cover-image" }),
      h("span", { class: "ap-cover-state" }, equalizer(), h("span", { class: "ap-cover-spinner", "aria-hidden": "true" })),
    );
    const state = art.lastChild;
    setIcon(state, "play");

    const current = h("span", { class: "ap-time" }, "0:00");
    const total = h("span", { class: "ap-time" }, UNKNOWN_TIME);
    const seek = progress(audio, () => {});
    const vol = volume(audio);
    const repeat = button("repeat", "ap-toggle");
    const speedButton = h("button", { type: "button", class: "ap-button ap-speed-button ap-edge" });
    const errorLine = h("div", { class: "ap-audio-error", hidden: true }, icon("error"), h("span"));
    const bar = h("div", { class: "ap-audio" }, current, seek.root, total, vol.root, repeat, speedButton);

    if (headphones) {
      headphones.classList.add("ap-replaced");
      headphones.before(art);
    } else if (info) info.prepend(art);
    else card.prepend(art);
    audio.after(bar, errorLine);
    const menu = speedMenu(speedButton, bar, { onOpen: () => {}, floating: true });

    const toggle = () => {
      if (!audio.error || !healing.hurry()) return togglePlayback(audio);
      // ещё загружается заново: заиграет, как только загрузится
      intent = true;
      loading();
    };
    let frame = 0;
    let loadTimer = 0;
    /** Пользователь хочет, чтобы аудио играло */
    let intent = !audio.paused;

    function paintTime() {
      current.textContent = time(audio.currentTime);
      total.textContent = Number.isFinite(audio.duration) ? time(audio.duration) : UNKNOWN_TIME;
      seek.paint();
    }
    // Загрузка: аудио должно играть, а данных ещё нет (медленная сеть) — на
    // обложке-кнопке индикатор вместо полосок «играет»; короткое ожидание
    // его не показывает.
    function loading() {
      clearTimeout(loadTimer);
      if (audio.paused || card.classList.contains("ap-loading")) return;
      loadTimer = setTimeout(() => card.classList.add("ap-loading"), SPINNER_DELAY);
    }
    function loaded() {
      clearTimeout(loadTimer);
      card.classList.remove("ap-loading");
    }
    function sync() {
      const paused = audio.paused || audio.ended;
      const ended = audio.ended && !audio.loop;
      setIcon(state, ended ? "replay" : paused ? "play" : "pause");
      const label = ended ? text.replay : paused ? text.listen : text.pause;
      art.setAttribute("aria-label", label);
      art.dataset.tip = label;
      card.classList.toggle("ap-playing", !paused);
      repeat.classList.toggle("ap-on", audio.loop);
      repeat.setAttribute("aria-pressed", String(audio.loop));
      repeat.setTip(audio.loop ? text.repeatOn : text.repeatOff);
      speedButton.dataset.tip = text.speed;
      speedButton.setAttribute("aria-label", text.speed);
      errorLine.lastChild.textContent = text.audioError;
      vol.sync();
      paintTime();
    }
    // на каждом кадре — только время и полоса, без перестройки кнопок
    function tick() {
      paintTime();
      frame = audio.paused ? 0 : requestAnimationFrame(tick);
    }

    const contextMenu = forwardContextMenu(menuTarget);
    const listeners = [
      [
        audio,
        "play",
        () => {
          intent = true;
          sync();
          frame ||= requestAnimationFrame(tick);
          if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) loading();
        },
      ],
      [audio, "waiting", loading],
      [audio, "playing", loaded],
      [
        audio,
        "pause",
        () => {
          if (!audio.error) intent = false;
          loaded();
          sync();
        },
      ],
      [audio, "ended", () => (loaded(), sync())],
      [audio, "loadedmetadata", sync],
      [audio, "durationchange", sync],
      [audio, "progress", () => seek.paint()],
      [audio, "seeked", sync],
      [card, "keydown", keys(audio, { toggle, volume: vol })],
      [art, "click", toggle],
      [repeat, "click", () => ((audio.loop = !audio.loop), sync())],
      [art, "contextmenu", contextMenu],
      [bar, "contextmenu", contextMenu],
    ];
    for (const [target, type, handler] of listeners) target.addEventListener(type, handler);

    const healing = keepLoading(audio, {
      wanted: () => intent,
      onRetry: (resume) => resume && loading(),
      onGiveUp: () => {
        errorLine.hidden = false;
        card.classList.add("ap-failed");
        loaded();
      },
    });

    // обложка — когда карточка подходит к экрану
    let alive = true;
    const watcher = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        watcher.disconnect();
        Covers.info(audio.currentSrc || audio.src).then(({ cover: url }) => {
          if (!alive || !url) return;
          const image = h("img", { src: url, alt: "", draggable: "false" });
          image.addEventListener("load", () => {
            if (!alive) return;
            art.firstChild.replaceChildren(image);
            art.classList.add("ap-has-cover");
          });
        });
      },
      { rootMargin: "100% 0px" },
    );
    watcher.observe(card);

    const player = {
      media: audio,
      sync,
      applySpeed() {
        audio.playbackRate = speed;
        speedButton.textContent = speedValue(speed);
      },
      destroy() {
        alive = false;
        watcher.disconnect();
        for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
        vol.dispose();
        cancelAnimationFrame(frame);
        clearTimeout(loadTimer);
        healing.dispose();
        menu.remove();
        bar.remove();
        errorLine.remove();
        art.remove();
        headphones?.classList.remove("ap-replaced");
        card.classList.remove("ap-audio-card", "ap-playing", "ap-failed", "ap-loading");
        audio.controls = before.controls;
        if (!keep.contains(audio)) audio.playbackRate = before.rate;
        players.delete(player);
      },
    };
    players.add(player);
    player.applySpeed();
    sync();
    return player;
  }

  // ─────────────────────── панель воспроизведения ───────────────────────
  // Как в Telegram: пока играет аудио (или видео ушло в «картинку в
  // картинке»), вверху ленты чата — панель: ⏮ ▶ ⏭, обложка, название трека
  // или имя файла (щелчок — к сообщению), время, скорость, громкость, ✕. Играет всегда один
  // файл: новый ставит прошлый на паузу.
  //
  // Сменили канал — for-web убирает сообщения вместе с <audio>/<video>, а
  // убранный элемент браузер ставит на паузу. Плеер в том же такте переносит
  // играющий элемент в скрытый контейнер, и он играет дальше; видео при этом
  // уходит в «картинку в картинке» (щелчок по каналу — жест пользователя,
  // браузер это разрешает). Вернулись в канал — тот же элемент встаёт на
  // место нового элемента for-web: без перезагрузки и с того же места.
  //
  // ⏮ ⏭ — соседние аудио того же канала: список берётся со страницы, а после
  // ухода из канала — каким он был при запуске.

  /** Сообщение for-web — div с id-ULID; путь канала — как в адресе for-web */
  const MESSAGE_ID = /^[0-9A-Z]{26}$/;
  const CHANNEL_PATH = /^(?:\/i\/[\w:.]+)?(?:\/server\/[0-9A-Z]{26})?\/channel\/[0-9A-Z]{26}/;

  /** Элементы, которые играют вне чата */
  const keep = h("div", { class: "ap-keep", "aria-hidden": "true" });
  /** Что играет: элемент, его файл и соседи по каналу; closed — плашку закрыли */
  const now = { media: null, playlist: [], closed: true };
  /** Элемент → файл: адрес, имя, сообщение и путь к нему */
  const tracks = new WeakMap();

  function trackOf(media) {
    let track = tracks.get(media);
    if (track) return track;
    const src = media.currentSrc || media.src;
    let message = null;
    for (let node = media.parentElement; node && !message; node = node.parentElement) {
      if (MESSAGE_ID.test(node.id)) message = node.id;
    }
    const channel = CHANNEL_PATH.exec(location.pathname)?.[0] ?? null;
    track = {
      src,
      /** Подпись: название трека, иначе имя файла; узнаётся из сети */
      label: labels.get(src) ?? null,
      video: media instanceof HTMLVideoElement,
      message,
      link: channel && message ? `${channel}/${message}` : null,
    };
    if (message) tracks.set(media, track);
    return track;
  }

  /** Подписи по адресу: у элементов без сообщения запись трека не хранится */
  const labels = new Map();

  /** Подпись файла: у аудио — название из тегов, иначе (и у видео) — имя */
  async function describe(track) {
    if (track.label) return track.label;
    const [tags, name] = await Promise.all([track.video ? null : Covers.info(track.src), Covers.name(track.src)]);
    track.label = tags?.title || name;
    labels.set(track.src, track.label);
    return track.label;
  }

  const sameTrack = (a, b) => Boolean(a && b && a.src === b.src && a.message === b.message);

  /** Аудио в чате по порядку сообщений */
  function chatAudio() {
    return [...attached.keys()]
      .filter((media) => media instanceof HTMLAudioElement && media.isConnected && !keep.contains(media))
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  /** Какой-то из наших элементов начал играть */
  function onPlay(event) {
    const media = event.target;
    if (!(media instanceof HTMLMediaElement) || !(attached.has(media) || keep.contains(media))) return;
    if (now.media !== media) {
      const previous = now.media;
      now.media = media;
      if (previous) {
        previous.pause();
        if (keep.contains(previous)) release(previous);
      }
      const track = trackOf(media);
      if (!keep.contains(media)) now.playlist = track.video ? [] : chatAudio().map(trackOf);
    }
    now.closed = false;
    bar?.bind(now.media);
    placeBar();
  }

  /** Отпустить элемент вне чата: он больше не нужен */
  function release(media) {
    if (document.pictureInPictureElement === media) void document.exitPictureInPicture().catch(() => {});
    media.pause();
    media.remove();
  }

  /** for-web убрал играющий элемент — он остаётся играть вне чата; видео на
   *  паузе не держится, аудио на паузе — да, как в Telegram */
  function adopt() {
    const media = now.media;
    if (media instanceof HTMLVideoElement && media.paused) {
      now.media = null;
      now.closed = true;
      bar?.unbind();
      return;
    }
    keep.append(media);
    if (media instanceof HTMLVideoElement) pictureInPicture(media);
    bar?.bind(media);
  }

  function pictureInPicture(video) {
    if (document.pictureInPictureEnabled && document.pictureInPictureElement !== video) {
      void video.requestPictureInPicture().catch(() => {});
    }
  }

  /** Новый элемент for-web того же файла, что играет вне чата, — вернуть на
   *  его место играющий; иначе null */
  function heldFor(media) {
    const held = now.media;
    if (!held || !keep.contains(held) || held.constructor !== media.constructor) return null;
    if (!sameTrack(trackOf(held), trackOf(media))) return null;
    media.replaceWith(held);
    if (document.pictureInPictureElement === held) void document.exitPictureInPicture().catch(() => {});
    return held;
  }

  /** Соседний файл по каналу: шаг -1 или 1 */
  function neighbour(step) {
    const current = now.media && trackOf(now.media);
    if (!current || current.video) return null;
    const fresh = chatAudio().map(trackOf);
    if (fresh.some((track) => sameTrack(track, current))) now.playlist = fresh;
    const index = now.playlist.findIndex((track) => sameTrack(track, current));
    return index < 0 ? null : (now.playlist[index + step] ?? null);
  }

  function playTrack(track) {
    if (!track) return;
    const inChat = chatAudio().find((media) => sameTrack(trackOf(media), track));
    if (inChat) {
      inChat.currentTime = 0;
      void inChat.play().catch(() => {});
      return;
    }
    // файла уже нет на странице — играет свой элемент вне чата
    const audio = document.createElement("audio");
    audio.preload = "auto";
    audio.src = track.src;
    tracks.set(audio, track);
    audio.volume = now.media?.volume ?? 1;
    audio.muted = now.media?.muted ?? false;
    audio.defaultPlaybackRate = audio.playbackRate = speed;
    keep.append(audio);
    void audio.play().catch(() => {});
  }

  function closeBar() {
    const media = now.media;
    now.closed = true;
    now.media = null;
    if (media) {
      media.pause();
      if (keep.contains(media)) release(media);
    }
    bar?.unbind();
    placeBar();
  }

  /**
   * Плашка видна, пока играет аудио или видео вне чата. Место — в ленте
   * чата (main for-web, без списка участников), поверх первых сообщений,
   * как плашка «Новые сообщения» for-web: держатель нулевой высоты первым
   * ребёнком, сама плашка — над ним, поэтому чат не сдвигается.
   */
  function placeBar() {
    if (!bar) return;
    const media = now.media;
    const visible = active && media && !now.closed && (media instanceof HTMLAudioElement || keep.contains(media));
    const chat = visible ? document.querySelector(".app_body main") : null;
    if (!chat) {
      bar.anchor.remove();
      return;
    }
    if (chat.firstElementChild !== bar.anchor) chat.prepend(bar.anchor);
  }

  /** Плашка: есть, пока настройка включена */
  let bar = null;

  function createBar() {
    const previous = button("skipPrevious", "ap-first");
    const play = button("play");
    const next = button("skipNext");
    const art = h("button", { type: "button", class: "ap-now-art" });
    const title = h("a", { class: "ap-now-title" });
    const clock = h("span", { class: "ap-time" });
    const speedButton = h("button", { type: "button", class: "ap-button ap-speed-button" });
    const volumeSlot = h("span", { class: "ap-now-volume" });
    const close = button("close", "ap-edge");
    const seekSlot = h("div", { class: "ap-now-seek" });
    const root = h(
      "div",
      { class: "ap-now", role: "region" },
      previous,
      play,
      next,
      art,
      h("div", { class: "ap-now-text" }, title, clock),
      h("span", { class: "ap-spacer" }),
      speedButton,
      volumeSlot,
      close,
      seekSlot,
    );
    const anchor = h("div", { class: "ap-now-anchor" }, root);
    const menu = speedMenu(speedButton, root, { onOpen: () => {}, floating: true });
    /** Привязка к играющему элементу: его громкость, перемотка, события */
    let bound = null;

    function paintTime() {
      const media = bound?.media;
      if (!media) return;
      const total = Number.isFinite(media.duration) ? time(media.duration) : UNKNOWN_TIME;
      clock.textContent = `${time(media.currentTime)} / ${total}`;
      bound.seek.paint();
    }
    function tick() {
      paintTime();
      bound.frame = bound.media.paused ? 0 : requestAnimationFrame(tick);
    }

    function sync() {
      const media = bound?.media;
      if (!media) return;
      const track = trackOf(media);
      const paused = media.paused || media.ended;
      root.setAttribute("aria-label", text.nowPlaying);
      play.setIcon(paused ? "play" : "pause");
      play.setTip(paused ? (track.video ? text.play : text.listen) : text.pause);
      previous.hidden = next.hidden = track.video;
      previous.disabled = !neighbour(-1);
      next.disabled = !neighbour(1);
      previous.setTip(text.previous);
      next.setTip(text.next);
      close.setTip(text.close);
      speedButton.dataset.tip = text.speed;
      speedButton.setAttribute("aria-label", text.speed);
      title.textContent = track.label ?? "";
      if (track.link) title.setAttribute("href", track.link);
      else title.removeAttribute("href");
      title.title = track.link ? text.goToMessage : "";
      art.dataset.tip = track.video ? text.pip : "";
      art.setAttribute("aria-label", track.video ? text.pip : (track.label ?? ""));
      art.tabIndex = track.video ? 0 : -1;
      root.classList.toggle("ap-now-video", track.video);
      bound.volume.sync();
      paintTime();
    }

    function bind(media) {
      if (bound?.media === media) return sync();
      unbind();
      const volumeControl = volume(media);
      const seek = progress(media, () => {});
      volumeSlot.replaceChildren(volumeControl.root);
      seekSlot.replaceChildren(seek.root);
      const track = trackOf(media);
      void describe(track).then(() => bound?.media === media && sync());
      art.replaceChildren();
      art.classList.remove("ap-has-cover");
      if (track.video) setIcon(art, "pip");
      else {
        delete art.dataset.icon;
        Covers.info(track.src).then(({ cover: url }) => {
          if (!url || bound?.media !== media) return;
          art.replaceChildren(h("img", { src: url, alt: "", draggable: "false" }));
          art.classList.add("ap-has-cover");
        });
      }
      const onState = () => {
        sync();
        if (!media.paused) bound.frame ||= requestAnimationFrame(tick);
      };
      // закрыли «картинку в картинке» кнопкой «Назад во вкладку» — к сообщению
      const onLeave = () => {
        if (keep.contains(media) && !media.paused && track.link) openMessage(track.link);
      };
      const listeners = [
        [media, "play", onState],
        [media, "pause", onState],
        [media, "ended", onState],
        [media, "loadedmetadata", onState],
        [media, "durationchange", onState],
        [media, "seeked", onState],
        [media, "progress", () => seek.paint()],
        [media, "leavepictureinpicture", onLeave],
      ];
      for (const [target, type, handler] of listeners) target.addEventListener(type, handler);
      bound = { media, volume: volumeControl, seek, listeners, frame: 0 };
      onState();
      applySpeed();
    }

    function unbind() {
      if (!bound) return;
      for (const [target, type, handler] of bound.listeners) target.removeEventListener(type, handler);
      bound.volume.dispose();
      cancelAnimationFrame(bound.frame);
      menu.close();
      bound = null;
    }

    function applySpeed() {
      speedButton.textContent = speedValue(speed);
      // у элементов вне чата нет своего плеера — скорость ставит плашка
      if (bound && keep.contains(bound.media)) bound.media.playbackRate = speed;
    }

    play.addEventListener("click", () => {
      const media = bound?.media;
      if (!media) return;
      togglePlayback(media);
      if (media instanceof HTMLVideoElement && keep.contains(media) && media.paused === false) pictureInPicture(media);
    });
    previous.addEventListener("click", () => playTrack(neighbour(-1)));
    next.addEventListener("click", () => playTrack(neighbour(1)));
    close.addEventListener("click", closeBar);
    art.addEventListener("click", () => {
      const media = bound?.media;
      if (media instanceof HTMLVideoElement && keep.contains(media)) pictureInPicture(media);
    });
    // щелчок по ссылке перехватывает роутер for-web, как у любой ссылки
    // приложения; адрес — канал и сообщение
    title.addEventListener("click", (event) => {
      if (!title.hasAttribute("href")) event.preventDefault();
    });

    function destroy() {
      unbind();
      menu.remove();
      anchor.remove();
    }

    return { root, anchor, bind, unbind, sync, applySpeed, destroy };
  }

  /** Перейти к сообщению: обычная ссылка приложения, её ведёт роутер for-web */
  function openMessage(link) {
    const anchor = h("a", { href: link, hidden: true });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  // ─────────────────────────────── стили ───────────────────────────────

  const STYLE = `
    /* ─────────────────────────────── общее ─────────────────────────────── */

    .ap-button {
      position: relative;
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: none;
      color: inherit;
      cursor: pointer;
      flex-shrink: 0;
    }

    .ap-button svg,
    .ap-big-play svg {
      width: 24px;
      height: 24px;
      fill: currentColor;
    }

    .ap-button:hover {
      background: color-mix(in srgb, currentColor 12%, transparent);
    }

    .ap-button:focus-visible,
    .ap-big-play:focus-visible,
    .ap-cover:focus-visible,
    .ap-menu-item:focus-visible {
      outline: 2px solid var(--md-sys-color-primary);
      outline-offset: -2px;
    }

    /* подсказка над кнопкой */
    .ap-button[data-tip]:hover::after,
    .ap-cover[data-tip]:hover::after {
      content: attr(data-tip);
      position: absolute;
      bottom: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%);
      padding: 4px 8px;
      border-radius: 6px;
      background: var(--md-sys-color-inverse-surface);
      color: var(--md-sys-color-inverse-on-surface);
      font: 500 12px/16px inherit;
      white-space: nowrap;
      pointer-events: none;
      z-index: 3;
    }

    .ap-first::after {
      left: 0 !important;
      transform: none !important;
    }

    .ap-edge::after {
      left: auto !important;
      right: 0;
      transform: none !important;
    }

    .ap-time {
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .ap-spacer {
      flex: 1;
    }

    .ap-toggle:not(.ap-on) {
      opacity: 0.6;
    }

    .ap-toggle.ap-on {
      color: var(--md-sys-color-primary);
    }

    /* ─────────────────────────── полоса перемотки ─────────────────────────── */

    .ap-progress {
      position: relative;
      height: 16px;
      display: flex;
      align-items: center;
      cursor: pointer;
      touch-action: none;
    }

    .ap-rail {
      position: relative;
      width: 100%;
      height: 4px;
      border-radius: 2px;
      background: color-mix(in srgb, currentColor 22%, transparent);
      transition: height 0.12s;
    }

    .ap-progress:hover .ap-rail,
    .ap-dragging .ap-rail {
      height: 6px;
    }

    .ap-buffered,
    .ap-played {
      position: absolute;
      inset: 0 auto 0 0;
      border-radius: inherit;
    }

    .ap-buffered {
      background: color-mix(in srgb, currentColor 30%, transparent);
    }

    .ap-played {
      background: var(--md-sys-color-primary);
    }

    .ap-thumb {
      position: absolute;
      top: 50%;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--md-sys-color-primary);
      transform: translate(-50%, -50%) scale(0);
      transition: transform 0.12s;
    }

    .ap-progress:hover .ap-thumb,
    .ap-dragging .ap-thumb {
      transform: translate(-50%, -50%) scale(1);
    }

    .ap-seek-tip {
      position: absolute;
      bottom: calc(100% + 4px);
      transform: translateX(-50%);
      padding: 2px 6px;
      border-radius: 6px;
      background: var(--md-sys-color-inverse-surface);
      color: var(--md-sys-color-inverse-on-surface);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      pointer-events: none;
      opacity: 0;
    }

    .ap-progress:hover .ap-seek-tip,
    .ap-dragging .ap-seek-tip {
      opacity: 1;
    }

    /* ─────────────────────────────── громкость ─────────────────────────────── */

    .ap-volume {
      display: flex;
      align-items: center;
    }

    .ap-volume-slider {
      --ap-level: 100%;
      width: 0;
      height: 16px;
      margin: 0;
      appearance: none;
      background: none;
      opacity: 0;
      cursor: pointer;
      transition:
        width 0.15s,
        opacity 0.15s,
        margin 0.15s;
    }

    .ap-volume:hover .ap-volume-slider,
    .ap-volume:focus-within .ap-volume-slider {
      width: 64px;
      margin: 0 8px 0 2px;
      opacity: 1;
    }

    .ap-volume-slider::-webkit-slider-runnable-track {
      height: 4px;
      border-radius: 2px;
      background: linear-gradient(
        to right,
        currentColor var(--ap-level),
        color-mix(in srgb, currentColor 25%, transparent) var(--ap-level)
      );
    }

    .ap-volume-slider::-webkit-slider-thumb {
      appearance: none;
      width: 12px;
      height: 12px;
      margin-top: -4px;
      border-radius: 50%;
      background: currentColor;
    }

    .ap-volume-slider::-moz-range-track {
      height: 4px;
      border-radius: 2px;
      background: color-mix(in srgb, currentColor 25%, transparent);
    }

    .ap-volume-slider::-moz-range-progress {
      height: 4px;
      border-radius: 2px;
      background: currentColor;
    }

    .ap-volume-slider::-moz-range-thumb {
      width: 12px;
      height: 12px;
      border: 0;
      border-radius: 50%;
      background: currentColor;
    }

    /* ─────────────────────────────── меню скорости ─────────────────────────────── */

    /* кнопки, переехавшие из узкого плеера; в широком их нет */
    .ap-menu-spare {
      display: none;
      padding-bottom: 4px;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--md-sys-color-outline-variant);
    }

    .ap-menu-spare .ap-menu-check svg {
      fill: currentColor;
    }

    .ap-menu {
      position: absolute;
      right: 8px;
      bottom: 56px;
      min-width: 160px;
      padding: 4px 0;
      border-radius: 12px;
      background: var(--md-sys-color-surface-container-high);
      color: var(--md-sys-color-on-surface);
      box-shadow: 0 4px 16px rgb(0 0 0 / 0.4);
      z-index: 4;
    }

    .ap-menu[hidden] {
      display: none;
    }

    /* в плеере видео меню не выходит за его края — список прокручивается */
    .ap-video .ap-menu:not([hidden]) {
      display: flex;
      flex-direction: column;
      max-height: calc(100% - 64px);
    }

    .ap-video .ap-menu-list {
      min-height: 0;
    }

    .ap-floating {
      position: fixed;
      inset: auto;
      margin: 0;
      border: 0;
      padding: 4px 0;
    }

    .ap-menu-title {
      padding: 8px 16px 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface-variant);
    }

    .ap-menu-list {
      max-height: min(280px, 60vh);
      overflow-y: auto;
      scrollbar-width: thin;
    }

    .ap-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 5px 16px 5px 8px;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      font-size: 14px;
      text-align: left;
      cursor: pointer;
    }

    .ap-menu-item:hover {
      background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
    }

    .ap-menu-check {
      display: grid;
      width: 20px;
      height: 20px;
    }

    .ap-menu-check svg {
      width: 20px;
      height: 20px;
      fill: var(--md-sys-color-primary);
    }

    .ap-selected {
      color: var(--md-sys-color-primary);
    }

    /* ───────────────────────────────── видео ───────────────────────────────── */

    .ap-host {
      position: relative;
      outline: none;
    }

    .ap-host.ap-idle,
    .ap-host.ap-idle * {
      cursor: none !important;
    }

    .ap-host:fullscreen {
      border-radius: 0;
      background: #000;
    }

    .ap-host:fullscreen video {
      width: 100%;
      height: 100%;
      max-height: none;
      object-fit: contain;
    }

    .ap-video {
      grid-area: 1 / 1 / 2 / 2;
      position: relative;
      container: ap-video / inline-size;
      pointer-events: none;
      color: #fff;
      font-family: inherit;
      user-select: none;
    }

    .ap-video > * {
      pointer-events: auto;
    }

    .ap-bottom {
      position: absolute;
      inset: auto 0 0;
      padding: 24px 8px 4px;
      background: linear-gradient(to top, rgb(0 0 0 / 0.75), rgb(0 0 0 / 0.35) 60%, transparent);
      opacity: 0;
      visibility: hidden;
      transition:
        opacity 0.2s,
        visibility 0.2s;
    }

    .ap-bottom .ap-progress {
      margin: 0 6px;
    }

    .ap-bar {
      display: flex;
      align-items: center;
      gap: 2px;
      height: 40px;
    }

    .ap-bar .ap-time {
      margin-left: 6px;
      text-shadow: 0 0 2px rgb(0 0 0 / 0.5);
    }

    .ap-bar .ap-button svg {
      filter: drop-shadow(0 0 2px rgb(0 0 0 / 0.4));
    }

    .ap-fullscreen .ap-bottom {
      padding: 48px 16px 8px;
    }

    .ap-fullscreen .ap-bar {
      height: 48px;
    }

    /* управление — только пока оно активно (мышь над видео) или фокус с клавиатуры */
    .ap-active .ap-bottom,
    .ap-host:focus-visible .ap-bottom {
      opacity: 1;
      visibility: visible;
    }

    /*
     * Узкий плеер — вертикальное видео (SizedContent for-web: не шире
     * 420 px и не выше 420 px, у 9:16 это 236 px): кнопки и значки меньше,
     * громкость — всплывающей полосой над кнопкой, меню — по ширине плеера.
     */
    @container ap-video (max-width: 359px) {
      .ap-bottom {
        padding: 20px 4px 2px;
      }

      .ap-bottom .ap-progress {
        margin: 0 4px;
      }

      .ap-bar {
        gap: 0;
        height: 34px;
      }

      .ap-bar .ap-button {
        width: 32px;
        height: 32px;
      }

      .ap-bar .ap-button svg {
        width: 20px;
        height: 20px;
      }

      .ap-bar .ap-time {
        margin-left: 4px;
        font-size: 11px;
      }

      .ap-bar .ap-volume {
        position: relative;
      }

      .ap-bar .ap-volume-slider {
        position: absolute;
        left: 0;
        bottom: 100%;
        box-sizing: content-box;
        width: 0;
        height: 16px;
        margin: 0;
        padding: 6px 10px;
        border-radius: 14px;
        background: rgb(0 0 0 / 0.6);
        /* мостик до кнопки, чтобы мышь не теряла полосу по дороге */
        border-bottom: 6px solid transparent;
        background-clip: padding-box;
        visibility: hidden;
      }

      .ap-bar .ap-volume:hover .ap-volume-slider,
      .ap-bar .ap-volume:focus-within .ap-volume-slider {
        width: 80px;
        margin: 0;
        visibility: visible;
      }

      /* подсказку кнопки громкости заслоняла бы полоса — её место занято */
      .ap-bar .ap-volume-button[data-tip]:hover::after {
        display: none;
      }

      .ap-video .ap-menu {
        left: 4px;
        right: 4px;
        bottom: 48px;
        min-width: 0;
      }

      .ap-video .ap-menu:not([hidden]) {
        max-height: calc(100% - 56px);
      }
    }

    /* повтор и «картинка в картинке» узкому плееру — в меню скорости */
    @container ap-video (max-width: 359px) {
      .ap-spare {
        display: none;
      }

      .ap-menu-spare {
        display: block;
      }
    }

    /* не помещается всё время — длительность переносится на скрытую
       вторую строку, остаётся текущее время */
    .ap-bar .ap-time {
      display: flex;
      flex-wrap: wrap;
      min-width: 0;
      height: 16px;
      line-height: 16px;
      overflow: hidden;
    }

    .ap-speed-badge {
      position: absolute;
      right: 0;
      bottom: 2px;
      padding: 0 3px;
      border-radius: 4px;
      background: var(--md-sys-color-primary);
      color: var(--md-sys-color-on-primary);
      font-size: 9px;
      font-weight: 700;
      line-height: 13px;
    }

    .ap-speed-badge[hidden] {
      display: none;
    }

    .ap-button.ap-open svg {
      transform: rotate(30deg);
    }

    .ap-button svg {
      transition: transform 0.2s;
    }

    /* скачать — в углу, только вместе с управлением и не во весь экран */
    .ap-corner {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 36px;
      height: 36px;
      background: rgb(0 0 0 / 0.55);
      opacity: 0;
      visibility: hidden;
      transition:
        opacity 0.2s,
        visibility 0.2s;
    }

    .ap-corner:hover {
      background: rgb(0 0 0 / 0.75);
    }

    .ap-corner[data-tip]:hover::after {
      top: calc(100% + 6px);
      bottom: auto;
      left: auto;
      right: 0;
      transform: none;
    }

    .ap-active .ap-corner,
    .ap-host:focus-visible .ap-corner {
      opacity: 1;
      visibility: visible;
    }

    .ap-fullscreen .ap-corner {
      display: none;
    }

    /* большая кнопка — до первого запуска и в конце */
    .ap-big-play {
      position: absolute;
      top: 50%;
      left: 50%;
      display: none;
      place-items: center;
      width: 60px;
      height: 60px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: rgb(0 0 0 / 0.6);
      color: #fff;
      transform: translate(-50%, -50%);
      cursor: pointer;
      transition:
        background 0.15s,
        transform 0.15s;
    }

    .ap-big-play svg {
      width: 36px;
      height: 36px;
    }

    .ap-big-play:hover {
      background: var(--md-sys-color-primary);
      color: var(--md-sys-color-on-primary);
      transform: translate(-50%, -50%) scale(1.06);
    }

    .ap-video:not(.ap-started) .ap-big-play,
    .ap-video.ap-ended .ap-big-play {
      display: grid;
    }

    .ap-flash {
      position: absolute;
      top: 50%;
      left: 50%;
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: rgb(0 0 0 / 0.5);
      transform: translate(-50%, -50%);
      opacity: 0;
      pointer-events: none !important;
    }

    .ap-flash svg {
      width: 30px;
      height: 30px;
      fill: #fff;
    }

    .ap-flashing {
      animation: ap-flash 0.5s ease-out;
    }

    @keyframes ap-flash {
      from {
        opacity: 1;
        transform: translate(-50%, -50%) scale(0.9);
      }
      to {
        opacity: 0;
        transform: translate(-50%, -50%) scale(1.4);
      }
    }

    .ap-spinner {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 40px;
      height: 40px;
      margin: -20px 0 0 -20px;
      border: 4px solid rgb(255 255 255 / 0.25);
      border-top-color: #fff;
      border-radius: 50%;
      animation: ap-spin 0.8s linear infinite;
      pointer-events: none !important;
    }

    .ap-spinner[hidden] {
      display: none;
    }

    @keyframes ap-spin {
      to {
        transform: rotate(1turn);
      }
    }

    .ap-error {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 16px;
      background: rgb(0 0 0 / 0.75);
      text-align: center;
      font-size: 13px;
    }

    .ap-error[hidden],
    .ap-audio-error[hidden] {
      display: none;
    }

    .ap-error svg {
      width: 32px;
      height: 32px;
      fill: var(--md-sys-color-error);
    }

    .ap-error-link {
      margin-top: 8px;
      padding: 6px 14px;
      border-radius: 999px;
      background: var(--md-sys-color-primary);
      color: var(--md-sys-color-on-primary);
      font-weight: 500;
      text-decoration: none;
    }

    .ap-error-link:hover {
      background: color-mix(in srgb, var(--md-sys-color-primary) 88%, var(--md-sys-color-on-primary));
    }

    .ap-error-link[hidden] {
      display: none;
    }

    .ap-video.ap-failed .ap-big-play,
    .ap-video.ap-failed .ap-bottom {
      display: none;
    }

    /* видео перекодируется: только значок загрузки; до ▶ — только ▶ */
    .ap-video.ap-undecodable .ap-bottom,
    .ap-video.ap-busy .ap-big-play {
      display: none;
    }

    .ap-video.ap-undecodable:not(.ap-busy) .ap-big-play {
      display: grid;
    }

    /* ───────────────────────────────── аудио ───────────────────────────────── */

    .ap-replaced {
      display: none !important;
    }

    /* обложка — она же кнопка воспроизведения */
    .ap-cover {
      --ap-cover: 48px;
      position: relative;
      display: grid;
      width: var(--ap-cover);
      height: var(--ap-cover);
      padding: 0;
      border: 0;
      border-radius: 8px;
      flex-shrink: 0;
      background: var(--md-sys-color-primary);
      color: var(--md-sys-color-on-primary);
      cursor: pointer;
    }

    .ap-cover > * {
      grid-area: 1 / 1;
    }

    .ap-cover-image {
      display: grid;
      place-items: center;
      overflow: hidden;
      border-radius: inherit;
    }

    .ap-cover-image img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      animation: ap-fade 0.2s;
    }

    @keyframes ap-fade {
      from {
        opacity: 0;
      }
    }

    .ap-cover-state {
      display: grid;
      place-items: center;
      border-radius: inherit;
      transition: background 0.15s;
    }

    .ap-cover-state svg {
      grid-area: 1 / 1;
      width: calc(var(--ap-cover) * 0.5);
      height: calc(var(--ap-cover) * 0.5);
      fill: currentColor;
      transition: opacity 0.15s;
    }

    .ap-has-cover .ap-cover-state {
      color: #fff;
      background: rgb(0 0 0 / 0.4);
    }

    .ap-has-cover .ap-cover-state svg {
      filter: drop-shadow(0 1px 3px rgb(0 0 0 / 0.5));
    }

    .ap-cover:hover .ap-cover-state {
      background: color-mix(in srgb, currentColor 10%, transparent);
    }

    .ap-has-cover:hover .ap-cover-state {
      background: rgb(0 0 0 / 0.5);
    }

    /* играет: обложка открыта, вместо паузы — полоски; пауза — при наведении */
    .ap-playing .ap-has-cover:not(:hover, :focus-visible) .ap-cover-state {
      background: rgb(0 0 0 / 0.15);
    }

    .ap-eq {
      grid-area: 1 / 1;
      display: none;
      align-items: end;
      gap: 3px;
      height: calc(var(--ap-cover) * 0.36);
    }

    .ap-eq i {
      width: 4px;
      height: 100%;
      border-radius: 2px;
      background: currentColor;
      transform-origin: bottom;
      animation: ap-eq 0.9s ease-in-out infinite alternate;
    }

    .ap-eq i:nth-child(2) {
      animation-delay: -0.45s;
    }

    .ap-eq i:nth-child(3) {
      animation-delay: -0.2s;
    }

    @keyframes ap-eq {
      from {
        transform: scaleY(0.25);
      }
      to {
        transform: scaleY(1);
      }
    }

    .ap-playing .ap-cover:not(:hover, :focus-visible) .ap-eq {
      display: flex;
    }

    .ap-playing .ap-cover:not(:hover, :focus-visible) .ap-cover-state svg {
      opacity: 0;
    }

    /* загрузка: индикатор вместо полосок; при наведении — пауза */
    .ap-cover-spinner {
      grid-area: 1 / 1;
      display: none;
      width: calc(var(--ap-cover) * 0.42);
      height: calc(var(--ap-cover) * 0.42);
      box-sizing: border-box;
      border: 3px solid color-mix(in srgb, currentColor 30%, transparent);
      border-top-color: currentColor;
      border-radius: 50%;
      animation: ap-spin 0.8s linear infinite;
    }

    .ap-loading .ap-cover:not(:hover, :focus-visible) .ap-eq {
      display: none;
    }

    .ap-loading .ap-cover:not(:hover, :focus-visible) .ap-cover-spinner {
      display: block;
    }

    .ap-cover[data-tip]:hover::after {
      bottom: auto;
      top: calc(100% + 6px);
      left: 0;
      transform: none;
    }

    /* полоса */
    .ap-audio {
      position: relative;
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      color: var(--md-sys-color-on-secondary-container);
    }

    .ap-audio .ap-progress {
      flex: 1;
      min-width: 48px;
    }

    .ap-audio .ap-time {
      min-width: 30px;
      text-align: center;
      opacity: 0.85;
    }

    .ap-speed-button {
      width: auto;
      min-width: 36px;
      padding: 0 6px;
      border-radius: 18px;
      font: 600 12px inherit;
    }

    .ap-audio-card .ap-volume:hover .ap-volume-slider,
    .ap-audio-card .ap-volume:focus-within .ap-volume-slider {
      width: 56px;
    }

    .ap-audio-error {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: var(--md-sys-color-error);
    }

    .ap-audio-error svg {
      width: 18px;
      height: 18px;
      fill: currentColor;
    }

    .ap-failed .ap-audio,
    .ap-failed .ap-cover-state {
      display: none;
    }

    .ap-audio-card .ap-audio {
      margin-left: 2px;
    }

    /* ─────────────────────── панель воспроизведения ─────────────────────── */

    .ap-keep {
      position: fixed;
      top: 0;
      left: 0;
      width: 1px;
      height: 1px;
      overflow: hidden;
      opacity: 0;
      pointer-events: none;
    }

    /* держатель нулевой высоты в ленте чата: чат под плашкой не сдвигается */
    .ap-now-anchor {
      position: relative;
      z-index: 10;
      flex-shrink: 0;
      height: 0;
    }

    /* поверх первых сообщений, по ширине ленты — как «Новые сообщения» */
    .ap-now {
      position: absolute;
      top: var(--gap-md, 8px);
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      gap: 2px;
      height: 48px;
      padding: 0 6px;
      border-radius: var(--borderRadius-lg, 16px);
      background: var(--md-sys-color-surface-container-high);
      box-shadow: 0 2px 8px rgb(0 0 0 / 0.35);
      color: var(--md-sys-color-on-surface);
      font-size: 14px;
      font-weight: 400;
      user-select: none;
      animation: ap-now-in 0.18s ease-out;
    }

    @keyframes ap-now-in {
      from {
        opacity: 0;
        transform: translateY(-6px);
      }
    }

    .ap-now .ap-button[hidden] {
      display: none;
    }

    .ap-now .ap-button:disabled {
      opacity: 0.38;
      cursor: default;
      background: none;
    }

    .ap-now .ap-button:disabled::after {
      display: none;
    }

    .ap-now-art {
      position: relative;
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      margin: 0 6px 0 4px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      overflow: hidden;
      flex-shrink: 0;
      background: color-mix(in srgb, currentColor 12%, transparent);
      color: inherit;
    }

    .ap-now-art:not(.ap-has-cover, [data-icon]) {
      display: none;
    }

    .ap-now-art img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      animation: ap-fade 0.2s;
    }

    .ap-now-art svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
    }

    .ap-now-video .ap-now-art {
      cursor: pointer;
    }

    .ap-now-video .ap-now-art:hover {
      background: color-mix(in srgb, currentColor 20%, transparent);
    }

    .ap-now-art[data-tip]:not([data-tip=""]):hover::after {
      content: attr(data-tip);
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      padding: 4px 8px;
      border-radius: 6px;
      background: var(--md-sys-color-inverse-surface);
      color: var(--md-sys-color-inverse-on-surface);
      font: 500 12px/16px inherit;
      white-space: nowrap;
      pointer-events: none;
      z-index: 3;
    }

    .ap-now-art:focus-visible {
      outline: 2px solid var(--md-sys-color-primary);
      outline-offset: -2px;
    }

    .ap-now-text {
      display: flex;
      align-items: baseline;
      gap: 10px;
      min-width: 0;
      margin-left: 4px;
    }

    .ap-now-title {
      overflow: hidden;
      color: inherit;
      font-weight: 600;
      text-decoration: none;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ap-now-title[href]:hover {
      text-decoration: underline;
    }

    .ap-now .ap-time {
      color: var(--md-sys-color-on-surface-variant);
    }

    .ap-now-volume .ap-volume:hover .ap-volume-slider,
    .ap-now-volume .ap-volume:focus-within .ap-volume-slider {
      width: 72px;
    }

    /* подсказки плашки — под кнопками: над ней край ленты */
    .ap-now .ap-button[data-tip]:hover::after {
      bottom: auto;
      top: calc(100% + 6px);
    }

    /* перемотка — тонкая полоса по нижнему краю */
    .ap-now-seek {
      position: absolute;
      left: 14px;
      right: 14px;
      bottom: 0;
    }

    .ap-now .ap-progress {
      height: 10px;
      align-items: flex-end;
      padding-bottom: 2px;
    }

    .ap-now .ap-rail {
      height: 2px;
    }

    .ap-now .ap-progress:hover .ap-rail,
    .ap-now .ap-dragging .ap-rail {
      height: 4px;
    }

    .ap-now .ap-thumb {
      top: calc(100% - 4px);
      width: 12px;
      height: 12px;
    }

    .ap-now .ap-progress:hover .ap-thumb,
    .ap-now .ap-dragging .ap-thumb {
      transform: translate(-50%, -50%) scale(1);
    }

    .ap-now .ap-seek-tip {
      bottom: auto;
      top: calc(100% + 4px);
    }
  `;

  // ─────────────────────────── элементы for-web ───────────────────────────

  /** Видео и аудио for-web со стандартными кнопками; GIF — без controls */
  const MEDIA = "video[controls], audio[controls]";
  /** Элемент → его плеер */
  const attached = new Map();
  let active = plugin.settings.media_player !== false;
  let observer = null;

  /** Подходит ли элемент: видео — в сетке SizedContent, аудио — в карточке
   *  под FileInfo */
  function fits(media) {
    const parent = media.parentElement;
    if (!parent || !media.isConnected) return false;
    if (media instanceof HTMLVideoElement) return getComputedStyle(parent).display === "grid";
    return media instanceof HTMLAudioElement && media.previousElementSibling !== null;
  }

  function attach(media) {
    if (attached.has(media) || !fits(media)) return;
    try {
      // этот файл играет вне чата — на место элемента for-web встаёт играющий
      const element = heldFor(media) ?? media;
      const enhance = element instanceof HTMLVideoElement ? enhanceVideo : enhanceAudio;
      attached.set(element, enhance(element, media));
      if (element !== media) placeBar();
    } catch (error) {
      console.error("[Arachnid] плеер", error);
    }
  }

  function scan(root) {
    if (!(root instanceof Element) || keep.contains(root)) return;
    if (root.matches(MEDIA)) attach(root);
    for (const media of root.querySelectorAll(MEDIA)) attach(media);
  }

  /** Плееры элементов, которые for-web убрал со страницы */
  function sweep() {
    for (const [media, player] of attached) {
      if (media.isConnected && !keep.contains(media)) continue;
      player.destroy();
      attached.delete(media);
    }
  }

  function onMutations(records) {
    let removed = false;
    for (const record of records) {
      for (const node of record.addedNodes) scan(node);
      if (record.removedNodes.length) removed = true;
    }
    // играющий элемент for-web убрал (сменили канал) — играет дальше вне чата
    if (removed && now.media && !now.media.isConnected && !now.closed) adopt();
    if (removed && attached.size) sweep();
    placeBar();
  }

  function start() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = STYLE;
      document.head.append(style);
    }
    document.body.append(keep);
    bar = createBar();
    document.addEventListener("play", onPlay, true);
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
    scan(document.body);
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    closeBar();
    bar?.destroy();
    bar = null;
    document.removeEventListener("play", onPlay, true);
    keep.remove();
    for (const player of attached.values()) player.destroy();
    attached.clear();
    document.getElementById(STYLE_ID)?.remove();
  }

  plugin.onSettingsChange((values) => {
    const next = values.media_player !== false;
    if (next === active) return;
    active = next;
    if (active) start();
    else stop();
  });

  // подписи — на языке интерфейса Stoat; сменили язык — переподписать
  i18n.onChange(() => {
    for (const player of attached.values()) {
      player.sync();
      player.applySpeed();
    }
    bar?.sync();
    bar?.applySpeed();
  });

  function boot() {
    if (active) start();
  }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
