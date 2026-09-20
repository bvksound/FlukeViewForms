// A small PDF writer with no dependencies: text in the standard Helvetica fonts, lines, rectangles and JPEG images.
// Coordinates are in points (1/72 inch) measured from the TOP-LEFT of the page, which is easier to lay out than the
// PDF's own bottom-left origin. Text is encoded as WinAnsi, so Western European characters work; anything else
// becomes "?" (and Ω becomes "ohm", since it is not in that encoding).

// Widths in 1/1000 em for the printable ASCII range (32..126), from the Adobe Helvetica metrics.
const HELVETICA = ('278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 ' +
  '278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 ' +
  '667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 ' +
  '500 722 500 500 500 334 260 334 584').split(' ').map(Number);
const HELVETICA_BOLD = ('278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 ' +
  '333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 ' +
  '667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 ' +
  '556 778 556 556 500 389 280 389 584').split(' ').map(Number);

// Characters outside ASCII/Latin-1 that WinAnsi does have, and stand-ins for common ones it lacks.
const WIN_ANSI = new Map([
  ['…', 0x85], ['–', 0x96], ['—', 0x97], ['‘', 0x91], ['’', 0x92], ['“', 0x93],
  ['”', 0x94], ['•', 0x95], ['€', 0x80], ['™', 0x99],
]);
const REPLACEMENTS = new Map([
  ['Ω', 'ohm'], ['Ω', 'ohm'], ['μ', 'µ'], ['−', '-'], [' ', ' '], ['→', '->'],
  ['≤', '<='], ['≥', '>='],
]);

// String -> array of WinAnsi byte values (unsupported characters become "?").
export function toWinAnsi(text) {
  const bytes = [];
  for (const ch of String(text)) {
    const c = REPLACEMENTS.has(ch) ? REPLACEMENTS.get(ch) : ch;
    for (const part of c) {
      const code = part.codePointAt(0);
      if (WIN_ANSI.has(part)) bytes.push(WIN_ANSI.get(part));
      else if (code >= 0x20 && code <= 0x7e) bytes.push(code);
      else if (code >= 0xa0 && code <= 0xff) bytes.push(code);
      else if (code === 0x09) bytes.push(0x20);
      else bytes.push(0x3f);
    }
  }
  return bytes;
}

// Width of a string in points.
export function textWidth(text, size, bold = false) {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let units = 0;
  for (const byte of toWinAnsi(text)) {
    if (byte >= 32 && byte <= 126) units += table[byte - 32];
    else if (byte >= 0xc0) units += table[(String.fromCharCode(byte).normalize('NFD').charCodeAt(0) || 63) - 32] ?? 556; // accented: use the base letter
    else units += { 0xb0: 400, 0xb5: 556, 0xb7: 278, 0xb1: 584, 0xd7: 584, 0x85: 1000, 0x96: 556, 0x97: 1000, 0x95: 350 }[byte] ?? 556;
  }
  return (units * size) / 1000;
}

// Greedy word wrap to `maxWidth` points; honours newlines and breaks words that are wider than the line.
export function wrapText(text, maxWidth, size, bold = false) {
  const lines = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const trial = line ? `${line} ${word}` : word;
      if (textWidth(trial, size, bold) <= maxWidth) {
        line = trial;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      let rest = word;
      while (textWidth(rest, size, bold) > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && textWidth(rest.slice(0, cut), size, bold) > maxWidth) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

const num = (x) => String(Math.round(x * 100) / 100);

// (text) as a PDF string literal, pure ASCII: control and high bytes as octal escapes.
function literal(text) {
  let out = '(';
  for (const b of toWinAnsi(text)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += `\\${b.toString(8).padStart(3, '0')}`;
  }
  return `${out})`;
}

function rgb(color) {
  if (typeof color === 'string') {
    const m = /^#?([0-9a-f]{6})$/i.exec(color);
    if (!m) return [0, 0, 0];
    const v = parseInt(m[1], 16);
    return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }
  return color;
}

// Reads a JPEG's size and colour components, or throws if it is not a JPEG this writer can embed.
export function jpegInfo(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG image');
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const components = bytes[i + 9];
      if (components !== 1 && components !== 3) throw new Error('Unsupported JPEG colour format');
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8], components };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) i += 2;
    else i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  throw new Error('Could not read the JPEG size');
}

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

export class PdfDocument {
  #pages = [];
  #images = []; // { bytes, width, height, components }
  #title;

  // A4 by default: 595.28 x 841.89 pt.
  constructor({ width = 595.28, height = 841.89, title = '' } = {}) {
    this.width = width;
    this.height = height;
    this.#title = title;
  }

  get pageCount() {
    return this.#pages.length;
  }

  addPage() {
    this.#pages.push({ ops: [], images: new Set() });
    return this.#pages.length;
  }

  // Draws on page `page` (1-based, default the last one).
  #page(page) {
    if (!this.#pages.length) this.addPage();
    return this.#pages[(page ?? this.#pages.length) - 1];
  }

  textWidth(text, size, bold = false) {
    return textWidth(text, size, bold);
  }

  wrap(text, maxWidth, size, bold = false) {
    return wrapText(text, maxWidth, size, bold);
  }

  // `y` is the text baseline, measured from the top of the page. align: left | right | center about x.
  text(text, x, y, { size = 10, bold = false, color = [0, 0, 0], align = 'left', page } = {}) {
    if (text === '' || text == null) return;
    const w = textWidth(text, size, bold);
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    const [r, g, b] = rgb(color);
    this.#page(page).ops.push(
      `BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(r)} ${num(g)} ${num(b)} rg 1 0 0 1 ${num(left)} ${num(this.height - y)} Tm ${literal(text)} Tj ET`,
    );
  }

  line(x1, y1, x2, y2, { width = 0.5, color = [0, 0, 0], dash = null, page } = {}) {
    const [r, g, b] = rgb(color);
    this.#page(page).ops.push(
      `q ${num(width)} w ${num(r)} ${num(g)} ${num(b)} RG${dash ? ` [${dash.map(num).join(' ')}] 0 d` : ''} ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S Q`,
    );
  }

  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 0.5, page } = {}) {
    const ops = ['q'];
    if (fill) ops.push(`${rgb(fill).map(num).join(' ')} rg`);
    if (stroke) ops.push(`${num(lineWidth)} w ${rgb(stroke).map(num).join(' ')} RG`);
    ops.push(`${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'} Q`);
    this.#page(page).ops.push(ops.join(' '));
  }

  // Embeds a JPEG (raw bytes) and draws it with its top-left corner at (x, y), scaled to w x h points.
  image(jpegBytes, x, y, w, h, { page } = {}) {
    const info = jpegInfo(jpegBytes);
    let index = this.#images.findIndex((im) => im.bytes === jpegBytes);
    if (index < 0) {
      this.#images.push({ bytes: jpegBytes, ...info });
      index = this.#images.length - 1;
    }
    const p = this.#page(page);
    p.images.add(index);
    p.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.height - y - h)} cm /Im${index + 1} Do Q`);
    return info;
  }

  // The finished file as bytes.
  build(now = new Date()) {
    const chunks = [];
    const offsets = [];
    let length = 0;
    const push = (data) => {
      const bytes = typeof data === 'string' ? ascii(data) : data;
      chunks.push(bytes);
      length += bytes.length;
    };
    const object = (id, body) => {
      offsets[id] = length;
      push(`${id} 0 obj\n`);
      for (const part of body) push(part);
      push('\nendobj\n');
    };

    // Object numbers: 1 catalog, 2 page tree, 3-4 fonts, 5 info, then images, then a page and its content stream each.
    const imageBase = 6;
    const pageBase = imageBase + this.#images.length;
    const pageIds = this.#pages.map((_, i) => pageBase + i * 2);

    push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    object(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
    object(2, [`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`]);
    object(3, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
    object(4, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']);
    const stamp = `D:${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
      `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    object(5, [`<< /Title ${literal(this.#title)} /Producer (FlukeView Forms Open) /CreationDate (${stamp}) >>`]);

    this.#images.forEach((im, i) => {
      object(imageBase + i, [
        `<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /${im.components === 1 ? 'DeviceGray' : 'DeviceRGB'} ` +
          `/BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`,
        im.bytes,
        '\nendstream',
      ]);
    });

    this.#pages.forEach((page, i) => {
      const contentId = pageIds[i] + 1;
      const xobjects = [...page.images].map((n) => `/Im${n + 1} ${imageBase + n} 0 R`).join(' ');
      object(pageIds[i], [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] /Contents ${contentId} 0 R ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >> >>`,
      ]);
      const content = page.ops.join('\n');
      object(contentId, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    });

    const count = pageBase + pageIds.length * 2; // number of objects + 1
    const xref = length;
    push(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let id = 1; id < count; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}
