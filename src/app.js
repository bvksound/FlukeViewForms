import { batteryBars, batteryBlocks, batteryLevel, formatBattery, formatEng, formatReading, parseEng, prettyFunction, unitSymbol } from './format.js';
import { LiveGraph } from './graph.js';
import { localTimestamp, pointsToTable, pointsToText } from './graph-text.js';
import { toCsv } from './csv.js';
import { initForms } from './forms-ui.js';
import { initMemory } from './memory-ui.js';
import { ReadingsStore } from './readings.js';
import { initReadings } from './readings-ui.js';
import { Meter, MeterError } from './meter.js';
import { initSettings } from './settings-ui.js';
import { TemplateStore } from './templates.js';
import { WebSerialTransport } from './transport.js';

const $ = (id) => document.getElementById(id);

let meter = null;
let polling = false;
let failures = 0;
let connectedLabel = ''; // what the status shows while all is well, restored after a "No reply" warning

let dataTitle = '';
let liveZoom = '40';

// Reflects which dataset the graph shows: live buffer or downloaded memory data.
function showGraphView(view) {
  const data = view === 'data';
  $('viewLive').setAttribute('aria-pressed', String(!data));
  $('viewData').setAttribute('aria-pressed', String(data));
  $('viewData').disabled = !graph.hasData;
  $('dataHint').hidden = graph.hasData;
  $('live').disabled = data ? false : graph.following;
  $('zoom').value = data ? 'fit' : liveZoom;
  $('graphTitle').textContent = data ? dataTitle : 'Reading over time';
  $('graphCount').textContent = data ? `${graph.length} points` : `${graph.length} samples`;
}

// The selection between the cursors, spelled out so it is clear what an export will contain.
function showCursorInfo(info) {
  $('cursorRow').hidden = !info;
  if (!info) return;
  const at = (ms, open) => (ms == null ? open : localTimestamp(ms).slice(info.spanMs > 86_400_000 ? 5 : 11, 19));
  $('cursorInfo').textContent =
    `Selection ${at(info.start, 'start')} – ${at(info.end, 'end')} · ${info.count} of ${info.total} points. Exports use only these.`;
}

const graph = new LiveGraph({
  scroll: $('graphScroll'),
  inner: $('graphInner'),
  canvas: $('graph'),
  onFollowChange: (following) => {
    if (graph.view === 'live') $('live').disabled = following;
  },
  onViewChange: (view) => showGraphView(view),
  onCursorChange: (info) => showCursorInfo(info),
  onRangeChange: (min, max, auto) => {
    $('yAuto').setAttribute('aria-pressed', String(auto));
    // Don't overwrite a limit while the user is typing it.
    if (document.activeElement !== $('yMin')) $('yMin').value = formatEng(min);
    if (document.activeElement !== $('yMax')) $('yMax').value = formatEng(max);
  },
});

if (!WebSerialTransport.supported) {
  $('notice').style.display = 'block';
  $('connect').disabled = true;
  $('choose').disabled = true;
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

function setConnected(connected) {
  $('connect').disabled = connected || !WebSerialTransport.supported;
  $('choose').disabled = connected || !WebSerialTransport.supported;
  $('disconnect').disabled = !connected;
  document.body.classList.toggle('connected', connected);
  $('settingsState').textContent = connected ? '' : 'meter settings need a connection';
  $('memoryCard').hidden = !connected;
  document.querySelectorAll('.needs-meter').forEach((el) => (el.disabled = !connected));
  $('readout').classList.toggle('stale', !connected);
}

// Memory reads share the IR link with the live polling, so polling pauses while they run.
let paused = false;
let lastReading = null; // the reading on the display right now, for the report's readings table
let meterInfo = null; // model, firmware, serial and owner fields of the last meter connected, for reports
const memory = initMemory({
  counts: $('memoryCounts'),
  message: $('memoryMsg'),
  body: $('memoryBody'),
  readButton: $('memoryRead'),
  viewButton: $('memoryView'),
  graphInfo: () => ({ hasData: graph.hasData, view: graph.view }),
  getMeter: () => meter,
  setBusy: (busy) => (paused = busy),
  showTrend: ({ title, unit, style, points }) => {
    dataTitle = title;
    graph.setData({ points, unit, style });
  },
});

const settings = initSettings({
  containers: {
    display: $('setDisplay'), power: $('setPower'), measure: $('setMeasure'), owner: $('setOwner'), slots: $('setSlots'),
  },
  message: $('settingsMsg'),
  getMeter: () => meter,
});

let connecting = false;

async function connect({ choose = false } = {}) {
  if (connecting || meter) return;
  connecting = true;
  try {
    const candidate = new Meter(await WebSerialTransport.request({ choose }));
    setStatus('Connecting…', 'warn');
    try {
      const id = await candidate.identify();
      meter = candidate;
      failures = 0;
      graph.clear();
      connectedLabel = `${id.model} · ${id.firmware} · S/N ${id.serial}`;
      setStatus(connectedLabel, 'ok');
      setConnected(true);
      poll();
      settings.load();
      memory.loadSummary();
      loadMeterInfo(id, candidate);
    } catch (e) {
      await candidate.close();
      throw e;
    }
  } catch (e) {
    console.error(e);
    meter = null;
    if (e.name === 'NotFoundError') {
      setStatus('No serial port selected');
    } else {
      setStatus(`Could not connect: ${e.message || e.name}`, 'bad');
    }
  } finally {
    connecting = false;
  }
}

async function loadMeterInfo(id, m) {
  meterInfo = { model: id.model, firmware: id.firmware, serial: id.serial, owner: {} };
  for (const field of ['company', 'site', 'operator', 'contact']) {
    try {
      meterInfo.owner[field] = await m.getOwnerField(field);
    } catch {
      break; // an older meter without these: the report just leaves them out
    }
  }  try {
    meterInfo.calibrationCounter = await m.queryCalibrationCounter();
    meterInfo.calibrationVersion = await m.queryCalibrationVersion();
  } catch {
    /* a meter without them: left out */
  }
  showMeterInfo();
}

// Read-only facts about the meter, at the top of Settings > Meter.
function showMeterInfo() {
  const i = meterInfo;
  const rows = i ? [['Model', i.model], ['Serial number', i.serial], ['Firmware', i.firmware], ['Calibration counter', i.calibrationCounter != null ? String(i.calibrationCounter) : 'not available'], ['Calibration version', i.calibrationVersion || 'not available']] : [];
  $('setInfo').replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'set-row';
    const l = document.createElement('label');
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'set-value';
    v.textContent = value;
    row.append(l, v, document.createElement('span'));
    return row;
  }));
}

async function disconnect(message = 'Not connected', kind = '') {
  polling = false;
  lastReading = null;
  const m = meter;
  meter = null;
  await m?.close();
  setConnected(false);
  $('battery').hidden = true;
  settings.reset();
  memory.reset();
  setStatus(message, kind);
}

const BATTERY_EVERY_MS = 30_000;
let batteryChecked = 0;
let batterySupported = true;

const SVG = 'http://www.w3.org/2000/svg';

// Draws the meter's own symbol: outline with the terminal on the left and four bars, `filled` of them lit.
function batteryIcon(filled) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 34 16');
  svg.setAttribute('aria-hidden', 'true');
  const rect = (x, y, w, h, attrs) => {
    const r = document.createElementNS(SVG, 'rect');
    Object.entries({ x, y, width: w, height: h, ...attrs }).forEach(([k, v]) => r.setAttribute(k, v));
    svg.append(r);
  };
  rect(0, 5, 3, 6, { rx: 1, fill: 'currentColor' }); // terminal
  rect(4.75, 0.75, 28.5, 14.5, { rx: 2.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 });
  batteryBars(filled).forEach((lit, i) => {
    rect(8 + i * 6, 4, 4, 8, { rx: 0.8, fill: 'currentColor', opacity: lit ? 1 : 0.15 });
  });
  return svg;
}

// The meter words the level itself (FULL, PARTLY_EMPTY_2, EMPTY…). Known wording becomes bars; anything else shows as text.
async function updateBattery() {
  batteryChecked = Date.now();
  try {
    const code = await meter.queryBattery();
    const bars = batteryBlocks(code);
    const el = $('battery');
    el.hidden = false;
    el.dataset.level = batteryLevel(bars) ?? '';
    el.title = `Battery: ${formatBattery(code)}${bars === null ? '' : ` (${bars} of 4 bars)`}`;
    el.setAttribute('aria-label', el.title);
    el.replaceChildren(bars === null ? `Battery: ${formatBattery(code)}` : batteryIcon(bars));
  } catch (e) {
    if (e instanceof MeterError) batterySupported = false; // older firmware without QBL: stop asking
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  batteryChecked = 0;
  batterySupported = true;
  while (polling && meter) {
    if (paused) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    const started = performance.now();
    try {
      render(await meter.queryDisplay());
      if (failures) setStatus(connectedLabel, 'ok'); // the meter answers again: clear the "No reply" warning
      if (batterySupported && Date.now() - batteryChecked > BATTERY_EVERY_MS) await updateBattery();
      failures = 0;
    } catch (e) {
      // A dropped reply is normal when the meter is off or the IR path is blocked; give up after a few.
      if (++failures >= 4) return disconnect(`Lost meter: ${e.message}`, 'bad');
      setStatus(`No reply (${failures}/4)…`, 'warn');
    }
    const wait = Number($('interval').value) - (performance.now() - started);
    await new Promise((r) => setTimeout(r, Math.max(0, wait)));
  }
}

function render(d) {
  const main = d.readings.PRIMARY ?? d.readings.LIVE;
  if (!main) return;
  const f = formatReading(main);
  lastReading = {
    t: Date.now(), function: prettyFunction(d.primaryFunction), text: `${f.text} ${f.unit}`.trim(),
    value: main.value, unit: unitSymbol(main.baseUnit), state: main.state,
  };
  $('value').textContent = f.text;
  $('unit').textContent = f.unit;
  $('coupling').textContent = f.coupling;
  $('func').textContent = prettyFunction(d.primaryFunction);
  $('miniValue').textContent = `${f.text} ${f.unit} ${f.coupling}`.trim();
  $('navValue').textContent = $('miniValue').textContent;
  $('modes').textContent = d.modes.map(prettyFunction).join(' · ');

  const sec = d.readings.SECONDARY;
  $('secondary').textContent = sec
    ? `${prettyFunction(d.secondaryFunction)} ${formatReading(sec).text} ${formatReading(sec).unit}`
    : prettyFunction(d.secondaryFunction);

  $('stats').replaceChildren(
    ...['MINIMUM', 'MAXIMUM', 'AVERAGE'].filter((k) => d.readings[k]).map((k) => {
      const s = formatReading(d.readings[k]);
      const box = document.createElement('div');
      const label = document.createElement('small');
      label.textContent = k.toLowerCase();
      box.append(label, `${s.text} ${s.unit}`);
      return box;
    }),
  );

  // The graph plots base units (V, A, Ω…) so a range change doesn't jump the trace.
  const now = Date.now();
  graph.add(now, main.state === 'NORMAL' ? main.value : NaN, unitSymbol(main.baseUnit), main.state);
  $('yUnit').textContent = unitSymbol(main.baseUnit);
  if (graph.view === 'live') {
    $('graphTitle').textContent = `${prettyFunction(d.primaryFunction)} over time`;
    $('graphCount').textContent = `${graph.length} samples`;
  }
}

$('connect').onclick = () => connect();
$('choose').onclick = () => connect({ choose: true });
$('disconnect').onclick = () => disconnect();
$('zoom').onchange = (e) => {
  if (graph.view === 'live') liveZoom = e.target.value;
  graph.setScale(e.target.value === 'fit' ? 'fit' : Number(e.target.value));
};
$('live').onclick = () => (graph.view === 'data' ? graph.showLive() : graph.jumpToLive());
$('viewLive').onclick = () => graph.showLive();
$('viewData').onclick = () => graph.showData();
$('clearGraph').onclick = clearGraph;
$('graphToReport').onclick = copyGraphToReport;
$('cursorClear').onclick = () => graph.clearCursors();

$('yAuto').onclick = () => graph.setYAuto();
$('yIn').onclick = () => graph.zoomY(1 / 1.5);
$('yOut').onclick = () => graph.zoomY(1.5);
const applyYLimits = () => {
  const min = parseEng($('yMin').value);
  const max = parseEng($('yMax').value);
  if (min < max) graph.setYRange(min, max);
  else {
    // Not a valid range: put the real one back.
    const { min: a, max: b } = graph.yRange;
    $('yMin').value = formatEng(a);
    $('yMax').value = formatEng(b);
  }
};
$('yMin').onchange = applyYLimits;
$('yMax').onchange = applyYLimits;

// Already-granted meter: connect without waiting for a click, and again whenever the cable is plugged in.
if (WebSerialTransport.supported) {
  WebSerialTransport.grantedPorts().then((ports) => ports.length && connect());
  navigator.serial.addEventListener('connect', () => connect());
}

// Advanced: documented setup commands (confirm first) and a raw command box.
async function runSetup(label, action, confirmText) {
  if (!meter || (confirmText && !confirm(confirmText))) return;
  const result = $('advResult');
  try {
    await action(meter);
    result.textContent = `${label}: done`;
  } catch (e) {
    result.textContent = `${label}: ${e.message}`;
  }
}
$('advDS').onclick = () => runSetup('Default setup', (m) => m.defaultSetup(), 'Reset the Hz trigger edge, pulse polarity and continuity beeper to defaults?');
$('advRMP').onclick = () => runSetup('Reset meter properties', (m) => m.resetMeterProperties(), 'Reset the meter properties, like Reset Setup on the meter? Your current settings will be lost.');
$('advRI').onclick = () => runSetup('Reset instrument', (m) => m.resetInstrument(), 'Restore ALL meter settings to factory defaults? Calibration is kept, other settings are lost.');

$('rawForm').onsubmit = async (e) => {
  e.preventDefault();
  const cmd = $('rawCmd').value.trim();
  if (!cmd || !meter) return;
  const log = $('rawLog');
  log.hidden = false;
  const append = (text) => {
    log.textContent = `${log.textContent}${text}\n`.split('\n').slice(-200).join('\n');
    log.scrollTop = log.scrollHeight;
  };
  append(`> ${cmd}`);
  try {
    const lines = await meter.raw(cmd);
    lines.forEach((l) => append(`< ${l}`));
  } catch (err) {
    append(`! ${err.message}`);
  }
  $('rawCmd').select();
};

// Export / copy the graph as an image. JPG downloads; the clipboard only takes PNG.
let graphMsgTimer;
function graphMessage(text) {
  $('graphMsg').textContent = text;
  clearTimeout(graphMsgTimer);
  graphMsgTimer = setTimeout(() => ($('graphMsg').textContent = ''), 4000);
}

function graphImage() {
  const canvas = graph.exportCanvas({
    title: $('graphTitle').textContent,
    subtitle: [$('status').textContent.startsWith('FLUKE') ? $('status').textContent : '', new Date().toLocaleDateString(),
      graph.hasCursors ? 'between the cursors' : '']
      .filter(Boolean)
      .join('  ·  '),
  });
  if (!canvas) graphMessage('Nothing to export yet');
  return canvas;
}

// Everything is exported and copied from the graph's right-click menu, for whatever the graph shows
// (live, or downloaded from the meter's memory).
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const fileStem = () => `fluke287-${$('graphTitle').textContent.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'graph'}`;

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportJpg() {
  graphImage()?.toBlob((blob) => {
    saveBlob(blob, `${fileStem()}-${stamp()}.jpg`);
    graphMessage(`Saved JPG${graph.hasCursors ? ' (between the cursors)' : ''}`);
  }, 'image/jpeg', 0.92);
}

// Every point of what the graph shows (not just the visible part): time, value, and min/max or state when present.
function exportCsv() {
  const points = graph.selectedPoints(); // between the cursors when they are set, otherwise everything
  if (!points.length) return graphMessage('Nothing to export yet');
  const { header, rows } = pointsToTable(points, graph.unit);
  saveBlob(new Blob([toCsv(header, rows)], { type: 'text/csv' }), `${fileStem()}-${stamp()}.csv`);
  graphMessage(`Saved CSV with ${points.length} points${graph.hasCursors ? ' (between the cursors)' : ''}`);
}

async function copyImage() {
  const canvas = graphImage();
  if (!canvas) return;
  try {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png')); // the clipboard only takes PNG
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    graphMessage(`Copied image to clipboard${graph.hasCursors ? ' (between the cursors)' : ''}`);
  } catch (e) {
    graphMessage(`Could not copy: ${e.message}`);
  }
}

// x,y values as tab-separated text (time in local time, value in base units).
async function copyValues(all) {
  // `all` = everything, or the cursor selection when cursors are set. Otherwise the part on screen.
  const points = all || graph.hasCursors ? graph.selectedPoints() : graph.visiblePoints();
  if (!points.length) return graphMessage('Nothing to copy yet');
  try {
    await navigator.clipboard.writeText(pointsToText(points, graph.unit));
    graphMessage(`Copied ${points.length} x,y values${graph.hasCursors ? ' (between the cursors)' : ''}`);
  } catch (e) {
    graphMessage(`Could not copy: ${e.message}`);
  }
}

// Adds the graph (its cursor window, if set) to the report and says so under the graph.
async function copyGraphToReport() {
  graphMessage(await forms.copyGraph());
}

function clearGraph() {
  graph.clear(); // in the downloaded view this drops that dataset and returns to live
  showGraphView(graph.view);
  $('graphCount').textContent = '';
}

function fitAll() {
  $('zoom').value = 'fit';
  $('zoom').dispatchEvent(new Event('change'));
}

// The menu is built each time it opens, so counts and availability are current.
function menuItems(timeHere) {
  const total = graph.allPoints().length;
  const visible = graph.visiblePoints().length;
  const has = total > 0;
  const cursors = graph.hasCursors;
  const selected = graph.selectedPoints().length;
  const pts = (n) => `${n} point${n === 1 ? '' : 's'}`;
  const scope = cursors ? `${selected} of ${total} points` : pts(total); // what Export / Copy-all will contain
  return [
    { group: 'Export' },
    { label: 'Export CSV', note: scope, enabled: selected > 0, run: exportCsv },
    { label: 'Export JPG image', note: cursors ? 'between cursors' : 'visible area', enabled: selected > 0, run: exportJpg },
    { group: 'Copy' },
    // With cursors set, every export and copy follows the selection, so there is one values item, not two.
    ...(cursors
      ? [{ label: 'Copy selected x,y values', note: scope, enabled: selected > 0, run: () => copyValues(true) }]
      : [
        { label: 'Copy visible x,y values', note: pts(visible), enabled: visible > 0, run: () => copyValues(false) },
        { label: 'Copy all x,y values', note: scope, enabled: has, run: () => copyValues(true) },
      ]),
    { label: 'Copy image', note: cursors ? 'between cursors' : 'visible area', enabled: selected > 0, run: copyImage },
    { label: 'Copy graph to report', note: scope, enabled: selected > 0, run: copyGraphToReport },
    { group: 'Cursors' },
    { label: 'Place start cursor here', enabled: has && timeHere != null, run: () => graph.placeCursor('start', timeHere) },
    { label: 'Place end cursor here', enabled: has && timeHere != null, run: () => graph.placeCursor('end', timeHere) },
    cursors
      ? { label: 'Remove cursors', enabled: true, run: () => graph.clearCursors() }
      : { label: 'Add cursors', enabled: total > 1, run: () => graph.addCursors() },
    { group: 'Graph' },
    graph.view === 'data'
      ? { label: 'Show live trace', enabled: true, run: () => graph.showLive() }
      : { label: 'Jump to live', enabled: !graph.following, run: () => graph.jumpToLive() },
    { label: 'Fit all in view', enabled: has, run: fitAll },
    { label: 'Auto Y axis', enabled: !graph.autoY, run: () => graph.setYAuto() },
    { label: 'Clear graph', enabled: true, run: clearGraph },
  ];
}

const menu = $('graphMenu');
const closeMenu = () => {
  menu.hidden = true;
  menu.replaceChildren();
};

function openMenu(x, y, timeHere) {
  menu.replaceChildren(...menuItems(timeHere).map((item) => {
    if (item.group) {
      const g = document.createElement('div');
      g.className = 'group';
      g.textContent = item.group;
      g.setAttribute('role', 'presentation');
      return g;
    }
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.disabled = !item.enabled;
    b.append(item.label);
    if (item.note) {
      const small = document.createElement('small');
      small.textContent = item.note;
      b.append(small);
    }
    b.onclick = () => {
      closeMenu();
      item.run();
    };
    return b;
  }));
  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector('button:not(:disabled)')?.focus();
}

$('graphScroll').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // From the keyboard (Shift+F10 / menu key) the event has no position: open at the graph's top-left corner.
  const box = $('graphScroll').getBoundingClientRect();
  const fromMouse = Boolean(e.clientX);
  // "Place a cursor here" uses the pointer position; from the keyboard, the middle of the graph.
  openMenu(fromMouse ? e.clientX : box.left + 24, fromMouse ? e.clientY : box.top + 24,
    graph.timeAtClientX(fromMouse ? e.clientX : box.left + box.width / 2));
});

// Arrow keys move through the enabled items; Escape and Tab close the menu.
menu.addEventListener('keydown', (e) => {
  const items = [...menu.querySelectorAll('button:not(:disabled)')];
  const at = items.indexOf(document.activeElement);
  const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
  if (go !== undefined) {
    e.preventDefault();
    items[(go + items.length) % items.length]?.focus();
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    e.preventDefault();
    closeMenu();
    $('graphScroll').focus();
  }
});
document.addEventListener('pointerdown', (e) => menu.contains(e.target) || closeMenu());
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
// Only the page scrolling closes the menu. The graph scrolls itself on every new live sample (capture would see
// that too), which used to dismiss the menu a moment after it opened.
window.addEventListener('scroll', (e) => e.target === document && closeMenu(), true);

// Ctrl/Cmd+C with the graph focused copies the visible values too.
$('graphScroll').addEventListener('copy', (e) => {
  const points = graph.hasCursors ? graph.selectedPoints() : graph.visiblePoints();
  if (!points.length) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', pointsToText(points, graph.unit));
  graphMessage(`Copied ${points.length} x,y values`);
});

// ---- reports: what the graph shows becomes the report's data (the cursor window, if cursors are set)
async function reportData() {
  const points = graph.selectedPoints();
  const canvas = graph.exportCanvas({ header: false });
  let image = null;
  if (canvas) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    image = new Uint8Array(await blob.arrayBuffer());
  }
  return {
    meter: meterInfo,
    section: {
      title: $('graphTitle').textContent,
      unit: graph.unit,
      points,
      total: graph.allPoints().length,
      selection: graph.hasCursors,
      image,
    },
  };
}

const forms = initForms({
  store: new TemplateStore({ getItem: (k) => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v) }),
  getData: reportData,
  getMeter: () => meterInfo,
  els: {
    paper: $('repPaper'), include: $('repInclude'), message: $('repMsg'),
    exportButton: $('repExport'), previewButton: $('repPreview'), copyButton: $('repCopy'), resetButton: $('repReset'),
  },
});

const readings = initReadings({
  store: new ReadingsStore({ getItem: (k) => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v) }),
  getReading: () => lastReading,
  onCopy: (rows) => forms.addTable(rows),
  els: {
    body: $('readingsBody'), count: $('readingsCount'), navCount: $('navCount'), saveButton: $('saveReading'), copyButton: $('readingsCopy'),
    csvButton: $('readingsCsv'), clearButton: $('readingsClear'), message: $('readingsMsg'),
  },
});
// The Save reading button and the report's instrument line follow the meter.
setInterval(() => {
  readings.refresh();
  $('saveReadingNav').disabled = $('saveReading').disabled;
  if ($('reportCard').open) forms.refresh();
}, 1000);

$('settingsReload').onclick = () => settings.load();

// Collapsible cards remember whether they were open.
for (const card of document.querySelectorAll('details.collapsible')) {
  const key = `fluke287.open.${card.id}`;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) card.open = saved === '1';
  } catch {
    /* storage blocked: keep the default */
  }
  card.addEventListener('toggle', () => {
    try {
      localStorage.setItem(key, card.open ? '1' : '0');
    } catch {
      /* ignore */
    }
  });
}

// Tabs (Settings, Reports): each tab list controls its own panels.
function initTabs(list) {
  const tabs = [...list.querySelectorAll('[role=tab]')];
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (e) => {
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      const target = tabs[(next + tabs.length) % tabs.length];
      select(target);
      target.focus();
    });
  });
}
document.querySelectorAll('[role=tablist]').forEach(initTabs);

// ---- section bar: shortcut links that scroll to each section, highlighting the one you are in
const sectionLinks = [...document.querySelectorAll('.section-tabs a')];
const sectionPanels = sectionLinks.map((a) => document.getElementById(a.getAttribute('href').slice(1)));

sectionLinks.forEach((link, i) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const card = sectionPanels[i].querySelector('details.collapsible');
    if (card && !card.hidden) card.open = true; // a collapsed section opens when you jump to it
    sectionPanels[i].scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', link.getAttribute('href'));
  });
});

let spyFrame = 0;
function spySections() {
  spyFrame = 0;
  const line = document.querySelector('.sections').getBoundingClientRect().bottom + 24;
  let current = 0;
  sectionPanels.forEach((panel, i) => {
    if (panel.getBoundingClientRect().top <= line) current = i;
  });
  sectionLinks.forEach((link, i) => {
    link.classList.toggle('active', i === current);
    if (i === current) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  });
  // Once the Live section has scrolled out of view, its reading and Save button stay in the bar.
  document.body.classList.toggle('live-away', sectionPanels[0].getBoundingClientRect().bottom < line - 24);
}
window.addEventListener('scroll', () => spyFrame || (spyFrame = requestAnimationFrame(spySections)), { passive: true });
window.addEventListener('resize', spySections);

// The bar sticks just below the site's own header, whatever height that has.
function placeSectionBar() {
  const header = document.getElementById('siteHeader');
  const h = header ? Math.round(header.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--nav-top', `${header && getComputedStyle(header).position === 'sticky' ? h : 0}px`);
  spySections();
}
placeSectionBar();
window.addEventListener('resize', placeSectionBar);
window.addEventListener('load', placeSectionBar);

$('saveReadingNav').onclick = () => readings.add();
