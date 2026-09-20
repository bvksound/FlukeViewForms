// Saved readings: single readings captured from the live display, kept in the browser until you clear them.
// Each row holds the time (computer clock), the function, the reading as shown, its numeric value and base unit, the
// state (NORMAL, OL…), and a description you type.
import { localTimestamp } from './graph-text.js';

export const MAX_READINGS = 1000;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// Coerces stored or pasted data into valid rows (bad entries are dropped, lengths clamped).
export function normalizeReadings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === 'object' && typeof r.text === 'string' && r.text.trim())
    .slice(0, MAX_READINGS)
    .map((r) => ({
      t: Number.isFinite(r.t) ? r.t : Date.now(),
      function: str(r.function, 40),
      text: str(r.text, 60).trim(),
      value: Number.isFinite(r.value) ? r.value : null,
      unit: str(r.unit, 12),
      state: str(r.state, 20),
      description: str(r.description, 200),
    }));
}

// The table as CSV columns: everything a spreadsheet needs, with the numeric value and base unit apart from the text.
export function readingsTable(rows) {
  return {
    header: ['time', 'function', 'reading', 'value', 'unit', 'state', 'description'],
    rows: rows.map((r) => [localTimestamp(r.t).slice(0, 19), r.function, r.text, r.value ?? '', r.unit, r.state, r.description]),
  };
}

// Rows in browser storage (or any getItem/setItem store). If storage is blocked they live in memory for the session,
// and `persistent` says so.
export class ReadingsStore {
  #storage;
  #key;
  persistent = true;
  rows = [];

  constructor(storage, key = 'fluke287.readings') {
    this.#storage = storage;
    this.#key = key;
    try {
      this.rows = normalizeReadings(JSON.parse(storage.getItem(key) ?? 'null'));
    } catch {
      this.rows = [];
    }
  }

  save() {
    try {
      this.#storage.setItem(this.#key, JSON.stringify(this.rows));
      this.persistent = true;
    } catch {
      this.persistent = false;
    }
  }

  // Adds a reading; returns it, or null when the table is full.
  add(reading) {
    if (this.rows.length >= MAX_READINGS) return null;
    const [row] = normalizeReadings([{ description: '', ...reading }]);
    if (!row) return null;
    this.rows.push(row);
    this.save();
    return row;
  }

  remove(index) {
    this.rows.splice(index, 1);
    this.save();
  }

  clear() {
    this.rows = [];
    this.save();
  }
}
