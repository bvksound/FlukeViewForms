// Scrollable strip chart of the primary reading over time.
//
// A wide spacer (`inner`) inside an overflow-x scroller gives the native horizontal scrollbar; the canvas is
// viewport-sized and sticky, and redraws just the visible time window. That keeps the canvas small however
// long the history grows.

import { pointsBetween } from './graph-text.js';

const AXIS_W = 64;
const PAD_T = 14;
const PAD_B = 24;
const PAD_R = 16;
const CURSOR_HIT = 8; // px either side of a cursor line that grabs it
const MAX_POINTS = 36000; // 5 h at 2 samples/s
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 43200, 86400, 172800, 604800];
const PREFIXES = [[-9, 'n'], [-6, 'µ'], [-3, 'm'], [0, ''], [3, 'k'], [6, 'M']];

function niceStep(rough) {
  const pow = 10 ** Math.floor(Math.log10(rough));
  const f = rough / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

// Largest prefix whose unit is <= the magnitude, so axis labels stay short (0.005 V -> 5 mV).
function prefixFor(maxAbs) {
  let pick = PREFIXES[0];
  for (const p of PREFIXES) if (maxAbs >= 10 ** p[0]) pick = p;
  return maxAbs === 0 ? PREFIXES[3] : pick;
}

// Light palette for exported images, so they read well on paper and in documents.
const PRINT_COLORS = { band: 'rgba(11,122,117,.16)', line: '#0b7a75', grid: '#e3e7ea', axis: '#5b6670', text: '#3a444c', title: '#10151a', bg: '#ffffff' };

const pad2 = (n) => String(n).padStart(2, '0');
function clock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Axis label for a tick; long spans (downloaded recordings) need the date as well.
function stamp(ms, stepSeconds) {
  const d = new Date(ms);
  const date = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (stepSeconds >= 86400) return date;
  if (stepSeconds >= 3600) return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return clock(ms);
}

export class LiveGraph {
  #scroll;
  #inner;
  #canvas;
  #onFollow;
  // Two datasets share the canvas: the live buffer, and a downloaded one (recording, saved measurements).
  // A point is { t: ms, v: base-unit value or NaN for an invalid/overload reading, lo?, hi? } (lo/hi = min/max band).
  #live = [];
  #liveUnit = ''; // caller-supplied symbol for the base unit, e.g. 'V'
  #data = null; // { points, unit, style: 'line' | 'points' }
  #view = 'live';
  #pps = 40; // pixels per second for the current view
  #livePps = 40;
  #fit = false; // downloaded view: keep the whole dataset fitted to the width
  #follow = true;
  #liveScroll = 0;
  #onView;
  #liveCursors = null; // { start, end } in ms; null = not set on that side. Each dataset has its own pair
  #onCursor;
  #lastCursorInfo = '';
  #colors;
  #manualY = null; // { min, max } in base units, or null for auto-scale
  #shownY = { min: -1, max: 1 }; // range used by the last draw
  #onRange;

  constructor({ scroll, inner, canvas, onFollowChange = () => {}, onRangeChange = () => {}, onViewChange = () => {}, onCursorChange = () => {} }) {
    this.#scroll = scroll;
    this.#inner = inner;
    this.#canvas = canvas;
    this.#onFollow = onFollowChange;
    this.#onRange = onRangeChange;
    this.#onView = onViewChange;
    this.#onCursor = onCursorChange;
    this.#enableDragPan();
    this.#readColors();
    scroll.addEventListener('scroll', () => {
      const atEnd = scroll.scrollLeft >= scroll.scrollWidth - scroll.clientWidth - 4;
      if (atEnd !== this.#follow) {
        this.#follow = atEnd;
        this.#onFollow(atEnd);
      }
      this.#draw();
    });
    new ResizeObserver(() => this.#layout(null, true)).observe(scroll);
    this.#layout();
  }

  get length() {
    return this.#points.length;
  }

  get following() {
    return this.#follow;
  }

  get #points() {
    return this.#view === 'live' ? this.#live : this.#data.points;
  }

  get #unit() {
    return this.#view === 'live' ? this.#liveUnit : this.#data.unit;
  }

  get #cursors() {
    return this.#view === 'live' ? this.#liveCursors : this.#data.cursors;
  }

  set #cursors(value) {
    if (this.#view === 'live') this.#liveCursors = value;
    else this.#data.cursors = value;
  }

  get view() {
    return this.#view;
  }

  get hasData() {
    return this.#data !== null;
  }

  // Symbol of the base unit of what is shown ('V', 'A', 'Ω'…).
  get unit() {
    return this.#unit;
  }

  allPoints() {
    return this.#points.map((p) => ({ ...p }));
  }

  // The points inside the time window currently on screen.
  visiblePoints() {
    const pts = this.#points;
    if (!pts.length) return [];
    const t0 = pts[0].t;
    const left = this.#scroll.scrollLeft;
    const plotW = this.#scroll.clientWidth - AXIS_W - PAD_R;
    const tMin = t0 + (left / this.#pps) * 1000;
    const tMax = t0 + ((left + plotW) / this.#pps) * 1000;
    return pts.filter((p) => p.t >= tMin && p.t <= tMax).map((p) => ({ ...p }));
  }

  // Shows a downloaded dataset instead of the live trace; the live buffer keeps filling in the background.
  setData({ points, unit, style = 'line' }) {
    this.#data = { points: [...points].sort((a, b) => a.t - b.t), unit, style, cursors: null };
    this.#enterData();
  }

  // Back to the dataset last shown (after looking at the live trace).
  showData() {
    if (this.#data) this.#enterData();
  }

  #enterData() {
    if (this.#view === 'live') {
      this.#livePps = this.#pps;
      this.#liveScroll = this.#scroll.scrollLeft;
    }
    this.#view = 'data';
    this.#manualY = null;
    this.#follow = false;
    this.#onFollow(false);
    this.#fit = true;
    this.#scroll.scrollLeft = 0;
    this.#layout();
    this.#onView('data');
    this.#notifyCursors();
  }

  showLive() {
    if (this.#view === 'live') return;
    this.#view = 'live';
    this.#manualY = null;
    this.#fit = false;
    this.#pps = this.#livePps;
    this.#follow = true;
    this.#onFollow(true);
    this.#layout();
    this.#onView('live');
    this.#notifyCursors();
  }

  clearData() {
    this.#data = null;
    this.showLive();
    this.#onView('live');
  }

  #readColors() {
    const s = getComputedStyle(document.documentElement);
    const get = (n, fallback) => s.getPropertyValue(n).trim() || fallback;
    this.#colors = {
      band: 'rgba(63, 209, 199, .16)',
      cursor: get('--amber', '#f0b429'),
      line: get('--trace', '#3fd1c7'),
      grid: get('--border', '#1c242c'),
      axis: get('--muted2', '#5b6670'),
      text: get('--muted', '#8a97a1'),
      bg: get('--bg', '#0a0e12'),
    };
  }

  // `unit` is the base unit's symbol; a different unit than before starts a fresh trace.
  add(t, value, unit, state) {
    if (unit !== this.#liveUnit) {
      this.#live = [];
      this.#liveUnit = unit;
      this.#liveCursors = null;
    }
    this.#live.push({ t, v: value, state });
    if (this.#live.length > MAX_POINTS) this.#trim(MAX_POINTS / 10);
    if (this.#view === 'live') {
      this.#layout();
      if (this.#liveCursors) this.#notifyCursors(); // the selected count grows as samples arrive
    }
  }

  #trim(count) {
    const oldT0 = this.#live[0].t;
    this.#live.splice(0, count);
    if (this.#view === 'live' && !this.#follow) {
      // Keep the window the user is looking at in place.
      const shift = ((this.#live[0].t - oldT0) / 1000) * this.#pps;
      this.#scroll.scrollLeft = Math.max(0, this.#scroll.scrollLeft - shift);
    }
  }

  // Clears the live trace; in the downloaded view it drops that dataset and returns to live.
  clear() {
    if (this.#view === 'data') return this.clearData();
    this.#live = [];
    this.#liveUnit = '';
    this.#liveCursors = null;
    this.#manualY = null;
    this.#layout();
    this.#notifyCursors();
  }

  get autoY() {
    return this.#manualY === null;
  }

  get yRange() {
    return { ...this.#shownY };
  }

  setYAuto() {
    this.#manualY = null;
    this.#draw();
  }

  setYRange(min, max) {
    if (!(Number.isFinite(min) && Number.isFinite(max) && min < max)) return;
    this.#manualY = { min, max };
    this.#draw();
  }

  // factor < 1 zooms in, > 1 zooms out, around the middle of what is shown.
  zoomY(factor) {
    const { min, max } = this.#shownY;
    const mid = (min + max) / 2;
    const half = ((max - min) / 2) * factor;
    this.setYRange(mid - half, mid + half);
  }

  // ---- x-axis cursors: two draggable vertical lines; exports use only the samples between them ----

  #xAt(t) {
    return AXIS_W + ((t - this.#points[0].t) / 1000) * this.#pps - this.#scroll.scrollLeft;
  }

  #tAt(x) {
    return this.#points[0].t + ((x - AXIS_W + this.#scroll.scrollLeft) / this.#pps) * 1000;
  }

  #clampToData(t) {
    const pts = this.#points;
    return Math.min(Math.max(t, pts[0].t), pts[pts.length - 1].t);
  }

  // The time under a screen x (clamped to the data), for "place a cursor here".
  timeAtClientX(clientX) {
    if (!this.#points.length) return null;
    return this.#clampToData(this.#tAt(clientX - this.#canvas.getBoundingClientRect().left));
  }

  get hasCursors() {
    return this.#points.length > 0 && this.#cursors !== null;
  }

  // Two cursors a quarter and three quarters across what is on screen.
  addCursors() {
    const pts = this.#points;
    if (pts.length < 2) return;
    const plotW = this.#scroll.clientWidth - AXIS_W - PAD_R;
    const lo = Math.max(this.#tAt(AXIS_W), pts[0].t);
    const hi = Math.min(this.#tAt(AXIS_W + plotW), pts[pts.length - 1].t);
    const [a, b] = hi > lo ? [lo, hi] : [pts[0].t, pts[pts.length - 1].t];
    this.#cursors = { start: a + (b - a) * 0.25, end: a + (b - a) * 0.75 };
    this.#cursorsChanged();
  }

  // which: 'start' | 'end'. The cursors never cross.
  placeCursor(which, t) {
    if (!this.#points.length) return;
    const cur = this.#cursors ?? { start: null, end: null };
    const time = this.#clampToData(t);
    if (which === 'start') cur.start = cur.end == null ? time : Math.min(time, cur.end);
    else cur.end = cur.start == null ? time : Math.max(time, cur.start);
    this.#cursors = cur;
    this.#cursorsChanged();
  }

  clearCursors() {
    this.#cursors = null;
    this.#cursorsChanged();
  }

  // The samples between the cursors, or all of them when no cursors are set.
  selectedPoints() {
    const cur = this.#points.length ? this.#cursors : null;
    return pointsBetween(this.#points, cur?.start, cur?.end).map((p) => ({ ...p }));
  }

  #cursorsChanged() {
    this.#draw();
    this.#notifyCursors();
  }

  #notifyCursors() {
    const cur = this.#points.length ? this.#cursors : null;
    const pts = this.#points;
    const info = cur && {
      start: cur.start,
      end: cur.end,
      count: pointsBetween(pts, cur.start, cur.end).length,
      total: pts.length,
      spanMs: (cur.end ?? pts[pts.length - 1].t) - (cur.start ?? pts[0].t),
    };
    const key = JSON.stringify(info);
    if (key === this.#lastCursorInfo) return;
    this.#lastCursorInfo = key;
    this.#onCursor(info);
  }

  // Which cursor line is under this screen x, if any.
  #cursorAt(clientX) {
    const cur = this.#points.length ? this.#cursors : null;
    if (!cur) return null;
    const x = clientX - this.#canvas.getBoundingClientRect().left;
    let best = null;
    for (const which of ['start', 'end']) {
      if (cur[which] == null) continue;
      const d = Math.abs(this.#xAt(cur[which]) - x);
      if (d <= CURSOR_HIT && (best === null || d < best.d)) best = { which, d };
    }
    return best?.which ?? null;
  }

  // Dragging the plot pans the value axis (mouse/pen; touch keeps scrolling the page), unless the pointer grabs a cursor.
  #enableDragPan() {
    const canvas = this.#canvas;
    let drag = null;
    canvas.style.cursor = 'ns-resize';
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      const cursor = this.#cursorAt(e.clientX);
      drag = cursor ? { cursor } : { y: e.clientY, ...this.#shownY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) {
        canvas.style.cursor = this.#cursorAt(e.clientX) ? 'ew-resize' : 'ns-resize';
        return;
      }
      if (drag.cursor) {
        this.placeCursor(drag.cursor, this.#tAt(e.clientX - canvas.getBoundingClientRect().left));
        return;
      }
      const plotH = canvas.clientHeight - PAD_T - PAD_B;
      const perPx = (drag.max - drag.min) / plotH;
      const shift = (e.clientY - drag.y) * perPx; // dragging down reveals higher values
      this.setYRange(drag.min + shift, drag.max + shift);
    });
    const end = () => (drag = null);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  // A number of pixels per second, or 'fit' to squeeze the whole dataset into the width.
  setScale(pixelsPerSecond) {
    const anchor = this.#anchorTime();
    if (pixelsPerSecond === 'fit') {
      this.#pps = this.#fitScale();
      this.#fit = this.#view === 'data';
    } else {
      this.#pps = pixelsPerSecond;
      this.#fit = false;
    }
    this.#layout(anchor);
  }

  #fitScale() {
    const pts = this.#points;
    const span = pts.length > 1 ? (pts[pts.length - 1].t - pts[0].t) / 1000 : 0;
    const room = this.#scroll.clientWidth - AXIS_W - PAD_R - 8;
    return span > 0 && room > 0 ? Math.max(room / span, 1e-4) : this.#pps;
  }

  jumpToLive() {
    this.#scroll.scrollLeft = this.#scroll.scrollWidth;
  }

  // Time at the left edge of the plot, so a zoom keeps the same moment in view.
  #anchorTime() {
    if (!this.#points.length || this.#follow) return null;
    return this.#points[0].t + ((this.#scroll.scrollLeft) / this.#pps) * 1000;
  }

  #layout(anchorTime = null, resized = false) {
    if (this.#fit && this.#view === 'data') {
      this.#pps = this.#fitScale();
      anchorTime = null;
      if (!resized) this.#scroll.scrollLeft = 0;
    }
    const pts = this.#points;
    const viewW = this.#scroll.clientWidth;
    const span = pts.length ? ((pts[pts.length - 1].t - pts[0].t) / 1000) * this.#pps : 0;
    this.#inner.style.width = `${Math.max(viewW, AXIS_W + span + PAD_R)}px`;
    if (anchorTime !== null) {
      this.#scroll.scrollLeft = ((anchorTime - pts[0].t) / 1000) * this.#pps;
    } else if (this.#follow) {
      this.#scroll.scrollLeft = this.#scroll.scrollWidth;
    }
    this.#draw();
  }

  #draw() {
    const canvas = this.#canvas;
    const W = this.#scroll.clientWidth;
    const H = this.#inner.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    this.#paint(g, W, H, this.#colors, true);
  }

  // Paints the current view into `g` (already scaled to CSS pixels). Returns the visible time span in ms,
  // or null when there is nothing to show. `notify` reports the Y range to the page (screen draws only).
  // `view` ({ pps, left }) overrides the on-screen zoom and scroll, so an export can render any time window.
  #paint(g, W, H, c, notify, view = null) {
    g.font = '11px ui-monospace, Menlo, Consolas, monospace';

    const pts = this.#points;
    const plotL = AXIS_W, plotR = W - PAD_R, plotT = PAD_T, plotB = H - PAD_B;
    if (!pts.length) {
      g.fillStyle = c.axis;
      g.textAlign = 'center';
      g.fillText('Waiting for readings…', W / 2, H / 2);
      return null;
    }

    const t0 = pts[0].t;
    const left = view ? view.left : this.#scroll.scrollLeft;
    const pps = view ? view.pps : this.#pps;
    const xAt = (t) => plotL + ((t - t0) / 1000) * pps - left;
    const tAt = (x) => t0 + ((x - plotL + left) / pps) * 1000;

    // Visible slice, with one point of margin either side so the line runs off the edges.
    const tMin = tAt(plotL), tMax = tAt(plotR);
    let lo = this.#firstAtOrAfter(tMin);
    let hi = this.#firstAtOrAfter(tMax);
    lo = Math.max(0, lo - 1);
    hi = Math.min(pts.length - 1, hi);

    let vMin = Infinity, vMax = -Infinity;
    for (let i = lo; i <= hi; i++) {
      for (const v of [pts[i].v, pts[i].lo, pts[i].hi]) {
        if (Number.isFinite(v)) {
          if (v < vMin) vMin = v;
          if (v > vMax) vMax = v;
        }
      }
    }
    if (vMin === Infinity) {
      vMin = -1;
      vMax = 1;
    }
    if (vMax - vMin < 1e-12) {
      const half = Math.max(Math.abs(vMax) * 0.01, 1e-6);
      vMin -= half;
      vMax += half;
    }
    if (this.#manualY) {
      ({ min: vMin, max: vMax } = this.#manualY);
    } else {
      const margin = (vMax - vMin) * 0.08;
      vMin -= margin;
      vMax += margin;
    }
    this.#shownY = { min: vMin, max: vMax };
    if (notify) this.#onRange(vMin, vMax, this.#manualY === null);
    const yAt = (v) => plotB - ((v - vMin) / (vMax - vMin)) * (plotB - plotT);

    // Y grid + labels
    const [exp, prefix] = prefixFor(Math.max(Math.abs(vMin), Math.abs(vMax)));
    const step = niceStep((vMax - vMin) / 5);
    const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step / 10 ** exp) - 1e-9)));
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.lineWidth = 1;
    for (let v = Math.ceil(vMin / step) * step; v <= vMax; v += step) {
      const y = Math.round(yAt(v)) + 0.5;
      g.strokeStyle = c.grid;
      g.beginPath();
      g.moveTo(plotL, y);
      g.lineTo(plotR, y);
      g.stroke();
      g.fillStyle = c.text;
      g.fillText((v / 10 ** exp).toFixed(decimals), plotL - 8, y);
    }
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillStyle = c.axis;
    g.fillText(prefix + this.#unit, 6, 2);

    // Time grid + labels
    const secPerLabel = TIME_STEPS.find((s) => s * pps >= 90) ?? TIME_STEPS.at(-1);
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    for (let s = Math.ceil(tMin / 1000 / secPerLabel) * secPerLabel; s * 1000 <= tMax; s += secPerLabel) {
      const x = Math.round(xAt(s * 1000)) + 0.5;
      g.strokeStyle = c.grid;
      g.beginPath();
      g.moveTo(x, plotT);
      g.lineTo(x, plotB);
      g.stroke();
      g.fillStyle = c.axis;
      // Keep the label inside the canvas: a tick at the very edge would otherwise be cut in half.
      const label = stamp(s * 1000, secPerLabel);
      const half = g.measureText(label).width / 2;
      g.fillText(label, Math.min(Math.max(x, half + 2), W - half - 2), H - 6);
    }

    // Axes
    g.strokeStyle = c.axis;
    g.beginPath();
    g.moveTo(plotL + 0.5, plotT);
    g.lineTo(plotL + 0.5, plotB + 0.5);
    g.lineTo(plotR, plotB + 0.5);
    g.stroke();

    // Trace, clipped to the plot area; invalid/overload readings break the line.
    g.save();
    g.beginPath();
    g.rect(plotL, plotT - 2, plotR - plotL, plotB - plotT + 4);
    g.clip();
    const dots = this.#view === 'data' && this.#data.style === 'points';

    // Min/max band behind the line (recording samples carry it).
    if (!dots && pts.slice(lo, hi + 1).some((p) => Number.isFinite(p.lo) && Number.isFinite(p.hi))) {
      g.fillStyle = c.band;
      g.beginPath();
      const run = [];
      const flush = () => {
        if (run.length > 1) {
          run.forEach((p, i) => (i ? g.lineTo(xAt(p.t), yAt(p.hi)) : g.moveTo(xAt(p.t), yAt(p.hi))));
          [...run].reverse().forEach((p) => g.lineTo(xAt(p.t), yAt(p.lo)));
          g.closePath();
        }
        run.length = 0;
      };
      for (let i = lo; i <= hi; i++) {
        if (Number.isFinite(pts[i].lo) && Number.isFinite(pts[i].hi)) run.push(pts[i]);
        else flush();
      }
      flush();
      g.fill();
    }

    g.strokeStyle = c.line;
    g.fillStyle = c.line;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.beginPath();
    let pen = false;
    for (let i = lo; i <= hi; i++) {
      const { t, v } = pts[i];
      if (!Number.isFinite(v)) {
        pen = false;
        continue;
      }
      const x = xAt(t), y = yAt(v);
      if (dots) {
        g.moveTo(x + 4, y);
        g.arc(x, y, 4, 0, Math.PI * 2);
        continue;
      }
      if (pen) g.lineTo(x, y);
      else g.moveTo(x, y);
      pen = true;
    }
    if (dots) g.fill();
    else g.stroke();
    const last = pts[pts.length - 1];
    if (this.#view === 'live' && Number.isFinite(last.v) && hi === pts.length - 1) {
      g.beginPath();
      g.arc(xAt(last.t), yAt(last.v), 3.5, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    if (notify) this.#paintCursors(g, { plotL, plotR, plotT, plotB, xAt, span: (tMax - tMin) / 1000 }, c);
    return { tMin, tMax };
  }

  // The time window between the cursors (an unset side is the data's edge), or null when no cursors are set.
  cursorRange() {
    const pts = this.#points;
    const cur = pts.length ? this.#cursors : null;
    return cur && { start: cur.start ?? pts[0].t, end: cur.end ?? pts[pts.length - 1].t };
  }

  // Renders a print-friendly image (white background, title strip on top): the window between the cursors when
  // they are set, otherwise what is on screen. Returns a canvas, or null when there is no data yet.
  exportCanvas({ title = '', subtitle = '', scale = 2, header = true } = {}) {
    const W = this.#scroll.clientWidth;
    const H = this.#inner.clientHeight;
    if (!this.#points.length || !W || !H) return null;
    const HEAD = header ? 46 : 0; // reports draw their own title, so they ask for the plain plot
    const out = document.createElement('canvas');
    out.width = Math.round(W * scale);
    out.height = Math.round((H + HEAD) * scale);
    const g = out.getContext('2d');
    g.scale(scale, scale);
    g.fillStyle = PRINT_COLORS.bg;
    g.fillRect(0, 0, W, H + HEAD);

    g.save();
    g.translate(0, HEAD);
    // Fit the cursor window across the whole plot width, whatever the on-screen zoom and scroll are.
    const sel = this.cursorRange();
    let view = null;
    if (sel && sel.end > sel.start) {
      const pps = (W - AXIS_W - PAD_R) / ((sel.end - sel.start) / 1000);
      view = { pps, left: ((sel.start - this.#points[0].t) / 1000) * pps };
    }
    const span = this.#paint(g, W, H, PRINT_COLORS, false, view);
    g.restore();

    if (!header) return out;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = PRINT_COLORS.title;
    g.font = '600 15px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    g.fillText(title, 12, 22);
    g.fillStyle = PRINT_COLORS.text;
    g.font = '12px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    const range = span ? `${clock(span.tMin)} – ${clock(span.tMax)}` : '';
    g.fillText([subtitle, range].filter(Boolean).join('  ·  '), 12, 39);
    return out;
  }

  // Dims what lies outside the cursors and draws the cursor lines with their times.
  #paintCursors(g, { plotL, plotR, plotT, plotB, xAt }, c) {
    const cur = this.#cursors;
    if (!cur) return;
    const clampX = (x) => Math.min(Math.max(x, plotL), plotR);
    g.save();
    g.fillStyle = 'rgba(10, 14, 18, .55)';
    if (cur.start != null) g.fillRect(plotL, plotT, clampX(xAt(cur.start)) - plotL, plotB - plotT);
    if (cur.end != null) g.fillRect(clampX(xAt(cur.end)), plotT, plotR - clampX(xAt(cur.end)), plotB - plotT);
    g.font = '11px ui-monospace, Menlo, Consolas, monospace';
    g.textBaseline = 'top';
    for (const which of ['start', 'end']) {
      if (cur[which] == null) continue;
      const x = Math.round(xAt(cur[which])) + 0.5;
      if (x < plotL - 1 || x > plotR + 1) continue;
      g.strokeStyle = c.cursor;
      g.fillStyle = c.cursor;
      g.lineWidth = 1.5;
      g.setLineDash([5, 4]);
      g.beginPath();
      g.moveTo(x, plotT);
      g.lineTo(x, plotB);
      g.stroke();
      g.setLineDash([]);
      // Handle: a small tab at the top, with the time beside it (inside the plot, away from the edge).
      g.fillRect(x - 4, plotT - 2, 8, 9);
      const text = clock(cur[which]);
      const w = g.measureText(text).width;
      const onLeft = which === 'end' && x - w - 10 > plotL;
      g.textAlign = onLeft ? 'right' : 'left';
      g.fillText(text, onLeft ? x - 8 : x + 8, plotT + 1);
    }
    g.restore();
  }

  #firstAtOrAfter(t) {
    const pts = this.#points;
    let a = 0, b = pts.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (pts[m].t < t) a = m + 1;
      else b = m;
    }
    return a;
  }
}
