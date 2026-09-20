// Meter settings reachable through QMP / MP (undocumented; see docs/protocol.md).
// `kind`: choice (a fixed list), minutes (the meter stores seconds), number (plain text), text (read-only here).
// Only values confirmed on a real 287 are listed for choices the meter accepts; anything else it rejects with an error.

export const BASIC = [
  { key: 'beeper', label: 'Beeper', kind: 'choice', options: [['ON', 'On'], ['OFF', 'Off']] },
  { key: 'digits', label: 'Display digits', kind: 'choice', options: [['4', '4 digits'], ['5', '5 digits']] },
  { key: 'ablto', label: 'Backlight timeout', kind: 'minutes' },
  { key: 'apoffto', label: 'Auto power-off', kind: 'minutes' },
  { key: 'dateFmt', label: 'Date format', kind: 'choice', options: [['DD_MM', 'Day / month'], ['MM_DD', 'Month / day']] },
  { key: 'timeFmt', label: 'Time format', kind: 'choice', options: [['24', '24 hour'], ['12', '12 hour']] },
  { key: 'numFmt', label: 'Number format', kind: 'choice', options: [['POINT', '1.23 (point)'], ['COMMA', '1,23 (comma)']] },
];

export const ADVANCED = [
  { key: 'tempOS', label: 'Temperature offset', kind: 'number' },
  { key: 'aheventTh', label: 'AutoHold event threshold', kind: 'number' },
  { key: 'lang', label: 'Language', kind: 'text', readOnly: true },
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

export function meterClockToText(seconds) {
  const d = new Date(Number(seconds) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

export function localClockText(date = new Date()) {
  return meterClockToText(clockValueFor(date));
}
