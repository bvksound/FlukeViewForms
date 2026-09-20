// The "Saved readings" card and the Save reading button: capture the live reading, describe it, export or copy it.
import { toCsv } from './csv.js';
import { localTimestamp } from './graph-text.js';
import { readingsTable } from './readings.js';

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// store: a ReadingsStore. getReading(): the live reading { t, function, text, value, unit, state } or null.
// onCopy(rows): hands the rows to the report. els: body (tbody), count, navCount (optional badge), saveButton, copyButton, csvButton, clearButton, message.
export function initReadings({ store, getReading, onCopy, els }) {
  let saveTimer;
  let flashTimer;

  const say = (text, bad = false) => {
    els.message.textContent = text;
    els.message.classList.toggle('bad', bad);
  };

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      store.save();
      if (!store.persistent) say('Browser storage is unavailable: saved readings last for this session only.', true);
    }, 250);
  }

  function draw() {
    els.body.replaceChildren(...store.rows.map((row, i) => el('tr', {},
      el('td', { className: 'r-n', textContent: String(i + 1) }),
      el('td', { className: 'r-time', textContent: localTimestamp(row.t).slice(0, 19) }),
      el('td', { textContent: row.function }),
      el('td', { className: `r-reading${row.state && row.state !== 'NORMAL' ? ' r-bad' : ''}`, textContent: row.text }),
      el('td', {}, Object.assign(el('input', { value: row.description, maxLength: 200, placeholder: 'Description', 'aria-label': `Description of reading ${i + 1}` }), {
        oninput: (e) => {
          row.description = e.target.value;
          persist();
        },
      })),
      el('td', {}, el('button', {
        className: 'p-x', textContent: '×', title: 'Remove this reading',
        onclick: () => {
          store.remove(i);
          draw();
        },
      })))));
    if (!store.rows.length) els.body.append(el('tr', {}, el('td', { colSpan: 6, className: 'r-empty', textContent: 'Nothing saved yet. Press "Save reading" next to the big reading to capture it here.' })));
    els.count.textContent = `${store.rows.length} reading${store.rows.length === 1 ? '' : 's'}`;
    if (els.navCount) els.navCount.textContent = String(store.rows.length);
    for (const b of [els.copyButton, els.csvButton, els.clearButton]) b.disabled = !store.rows.length;
  }

  // Captures the reading on the display right now.
  function add() {
    const r = getReading();
    if (!r) return say('There is no live reading yet: connect the meter first.', true);
    const row = store.add({ ...r, description: '' });
    if (!row) return say('The table is full. Clear some readings first.', true);
    draw();
    els.body.querySelector('tr:last-child input')?.scrollIntoView({ block: 'nearest' });
    persist();
    say(`Saved reading ${store.rows.length}: ${row.text}`);
    els.saveButton.textContent = 'Saved ✓';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (els.saveButton.textContent = 'Save reading'), 1200);
  }

  els.saveButton.onclick = add;
  els.copyButton.onclick = () => {
    onCopy(store.rows.map((r) => ({ ...r })));
    say(`Copied ${store.rows.length} reading${store.rows.length === 1 ? '' : 's'} to the report as a table. Open the Report section to add a description and export.`);
  };
  els.csvButton.onclick = () => {
    const { header, rows } = readingsTable(store.rows);
    const a = el('a', { href: URL.createObjectURL(new Blob([toCsv(header, rows)], { type: 'text/csv' })), download: `fluke287-readings-${new Date().toISOString().replace(/[:.]/g, '-')}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
    say(`Saved a CSV with ${store.rows.length} readings`);
  };
  els.clearButton.onclick = () => {
    if (!confirm(`Remove all ${store.rows.length} saved readings? This cannot be undone.`)) return;
    store.clear();
    draw();
    say('Cleared the saved readings');
  };

  draw();

  return {
    // Save reading is only useful while there is a live reading.
    refresh() {
      els.saveButton.disabled = !getReading();
    },
    add,
  };
}
