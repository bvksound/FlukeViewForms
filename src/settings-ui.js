// The "Meter settings" panel: reads every property from the meter, and writes one at a time on Apply.
import { MeterError } from './meter.js';
import {
  ADVANCED, BASIC, OWNER_FIELDS, SAVE_SLOTS,
  localClockText, clockValueFor, meterClockToText, minutesToSeconds, secondsToMinutes,
} from './settings.js';

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

export function initSettings({ basic, advanced, message, getMeter }) {
  const rows = []; // { load(meter), reset() }

  const say = (text, bad = false) => {
    message.textContent = text;
    message.classList.toggle('bad', bad);
  };

  // One labelled row: a control, an Apply button that lights up when the value differs from the meter's.
  function addRow(parent, label, control, { read, write, hint = '', display = (v) => v }) {
    const apply = el('button', { className: 'btn btn-ghost btn-sm', textContent: 'Apply', disabled: true });
    let current = null;
    const isChanged = () => control.value !== current;
    const set = (value) => {
      current = value;
      control.value = display(value);
      current = control.value; // a <select> may normalise the value
      apply.disabled = true;
    };
    control.addEventListener('input', () => (apply.disabled = !isChanged() || !control.value.trim()));
    apply.onclick = async () => {
      const meter = getMeter();
      if (!meter) return;
      apply.disabled = true;
      try {
        await write(meter, control.value);
        set(await read(meter));
        say(`${label}: saved`);
      } catch (e) {
        say(`${label}: ${e instanceof MeterError ? `the meter rejected it (${e.message})` : e.message}`, true);
        apply.disabled = false;
      }
    };
    parent.append(el('div', { className: 'set-row' }, el('label', {}, label, hint ? el('small', { textContent: hint }) : ''), control, apply));
    rows.push({
      async load(meter) {
        control.disabled = false;
        try {
          set(await read(meter));
        } catch {
          control.value = '';
          control.placeholder = 'not available';
          control.disabled = true;
        }
      },
      reset() {
        control.value = '';
        apply.disabled = true;
      },
    });
  }

  const choice = (spec) => {
    const select = el('select', { id: `set-${spec.key}` });
    select.append(...spec.options.map(([value, text]) => el('option', { value, textContent: text })));
    return select;
  };

  function propertyRow(parent, spec) {
    const read = (m) => m.getProperty(spec.key);
    const write = (m, value) => m.setProperty(spec.key, spec.kind === 'minutes' ? minutesToSeconds(value) : value);
    let control;
    if (spec.kind === 'choice') {
      control = choice(spec);
      // A value the meter reports that we don't list still has to be shown.
      const inner = read;
      return addRow(parent, spec.label, control, {
        read: async (m) => {
          const v = await inner(m);
          if (![...control.options].some((o) => o.value === v)) control.append(el('option', { value: v, textContent: v }));
          return v;
        },
        write,
      });
    }
    if (spec.kind === 'minutes') {
      control = el('input', { type: 'number', min: 0, step: 1, id: `set-${spec.key}` });
      return addRow(parent, spec.label, control, { read, write, hint: 'minutes', display: (v) => String(secondsToMinutes(v)) });
    }
    control = el('input', { type: 'text', id: `set-${spec.key}`, readOnly: !!spec.readOnly, spellcheck: false });
    if (spec.readOnly) {
      // Read-only rows still show the value, with no Apply.
      const value = el('span', { className: 'set-value' });
      parent.append(el('div', { className: 'set-row' }, el('label', {}, spec.label), value, el('span')));
      rows.push({ load: async (m) => (value.textContent = await read(m).catch(() => 'not available')), reset: () => (value.textContent = '') });
      return;
    }
    addRow(parent, spec.label, control, { read, write });
  }

  // Clock: meter time next to computer time, with a one-click sync.
  const meterTime = el('span', { className: 'set-value' });
  const computerTime = el('span', { className: 'set-value' });
  const syncBtn = el('button', { className: 'btn btn-primary btn-sm', textContent: 'Sync to computer' });
  const readClock = async (m) => {
    meterTime.textContent = meterClockToText(await m.getProperty('clock'));
    computerTime.textContent = localClockText();
  };
  syncBtn.onclick = async () => {
    const meter = getMeter();
    if (!meter) return;
    try {
      await meter.setProperty('clock', clockValueFor(new Date()));
      await readClock(meter);
      say('Clock: synced to this computer');
    } catch (e) {
      say(`Clock: ${e.message}`, true);
    }
  };
  basic.append(el('div', { className: 'set-row' }, el('label', {}, 'Meter clock', el('small', { textContent: 'meter / computer' })),
    el('span', { className: 'set-clock' }, meterTime, ' / ', computerTime), syncBtn));
  rows.push({ load: readClock, reset: () => { meterTime.textContent = computerTime.textContent = ''; } });

  BASIC.forEach((spec) => propertyRow(basic, spec));
  ADVANCED.forEach((spec) => propertyRow(advanced, spec));

  for (const [field, label] of OWNER_FIELDS) {
    addRow(advanced, label, el('input', { type: 'text', id: `set-owner-${field}`, maxLength: 40, spellcheck: false }), {
      read: (m) => m.getOwnerField(field),
      write: (m, value) => m.setOwnerField(field, value.trim()),
      hint: 'owner',
    });
  }

  for (let i = 0; i < SAVE_SLOTS; i++) {
    addRow(advanced, `Save slot ${i + 1}`, el('input', { type: 'text', id: `set-save-${i}`, maxLength: 20, spellcheck: false }), {
      read: (m) => m.getSaveName(i),
      write: (m, value) => m.setSaveName(i, value.trim()),
      hint: 'name',
    });
  }

  return {
    async load() {
      const meter = getMeter();
      if (!meter) return;
      say('Reading settings…');
      for (const row of rows) await row.load(meter);
      say('');
    },
    reset() {
      rows.forEach((r) => r.reset());
      say('');
    },
  };
}
