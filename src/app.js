import { formatReading, prettyFunction } from './format.js';
import { Meter } from './meter.js';
import { MockTransport } from './mock.js';
import { WebSerialTransport } from './transport.js';

const $ = (id) => document.getElementById(id);
const TRACE_POINTS = 120;

let meter = null;
let polling = false;
let failures = 0;
const trace = [];
let recording = false;
let rows = [];

if (!WebSerialTransport.supported) {
  $('notice').style.display = 'block';
  $('connect').disabled = true;
}

function setStatus(text) {
  $('status').textContent = text;
}

function setConnected(connected) {
  $('connect').disabled = connected || !WebSerialTransport.supported;
  $('demo').disabled = connected;
  $('disconnect').disabled = !connected;
  $('record').disabled = !connected;
  $('readout').classList.toggle('stale', !connected);
}

async function connect(makeTransport) {
  try {
    const transport = await makeTransport();
    const candidate = new Meter(transport);
    setStatus('Connecting…');
    const id = await candidate.identify();
    meter = candidate;
    failures = 0;
    setStatus(`${id.model} · ${id.firmware} · S/N ${id.serial}`);
    setConnected(true);
    poll();
  } catch (e) {
    console.error(e);
    setStatus(
      e.name === 'NotFoundError'
        ? 'No serial port selected (picker dismissed, or no port available to this browser)'
        : `Could not connect: ${e.name}: ${e.message}`,
    );
    meter?.close();
    meter = null;
  }
}

async function disconnect(message = 'Not connected') {
  polling = false;
  const m = meter;
  meter = null;
  await m?.close();
  setConnected(false);
  setStatus(message);
}

async function poll() {
  if (polling) return;
  polling = true;
  while (polling && meter) {
    const started = performance.now();
    try {
      render(await meter.queryDisplay());
      failures = 0;
    } catch (e) {
      // A dropped reply is normal when the meter is off or the IR path is blocked; give up after a few.
      if (++failures >= 4) return disconnect(`Lost meter: ${e.message}`);
      setStatus(`No reply (${failures}/4)…`);
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
  if (sec) {
    const s = formatReading(sec);
    $('secondary').textContent = `${prettyFunction(d.secondaryFunction)} ${s.text} ${s.unit}`;
  } else {
    $('secondary').textContent = prettyFunction(d.secondaryFunction);
  }

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

  if (main.state === 'NORMAL') {
    trace.push(main.value / 10 ** main.unitMultiplier);
    if (trace.length > TRACE_POINTS) trace.shift();
    drawTrace();
  }

  if (recording) {
    rows.push([
      new Date().toISOString(),
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

function drawTrace() {
  const c = $('trace');
  const dpr = window.devicePixelRatio || 1;
  c.width = c.clientWidth * dpr;
  c.height = c.clientHeight * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const w = c.clientWidth, h = c.clientHeight;
  const lo = Math.min(...trace), hi = Math.max(...trace);
  const span = hi - lo || 1;
  const style = getComputedStyle(document.documentElement);
  g.strokeStyle = style.getPropertyValue('--trace');
  g.lineWidth = 2;
  g.beginPath();
  trace.forEach((v, i) => {
    const x = (i / (TRACE_POINTS - 1)) * w;
    const y = h - 6 - ((v - lo) / span) * (h - 12);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
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

$('connect').onclick = () => connect(() => WebSerialTransport.request());
$('demo').onclick = () => connect(async () => new MockTransport());
$('disconnect').onclick = () => disconnect();
$('record').onclick = () => {
  recording = !recording;
  if (recording) rows = [];
  $('record').textContent = recording ? 'Stop recording' : 'Record';
  $('count').textContent = recording ? '0 samples' : $('count').textContent;
  $('export').disabled = rows.length === 0;
};
$('export').onclick = exportCsv;
