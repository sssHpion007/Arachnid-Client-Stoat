// Прототип: обложка аудио прямо из файла на CDN. Файл не скачивается целиком:
// частичные запросы (Range) читают только заголовки и блок с картинкой.
// autumn отдаёт файлы частями и открывает для страниц Accept-Ranges и
// Content-Range (CORS), поэтому так можно читать и вложения Stoat.
//
// Форматы: MP3 (ID3v2.2–2.4: APIC/PIC), FLAC (PICTURE), OGG Vorbis и Opus
// (METADATA_BLOCK_PICTURE, COVERART), M4A/MP4 (moov › udta › meta › ilst ›
// covr; moov может быть и в конце файла), WAV (кусок «id3 »).

const Covers = (() => {
  "use strict";

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
      if (id !== "APIC" && id !== "PIC") continue;
      if (formatFlags & 0x01) body = body.subarray(4); // длина данных
      if (formatFlags & 0x02) body = resync(body);
      const encoding = body[0];
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
    return pick(pictures);
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
    for (;;) {
      const header = await reader.bytes(at, 4);
      if (header.length < 4) break;
      const last = header[0] & 0x80;
      const type = header[0] & 0x7f;
      const length = (header[1] << 16) | (header[2] << 8) | header[3];
      if (type === 6) pictures.push(flacPicture(await reader.bytes(at + 4, length)));
      at += 4 + length;
      if (last) break;
    }
    return pick(pictures);
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
    let i = ascii(packet, 0, 7) === "\x03vorbis" ? 7 : ascii(packet, 0, 8) === "OpusTags" ? 8 : -1;
    if (i < 0) return null;
    i += 4 + u32le(packet, i); // поставщик
    const count = u32le(packet, i);
    i += 4;
    const decoder = new TextDecoder();
    const pictures = [];
    let legacy = null;
    let legacyMime = null;
    for (let n = 0; n < count && i < packet.length; n++) {
      const length = u32le(packet, i);
      const comment = packet.subarray(i + 4, i + 4 + length);
      i += 4 + length;
      const equals = comment.indexOf(0x3d);
      const key = ascii(comment, 0, equals).toUpperCase();
      if (key === "METADATA_BLOCK_PICTURE") pictures.push(flacPicture(base64(decoder.decode(comment.subarray(equals + 1)))));
      else if (key === "COVERART") legacy = base64(decoder.decode(comment.subarray(equals + 1)));
      else if (key === "COVERARTMIME") legacyMime = decoder.decode(comment.subarray(equals + 1));
    }
    return pick(pictures) ?? (legacy ? { type: 3, mime: legacyMime, data: legacy } : null);
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
    let box = { start: 0, end: reader.size };
    for (const type of ["moov", "udta", "meta", "ilst", "covr", "data"]) {
      box = await atom(reader, box.start, box.end, type);
      if (!box) return null;
      if (type === "meta") box.start += 4; // версия и флаги
    }
    const data = await reader.bytes(box.start, box.end - box.start);
    const kind = u32(data, 0);
    return { type: 3, mime: { 13: "image/jpeg", 14: "image/png", 27: "image/bmp" }[kind], data: data.subarray(8) };
  }

  // ───────────────────────────── WAV ─────────────────────────────

  async function wav(reader) {
    for (let at = 12; ; ) {
      const head = await reader.bytes(at, 8);
      if (head.length < 8) return null;
      const id = ascii(head, 0, 4);
      const size = u32le(head, 4);
      if (id === "id3 " || id === "ID3 ") return id3(reader, at + 8);
      at += 8 + size + (size & 1);
    }
  }

  // ───────────────────────────── вход ─────────────────────────────

  async function extract(url, signal) {
    const reader = new RangeReader(url, signal);
    const start = await reader.bytes(0, 12);
    let picture = null;
    if (ascii(start, 0, 3) === "ID3") picture = await id3(reader, 0);
    else if (ascii(start, 0, 4) === "fLaC") picture = await flac(reader, 0);
    else if (ascii(start, 0, 4) === "OggS") picture = await ogg(reader);
    else if (ascii(start, 4, 4) === "ftyp") picture = await mp4(reader);
    else if (ascii(start, 0, 4) === "RIFF" && ascii(start, 8, 4) === "WAVE") picture = await wav(reader);
    if (!picture || picture.data.length === 0) return null;
    const type = sniff(picture.data, picture.mime);
    if (!type) return null;
    return URL.createObjectURL(new Blob([picture.data], { type }));
  }

  /** Адрес файла → Promise адреса картинки (blob:) или null */
  const cache = new Map();

  function cover(url) {
    if (cache.has(url)) {
      const found = cache.get(url);
      cache.delete(url);
      cache.set(url, found);
      return found;
    }
    const promise = extract(url).catch((error) => {
      if (!(error instanceof NoCover)) console.warn("[Arachnid] обложка", url, error);
      return null;
    });
    cache.set(url, promise);
    while (cache.size > KEEP) {
      const [oldest, value] = cache.entries().next().value;
      cache.delete(oldest);
      value.then((blob) => blob && URL.revokeObjectURL(blob));
    }
    return promise;
  }

  return { cover };
})();
