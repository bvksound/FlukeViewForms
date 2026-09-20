import assert from 'node:assert/strict';
import test from 'node:test';
import { PdfDocument, jpegInfo, textWidth, toWinAnsi, wrapText } from '../src/pdf.js';

// A 24 x 12 pixel JPEG (yellow left half, teal right half).
const TINY_JPEG = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wgARCAAMABgDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAABwj/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCP/aAAwDAQACEAMQAAABcJVVh9lHR9lHbAjWxB9lHR9lHf/EABYQAQEBAAAAAAAAAAAAAAAAAAcQAP/aAAgBAQABBQLK9V5//8QAGREAAgMBAAAAAAAAAAAAAAAABxBEg8IA/9oACAEDAQE/AeLMOzDLMOzC/8QAGREAAgMBAAAAAAAAAAAAAAAABxBEg8IA/9oACAECAQE/AeEk2vbEk2va/8QAGBAAAwEBAAAAAAAAAAAAAAAABBCDwgD/2gAIAQEABj8C4CuGBXC//8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQABPyFAH//aAAwDAQACAAMAAAAQAAA//8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAwEBPxBKv//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQIBAT8QV3//xAAUEAEAAAAAAAAAAAAAAAAAAAAg/9oACAEBAAE/EEif/9k=', 'base64'));

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

test('text metrics match Helvetica', () => {
  // Widths from the Adobe metrics: H=722, i=222, space=278 (regular); bold H=722, i=278.
  assert.equal(textWidth('Hi', 1000), 944);
  assert.equal(textWidth('Hi', 1000, true), 1000);
  assert.equal(textWidth('0123456789', 10), 55.6);
  assert.equal(textWidth('', 10), 0);
});

test('encoding: WinAnsi bytes, stand-ins, and unsupported characters', () => {
  assert.deepEqual(toWinAnsi('A~'), [65, 126]);
  assert.deepEqual(toWinAnsi('µV °C'), [0xb5, 86, 32, 0xb0, 67]);
  assert.deepEqual(toWinAnsi('–'), [0x96]);
  assert.deepEqual(toWinAnsi('Ω'), [111, 104, 109]); // "ohm"
  assert.deepEqual(toWinAnsi('中'), [63]); // not representable
  assert.deepEqual(toWinAnsi('café'), [99, 97, 102, 0xe9]);
});

test('wrapText breaks on spaces, keeps newlines, splits over-long words', () => {
  const width = textWidth('hello world', 10);
  assert.deepEqual(wrapText('hello world foo', width, 10), ['hello world', 'foo']);
  assert.deepEqual(wrapText('a\nb', 500, 10), ['a', 'b']);
  const pieces = wrapText('x'.repeat(200), 100, 10);
  assert.ok(pieces.length > 1 && pieces.every((p) => textWidth(p, 10) <= 100));
  assert.equal(pieces.join(''), 'x'.repeat(200));
});

test('jpegInfo reads size and rejects other data', () => {
  assert.deepEqual(jpegInfo(TINY_JPEG), { width: 24, height: 12, components: 3 });
  assert.throws(() => jpegInfo(Uint8Array.from([1, 2, 3, 4])), /Not a JPEG/);
});

// Every entry of the cross-reference table must point at "N 0 obj", and startxref at the table itself.
function checkStructure(bytes) {
  const text = latin1(bytes);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  const start = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
  assert.equal(text.slice(start, start + 4), 'xref');
  const [, first, count] = /xref\n(\d+) (\d+)\n/.exec(text.slice(start));
  assert.equal(first, '0');
  const table = text.slice(start).split('\n').slice(2, 2 + Number(count));
  table.slice(1).forEach((entry, i) => {
    assert.equal(entry.length, 19); // 10 + 1 + 5 + 1 + 1 + 1, plus the newline makes 20
    const offset = Number(entry.slice(0, 10));
    assert.ok(text.slice(offset).startsWith(`${i + 1} 0 obj`), `object ${i + 1} at ${offset}`);
  });
  return text;
}

test('a document has a valid structure, pages, fonts and an embedded image', () => {
  const doc = new PdfDocument({ title: 'Test (report)' });
  doc.addPage();
  doc.text('Hello (world) \\ 10 µV', 40, 60, { size: 14, bold: true });
  doc.line(40, 70, 500, 70);
  doc.rect(40, 80, 100, 20, { fill: '#f5b721', stroke: [0, 0, 0] });
  doc.image(TINY_JPEG, 40, 120, 120, 60);
  doc.addPage();
  doc.text('Page two', 40, 60);
  const bytes = doc.build(new Date(2026, 8, 20, 12, 30, 0));
  const text = checkStructure(bytes);
  assert.equal(doc.pageCount, 2);
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/Filter \/DCTDecode/);
  assert.match(text, /\/Width 24 \/Height 12/);
  assert.match(text, /\/CreationDate \(D:20260920123000\)/);
  assert.ok(text.includes('(Hello \\(world\\) \\\\ 10 \\265V) Tj'), 'text is escaped');
  assert.ok(text.includes('/Title (Test \\(report\\))'));
});

test('the same image object is embedded once, however often it is drawn', () => {
  const doc = new PdfDocument();
  doc.addPage();
  doc.image(TINY_JPEG, 0, 0, 10, 5);
  doc.image(TINY_JPEG, 20, 0, 10, 5);
  const text = checkStructure(doc.build());
  assert.equal((text.match(/\/Subtype \/Image/g) ?? []).length, 1);
});
