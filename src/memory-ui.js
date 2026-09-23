// The "Meter memory" panel: reads stored measurements, min/max and peak sessions and recordings from the meter.
import { formatReading, prettyFunction, unitSymbol } from './format.js';
import { MemoryReader } from './memory.js';
import { meterClockToText, meterSecondsToLocalMs } from './settings.js';

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const when = (seconds) => meterClockToText(seconds);

// A stored reading as the meter would have displayed it.
function show(r) {
  if (!r) return '';
  const f = formatReading({ value: r.value, baseUnit: r.unit, unitMultiplier: r.unitMultiplier, decimalPlaces: r.decimals, state: r.state });
  return `${f.text} ${f.unit}${f.coupling ? ` ${f.coupling}` : ''}`.trim();
}

const usable = (r) => (r.state === 'NORMAL' ? r.value : NaN);

// Saved measurements as dots over time (all in the unit most of them share).
export function measurementsTrend(entries) {
  const items = entries.filter((e) => e.item).map((e) => {
    const r = e.item.readings.PRIMARY ?? Object.values(e.item.readings)[0];
    return r && { t: meterSecondsToLocalMs(r.time), v: usable(r), unit: r.unit, state: r.state };
  }).filter(Boolean);
  if (!items.length) return null;
  const counts = new Map();
  items.forEach((i) => counts.set(i.unit, (counts.get(i.unit) ?? 0) + 1));
  const [unit] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const points = items.filter((i) => i.unit === unit).map(({ t, v, state }) => ({ t, v, state }));
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
      state: s.stats.AVERAGE?.state,
      lo: s.stats.MINIMUM ? usable(s.stats.MINIMUM) : NaN,
      hi: s.stats.MAXIMUM ? usable(s.stats.MAXIMUM) : NaN,
    };
  });
  return { title: `Recording "${info.name}": ${samples.length} samples`, unit: unitSymbol(unit), style: 'line', points };
}

// A min/max or peak session as dots: one per stored reading (minimum, maximum, average…), at its own time.
export function sessionTrend(item, label) {
  const readings = Object.values(item.readings);
  if (!readings.length) return null;
  const unit = readings[0].unit;
  const points = readings.filter((r) => r.unit === unit).map((r) => ({ t: meterSecondsToLocalMs(r.time), v: usable(r), state: r.state }));
  return { title: `${label} "${item.name}": ${points.length} readings`, unit: unitSymbol(unit), style: 'points', points };
}

// The memory panel's tables as plain text, one group per table that has entries. Rows keep their `item` (for the
// per-row buttons); `cells` are what is shown, and what a report copy contains.
export function memoryGroups(data) {
  if (!data) return [];
  const primary = (item) => item.readings.PRIMARY ?? Object.values(item.readings)[0];
  const failed = (index, error) => [`${index + 1}`, `could not read: ${error.message}`];
  const readings = (item) => Object.values(item.readings).map((r) => `${r.id.toLowerCase()} ${show(r)}`).join(' \u00b7 ');
  const group = (key, title, columns, list, cellsFor) => ({
    key, title, columns,
    rows: list.map(({ index, item, error }) => ({ item, error, cells: error ? failed(index, error) : cellsFor(index, item) })),
  });
  return [
    group('measurements', 'Saved measurements', ['#', 'Name', 'Time', 'Function', 'Reading'], data.measurements,
      (i, item) => [`${i + 1}`, item.name, when(primary(item)?.time ?? 0), prettyFunction(item.primaryFunction), show(primary(item))]),
    group('minMax', 'Min / max sessions', ['#', 'Name', 'Start', 'End', 'Function', 'Readings'], data.minMax,
      (i, item) => [`${i + 1}`, item.name, when(item.start), when(item.end), prettyFunction(item.primaryFunction), readings(item)]),
    group('peak', 'Peak sessions', ['#', 'Name', 'Start', 'End', 'Function', 'Readings'], data.peak,
      (i, item) => [`${i + 1}`, item.name, when(item.start), when(item.end), prettyFunction(item.primaryFunction), readings(item)]),
    group('recordings', 'Recordings', ['#', 'Name', 'Start', 'End', 'Interval', 'Samples'], data.recordings,
      (i, item) => [`${i + 1}`, item.name, when(item.start), when(item.end), `${item.sampleInterval} s`, `${item.sampleCount}`]),
  ].filter((g) => g.rows.length);
}

// Tables that can be copied straight into a report. A recording's data is in its samples, so a recording goes
// through the graph first (View in graph, then Copy graph to report); its list would only be names and times.
export const REPORTABLE = new Set(['measurements', 'minMax', 'peak']);

// What goes into a report: the text of a group, without the live items behind it.
export const groupForReport = (g) => ({ title: g.title, columns: g.columns, rows: g.rows.map((r) => r.cells) });

export function initMemory({
  counts, message, body, readButton, getMeter, setBusy,
  showTrend = () => {}, graphInfo = () => ({ hasData: false, view: 'live' }),
  onCopy = () => 'Copying to the report is not available', // (groups) => a message saying what happened
}) {
  let reader = null;
  let readerMeter = null;
  let data = null;
  let abort = null;
  const sampleCache = new Map(); // downloaded recording samples, so viewing after downloading (or twice) is instant

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

  // Every table ends in a button column, with all buttons in ordinary body rows so they look and sit the same.
  function table(title, columns, rows) {
    const head = el('tr', {}, ...columns.map((c) => el('th', { textContent: c })));
    const bodyRows = rows.map((cells) => el('tr', {}, ...cells.map((c) => el('td', {}, c))));
    return el('section', { className: 'mem-block' }, el('h4', { textContent: title }),
      el('div', { className: 'mem-scroll' }, el('table', { className: 'has-action' }, el('thead', {}, head), el('tbody', {}, ...bodyRows))));
  }

  function render() {
    body.replaceChildren();
    if (!data) return;
    const { summary, measurements, minMax, peak, recordings } = data;
    if (!summary.measurements && !summary.minMax && !summary.peak && !summary.recordings) {
      body.append(el('p', { className: 'hint', textContent: 'Nothing is stored on the meter. Press Save on the meter (or record a session there), then read again.' }));
      return;
    }
    for (const g of memoryGroups(data)) {
      const copy = REPORTABLE.has(g.key) && el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Copy to report', title: `Adds this table (${g.title}) to the report` });
      if (copy) copy.onclick = () => say(onCopy([groupForReport(g)]));
      const rows = g.rows.map(({ item, error, cells }, i) => {
        if (error) return [cells[0], el('span', { className: 'bad', textContent: cells[1] })];
        // sessions and recordings can be shown in the graph from a button on the row
        if (g.key === 'minMax' || g.key === 'peak') {
          const view = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'View in graph' });
          view.onclick = () => viewSession(item, g.key === 'peak' ? 'Peak session' : 'Min/max session');
          return [...cells, view];
        }
        if (g.key === 'recordings') {
          const view = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'View in graph' });
          view.onclick = () => viewRecording(item, view);
          return [...cells, view];
        }
        return [...cells, i === 0 ? copy : ''];
      });
      // sessions already have a button on every row (and a failed first row can't hold one), so copy gets a row of its own
      if (copy && rows.length && (g.key !== 'measurements' || g.rows[0].error)) rows.push([...g.columns.map(() => ''), copy]);
      body.append(table(g.title, [...g.columns, ''], rows));
    }
  }

  // What the graph is showing now, and what replacing it would discard, spelled out before anything is replaced.
  function confirmReplace(what) {
    const info = graphInfo();
    const lines = [`Show ${what} in the graph?`, '', 'This replaces what the graph is showing now.'];
    if (info.hasData) lines.push('The downloaded data currently in the graph will be discarded.');
    if (info.view === 'live') {
      lines.push('The live view is hidden while this is shown. Live readings keep being collected in the background, and the Live button brings the view back.');
    }
    return confirm(lines.join('\n'));
  }

  // Reads every sample of a recording (or reuses them if already downloaded). `button` turns into Cancel while it runs.
  async function loadSamples(info, button, label, others = []) {
    const meter = getMeter();
    if (!meter) return null;
    const key = `${info.readingIndex}:${info.start}`;
    if (sampleCache.has(key)) return { samples: sampleCache.get(key), cancelled: false };
    abort = new AbortController();
    button.textContent = 'Cancel';
    others.forEach((b) => (b.disabled = true));
    setBusy(true);
    try {
      const samples = await readerFor(meter).recordingSamples(info, {
        signal: abort.signal,
        onProgress: (done, total) => say(`Reading "${info.name}": sample ${done} of ${total}…`),
      });
      const cancelled = abort.signal.aborted;
      if (!cancelled) sampleCache.set(key, samples);
      return { samples, cancelled };
    } catch (e) {
      say(`Reading "${info.name}" failed: ${e.message}`, true);
      return null;
    } finally {
      abort = null;
      button.textContent = label;
      others.forEach((b) => (b.disabled = false));
      setBusy(false);
    }
  }

  // Plots a recording in the graph, after a warning; samples are read first if they have not been downloaded yet.
  async function viewRecording(info, button) {
    if (abort) return abort.abort();
    if (!confirmReplace(`the recording "${info.name}"`)) return;
    const result = await loadSamples(info, button, 'View in graph');
    if (!result?.samples.length) return;
    showTrend(recordingTrend(info, result.samples));
    say(`${result.cancelled ? 'Showing the first' : 'Showing'} ${result.samples.length} of ${info.sampleCount} samples in the graph`);
  }

  function viewSession(item, label) {
    const trend = sessionTrend(item, label);
    if (!trend || !confirmReplace(`the ${label.toLowerCase()} "${item.name}"`)) return;
    showTrend(trend);
    say(`Showing the ${label.toLowerCase()} in the graph`);
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
      say(`Done: ${summaryText(summary)}`);
    } catch (e) {
      say(`Could not read memory: ${e.message}`, true);
    } finally {
      readButton.disabled = false;
      setBusy(false);
    }
  }

  readButton.onclick = readAll;

  return {
    loadSummary,
    reset() {
      data = null;
      reader = readerMeter = null;
      body.replaceChildren();
      counts.textContent = '';
      sampleCache.clear();
      say('');
    },
  };
}
