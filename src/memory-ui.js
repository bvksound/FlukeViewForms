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

export function initMemory({
  counts, message, body, readButton, viewButton, getMeter, setBusy,
  showTrend = () => {}, graphInfo = () => ({ hasData: false, view: 'live' }),
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
      const label = title.startsWith('Peak') ? 'Peak session' : 'Min/max session';
      body.append(table(title, ['#', 'Name', 'Start', 'End', 'Function', 'Readings', ''],
        list.map(({ index, item, error }) => {
          if (error) return [`${index + 1}`, ...failed(error)];
          const view = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'View in graph' });
          view.onclick = () => viewSession(item, label);
          return [`${index + 1}`, item.name, when(item.start), when(item.end), prettyFunction(item.primaryFunction),
            Object.values(item.readings).map((r) => `${r.id.toLowerCase()} ${show(r)}`).join(' · '), view];
        })));
    }
    if (recordings.length) {
      body.append(table('Recordings', ['#', 'Name', 'Start', 'End', 'Interval', 'Samples', ''],
        recordings.map(({ index, item, error }) => {
          if (error) return [`${index + 1}`, ...failed(error)];
          const view = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'View in graph' });
          view.onclick = () => viewRecording(item, view);
          return [`${index + 1}`, item.name, when(item.start), when(item.end), `${item.sampleInterval} s`, `${item.sampleCount}`, view];
        })));
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

  function viewMeasurements() {
    const trend = data && measurementsTrend(data.measurements);
    if (!trend || !confirmReplace('the saved measurements')) return;
    showTrend(trend);
    say('Showing the saved measurements in the graph');
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
      viewButton.disabled = !measurementsTrend(result.measurements);
      say(`Done: ${summaryText(summary)}`);
    } catch (e) {
      say(`Could not read memory: ${e.message}`, true);
    } finally {
      readButton.disabled = false;
      setBusy(false);
    }
  }

  readButton.onclick = readAll;
  viewButton.onclick = viewMeasurements;

  return {
    loadSummary,
    reset() {
      data = null;
      reader = readerMeter = null;
      body.replaceChildren();
      counts.textContent = '';
      viewButton.disabled = true;
      sampleCache.clear();
      say('');
    },
  };
}
