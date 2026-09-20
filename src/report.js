// Turns a report template plus measurement data into a PDF. A minimal layout: a slim header with a logo, the fields
// that were filled in, one line about the instrument, then one section per graph, and a footer with a logo.
//   template: see templates.js
//   data: { meter: { model, firmware, serial, owner: { company, site, operator, contact } } | null,
//           elements: [ the parts of the report, in order:
//             { type: 'graph', title, description, unit, points (already limited to the cursor window), total, selection, image (JPEG bytes|null) }
//             { type: 'table', title, description, rows: [{ t (ms), function, text (the reading as shown), description }] } ] }
import { formatQuantity } from './format.js';
import { BVK_LOGO, FLUKE_LOGO } from './logos.js';
import { localTimestamp, pointsToTable } from './graph-text.js';
import { PdfDocument, jpegInfo, wrapText } from './pdf.js';
import { normalizeTemplate, pageSize } from './templates.js';

// The footer is fixed: the BVK logo and this line (an em dash and middle dots, all in the PDF's WinAnsi encoding).
export const FOOTER_TEXT = 'BVKsound \u2014 Professional Audio \u00b7 Embedded Systems \u00b7 Acoustic Measurement';

const INK = '#10151a';
const MUTED = '#6b747c';
const RULE = '#d5dadf';
const ZEBRA = '#f5f7f8';

// Statistics over what a section covers. Min/max include a recording's min/max band.
export function summarize(points) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let valid = 0;
  for (const p of points) {
    for (const v of [p.v, p.lo, p.hi]) {
      if (Number.isFinite(v)) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    if (Number.isFinite(p.v)) {
      sum += p.v;
      valid++;
    }
  }
  return {
    count: points.length,
    valid,
    min: min === Infinity ? null : min,
    max: max === -Infinity ? null : max,
    mean: valid ? sum / valid : null,
    start: points[0]?.t ?? null,
    end: points.at(-1)?.t ?? null,
  };
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.round(ms / 100) / 10} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min ${String(sec).padStart(2, '0')} s` : `${m} min ${String(sec).padStart(2, '0')} s`;
}

// At most `max` rows, evenly spread and always ending on the last row.
export function decimate(rows, max) {
  if (rows.length <= max) return { rows, step: 1 };
  const step = Math.ceil(rows.length / max);
  const kept = rows.filter((_, i) => i % step === 0);
  if (kept.at(-1) !== rows.at(-1)) kept.push(rows.at(-1));
  return { rows: kept, step };
}

const columnLabel = (name) => {
  const [head, unit] = name.split('_');
  const label = { time: 'Time', value: 'Value', min: 'Min', max: 'Max', state: 'State' }[head] ?? head;
  return unit ? `${label} (${unit})` : label;
};

const shortTime = (ms) => localTimestamp(ms).slice(0, 19);

function decodeJpeg(dataUrl) {
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  return { bytes, ...jpegInfo(bytes) };
}

// A logo data URL as bytes and a size that fits the box; null when it is missing or damaged (never stops a report).
function logoFor(dataUrl, maxW, maxH) {
  if (!dataUrl) return null;
  try {
    const im = decodeJpeg(dataUrl);
    const scale = Math.min(maxW / im.width, maxH / im.height);
    return { bytes: im.bytes, w: im.width * scale, h: im.height * scale };
  } catch {
    return null;
  }
}

export function buildReportPdf({ template, data, now = new Date() }) {
  const t = normalizeTemplate(template);
  const elements = [...(data.elements ?? [])];
  const [pw, ph] = pageSize(t);
  const M = 40;
  const W = pw - 2 * M;
  const bottom = ph - 60; // room for the footer
  const doc = new PdfDocument({ width: pw, height: ph, title: t.header.title || t.name });
  doc.addPage();
  let y = M;

  // Starts a new page when `h` points do not fit.
  const need = (h) => {
    if (y + h > bottom) {
      doc.addPage();
      y = M;
      return true;
    }
    return false;
  };
  // `keep`: points of content that must fit under the heading, so a heading is never left alone at a page bottom.
  const heading = (label, keep = 0) => {
    need(30 + keep);
    y += 6;
    doc.text(label, M, y + 11, { size: 11, bold: true, color: INK });
    doc.line(M, y + 17, M + W, y + 17, { color: RULE });
    y += 26;
  };
  // Label/value pairs in `cols` columns, wrapping long values; rows never split across pages.
  const grid = (items, cols) => {
    const gap = 14;
    const cw = (W - gap * (cols - 1)) / cols;
    for (let i = 0; i < items.length; i += cols) {
      const row = items.slice(i, i + cols).map(([label, value]) => ({ label, lines: wrapText(String(value), cw - 4, 10) }));
      const h = 11 + Math.max(...row.map((c) => c.lines.length)) * 12.5 + 7;
      need(h);
      row.forEach((c, k) => {
        const x = M + k * (cw + gap);
        doc.text(c.label, x, y + 8, { size: 7.5, bold: true, color: MUTED });
        c.lines.forEach((line, n) => doc.text(line, x, y + 20 + n * 12.5, { size: 10, color: INK }));
      });
      y += h;
    }
  };

  // ---- header: logo(s), title, and a quiet line under it
  // The Fluke logo is always top left; a template may add one more logo (say a customer's) at the top right. The logos
  // and the title's first line are all centred on one line, so they line up.
  const logo = logoFor(FLUKE_LOGO, 120, 30);
  const extra = logoFor(t.extraLogo, 110, 30);
  const textX = M + logo.w + 16;
  const textW = W - logo.w - 16 - (extra ? extra.w + 16 : 0);
  const logosH = Math.max(logo.h, extra ? extra.h : 0);
  const centre = y + 2 + logosH / 2;
  doc.image(logo.bytes, M, centre - logo.h / 2, logo.w, logo.h);
  if (extra) doc.image(extra.bytes, M + W - extra.w, centre - extra.h / 2, extra.w, extra.h);
  let base = centre + 0.36 * 18; // baseline that centres a line of 18 pt capitals on the centre line
  let last = null;
  for (const line of wrapText(t.header.title, textW, 18, true)) {
    doc.text(line, textX, base, { size: 18, bold: true, color: INK });
    last = base;
    base += 22;
  }
  const sub = [t.header.subtitle, t.header.showDate ? `Generated ${localTimestamp(now).slice(0, 16)}` : ''].filter(Boolean).join('   ');
  let subBase = last === null ? centre + 3 : last + 14;
  for (const line of wrapText(sub, textW, 9)) {
    doc.text(line, textX, subBase, { size: 9, color: MUTED });
    last = subBase;
    subBase += 12;
  }
  y = Math.max(y + 2 + logosH, (last ?? centre) + 4) + 8;
  doc.line(M, y, M + W, y, { color: RULE, width: 0.75 });
  y += 12;

  // ---- fields to fill in: two columns, multi-line fields across the page
  if (t.fields.length) {
    const half = (W - 20) / 2;
    const cells = t.fields.map((f) => {
      const value = f.value.trim() || (f.type === 'date' ? localTimestamp(now).slice(0, 10) : '');
      return { f, value, lines: value ? wrapText(value, f.type === 'multiline' ? W : half - 6, 10) : [''] };
    });
    for (let i = 0; i < cells.length; ) {
      const a = cells[i];
      const b = a.f.type !== 'multiline' && cells[i + 1] && cells[i + 1].f.type !== 'multiline' ? cells[i + 1] : null;
      const row = b ? [a, b] : [a];
      const h = 11 + Math.max(...row.map((c) => c.lines.length)) * 12.5 + 8;
      need(h);
      row.forEach((c, k) => {
        const x = M + k * (half + 20);
        const width = c.f.type === 'multiline' ? W : half;
        doc.text(c.f.label, x, y + 8, { size: 7.5, bold: true, color: MUTED });
        c.lines.forEach((line, n) => doc.text(line, x, y + 20 + n * 12.5, { size: 10, color: INK }));
        if (!c.value) doc.line(x, y + 23, x + width - 6, y + 23, { color: RULE }); // a blank line to write on
      });
      y += h;
      i += row.length;
    }
  }

  // ---- instrument: one quiet line
  if (t.blocks.meter && data.meter) {
    const m = data.meter;
    const parts = [m.model, m.serial && `serial ${m.serial}`, m.firmware && `firmware ${m.firmware}`, m.owner?.company, m.owner?.site, m.owner?.operator]
      .filter(Boolean);
    const lines = wrapText(`Instrument: ${parts.join('  ·  ')}`, W, 8.5);
    need(lines.length * 11 + 6);
    y += 2;
    lines.forEach((line) => {
      doc.text(line, M, y + 8, { size: 8.5, color: MUTED });
      y += 11;
    });
    y += 4;
  }

  // ---- the elements the report is made of: graphs and readings tables, each with its description
  const describe = (text) => {
    for (const line of wrapText(text ?? '', W, 10)) {
      need(14);
      doc.text(line, M, y + 9, { size: 10, color: INK });
      y += 13;
    }
    if ((text ?? '').trim()) y += 4;
  };

  for (const element of elements) {
    if (element.type === 'table') {
      // a table of saved readings: time, the reading as it was shown, and a note per row
      const rows = element.rows ?? [];
      heading(element.title || 'Readings', 40);
      describe(element.description);
      if (!rows.length) {
        doc.text('No readings were saved.', M, y + 6, { size: 9.5, color: MUTED });
        y += 18;
        continue;
      }
      // time, function, the reading as it was shown, and a description per row
      const timeW = 118;
      const fnW = 92;
      const readW = 96;
      const descW = W - timeW - fnW - readW;
      const drawHeader = () => {
        doc.text('Time', M + 4, y + 10, { size: 8, bold: true, color: MUTED });
        doc.text('Function', M + timeW + 4, y + 10, { size: 8, bold: true, color: MUTED });
        doc.text('Reading', M + timeW + fnW + 4, y + 10, { size: 8, bold: true, color: MUTED });
        doc.text('Description', M + timeW + fnW + readW + 4, y + 10, { size: 8, bold: true, color: MUTED });
        doc.line(M, y + 15, M + W, y + 15, { color: RULE });
        y += 18;
      };
      need(40);
      drawHeader();
      rows.forEach((row, n) => {
        const desc = wrapText(row.description ?? '', descW - 8, 8.5);
        const h = Math.max(14, desc.length * 11 + 3);
        if (need(h + 2)) drawHeader();
        if (n % 2) doc.rect(M, y, W, h, { fill: ZEBRA });
        doc.text(shortTime(row.t), M + 4, y + 10, { size: 8.5, color: INK });
        doc.text(row.function ?? '', M + timeW + 4, y + 10, { size: 8.5, color: INK });
        doc.text(row.text, M + timeW + fnW + 4, y + 10, { size: 8.5, bold: true, color: INK });
        desc.forEach((line, k) => doc.text(line, M + timeW + fnW + readW + 4, y + 10 + k * 11, { size: 8.5, color: INK }));
        y += h;
      });
      y += 6;
      continue;
    }

    // a graph: image, summary and (if asked for) a table of its samples
    const points = element.points ?? [];
    let picture = null; // the graph image and the size it will be drawn at
    if (points.length && t.blocks.graph && element.image) {
      const im = jpegInfo(element.image);
      const scale = Math.min(W / im.width, Math.min(280, ph * 0.38) / im.height);
      picture = { w: im.width * scale, h: im.height * scale };
    }
    heading(element.title || 'Graph', 20 + (picture ? picture.h : 0));
    describe(element.description);
    if (!points.length) {
      doc.text('There is no data in the graph.', M, y + 6, { size: 9.5, color: MUTED });
      y += 18;
      continue;
    }
    const s = summarize(points);
    const scope = element.selection ? `${points.length} of ${element.total} points, between the cursors` : `${points.length} points`;
    doc.text(`${shortTime(s.start)}  -  ${shortTime(s.end)}   \u00b7   ${scope}`, M, y + 4, { size: 8.5, color: MUTED });
    y += 14;

    if (picture) {
      doc.image(element.image, M, y, picture.w, picture.h);
      doc.rect(M, y, picture.w, picture.h, { stroke: RULE });
      y += picture.h + 10;
    }

    if (t.blocks.summary) {
      const q = (v) => (v == null ? '-' : formatQuantity(v, element.unit));
      grid([
        ['SAMPLES', String(s.count)], ['DURATION', formatDuration(s.end - s.start)], ['MINIMUM', q(s.min)], ['MAXIMUM', q(s.max)],
        ['AVERAGE', q(s.mean)], ['PEAK TO PEAK', s.min == null ? '-' : q(s.max - s.min)],
      ], 4);
    }

    // ---- data table of the graph's samples
    if (t.blocks.table) {
      need(50);
      y += 4;
      const { header, rows } = pointsToTable(points, element.unit);
      const { rows: shown, step } = decimate(rows, t.table.maxRows);
      if (step > 1) {
        doc.text(`Showing ${shown.length} of ${rows.length} samples: 1 in every ${step}, plus the last.`, M, y + 6, { size: 8.5, color: MUTED });
        y += 14;
      }
      // Time first, then the value columns close beside it, right-aligned; numbers to 6 significant digits.
      const first = 150;
      const colW = Math.min(110, (W - first) / Math.max(1, header.length - 1));
      const right = (i) => M + first + i * colW - 6; // right edge of value column i (1-based)
      const tableRight = right(header.length - 1) + 6;
      const isValue = (i) => i > 0 && header[i] !== 'state';
      const text = (cell, i) => (isValue(i) && cell !== '' && Number.isFinite(Number(cell)) ? String(Number(Number(cell).toPrecision(6))) : cell);
      const drawHeader = () => {
        header.forEach((name, i) => {
          const label = columnLabel(name);
          if (i === 0) doc.text(label, M + 4, y + 10, { size: 8, bold: true, color: MUTED });
          else doc.text(label, right(i), y + 10, { size: 8, bold: true, color: MUTED, align: 'right' });
        });
        doc.line(M, y + 15, tableRight, y + 15, { color: RULE });
        y += 18;
      };
      drawHeader();
      shown.forEach((row, n) => {
        if (need(16)) drawHeader();
        if (n % 2) doc.rect(M, y, tableRight - M, 14, { fill: ZEBRA });
        row.forEach((cell, i) => {
          if (i === 0) doc.text(cell, M + 4, y + 10, { size: 8, color: INK });
          else doc.text(text(cell, i), right(i), y + 10, { size: 8, color: INK, align: 'right' });
        });
        y += 14;
      });
    }
  }

  if (!elements.length) {
    doc.text('Nothing has been added to this report yet.', M, y + 10, { size: 9.5, color: MUTED });
  }

  // ---- footer on every page: logo and text on the left, page number on the right
  const footerLogo = logoFor(BVK_LOGO, 60, 18); // built in
  const pages = doc.pageCount;
  for (let p = 1; p <= pages; p++) {
    doc.line(M, ph - 42, M + W, ph - 42, { color: RULE, page: p });
    doc.image(footerLogo.bytes, M, ph - 36, footerLogo.w, footerLogo.h, { page: p });
    const x = M + footerLogo.w + 8;
    const [footer] = wrapText(FOOTER_TEXT, W - 90 - (x - M), 8);
    doc.text(footer, x, ph - 24, { size: 8, color: MUTED, page: p });
    doc.text(`Page ${p} of ${pages}`, M + W, ph - 24, { size: 8, color: MUTED, align: 'right', page: p });
  }

  return doc.build(now);
}
