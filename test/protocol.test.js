import assert from 'node:assert/strict';
import test from 'node:test';
import { batteryBars, batteryBlocks, formatBattery, formatEng, formatReading, parseEng, prettyFunction } from '../src/format.js';
import { Meter, MeterError } from '../src/meter.js';
import { MockTransport } from './mock-meter.js';
import { ProtocolError, parseAck, parseId, parseQdda, parseQm } from '../src/protocol.js';
import { clockValueFor, localClockText, meterClockToText, minutesToSeconds, secondsToMinutes } from '../src/settings.js';
import { LineBuffer, TimeoutError } from '../src/transport.js';

// Examples taken from the Fluke 289/287 Remote Interface Specification.
const QDDA_LIVE =
  'MV_AC,NONE,AUTO,VAC,50,-3,OFF,0.000,0,2,' +
  'LIVE,0.005029,VAC,-3,3,5,NORMAL,NONE,1197308998.282,' +
  'PRIMARY,0.005029,VAC,-3,3,5,NORMAL,NONE,1197308998.282';

const QDDA_MINMAX =
  'MV_AC,PEAK_MIN_MAX,AUTO,VAC,50,-3,OFF,1197309132.612,1,MIN_MAX_AVG,5,' +
  'LIVE,0.00515,VAC,-3,2,5,NORMAL,NONE,1197309141.806,' +
  'PRIMARY,0.00515,VAC,-3,2,5,NORMAL,NONE,1197309141.806,' +
  'MINIMUM,-0.0211,V,-3,2,5,NORMAL,NONE,1197309133.616,' +
  'MAXIMUM,0.03055,V,-3,2,5,NORMAL,NONE,1197309133.366,' +
  'AVERAGE,0.00529,VAC,-3,2,5,NORMAL,NONE,1197309141.806';

test('parseAck', () => {
  assert.equal(parseAck('0'), 0);
  assert.equal(parseAck('5'), 5);
  assert.throws(() => parseAck('9'), ProtocolError);
});

test('parseId', () => {
  assert.deepEqual(parseId('FLUKE 289,V1.00,95081087'), {
    model: 'FLUKE 289', firmware: 'V1.00', serial: '95081087',
  });
  assert.throws(() => parseId('garbage'), ProtocolError);
});

test('parseQm', () => {
  assert.deepEqual(parseQm('0.5498E0,VDC,NORMAL,GOOD_DIODE'), {
    value: 0.5498, unit: 'VDC', state: 'NORMAL', attribute: 'GOOD_DIODE',
  });
  const ol = parseQm('+9.99999999E+37,OHM,OL,NONE');
  assert.equal(ol.state, 'OL');
  assert.equal(ol.value, 9.99999999e37);
});

test('parseQdda: simple reading', () => {
  const d = parseQdda(QDDA_LIVE);
  assert.equal(d.primaryFunction, 'MV_AC');
  assert.deepEqual(d.range, { auto: true, baseUnit: 'VAC', number: 50, unitMultiplier: -3 });
  assert.equal(d.lightningBolt, false);
  assert.deepEqual(d.modes, []);
  assert.deepEqual(Object.keys(d.readings), ['LIVE', 'PRIMARY']);
  assert.equal(d.readings.PRIMARY.timestamp, 1197308998.282);
});

test('parseQdda: min/max/avg with a mode', () => {
  const d = parseQdda(QDDA_MINMAX);
  assert.equal(d.secondaryFunction, 'PEAK_MIN_MAX');
  assert.deepEqual(d.modes, ['MIN_MAX_AVG']);
  assert.equal(d.minMaxStartTime, 1197309132.612);
  assert.deepEqual(Object.keys(d.readings), ['LIVE', 'PRIMARY', 'MINIMUM', 'MAXIMUM', 'AVERAGE']);
  assert.equal(d.readings.MINIMUM.value, -0.0211);
});

test('parseQdda: truncated response is rejected', () => {
  assert.throws(() => parseQdda(QDDA_LIVE.slice(0, -20)), ProtocolError);
});

test('formatReading scales by unit multiplier and handles overload', () => {
  const d = parseQdda(QDDA_LIVE);
  assert.deepEqual(formatReading(d.readings.PRIMARY), { text: '5.029', unit: 'mV', coupling: 'AC', ok: true });
  const ol = { ...d.readings.PRIMARY, state: 'OL' };
  assert.equal(formatReading(ol).text, 'OL');
});

test('prettyFunction writes units with the right case', () => {
  assert.equal(prettyFunction('MV_DC'), 'mV DC');
  assert.equal(prettyFunction('MV_AC_OVER_DC'), 'mV AC over DC');
  assert.equal(prettyFunction('UA_DC'), 'µA DC');
  assert.equal(prettyFunction('V_AC'), 'V AC');
  assert.equal(prettyFunction('DIODE_TEST'), 'Diode test');
  assert.equal(prettyFunction('MIN_MAX_AVG'), 'Min max avg');
  assert.equal(prettyFunction('NONE'), '');
});

test('formatBattery keeps the meter wording', () => {
  assert.equal(formatBattery('PARTLY_EMPTY_2'), 'Partly empty (2)');
  assert.equal(formatBattery('FULL'), 'Full');
  assert.equal(formatBattery('EMPTY\r'), 'Empty');
});

test('batteryBlocks maps the meter wording to bars', () => {
  assert.equal(batteryBlocks('FULL'), 4);
  assert.equal(batteryBlocks('PARTLY_EMPTY_2'), 2);
  assert.equal(batteryBlocks('PARTLY_EMPTY_1'), 1);
  assert.equal(batteryBlocks('EMPTY'), 0);
  assert.equal(batteryBlocks('SOMETHING_NEW'), null);
});

test('batteryBars lights the bars from the right, like the meter', () => {
  assert.deepEqual(batteryBars(2), [false, false, true, true]);
  assert.deepEqual(batteryBars(4), [true, true, true, true]);
  assert.deepEqual(batteryBars(0), [false, false, false, false]);
});

test('formatEng / parseEng round-trip axis limits', () => {
  assert.equal(formatEng(0.00503), '5.03m');
  assert.equal(formatEng(1500), '1.5k');
  assert.equal(formatEng(-0.0002), '-200µ');
  assert.equal(formatEng(0), '0');
  assert.equal(parseEng('5m'), 0.005);
  assert.equal(parseEng('1.5k'), 1500);
  assert.equal(parseEng('-2'), -2);
  assert.equal(parseEng('3u'), 3e-6);
  assert.equal(parseEng('3µ'), 3e-6);
  assert.equal(parseEng('2M'), 2e6);
  assert.equal(parseEng('1e-3'), 0.001);
  assert.ok(Number.isNaN(parseEng('abc')));
  assert.ok(Number.isNaN(parseEng('')));
});

test('LineBuffer reassembles replies delivered in fragments', async () => {
  const buf = new LineBuffer();
  // Real serial ports deliver arbitrary chunks; a chunk may hold no complete line.
  const feed = async () => {
    for (const chunk of ['0', '\rFLUKE 2', '87,V1.16,', '14560135\r']) {
      await new Promise((r) => setTimeout(r, 5));
      buf.push(chunk);
    }
  };
  feed();
  assert.equal(await buf.readLine(500), '0');
  assert.equal(await buf.readLine(500), 'FLUKE 287,V1.16,14560135');
});

test('LineBuffer times out and reports errors', async () => {
  const buf = new LineBuffer();
  await assert.rejects(buf.readLine(20), TimeoutError);
  buf.fail(new Error('unplugged'));
  await assert.rejects(buf.readLine(20), /unplugged/);
});

test('Meter talks to the mock meter', async () => {
  const meter = new Meter(new MockTransport());
  assert.equal((await meter.identify()).model, 'FLUKE 287');
  assert.equal((await meter.queryMeasurement()).unit, 'VDC');
  assert.equal((await meter.queryDisplay()).primaryFunction, 'V_DC');
  assert.equal(await meter.queryBattery(), 'PARTLY_EMPTY_2');
  await assert.rejects(meter.command('BOGUS'), MeterError);
  // Concurrent commands are serialized rather than interleaved.
  const [a, b] = await Promise.all([meter.queryDisplay(), meter.queryMeasurement()]);
  assert.ok(a.readings.PRIMARY && b.unit);
});

test('Meter.raw returns every reply line, and bad commands still answer', async () => {
  const meter = new Meter(new MockTransport());
  assert.deepEqual(await meter.raw('ID', { settleMs: 60 }), ['0', 'FLUKE 287,V1.00,00000000']);
  assert.deepEqual(await meter.raw('NOPE', { settleMs: 60 }), ['1']);
});

test('settings helpers: minutes and the meter clock (local time encoded as UTC)', () => {
  assert.equal(secondsToMinutes('900'), 15);
  assert.equal(minutesToSeconds(35), 2100);
  assert.equal(meterClockToText(1789918816), '2026-09-20 15:40:16');
  // Whatever the machine's timezone, syncing shows the same wall-clock time that the computer shows.
  const d = new Date(2026, 8, 20, 9, 5, 7);
  assert.equal(meterClockToText(clockValueFor(d)), '2026-09-20 09:05:07');
  assert.equal(localClockText(d), '2026-09-20 09:05:07');
});

test('Meter reads and writes properties, owner fields and save names', async () => {
  const meter = new Meter(new MockTransport());
  assert.equal(await meter.getProperty('beeper'), 'ON');
  await meter.setProperty('beeper', 'OFF');
  assert.equal(await meter.getProperty('beeper'), 'OFF');
  await assert.rejects(meter.getProperty('nope'), MeterError);
  await assert.rejects(meter.setProperty('lang', 'FRENCH'), MeterError);
  assert.equal(await meter.getOwnerField('company'), 'ACME');
  await meter.setOwnerField('company', 'BVK Sound');
  assert.equal(await meter.getOwnerField('company'), 'BVK Sound');
  await assert.rejects(meter.setOwnerField('company', "O'Neil"), /quotes/);
  assert.equal(await meter.getSaveName(1), 'Site 1');
  await meter.setSaveName(2, 'Bench');
  assert.equal(await meter.getSaveName(2), 'Bench');
  await assert.rejects(meter.getSaveName(7), MeterError);
});
