// Parsers for the Fluke 287/289 remote interface (ASCII over 115200 8N1, CR-terminated).
// Source: "Fluke 289/287 Remote Interface Specification" (Fluke, 2007). See docs/protocol.md.

export class ProtocolError extends Error {}

export const ACK_MESSAGES = {
  0: 'OK',
  1: 'Syntax error',
  2: 'Execution error',
  5: 'No data available',
};

export function parseAck(line) {
  const code = line.trim();
  if (!(code in ACK_MESSAGES)) {
    throw new ProtocolError(`Unexpected acknowledge: ${JSON.stringify(line)}`);
  }
  return Number(code);
}

// "FLUKE 287,V1.00,95081087"
export function parseId(line) {
  const [model, firmware, serial] = line.split(',').map((s) => s.trim());
  if (!model?.startsWith('FLUKE')) {
    throw new ProtocolError(`Unexpected ID response: ${JSON.stringify(line)}`);
  }
  return { model, firmware, serial };
}

// "0.5498E0,VDC,NORMAL,GOOD_DIODE"
export function parseQm(line) {
  const [value, unit, state, attribute] = line.split(',').map((s) => s.trim());
  if (attribute === undefined) {
    throw new ProtocolError(`Unexpected QM response: ${JSON.stringify(line)}`);
  }
  return { value: Number(value), unit, state, attribute };
}

const READING_FIELDS = 9;

// One long line:
// primaryFunction,secondaryFunction,autoRangeState,baseUnit,rangeNumber,unitMultiplier,
// lightningBolt,minMaxStartTime,numberOfModes,<modes...>,numberOfReadings,<readings...>
// where each reading is:
// readingID,value,baseUnit,unitMultiplier,decimalPlaces,displayDigits,state,attribute,timeStamp
export function parseQdda(line) {
  const f = line.split(',').map((s) => s.trim());
  let i = 0;
  const next = () => {
    if (i >= f.length) throw new ProtocolError('QDDA response truncated');
    return f[i++];
  };

  const primaryFunction = next();
  const secondaryFunction = next();
  const range = {
    auto: next() === 'AUTO',
    baseUnit: next(),
    number: Number(next()),
    unitMultiplier: Number(next()),
  };
  const lightningBolt = next() === 'ON';
  const minMaxStartTime = Number(next());

  const modes = Array.from({ length: Number(next()) }, next);

  const readings = {};
  const count = Number(next());
  for (let n = 0; n < count; n++) {
    if (i + READING_FIELDS > f.length) throw new ProtocolError('QDDA reading truncated');
    const id = next();
    readings[id] = {
      id,
      value: Number(next()),
      baseUnit: next(),
      unitMultiplier: Number(next()),
      decimalPlaces: Number(next()),
      displayDigits: Number(next()),
      state: next(),
      attribute: next(),
      timestamp: Number(next()), // seconds since Unix epoch, meter clock
    };
  }

  return { primaryFunction, secondaryFunction, range, lightningBolt, minMaxStartTime, modes, readings };
}
