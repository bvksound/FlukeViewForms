import assert from 'node:assert/strict';
import test from 'node:test';
import { Meter } from '../src/meter.js';
import { MemoryReader, MAP_NAMES } from '../src/memory.js';
import {
  f64, parseLive, parseMap, parseMinMaxPeak, parseRecordingInfo, parseRecordingSample, parseSavedMeasurement, s16, u16,
} from '../src/records.js';
import { MockTransport } from './mock-meter.js';

// A real QDDB reply from a Fluke 287 (V1.16), payload only: two readings (LIVE and PRIMARY) in mV AC.
const REAL_QDDB = Uint8Array.from(Buffer.from(
  '02000000010002000000494000000000fdff000000000000000000000000000002000100e5ce9c3f8ae3c0ab0200fdff0300050002000000' +
  'feabda4100c014540200e5ce9c3f8ae3c0ab0200fdff0300050002000000feabda4100c01454', 'hex'));

const MAPS = {
  readingid: { 1: 'LIVE', 2: 'PRIMARY', 3: 'SECONDARY', 5: 'MINIMUM', 6: 'MAXIMUM', 7: 'AVERAGE' },
  unit: { 0: 'NONE', 1: 'VDC', 2: 'VAC', 3: 'ADC' },
  state: { 0: 'INVALID', 2: 'NORMAL', 4: 'OL' },
  attribute: { 0: 'NONE' },
  primfunction: { 2: 'MV_AC', 3: 'V_DC' },
  secfunction: { 0: 'NONE' },
  autorange: { 1: 'AUTO', 2: 'MANUAL' },
  bolt: { 0: 'OFF', 1: 'ON' },
  mode: { 0: 'NONE', 1: 'HOLD' },
  recordtype: { 0: 'INTERVAL', 1: 'EVENT' },
  isstableflag: { 0: 'UNSTABLE', 1: 'STABLE' },
  transientstate: { 0: 'NONE' },
};
const lookup = (map, id) => MAPS[map]?.[id] ?? `#${id}`;

// ---- tiny encoder for building records in the meter's layout
function writer(size) {
  const bytes = new Uint8Array(size);
  const dv = new DataView(bytes.buffer);
  return {
    bytes,
    u16: (o, v) => dv.setUint16(o, v, true),
    s16: (o, v) => dv.setInt16(o, v, true),
    f64(o, v) {
      const tmp = new DataView(new ArrayBuffer(8));
      tmp.setFloat64(0, v);
      dv.setUint32(o, tmp.getUint32(0), true); // high word first
      dv.setUint32(o + 4, tmp.getUint32(4), true);
    },
    text(o, s) {
      [...s].forEach((c, i) => (bytes[o + i] = c.charCodeAt(0)));
    },
  };
}

function reading(w, o, { id, value, unit = 2, mult = -3, dec = 3, digits = 5, state = 2, time = 1789917520.5 }) {
  w.u16(o, id);
  w.f64(o + 2, value);
  w.u16(o + 10, unit);
  w.s16(o + 12, mult);
  w.s16(o + 14, dec);
  w.s16(o + 16, digits);
  w.u16(o + 18, state);
  w.u16(o + 20, 0);
  w.f64(o + 22, time);
}

test('primitives: little-endian words and the meter double order', () => {
  const w = writer(8);
  w.f64(0, 0.028133);
  assert.equal(f64(w.bytes, 0), 0.028133);
  w.u16(0, 0xfffd);
  assert.equal(u16(w.bytes, 0), 65533);
  assert.equal(s16(w.bytes, 0), -3);
});

test('decodes a real QDDB reply from a 287', () => {
  const live = parseLive(REAL_QDDB, lookup);
  assert.equal(live.primaryFunction, 'MV_AC');
  assert.equal(live.unit, 'VAC');
  assert.equal(live.autoRange, 'AUTO');
  assert.equal(live.rangeMax, 50);
  assert.equal(live.unitMultiplier, -3);
  assert.deepEqual(Object.keys(live.readings), ['LIVE', 'PRIMARY']);
  const r = live.readings.PRIMARY;
  assert.equal(r.value, 0.028133);
  assert.equal(r.state, 'NORMAL');
  assert.equal(r.decimals, 3);
  assert.equal(r.displayDigits, 5);
  assert.ok(Math.abs(r.time - 1789917520.32) < 0.01);
});

test('saved measurement', () => {
  const w = writer(38 + 30 + 6);
  w.u16(0, 7);
  w.u16(4, 3); // V_DC
  w.u16(8, 1);
  w.u16(10, 1); // VDC
  w.f64(12, 50);
  w.s16(20, 0);
  w.u16(36, 1);
  reading(w, 38, { id: 2, value: 4.9987, unit: 1, mult: 0, dec: 4 });
  w.text(68, 'Bench');
  const m = parseSavedMeasurement(w.bytes, lookup);
  assert.equal(m.name, 'Bench');
  assert.equal(m.primaryFunction, 'V_DC');
  assert.equal(m.readings.PRIMARY.value, 4.9987);
  assert.equal(m.readings.PRIMARY.unit, 'VDC');
  assert.throws(() => parseSavedMeasurement(w.bytes.subarray(0, 60), lookup), /expected at least/);
});

test('min/max session', () => {
  const w = writer(54 + 90 + 4);
  w.f64(4, 1789917000);
  w.f64(12, 1789917600);
  w.u16(20, 2);
  w.u16(26, 2);
  w.u16(52, 3);
  reading(w, 54, { id: 5, value: -0.0211 });
  reading(w, 84, { id: 6, value: 0.03055 });
  reading(w, 114, { id: 7, value: 0.00529 });
  w.text(144, 'MM 1');
  const s = parseMinMaxPeak(w.bytes, lookup, 'minmax');
  assert.equal(s.kind, 'minmax');
  assert.equal(s.end - s.start, 600);
  assert.equal(s.readings.MINIMUM.value, -0.0211);
  assert.equal(s.readings.MAXIMUM.value, 0.03055);
  assert.equal(s.name, 'MM 1');
});

test('recording header and sample', () => {
  const w = writer(78 + 30 + 3);
  w.f64(4, 1789910000);
  w.f64(12, 1789913600);
  w.f64(20, 5); // seconds between samples
  w.u16(36, 4); // reading index used by QSRR
  w.u16(40, 720);
  w.u16(44, 2);
  w.u16(76, 1);
  reading(w, 78, { id: 2, value: 0.5 });
  w.text(108, 'Log');
  const info = parseRecordingInfo(w.bytes, lookup);
  assert.equal(info.sampleCount, 720);
  assert.equal(info.readingIndex, 4);
  assert.equal(info.sampleInterval, 5);
  assert.equal(info.name, 'Log');

  const s = writer(146);
  s.f64(0, 1789910005);
  s.f64(8, 1789910010);
  reading(s, 16, { id: 6, value: 0.012 });
  reading(s, 46, { id: 7, value: 0.01 });
  reading(s, 76, { id: 5, value: 0.008 });
  s.u16(106, 5);
  reading(s, 110, { id: 2, value: 0.011 });
  s.u16(140, 0);
  s.u16(142, 1);
  const sample = parseRecordingSample(s.bytes, lookup);
  assert.equal(sample.stats.MAXIMUM.value, 0.012);
  assert.equal(sample.count, 5);
  assert.equal(sample.stats.MINIMUM.value, 0.008);
  assert.equal(sample.primary.PRIMARY.value, 0.011);
  assert.equal(sample.recordType, 'INTERVAL');
  assert.equal(sample.stable, 'STABLE');
  assert.throws(() => parseRecordingSample(s.bytes.subarray(0, 100), lookup), /expected 146/);
});

test('parseMap', () => {
  const m = parseMap('3,0,NONE,1,HERTZ,2,DUTY_CYCLE');
  assert.equal(m.get('1'), 'HERTZ');
  assert.throws(() => parseMap('3,0,NONE'), /value map/);
});

test('MemoryReader reads stored data through binary replies (CR bytes and fragments included)', async () => {
  const transport = new MockTransport();
  const mapText = (name) => {
    const entries = Object.entries(MAPS[name]);
    return `${entries.length},${entries.flat().join(',')}`;
  };
  // A saved measurement whose payload deliberately contains 0x0D bytes: a line reader would cut it apart.
  const w = writer(38 + 30 + 4);
  w.u16(0, 1);
  w.u16(4, 3);
  w.u16(36, 1);
  reading(w, 38, { id: 2, value: 13.0, unit: 1, mult: 0, dec: 1, time: 1789917520.5 });
  w.text(68, 'Cr\r\r');
  w.bytes[2] = 0x0d;
  transport.handlers.push((cmd) => {
    if (cmd === 'QSLS') return '1,2,3,4';
    if (/^QEMAP (\w+)$/i.test(cmd)) return mapText(cmd.split(' ')[1]);
    if (cmd === 'QSMR 0') return w.bytes;
    if (cmd === 'QSMR 1') return w.bytes.subarray(0, 50); // truncated on the wire: must be retried, then give up
  });
  const reader = new MemoryReader(new Meter(transport, { timeoutMs: 400 }));

  assert.deepEqual(await reader.summary(), { recordings: 1, minMax: 2, peak: 3, measurements: 4 });
  const m = await reader.savedMeasurement(0);
  assert.equal(m.readings.PRIMARY.value, 13);
  assert.equal(m.primaryFunction, 'V_DC');
  assert.equal(m.name, 'Cr'); // control characters stripped from the name
  assert.equal(MAP_NAMES.length, 12);
  await assert.rejects(reader.savedMeasurement(1), /incomplete|expected/);
});

test('recording sample: the stored average is a sum, divided by the reading count (numbers from a real 287)', () => {
  // Sample 1 of a real recording: sum 0.023606 over 3 readings, max 0.007894, min 0.007856.
  const s = writer(146);
  reading(s, 16, { id: 6, value: 0.007894 });
  reading(s, 46, { id: 7, value: 0.023606 });
  reading(s, 76, { id: 5, value: 0.007856 });
  s.u16(106, 3);
  reading(s, 110, { id: 2, value: 0.0079 });
  const sample = parseRecordingSample(s.bytes, lookup);
  assert.equal(sample.stats.AVERAGE.value, 0.023606); // what is stored: larger than the maximum
  assert.ok(Math.abs(sample.average - 0.007869) < 1e-6);
  assert.ok(sample.average >= sample.stats.MINIMUM.value && sample.average <= sample.stats.MAXIMUM.value);
  // no readings in the interval: no average rather than a division by zero
  s.u16(106, 0);
  assert.ok(Number.isNaN(parseRecordingSample(s.bytes, lookup).average));
});
