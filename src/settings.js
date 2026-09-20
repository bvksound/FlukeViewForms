// Meter settings reachable through QMP / MP (undocumented; see docs/protocol.md).
// `kind`: choice (a fixed list), minutes (the meter stores seconds), number (plain text), text (read-only here).
// Only values confirmed on a real 287 are listed for choices the meter accepts; anything else it rejects with an error.

// Grouped for the Settings page: display (with the clock), power and sound, measurement.
export const PROPERTIES = [
  { group: 'display', key: 'digits', label: 'Display digits', kind: 'choice', options: [['4', '4 digits'], ['5', '5 digits']] },
  { group: 'display', key: 'numFmt', label: 'Number format', kind: 'choice', options: [['POINT', '1.23 (point)'], ['COMMA', '1,23 (comma)']] },
  { group: 'display', key: 'dateFmt', label: 'Date format', kind: 'choice', options: [['DD_MM', 'Day / month'], ['MM_DD', 'Month / day']] },
  { group: 'display', key: 'timeFmt', label: 'Time format', kind: 'choice', options: [['24', '24 hour'], ['12', '12 hour']] },
  { group: 'display', key: 'lang', label: 'Language', kind: 'choice', options: [
    ['ENGLISH', 'English'], ['GERMAN', 'German'], ['FRENCH', 'French'], ['ITALIAN', 'Italian'],
    ['SPANISH', 'Spanish'], ['JAPANESE', 'Japanese'], ['CHINESE', 'Chinese'],
  ] },
  { group: 'power', key: 'beeper', label: 'Beeper', kind: 'choice', options: [['ON', 'On'], ['OFF', 'Off']] },
  { group: 'power', key: 'ablto', label: 'Backlight timeout', kind: 'minutes' },
  { group: 'power', key: 'apoffto', label: 'Auto power-off', kind: 'minutes' },
  { group: 'measure', key: 'acsmooth', label: 'AC smoothing', kind: 'choice', options: [['OFF', 'Off'], ['ON', 'On']] },
  { group: 'measure', key: 'dBmRef', label: 'dBm reference', kind: 'choice', options: [
    ...['4', '8', '16', '25', '32', '50', '75', '600', '1000'].map((v) => [v, `${v} Ω`]), ['CUSTOM', 'Custom'],
  ] },
  { group: 'measure', key: 'cusDBm', label: 'Custom dBm reference', kind: 'number' },
  { group: 'measure', key: 'recEventTh', label: 'Recording event threshold', kind: 'number' },
  { group: 'measure', key: 'tempOS', label: 'Temperature offset', kind: 'number' },
  { group: 'measure', key: 'aheventTh', label: 'AutoHold event threshold', kind: 'number' },
];

export const OWNER_FIELDS = [
  ['company', 'Company'],
  ['site', 'Site'],
  ['operator', 'Operator'],
  ['contact', 'Contact'],
];

export const SAVE_SLOTS = 8;

export const secondsToMinutes = (seconds) => Number(seconds) / 60;
export const minutesToSeconds = (minutes) => Math.round(Number(minutes) * 60);

const pad2 = (n) => String(n).padStart(2, '0');

// The meter keeps *local wall-clock time* encoded as if it were UTC, so "12:00 here" is 12:00 UTC to the meter.
export function clockValueFor(date = new Date()) {
  return Math.round(date.getTime() / 1000) - date.getTimezoneOffset() * 60;
}

// A meter timestamp (local wall-clock time encoded as UTC) as a real epoch in ms, so a chart shows the same
// clock time the meter did, DST included.
export function meterSecondsToLocalMs(seconds) {
  const d = new Date(Number(seconds) * 1000);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime() +
    Math.round((Number(seconds) % 1) * 1000);
}

export function meterClockToText(seconds) {
  const d = new Date(Number(seconds) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

export function localClockText(date = new Date()) {
  return meterClockToText(clockValueFor(date));
}
