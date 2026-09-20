// The "Meter memory" panel: reads stored measurements, min/max and peak sessions and recordings from the meter.
import { toCsv } from './csv.js';
import { formatReading, prettyFunction, unitSymbol } from './format.js';
import { MemoryReader } from './memory.js';
import { meterClockToText, meterSecondsToLocalMs } from './settings.js';

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const when = (seconds) => meterClockToText(seconds);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const safe = (name) => name.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'recording';

// A stored reading as the meter would have displayed it.
function show(r) {
  if (!r) return '';
  const f = formatReading({ value: r.value, baseUnit: r.unit, unitMultiplier: r.unitMultiplier, decimalPlaces: r.decimals, state: r.state });
  return `${f.text} ${f.unit}${f.coupling ? ` ${f.coupling}` : ''}`.trim();
}

function download(filename, text) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}

const usable = (r) => (r.state === 'NORMAL' ? r.value : NaN);

// Saved measurements as dots over time (all in the unit most of them share).
export function measurementsTrend(entries) {
  const items = entries.filter((e) => e.item).map((e) => {
    const r = e.item.readings.PRIMARY ?? Object.values(e.item.readings)[0];
    return r && { t: meterSecondsToLocalMs(r.time), v: usable(r), unit: r.unit };
  }).filter(Boolean);
  if (!items.length) return null;
  const counts = new Map();
  items.forEach((i) => counts.set(i.unit, (counts.get(i.unit) ?? 0) + 1));
  const [unit] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const points = items.filter((i) => i.unit === unit).map(({ t, v }) => ({ t, v }));
  const skipped = items.length - points.length;
  return {
    title: `Saved measurements: ${points.length}${skipped ? ` (${skipped} in other units not shown)` : ''}`,
    unit: unitSymbol(unit),
    style: 'points',
    points,
  };
}

// A recording as its average over time, with the min/max of each interval as a band.
export function recordingTrend(info, samples) {
  const unit = samples[0].stats.AVERAGE?.unit ?? samples[0].primary.PRIMARY?.unit ?? '';
  const points = samples.map((s) => {
    const ok = s.stats.AVERAGE?.state === 'NORMAL' && Number.isFinite(s.average);
    return {
      t: meterSecondsToLocalMs(s.start),
      v: ok ? s.average : NaN,
      lo: s.stats.MINIMUM ? usable(s.stats.MINIMUM) : NaN,
      hi: s.stats.MAXIMUM ? usable(s.stats.MAXIMUM) : NaN,
    };
  });
  return { title: `Recording "${info.name}": ${samples.length} samples`, unit: unitSymbol(unit), style: 'line', points };
}

export function initMemory({ counts, message, body, readButton, csvButton, getMeter, setBusy, showTrend = () => {} }) {
  let reader = null;
  let readerMeter = null;
  let data = null;
  let abort = null;

  const say = (text, bad = false) => {
    message.textContent = text;
    message.classList.toggle('bad', bad);
  };

  function readerFor(meter) {
    if (readerMeter !== meter) {
      reader = new MemoryReader(meter);
      readerMeter = meter;
    }
    return reader;
  }

  const summaryText = (s) =>
    `${s.measurements} saved · ${s.minMax} min/max · ${s.peak} peak · ${s.recordings} recording${s.recordings === 1 ? '' : 's'}`;

  function table(title, columns, rows) {
    const head = el('tr', {}, ...columns.map((c) => el('th', { textContent: c })));
    const bodyRows = rows.map((cells) => el('tr', {}, ...cells.map((c) => el('td', {}, c))));
    return el('section', { className: 'mem-block' }, el('h4', { textContent: title }),
      el('div', { className: 'mem-scroll' }, el('table', {}, el('thead', {}, head), el('tbody', {}, ...bodyRows))));
  }

  function render() {
    body.replaceChildren();
    if (!data) return;
    const { summary, measurements, minMax, peak, recordings } = data;
    if (!summary.measurements && !summary.minMax && !summary.peak && !summary.recordings) {
      body.append(el('p', { className: 'hint', textContent: 'Nothing is stored on the meter. Press Save on the meter (or record a session there), then read again.' }));
      return;
    }
    const failed = (e) => [el('span', { className: 'bad', textContent: `could not read: ${e.message}` })];

    if (measurements.length) {
      body.append(table('Saved measurements', ['#', 'Name', 'Time', 'Function', 'Reading'],
        measurements.map(({ index, item, error }) => (error ? [`${index + 1}`, ...failed(error)]
          : [`${index + 1}`, item.name, when((item.readings.PRIMARY ?? Object.values(item.readings)[0])?.time ?? 0),
            prettyFunction(item.primaryFunction), show(item.readings.PRIMARY ?? Object.values(item.readings)[0])]))));
    }
    for (const [title, list] of [['Min / max sessions', minMax], ['Peak sessions', peak]]) {
      if (!list.length) continue;
      body.append(table(title, ['#', 'Name', 'Start', 'End', 'Function', 'Readings'],
        list.map(({ index, item, error }) => (error ? [`${index + 1}`, ...failed(error)]
          : [`${index + 1}`, item.name, when(item.start), when(item.end), prettyFunction(item.primaryFunction),
            Object.values(item.readings).map((r) => `${r.id.toLowerCase()} ${show(r)}`).join(' · ')]))));
    }
    if (recordings.length) {
      body.append(table('Recordings', ['#', 'Name', 'Start', 'End', 'Interval', 'Samples', ''],
        recordings.map(({ index, item, error }) => {
          if (error) return [`${index + 1}`, ...failed(error)];
          const button = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Download samples' });
          button.onclick = () => downloadRecording(item, button);
          return [`${index + 1}`, item.name, when(item.start), when(item.end), `${item.sampleInterval} s`, `${item.sampleCount}`, button];
        })));
    }
  }

  async function downloadRecording(info, button) {
    const meter = getMeter();
    if (!meter) return;
    if (abort) {
      abort.abort();
      return;
    }
    abort = new AbortController();
    button.textContent = 'Cancel';
    setBusy(true);
    try {
      const samples = await readerFor(meter).recordingSamples(info, {
        signal: abort.signal,
        onProgress: (done, total) => say(`Reading "${info.name}": sample ${done} of ${total}…`),
      });
      const cancelled = abort.signal.aborted;
      const rows = samples.map((s, i) => [i + 1, when(s.start), when(s.end), s.count, s.recordType, s.stable,
        s.primary.PRIMARY?.value, s.stats.MAXIMUM?.value, s.average, s.stats.MINIMUM?.value, s.primary.PRIMARY?.unit]);
      if (samples.length) showTrend(recordingTrend(info, samples));
      if (rows.length) {
        download(`fluke287-${safe(info.name)}-${stamp()}.csv`,
          toCsv(['sample', 'start', 'end', 'readings', 'type', 'stable', 'primary', 'maximum', 'average', 'minimum', 'unit'], rows));
      }
      say(`${cancelled ? 'Cancelled after' : 'Saved'} ${rows.length} of ${info.sampleCount} samples`);
    } catch (e) {
      say(`Recording download failed: ${e.message}`, true);
    } finally {
      abort = null;
      button.textContent = 'Download samples';
      setBusy(false);
    }
  }

  // Reading the counts is one quick command, so it runs on connect.
  async function loadSummary() {
    const meter = getMeter();
    if (!meter) return;
    try {
      counts.textContent = summaryText(await readerFor(meter).summary());
    } catch {
      counts.textContent = 'memory not available';
    }
  }

  async function readAll() {
    const meter = getMeter();
    if (!meter) return;
    const r = readerFor(meter);
    readButton.disabled = true;
    setBusy(true);
    try {
      say('Reading memory…');
      const summary = await r.summary();
      counts.textContent = summaryText(summary);
      const result = { summary, measurements: [], minMax: [], peak: [], recordings: [] };
      const kinds = [
        ['measurements', 'saved measurements', summary.measurements, (i) => r.savedMeasurement(i)],
        ['minMax', 'min/max sessions', summary.minMax, (i) => r.minMax(i)],
        ['peak', 'peak sessions', summary.peak, (i) => r.peak(i)],
        ['recordings', 'recordings', summary.recordings, (i) => r.recording(i)],
      ];
      for (const [key, label, count, read] of kinds) {
        for (let i = 0; i < count; i++) {
          say(`Reading ${label}: ${i + 1} of ${count}…`);
          try {
            result[key].push({ index: i, item: await read(i) });
          } catch (e) {
            result[key].push({ index: i, error: e });
          }
        }
      }
      data = result;
      render();
      const trend = measurementsTrend(result.measurements);
      if (trend) showTrend(trend);
      csvButton.disabled = !(result.measurements.length || result.minMax.length || result.peak.length);
      say(`Done: ${summaryText(summary)}`);
    } catch (e) {
      say(`Could not read memory: ${e.message}`, true);
    } finally {
      readButton.disabled = false;
      setBusy(false);
    }
  }

  // One row per stored reading, for the items that hold values directly (recordings have their own download).
  function exportCsv() {
    if (!data) return;
    const rows = [];
    const add = (kind, { index, item }) => {
      if (!item) return;
      for (const r of Object.values(item.readings)) {
        rows.push([kind, index + 1, item.name, when(item.start ?? r.time), item.end ? when(item.end) : '',
          item.primaryFunction, r.id, r.value, r.unit, r.state]);
      }
    };
    data.measurements.forEach((m) => add('measurement', m));
    data.minMax.forEach((m) => add('minmax', m));
    data.peak.forEach((m) => add('peak', m));
    download(`fluke287-memory-${stamp()}.csv`,
      toCsv(['kind', 'index', 'name', 'start', 'end', 'function', 'reading', 'value_base_units', 'unit', 'state'], rows));
  }

  readButton.onclick = readAll;
  csvButton.onclick = exportCsv;

  return {
    loadSummary,
    reset() {
      data = null;
      reader = readerMeter = null;
      body.replaceChildren();
      counts.textContent = '';
      csvButton.disabled = true;
      say('');
    },
  };
}
