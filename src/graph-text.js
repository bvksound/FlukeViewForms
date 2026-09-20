// Plain-text (tab-separated) x,y values of a graph, for the clipboard: pastes into a spreadsheet or a text editor.
const pad = (n, w = 2) => String(n).padStart(w, '0');

// Local time with milliseconds, e.g. 2026-09-20 14:05:00.250
export function localTimestamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// The graph's data as a table: x = time, y = value in base units. Band columns (min, max) appear when the data has
// them (recordings), and a state column (OL, INVALID…) when any reading was not a normal one.
export function pointsToTable(points, unit = '') {
  const band = points.some((p) => Number.isFinite(p.lo) || Number.isFinite(p.hi));
  const withState = points.some((p) => p.state && p.state !== 'NORMAL');
  const num = (v) => (Number.isFinite(v) ? String(v) : '');
  const label = unit ? `_${unit}` : '';
  const header = ['time', `value${label}`, ...(band ? [`min${label}`, `max${label}`] : []), ...(withState ? ['state'] : [])];
  const rows = points.map((p) => [
    localTimestamp(p.t), num(p.v), ...(band ? [num(p.lo), num(p.hi)] : []), ...(withState ? [p.state ?? ''] : []),
  ]);
  return { header, rows };
}

// Tab-separated text for the clipboard: pastes into a spreadsheet or a text editor.
export function pointsToText(points, unit = '', { sep = '\t' } = {}) {
  const { header, rows } = pointsToTable(points, unit);
  return [header, ...rows].map((r) => r.join(sep)).join('\n') + '\n';
}

// The points between two cursors, inclusive. A null cursor means "no limit" on that side.
export function pointsBetween(points, start, end) {
  return points.filter((p) => (start == null || p.t >= start) && (end == null || p.t <= end));
}
