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

export function formatReading(r) {
  const unit = (PREFIX[r.unitMultiplier] ?? '') + (UNIT[r.baseUnit] ?? '');
  const coupling = COUPLING[r.baseUnit] ?? '';
  const text =
    r.state in STATE_TEXT
      ? STATE_TEXT[r.state]
      : (r.value / 10 ** r.unitMultiplier).toFixed(Math.max(0, r.decimalPlaces));
  return { text, unit, coupling, ok: r.state === 'NORMAL' };
}

export function prettyFunction(name) {
  return name === 'NONE' ? '' : name.replaceAll('_', ' ');
}
