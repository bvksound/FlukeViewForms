import { BATTERY_BLOCKS, batteryBlocks, formatBattery, formatEng, formatReading, parseEng, prettyFunction, unitSymbol } from './format.js';
import { LiveGraph } from './graph.js';
import { Meter, MeterError } from './meter.js';
import { initSettings } from './settings-ui.js';
import { WebSerialTransport } from './transport.js';

const $ = (id) => document.getElementById(id);

let meter = null;
let polling = false;
let failures = 0;
let recording = false;
let rows = [];

const graph = new LiveGraph({
  scroll: $('graphScroll'),
  inner: $('graphInner'),
  canvas: $('graph'),
  onFollowChange: (following) => {
    $('live').disabled = following;
  },
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
  $('record').disabled = !connected;
  $('settingsCard').hidden = !connected;
  document.querySelectorAll('.needs-meter').forEach((el) => (el.disabled = !connected));
  $('readout').classList.toggle('stale', !connected);
}

const settings = initSettings({
  basic: $('settingsBasic'),
  advanced: $('settingsAdvanced'),
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
      setStatus(`${id.model} · ${id.firmware} · S/N ${id.serial}`, 'ok');
      setConnected(true);
      poll();
      settings.load();
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

async function disconnect(message = 'Not connected', kind = '') {
  polling = false;
  const m = meter;
  meter = null;
  await m?.close();
  setConnected(false);
  $('battery').hidden = true;
  settings.reset();
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
  for (let i = 0; i < BATTERY_BLOCKS; i++) {
    rect(8 + i * 6, 4, 4, 8, { rx: 0.8, fill: 'currentColor', opacity: i < filled ? 1 : 0.15 });
  }
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
    el.classList.toggle('low', bars === 0);
    el.title = `Battery: ${formatBattery(code)}${bars === null ? '' : ` (${bars} of ${BATTERY_BLOCKS} bars)`}`;
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
    const started = performance.now();
    try {
      render(await meter.queryDisplay());
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
  $('value').textContent = f.text;
  $('unit').textContent = f.unit;
  $('coupling').textContent = f.coupling;
  $('func').textContent = prettyFunction(d.primaryFunction);
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
  graph.add(now, main.state === 'NORMAL' ? main.value : NaN, unitSymbol(main.baseUnit));
  $('yUnit').textContent = unitSymbol(main.baseUnit);
  $('graphTitle').textContent = `${prettyFunction(d.primaryFunction)} over time`;
  $('graphCount').textContent = `${graph.length} samples`;

  if (recording) {
    rows.push([
      new Date(now).toISOString(),
      new Date(main.timestamp * 1000).toISOString(),
      d.primaryFunction,
      main.value,
      main.baseUnit,
      main.state,
    ]);
    $('count').textContent = `${rows.length} samples`;
    $('export').disabled = false;
  }
}

function exportCsv() {
  const header = 'computer_time,meter_time,function,value_base_units,unit,state';
  const csv = [header, ...rows.map((r) => r.join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `fluke287-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('connect').onclick = () => connect();
$('choose').onclick = () => connect({ choose: true });
$('disconnect').onclick = () => disconnect();
$('record').onclick = () => {
  recording = !recording;
  if (recording) rows = [];
  $('record').textContent = recording ? 'Stop recording' : 'Record';
  $('count').textContent = recording ? '0 samples' : $('count').textContent;
  $('export').disabled = rows.length === 0;
};
$('export').onclick = exportCsv;
$('zoom').onchange = (e) => graph.setScale(Number(e.target.value));
$('live').onclick = () => graph.jumpToLive();
$('clearGraph').onclick = () => {
  graph.clear();
  $('graphCount').textContent = '';
};

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
    subtitle: [$('status').textContent.startsWith('FLUKE') ? $('status').textContent : '', new Date().toLocaleDateString()]
      .filter(Boolean)
      .join('  ·  '),
  });
  if (!canvas) graphMessage('Nothing to export yet');
  return canvas;
}

$('exportJpg').onclick = () => {
  const canvas = graphImage();
  canvas?.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fluke287-graph-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    a.click();
    URL.revokeObjectURL(a.href);
    graphMessage('Saved JPG');
  }, 'image/jpeg', 0.92);
};

$('copyGraph').onclick = async () => {
  const canvas = graphImage();
  if (!canvas) return;
  try {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    graphMessage('Copied to clipboard');
  } catch (e) {
    graphMessage(`Could not copy: ${e.message}`);
  }
};

$('settingsReload').onclick = () => settings.load();
