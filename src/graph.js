// Scrollable strip chart of the primary reading over time.
//
// A wide spacer (`inner`) inside an overflow-x scroller gives the native horizontal scrollbar; the canvas is
// viewport-sized and sticky, and redraws just the visible time window. That keeps the canvas small however
// long the history grows.

const AXIS_W = 64;
const PAD_T = 14;
const PAD_B = 24;
const PAD_R = 16;
const MAX_POINTS = 36000; // 5 h at 2 samples/s
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
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

const pad2 = (n) => String(n).padStart(2, '0');
function clock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export class LiveGraph {
  #scroll;
  #inner;
  #canvas;
  #onFollow;
  #points = []; // { t: ms, v: base-unit value or NaN for an invalid/overload reading }
  #unit = ''; // caller-supplied symbol for the base unit, e.g. 'V'
  #pps = 40; // pixels per second
  #follow = true;
  #colors;
  #manualY = null; // { min, max } in base units, or null for auto-scale
  #shownY = { min: -1, max: 1 }; // range used by the last draw
  #onRange;

  constructor({ scroll, inner, canvas, onFollowChange = () => {}, onRangeChange = () => {} }) {
    this.#scroll = scroll;
    this.#inner = inner;
    this.#canvas = canvas;
    this.#onFollow = onFollowChange;
    this.#onRange = onRangeChange;
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
    new ResizeObserver(() => this.#layout()).observe(scroll);
    this.#layout();
  }

  get length() {
    return this.#points.length;
  }

  get following() {
    return this.#follow;
  }

  #readColors() {
    const s = getComputedStyle(document.documentElement);
    const get = (n, fallback) => s.getPropertyValue(n).trim() || fallback;
    this.#colors = {
      line: get('--trace', '#3fd1c7'),
      grid: get('--border', '#1c242c'),
      axis: get('--muted2', '#5b6670'),
      text: get('--muted', '#8a97a1'),
      bg: get('--bg', '#0a0e12'),
    };
  }

  // `unit` is the base unit's symbol; a different unit than before starts a fresh trace.
  add(t, value, unit) {
    if (unit !== this.#unit) {
      this.#points = [];
      this.#unit = unit;
    }
    this.#points.push({ t, v: value });
    if (this.#points.length > MAX_POINTS) this.#trim(MAX_POINTS / 10);
    this.#layout();
  }

  #trim(count) {
    const oldT0 = this.#points[0].t;
    this.#points.splice(0, count);
    if (!this.#follow) {
      // Keep the window the user is looking at in place.
      const shift = ((this.#points[0].t - oldT0) / 1000) * this.#pps;
      this.#scroll.scrollLeft = Math.max(0, this.#scroll.scrollLeft - shift);
    }
  }

  clear() {
    this.#points = [];
    this.#unit = '';
    this.#manualY = null;
    this.#layout();
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

  // Dragging the plot up/down pans the value axis (mouse/pen; touch keeps scrolling the page).
  #enableDragPan() {
    const canvas = this.#canvas;
    let drag = null;
    canvas.style.cursor = 'ns-resize';
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      drag = { y: e.clientY, ...this.#shownY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const plotH = canvas.clientHeight - PAD_T - PAD_B;
      const perPx = (drag.max - drag.min) / plotH;
      const shift = (e.clientY - drag.y) * perPx; // dragging down reveals higher values
      this.setYRange(drag.min + shift, drag.max + shift);
    });
    const end = () => (drag = null);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  setScale(pixelsPerSecond) {
    const anchor = this.#anchorTime();
    this.#pps = pixelsPerSecond;
    this.#layout(anchor);
  }

  jumpToLive() {
    this.#scroll.scrollLeft = this.#scroll.scrollWidth;
  }

  // Time at the left edge of the plot, so a zoom keeps the same moment in view.
  #anchorTime() {
    if (!this.#points.length || this.#follow) return null;
    return this.#points[0].t + ((this.#scroll.scrollLeft) / this.#pps) * 1000;
  }

  #layout(anchorTime = null) {
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
    const c = this.#colors;
    g.clearRect(0, 0, W, H);
    g.font = '11px ui-monospace, Menlo, Consolas, monospace';

    const pts = this.#points;
    const plotL = AXIS_W, plotR = W - PAD_R, plotT = PAD_T, plotB = H - PAD_B;
    if (!pts.length) {
      g.fillStyle = c.axis;
      g.textAlign = 'center';
      g.fillText('Waiting for readings…', W / 2, H / 2);
      return;
    }

    const t0 = pts[0].t;
    const left = this.#scroll.scrollLeft;
    const xAt = (t) => plotL + ((t - t0) / 1000) * this.#pps - left;
    const tAt = (x) => t0 + ((x - plotL + left) / this.#pps) * 1000;

    // Visible slice, with one point of margin either side so the line runs off the edges.
    const tMin = tAt(plotL), tMax = tAt(plotR);
    let lo = this.#firstAtOrAfter(tMin);
    let hi = this.#firstAtOrAfter(tMax);
    lo = Math.max(0, lo - 1);
    hi = Math.min(pts.length - 1, hi);

    let vMin = Infinity, vMax = -Infinity;
    for (let i = lo; i <= hi; i++) {
      const v = pts[i].v;
      if (Number.isFinite(v)) {
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
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
    this.#onRange(vMin, vMax, this.#manualY === null);
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
    const secPerLabel = TIME_STEPS.find((s) => s * this.#pps >= 90) ?? TIME_STEPS.at(-1);
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
      g.fillText(clock(s * 1000), x, H - 6);
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
    g.strokeStyle = c.line;
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
      if (pen) g.lineTo(x, y);
      else g.moveTo(x, y);
      pen = true;
    }
    g.stroke();
    const last = pts[pts.length - 1];
    if (Number.isFinite(last.v) && hi === pts.length - 1) {
      g.fillStyle = c.line;
      g.beginPath();
      g.arc(xAt(last.t), yAt(last.v), 3.5, 0, Math.PI * 2);
      g.fill();
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
