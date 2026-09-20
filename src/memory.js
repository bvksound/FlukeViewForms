// Reads what the meter has stored: saved measurements, min/max and peak sessions, and recordings.
// Read-only. Nothing here can erase or change the meter's memory.
import { ProtocolError } from './protocol.js';
import {
  RECORDING_SAMPLE_SIZE, parseMap, parseMinMaxPeak, parseRecordingInfo, parseRecordingSample, parseSavedMeasurement,
  u16,
} from './records.js';

// Value maps the record decoders need; fetched once per connection with QEMAP.
export const MAP_NAMES = [
  'readingid', 'unit', 'state', 'attribute', 'primfunction', 'secfunction', 'autorange', 'bolt', 'mode',
  'recordtype', 'isstableflag', 'transientstate',
];

const bytesFor = (head, perReading, count) => head + perReading * count;

export class MemoryReader {
  #meter;
  #maps = new Map();

  constructor(meter) {
    this.#meter = meter;
  }

  // Unknown ids show as "#7" rather than failing a whole download over one new value.
  lookup = (mapName, id) => this.#maps.get(mapName)?.get(String(id)) ?? `#${id}`;

  async loadMaps() {
    for (const name of MAP_NAMES) {
      if (!this.#maps.has(name)) this.#maps.set(name, parseMap((await this.#meter.command(`QEMAP ${name}`)).trim()));
    }
  }

  // QSLS -> how many of each kind are stored.
  async summary() {
    const fields = (await this.#meter.command('QSLS')).trim().split(',').map(Number);
    if (fields.length !== 4 || fields.some((n) => !Number.isInteger(n) || n < 0)) {
      throw new ProtocolError('Unexpected QSLS reply');
    }
    const [recordings, minMax, peak, measurements] = fields;
    return { recordings, minMax, peak, measurements };
  }

  // Each of these takes a 0-based index.
  async savedMeasurement(index) {
    await this.loadMaps();
    const payload = await this.#meter.commandBinary(`QSMR ${index}`, {
      isComplete: (b) => b.length >= 38 && b.length >= bytesFor(38, 30, u16(b, 36)),
    });
    return parseSavedMeasurement(payload, this.lookup);
  }

  async minMax(index) {
    return this.#session('QMMSI', index, 'minmax');
  }

  async peak(index) {
    return this.#session('QPSI', index, 'peak');
  }

  async #session(command, index, kind) {
    await this.loadMaps();
    const payload = await this.#meter.commandBinary(`${command} ${index}`, {
      isComplete: (b) => b.length >= 54 && b.length >= bytesFor(54, 30, u16(b, 52)),
    });
    return parseMinMaxPeak(payload, this.lookup, kind);
  }

  async recording(index) {
    await this.loadMaps();
    const payload = await this.#meter.commandBinary(`QRSI ${index}`, {
      isComplete: (b) => b.length >= 78 && b.length >= bytesFor(78, 30, u16(b, 76)),
    });
    return parseRecordingInfo(payload, this.lookup);
  }

  // All samples of a recording, one QSRR each. Long recordings take a while over the IR link, so this reports
  // progress and stops cleanly when `signal` is aborted, returning what it has.
  async recordingSamples(info, { onProgress = () => {}, signal } = {}) {
    await this.loadMaps();
    const samples = [];
    for (let i = 0; i < info.sampleCount; i++) {
      if (signal?.aborted) break;
      const payload = await this.#meter.commandBinary(`QSRR ${info.readingIndex},${i}`, {
        isComplete: (b) => b.length === RECORDING_SAMPLE_SIZE,
      });
      samples.push(parseRecordingSample(payload, this.lookup));
      onProgress(i + 1, info.sampleCount);
    }
    return samples;
  }
}
