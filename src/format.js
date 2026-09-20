// Turns parsed readings into what the meter's LCD would show.

const PREFIX = { '-9': 'n', '-6': 'µ', '-3': 'm', 0: '', 3: 'k', 6: 'M' };

const UNIT = {
  VDC: 'V', VAC: 'V', V: 'V', VAC_PLUS_DC: 'V',
  ADC: 'A', AAC: 'A', A: 'A', AAC_PLUS_DC: 'A',
  OHM: 'Ω', SIE: 'S', Hz: 'Hz', S: 's', F: 'F',
  CEL: '°C', FAR: '°F', PCT: '%',
  dBm: 'dBm', dBV: 'dBV', dB: 'dB',
};

const COUPLING = {
  VDC: 'DC', ADC: 'DC',
  VAC: 'AC', AAC: 'AC',
  VAC_PLUS_DC: 'AC+DC', AAC_PLUS_DC: 'AC+DC',
};

const STATE_TEXT = {
  OL: 'OL',
  OL_MINUS: '-OL',
  OPEN_TC: 'OPEN',
  DISCHARGE: 'dISC',
  BLANK: '----',
  INVALID: '----',
};

export function unitSymbol(baseUnit) {
  return UNIT[baseUnit] ?? '';
}

export function formatReading(r) {
  const unit = (PREFIX[r.unitMultiplier] ?? '') + (UNIT[r.baseUnit] ?? '');
  const coupling = COUPLING[r.baseUnit] ?? '';
  const text =
    r.state in STATE_TEXT
      ? STATE_TEXT[r.state]
      : (r.value / 10 ** r.unitMultiplier).toFixed(Math.max(0, r.decimalPlaces));
  return { text, unit, coupling, ok: r.state === 'NORMAL' };
}

// Function/mode names arrive as MV_AC, DIODE_TEST, MIN_MAX_AVG…; the leading "MV" means millivolts, not mega.
const WORDS = {
  MV: 'mV', MA: 'mA', UA: 'µA', V: 'V', A: 'A', AC: 'AC', DC: 'DC',
  OVER: 'over', PLUS: '+', LOZ: 'LoZ', DBM: 'dBm', DBV: 'dBV',
};

export function prettyFunction(name) {
  if (name === 'NONE') return '';
  const words = name.split('_').map((w) => WORDS[w] ?? w.toLowerCase());
  if (!(name.split('_')[0] in WORDS)) words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(' ');
}

const ENG = [[-9, 'n'], [-6, 'µ'], [-3, 'm'], [0, ''], [3, 'k'], [6, 'M']];

// 0.00503 -> "5.03m", 1500 -> "1.5k". For editable axis limits, so no unit symbol.
export function formatEng(v) {
  if (v === 0 || !Number.isFinite(v)) return '0';
  const abs = Math.abs(v);
  const [exp, prefix] = ENG.reduce((pick, p) => (abs >= 10 ** p[0] ? p : pick), ENG[0]);
  return Number((v / 10 ** exp).toPrecision(3)).toString() + prefix;
}

// "5m" -> 0.005, "1.5k" -> 1500, "-2" -> -2. Returns NaN when it isn't a number.
export function parseEng(text) {
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([nuµmkM]?)\s*$/i.exec(text.replace('µ', 'u'));
  if (!m) return NaN;
  const exp = { n: -9, u: -6, m: -3, k: 3, M: 6 }[m[2]] ?? 0;
  return Number(m[1]) * 10 ** exp;
}

// "PARTLY_EMPTY_2" -> "Partly empty (2)", "FULL" -> "Full". The meter's own wording is kept; only the case changes.
export function formatBattery(code) {
  const words = code.trim().split('_');
  const level = /^\d+$/.test(words.at(-1)) && words.length > 1 ? words.pop() : null;
  const text = words.join(' ').toLowerCase();
  return text[0].toUpperCase() + text.slice(1) + (level ? ` (${level})` : '');
}

export const BATTERY_BLOCKS = 4; // the meter's battery symbol has four bars

// FULL -> 4 bars, EMPTY -> 0, PARTLY_EMPTY_2 -> 2 (matches a 287 showing two bars when it reported PARTLY_EMPTY_2).
// Returns null for wording we haven't seen, so the caller can fall back to the text.
export function batteryBlocks(code) {
  const c = code.trim();
  if (c === 'FULL') return BATTERY_BLOCKS;
  if (c === 'EMPTY') return 0;
  const m = /^PARTLY_EMPTY_(\d)$/.exec(c);
  return m ? Math.min(Number(m[1]), BATTERY_BLOCKS - 1) : null;
}

// Which of the four bars are lit. The meter's symbol empties from the terminal (left) side, so the lit bars are the last ones.
export function batteryBars(filled) {
  return Array.from({ length: BATTERY_BLOCKS }, (_, i) => i >= BATTERY_BLOCKS - filled);
}
