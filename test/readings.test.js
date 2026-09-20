import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_READINGS, ReadingsStore, normalizeReadings, readingsTable } from '../src/readings.js';

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};
const sample = { t: new Date(2026, 8, 20, 14, 5, 3).getTime(), function: 'V DC', text: '4.987 V', value: 4.987, unit: 'V', state: 'NORMAL' };

test('normalizeReadings drops bad entries and clamps lengths', () => {
  const rows = normalizeReadings([
    { ...sample, description: 'x'.repeat(500) }, { text: '' }, null, 'nope', { ...sample, value: 'abc', unit: 5 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].description.length, 200);
  assert.equal(rows[1].value, null);
  assert.equal(rows[1].unit, '');
  assert.deepEqual(normalizeReadings('garbage'), []);
  assert.equal(normalizeReadings(Array.from({ length: MAX_READINGS + 50 }, () => sample)).length, MAX_READINGS);
});

test('ReadingsStore adds, describes, removes and remembers rows', () => {
  const storage = memoryStorage();
  const store = new ReadingsStore(storage);
  assert.equal(store.rows.length, 0);
  const row = store.add(sample);
  row.description = 'Supply rail, no load';
  store.add({ ...sample, text: 'OL V', value: 9.99999999e37, state: 'OL' });
  store.save();
  assert.equal(new ReadingsStore(storage).rows.length, 2, 'a new store finds them again');
  assert.equal(new ReadingsStore(storage).rows[0].description, 'Supply rail, no load');
  store.remove(0);
  assert.equal(store.rows.length, 1);
  assert.equal(store.add({ text: '' }), null, 'a reading without text is refused');
  store.clear();
  assert.equal(new ReadingsStore(storage).rows.length, 0);
});

test('ReadingsStore keeps working when storage is blocked, and says so', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  const store = new ReadingsStore(blocked);
  store.add(sample);
  assert.equal(store.persistent, false);
  assert.equal(store.rows.length, 1);
});

test('readingsTable gives spreadsheet columns with the numeric value and unit apart from the text', () => {
  const { header, rows } = readingsTable(normalizeReadings([{ ...sample, description: 'no load' }, { ...sample, text: 'OL', value: null, state: 'OL' }]));
  assert.deepEqual(header, ['time', 'function', 'reading', 'value', 'unit', 'state', 'description']);
  assert.deepEqual(rows[0], ['2026-09-20 14:05:03', 'V DC', '4.987 V', 4.987, 'V', 'NORMAL', 'no load']);
  assert.equal(rows[1][3], '');
});
