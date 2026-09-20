// Decoders for the meter's binary memory records (QSMR, QMMSI, QPSI, QRSI, QSRR, QDDB).
//
// Layout follows the open-source dmm_util (N0ury/dmm_util, MIT) and was checked against a real 287's QDDB reply.
// Everything is little-endian; a double is two little-endian 32-bit words with the HIGH word first. Enumerated
// fields (function, unit, state…) are numeric ids that the meter translates through `QEMAP <name>` value maps,
// which the caller supplies as `lookup(mapName, id)`.
import { ProtocolError } from './protocol.js';

const READING_SIZE = 30;
const latin1 = new TextDecoder('latin1');

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export const u16 = (bytes, o) => view(bytes).getUint16(o, true);
export const s16 = (bytes, o) => view(bytes).getInt16(o, true);

export function f64(bytes, o) {
  const v = view(bytes);
  const out = new DataView(new ArrayBuffer(8));
  out.setUint32(0, v.getUint32(o, true)); // high word first
  out.setUint32(4, v.getUint32(o + 4, true));
  return out.getFloat64(0);
}

// Meter timestamps are seconds since 1970 in the meter's local wall-clock time (see docs/protocol.md).
export const seconds = (bytes, o) => f64(bytes, o);

function need(bytes, length, what) {
  if (bytes.length < length) throw new ProtocolError(`${what}: expected at least ${length} bytes, got ${bytes.length}`);
}

// One reading is 30 bytes: id, value(8), unit, multiplier, decimals, digits, state, attribute, time(8).
export function parseReadings(bytes, offset, count, lookup) {
  const readings = {};
  for (let i = 0; i < count; i++) {
    const o = offset + i * READING_SIZE;
    const id = lookup('readingid', u16(bytes, o));
    readings[id] = {
      id,
      value: f64(bytes, o + 2),
      unit: lookup('unit', u16(bytes, o + 10)),
      unitMultiplier: s16(bytes, o + 12),
      decimals: s16(bytes, o + 14),
      displayDigits: s16(bytes, o + 16),
      state: lookup('state', u16(bytes, o + 18)),
      attribute: lookup('attribute', u16(bytes, o + 20)),
      time: seconds(bytes, o + 22),
    };
  }
  return readings;
}

// The record name follows the readings; the meter pads or terminates it, so trim control characters.
const nameAt = (bytes, offset) => latin1.decode(bytes.subarray(offset)).replace(/[\u0000-\u001f]/g, '').trim();

// Present display: QDDB.
export function parseLive(bytes, lookup) {
  need(bytes, 34, 'QDDB');
  const count = u16(bytes, 32);
  need(bytes, 34 + count * READING_SIZE, 'QDDB');
  return {
    primaryFunction: lookup('primfunction', u16(bytes, 0)),
    secondaryFunction: lookup('secfunction', u16(bytes, 2)),
    autoRange: lookup('autorange', u16(bytes, 4)),
    unit: lookup('unit', u16(bytes, 6)),
    rangeMax: f64(bytes, 8),
    unitMultiplier: s16(bytes, 16),
    bolt: lookup('bolt', u16(bytes, 18)),
    mode: lookup('mode', u16(bytes, 28)),
    readings: parseReadings(bytes, 34, count, lookup),
  };
}

// Saved measurement: QSMR n.
export function parseSavedMeasurement(bytes, lookup) {
  need(bytes, 38, 'QSMR');
  const count = u16(bytes, 36);
  need(bytes, 38 + count * READING_SIZE, 'QSMR');
  return {
    kind: 'measurement',
    seq: u16(bytes, 0),
    primaryFunction: lookup('primfunction', u16(bytes, 4)),
    secondaryFunction: lookup('secfunction', u16(bytes, 6)),
    autoRange: lookup('autorange', u16(bytes, 8)),
    unit: lookup('unit', u16(bytes, 10)),
    rangeMax: f64(bytes, 12),
    unitMultiplier: s16(bytes, 20),
    bolt: lookup('bolt', u16(bytes, 22)),
    mode: lookup('mode', u16(bytes, 32)),
    readings: parseReadings(bytes, 38, count, lookup),
    name: nameAt(bytes, 38 + count * READING_SIZE),
  };
}

// Min/max session (QMMSI n) and peak session (QPSI n) share one layout.
export function parseMinMaxPeak(bytes, lookup, kind) {
  need(bytes, 54, kind);
  const count = u16(bytes, 52);
  need(bytes, 54 + count * READING_SIZE, kind);
  return {
    kind,
    seq: u16(bytes, 0),
    start: seconds(bytes, 4),
    end: seconds(bytes, 12),
    primaryFunction: lookup('primfunction', u16(bytes, 20)),
    secondaryFunction: lookup('secfunction', u16(bytes, 22)),
    autoRange: lookup('autorange', u16(bytes, 24)),
    unit: lookup('unit', u16(bytes, 26)),
    rangeMax: f64(bytes, 28),
    unitMultiplier: s16(bytes, 36),
    bolt: lookup('bolt', u16(bytes, 38)),
    mode: lookup('mode', u16(bytes, 48)),
    readings: parseReadings(bytes, 54, count, lookup),
    name: nameAt(bytes, 54 + count * READING_SIZE),
  };
}

// Recording session header: QRSI n. `readingIndex` is what QSRR expects as its first argument.
export function parseRecordingInfo(bytes, lookup) {
  need(bytes, 78, 'QRSI');
  const count = u16(bytes, 76);
  need(bytes, 78 + count * READING_SIZE, 'QRSI');
  return {
    kind: 'recording',
    seq: u16(bytes, 0),
    start: seconds(bytes, 4),
    end: seconds(bytes, 12),
    sampleInterval: f64(bytes, 20),
    eventThreshold: f64(bytes, 28),
    readingIndex: u16(bytes, 36),
    sampleCount: u16(bytes, 40),
    primaryFunction: lookup('primfunction', u16(bytes, 44)),
    secondaryFunction: lookup('secfunction', u16(bytes, 46)),
    autoRange: lookup('autorange', u16(bytes, 48)),
    unit: lookup('unit', u16(bytes, 50)),
    rangeMax: f64(bytes, 52),
    unitMultiplier: s16(bytes, 60),
    bolt: lookup('bolt', u16(bytes, 62)),
    mode: lookup('mode', u16(bytes, 72)),
    readings: parseReadings(bytes, 78, count, lookup),
    name: nameAt(bytes, 78 + count * READING_SIZE),
  };
}

export const RECORDING_SAMPLE_SIZE = 146;

// One recording sample: QSRR readingIndex,sampleIndex. Exactly 146 bytes.
export function parseRecordingSample(bytes, lookup) {
  if (bytes.length !== RECORDING_SAMPLE_SIZE) {
    throw new ProtocolError(`QSRR: expected ${RECORDING_SAMPLE_SIZE} bytes, got ${bytes.length}`);
  }
  const stats = parseReadings(bytes, 16, 3, lookup); // MAXIMUM / AVERAGE / MINIMUM over the interval
  // The stored AVERAGE is the SUM of the interval's readings; dmm_util divides it by the reading count (u16 @106).
  // Confirmed on a real 287: sums exceeded the interval's own maximum until divided.
  const count = u16(bytes, 106);
  return {
    start: seconds(bytes, 0),
    end: seconds(bytes, 8),
    stats,
    count,
    average: count > 0 && stats.AVERAGE ? stats.AVERAGE.value / count : NaN,
    primary: parseReadings(bytes, 110, 1, lookup), // the value at the moment of the sample
    recordType: lookup('recordtype', u16(bytes, 140)),
    stable: lookup('isstableflag', u16(bytes, 142)),
    transient: lookup('transientstate', u16(bytes, 144)),
  };
}

// "3,0,NONE,1,HERTZ,2,X" -> Map { '0' => 'NONE', … }. The first field is the pair count.
export function parseMap(line) {
  const fields = line.split(',').map((f) => f.trim());
  const count = Number(fields.shift());
  if (!Number.isInteger(count) || fields.length !== count * 2) {
    throw new ProtocolError(`Unexpected value map: ${JSON.stringify(line)}`);
  }
  const map = new Map();
  for (let i = 0; i < fields.length; i += 2) map.set(fields[i], fields[i + 1]);
  return map;
}
