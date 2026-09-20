// The "Reports" panel: the report page itself, on screen. Type into the fields where they appear, click the logo slot
// to add a logo of your own, and build the body from elements you add on purpose: a copy of the graph, or a copy of the
// Saved readings table, each with a description. Then export the PDF.
// The layout (title, fields, logo) is remembered for the next report; the elements are for this report only.
import { formatQuantity } from './format.js';
import { FOOTER_TEXT, formatDuration, buildReportPdf, summarize } from './report.js';
import { MAX_FIELDS, choiceOptions } from './templates.js';
import { FLUKE_LOGO, BVK_LOGO } from './logos.js';
import { localTimestamp } from './graph-text.js';

const MAX_ELEMENTS = 20;
const TYPE_LABELS = { text: 'Text', multiline: 'Multi-line', date: 'Date', choice: 'Choice' };

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const today = () => localTimestamp(Date.now()).slice(0, 10);
const shortTime = (ms) => localTimestamp(ms).slice(0, 19);

function saveBlob(blob, filename) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}

// A picked image, scaled down and flattened onto white as a JPEG data URL (small enough to store with the layout).
async function logoFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file could not be read as an image'));
      i.src = url;
    });
    const w0 = img.naturalWidth || 300;
    const h0 = img.naturalHeight || 100;
    for (const [maxW, quality] of [[600, 0.9], [400, 0.85], [240, 0.8]]) {
      const scale = Math.min(1, maxW / w0, 200 / h0);
      const canvas = el('canvas', { width: Math.max(1, Math.round(w0 * scale)), height: Math.max(1, Math.round(h0 * scale)) });
      const g = canvas.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrl.length <= 300_000) return dataUrl;
    }
    throw new Error('That image is too large to store');
  } finally {
    URL.revokeObjectURL(url);
  }
}

// store: a TemplateStore holding the one layout in use.
// getData(): async, the graph as it is now: { meter, section: { title, unit, points, total, selection, image } }.
// getMeter(): the connected meter's details for the instrument line, or null.
// els: paper, include, exportButton, previewButton, copyButton (graph), resetButton, message
export function initForms({ store, getData, getMeter, els }) {
  let template = store.list()[0];
  let elements = []; // the body of this report, in order
  let instrumentNode = null;
  let nextId = 1;
  let saveTimer;

  const say = (text, bad = false) => {
    els.message.textContent = text;
    els.message.classList.toggle('bad', bad);
  };

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      store.save(template); // the page keeps editing this same object; the store keeps its own validated copy
      if (!store.persistent) say('Browser storage is unavailable: this layout lasts for this session only.', true);
    }, 250);
  }

  // Anything typed on the page goes straight into the layout or the element.
  const bind = (input, apply, save = true) => {
    input.addEventListener('input', () => {
      apply(input.value);
      if (save) persist();
    });
    return input;
  };

  // ---- the include switches above the page: what a copied graph brings along
  const blocks = [['meter', 'Instrument line'], ['graph', 'Graph image'], ['summary', 'Summary'], ['table', 'Data table']];
  els.include.replaceChildren(el('span', { className: 'hint', textContent: 'Include:' }),
    ...blocks.map(([key, label]) => {
      const box = el('input', { type: 'checkbox', checked: template.blocks[key] });
      box.addEventListener('change', () => {
        template.blocks[key] = box.checked;
        persist();
        renderElements();
        refresh();
      });
      return el('label', { className: 'inl' }, box, ` ${label}`);
    }));

  const removeButton = (title, onClick) => el('button', { className: 'p-x', textContent: '×', title, onclick: onClick });

  // ---- a copied graph, as it will appear in the PDF
  function graphBlock(item) {
    const section = item.section;
    const s = summarize(section.points);
    const q = (v) => (v == null ? '-' : formatQuantity(v, section.unit));
    const node = el('div', { className: 'p-element' },
      el('div', { className: 'p-section-head' }, el('h3', { textContent: section.title || 'Graph' }),
        removeButton('Remove this graph from the report', () => {
          URL.revokeObjectURL(item.previewUrl);
          elements = elements.filter((e) => e !== item);
          renderElements();
        })),
      bind(el('input', { className: 'p-desc', value: item.description, maxLength: 500, placeholder: 'Description (optional)', 'aria-label': 'Graph description' }), (v) => (item.description = v), false));
    node.append(el('p', { className: 'p-muted', textContent: `${shortTime(s.start)}  -  ${shortTime(s.end)}   ·   ${section.selection ? `${section.points.length} of ${section.total} points, between the cursors` : `${section.points.length} points`}` }));
    if (template.blocks.graph && item.previewUrl) node.append(el('img', { className: 'p-graph', src: item.previewUrl, alt: `Graph: ${section.title}` }));
    if (template.blocks.summary) {
      node.append(el('div', { className: 'p-summary' }, ...[
        ['Samples', String(s.count)], ['Duration', formatDuration(s.end - s.start)], ['Minimum', q(s.min)], ['Maximum', q(s.max)],
        ['Average', q(s.mean)], ['Peak to peak', s.min == null ? '-' : q(s.max - s.min)],
      ].map(([label, value]) => el('div', {}, el('small', { textContent: label }), value))));
    }
    if (template.blocks.table) node.append(el('p', { className: 'p-muted', textContent: `A table of up to ${template.table.maxRows} samples follows in the PDF.` }));
    return node;
  }

  // ---- a copy of the Saved readings table: time, function, reading, and a description you can still edit here
  function tableBlock(item) {
    const body = el('tbody');
    const draw = () => {
      body.replaceChildren(...item.rows.map((row, i) => el('tr', {},
        el('td', { textContent: shortTime(row.t) }),
        el('td', { textContent: row.function }),
        el('td', { className: 'p-reading', textContent: row.text }),
        el('td', {}, bind(el('input', { value: row.description, maxLength: 200, placeholder: 'Description', 'aria-label': 'Description of this reading' }), (v) => (row.description = v), false)),
        el('td', {}, removeButton('Remove this reading from the report', () => {
          item.rows.splice(i, 1);
          draw();
        })))));
      if (!item.rows.length) body.append(el('tr', {}, el('td', { colSpan: 5, className: 'p-muted', textContent: 'No readings in this table.' })));
    };
    draw();
    return el('div', { className: 'p-element' },
      el('div', { className: 'p-section-head' }, el('h3', { textContent: 'Readings' }),
        removeButton('Remove this table from the report', () => {
          elements = elements.filter((e) => e !== item);
          renderElements();
        })),
      bind(el('input', { className: 'p-desc', value: item.description, maxLength: 500, placeholder: 'Description (optional)', 'aria-label': 'Table description' }), (v) => (item.description = v), false),
      el('table', { className: 'p-table' }, el('thead', {}, el('tr', {}, ...['Time', 'Function', 'Reading', 'Description', ''].map((h) => el('th', { textContent: h })))), body));
  }

  // The body of the report: the elements added so far.
  function renderElements() {
    const host = els.paper.querySelector('.p-elements');
    if (!host) return;
    host.replaceChildren(...(elements.length
      ? elements.map((e) => (e.type === 'table' ? tableBlock(e) : graphBlock(e)))
      : [el('p', { className: 'p-hint', textContent: 'Nothing added yet. "Copy graph to report" adds the graph as it is now, and "Copy table to report" in the Saved readings card adds that table. Each can have a description.' })]));
    els.copyButton.disabled = elements.length >= MAX_ELEMENTS;
    refresh();
  }

  // ---- the page
  function render() {
    const t = template;

    // header: the built-in Fluke logo, a title and subtitle you can edit, and one optional logo of your own
    const extra = t.extraLogo
      ? el('div', { className: 'p-extra' },
        el('img', { src: t.extraLogo, alt: 'Additional logo' }),
        removeButton('Remove this logo', () => {
          t.extraLogo = null;
          persist();
          render();
        }))
      : el('button', { className: 'p-add-logo', textContent: '+ Add a logo', title: 'Optional, for example a customer logo' });
    const pick = el('input', { type: 'file', accept: 'image/*', hidden: true });
    const chooseLogo = () => pick.click();
    if (!t.extraLogo) extra.onclick = chooseLogo;
    else extra.querySelector('img').onclick = chooseLogo;
    pick.addEventListener('change', async () => {
      if (!pick.files[0]) return;
      try {
        t.extraLogo = await logoFromFile(pick.files[0]);
        persist();
        render();
      } catch (e) {
        say(e.message, true);
      }
    });
    const head = el('div', { className: 'p-head' },
      el('img', { className: 'p-fluke', src: FLUKE_LOGO, alt: 'Fluke' }),
      el('div', { className: 'p-titles' },
        bind(el('input', { className: 'p-title', value: t.header.title, maxLength: 120, placeholder: 'Report title', 'aria-label': 'Report title' }), (v) => (t.header.title = v)),
        bind(el('input', { className: 'p-subtitle', value: t.header.subtitle, maxLength: 200, placeholder: 'Subtitle (optional)', 'aria-label': 'Subtitle' }), (v) => (t.header.subtitle = v)),
        el('span', { className: 'p-muted', textContent: `Generated ${localTimestamp(Date.now()).slice(0, 16)}` })),
      el('div', { className: 'p-logo-slot' }, extra, pick));

    // fields: label and value on the page; a small control appears on hover to change the type or remove it
    const fieldNodes = t.fields.map((f, i) => {
      let value;
      if (f.type === 'multiline') value = el('textarea', { rows: 3, value: f.value, maxLength: 2000, 'aria-label': f.label });
      else if (f.type === 'date') value = el('input', { type: 'date', value: f.value || today(), 'aria-label': f.label });
      else if (f.type === 'choice') {
        value = el('select', { 'aria-label': f.label }, el('option', { value: '', textContent: '' }), ...choiceOptions(f).map((o) => el('option', { value: o, textContent: o })));
        value.value = f.value;
      } else value = el('input', { type: 'text', value: f.value, maxLength: 300, 'aria-label': f.label });
      bind(value, (v) => (f.value = v));
      const type = el('select', { className: 'p-type', title: 'Field type', 'aria-label': `Type of ${f.label}` },
        ...Object.entries(TYPE_LABELS).map(([k, label]) => el('option', { value: k, textContent: label })));
      type.value = f.type;
      type.onchange = () => {
        f.type = type.value;
        if (f.type === 'choice' && !f.options) f.options = 'Pass, Fail';
        persist();
        render();
      };
      const remove = removeButton('Remove this field', () => {
        t.fields.splice(i, 1);
        persist();
        render();
      });
      const options = f.type === 'choice'
        ? bind(el('input', { className: 'p-options', value: f.options, placeholder: 'Options, separated by commas', maxLength: 300 }), (v) => {
          f.options = v;
        })
        : null;
      if (options) options.addEventListener('change', render); // rebuild the choices once you are done typing them
      return el('div', { className: `p-field${f.type === 'multiline' ? ' wide' : ''}` },
        bind(el('input', { className: 'p-label', value: f.label, maxLength: 60, 'aria-label': 'Field name' }), (v) => (f.label = v || 'Field')),
        value, options ?? '', el('span', { className: 'p-fx' }, type, remove));
    });
    const addType = el('select', { 'aria-label': 'New field type' }, ...Object.entries(TYPE_LABELS).map(([k, label]) => el('option', { value: k, textContent: label })));
    const add = el('button', { className: 'btn btn-ghost btn-sm', textContent: '+ Add field', disabled: t.fields.length >= MAX_FIELDS });
    add.onclick = () => {
      t.fields.push({ id: `f-${Date.now().toString(36)}`, label: 'New field', type: addType.value, options: addType.value === 'choice' ? 'Pass, Fail' : '', value: '' });
      persist();
      render();
    };

    instrumentNode = el('p', { className: 'p-muted p-instrument' });
    const footer = el('div', { className: 'p-foot' },
      el('img', { src: BVK_LOGO, alt: 'BVK', className: 'p-bvk' }),
      el('span', { className: 'p-footer-text', textContent: FOOTER_TEXT }),
      el('span', { className: 'p-muted', textContent: 'Page 1 of 1' }));

    els.paper.replaceChildren(head, el('div', { className: 'p-fields' }, ...fieldNodes),
      el('div', { className: 'p-addrow' }, addType, add), instrumentNode, el('div', { className: 'p-elements' }), footer);
    renderElements();
  }

  // The parts of the page that follow the meter; called as they change.
  function refresh() {
    if (!instrumentNode) return;
    const m = getMeter();
    instrumentNode.textContent = template.blocks.meter && m
      ? `Instrument: ${[m.model, m.serial && `serial ${m.serial}`, m.firmware && `firmware ${m.firmware}`, m.owner?.company, m.owner?.site, m.owner?.operator].filter(Boolean).join('  ·  ')}`
      : '';
  }

  // ---- actions
  const buttons = [els.exportButton, els.previewButton, els.copyButton];
  async function run(work) {
    for (const b of buttons) b.disabled = true;
    say('Working...');
    try {
      await work();
      return true;
    } catch (e) {
      console.error(e);
      say(`Could not do that: ${e.message}`, true);
      return false;
    } finally {
      for (const b of buttons) b.disabled = false;
      renderElements();
    }
  }

  // The elements in the shape the PDF builder wants.
  const forPdf = () => elements.map((e) => (e.type === 'table'
    ? { type: 'table', title: 'Readings', description: e.description, rows: e.rows.map((r) => ({ t: r.t, function: r.function, text: r.text, description: r.description })) }
    : { type: 'graph', description: e.description, ...e.section }));

  async function generate() {
    store.save(template);
    return buildReportPdf({ template, data: { meter: getMeter(), elements: forPdf() }, now: new Date() });
  }

  els.exportButton.onclick = () => run(async () => {
    const bytes = await generate();
    saveBlob(new Blob([bytes], { type: 'application/pdf' }), `fluke287-report-${stamp()}.pdf`);
    say(`Saved the PDF (${Math.round(bytes.length / 1024)} KB)`);
  });

  els.previewButton.onclick = () => {
    const tab = window.open('', '_blank'); // opened now, inside the click, so pop-up blockers allow it
    return run(async () => {
      const bytes = await generate();
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      if (tab) {
        tab.location.href = url;
        say('Opened the PDF in a new tab');
      } else {
        saveBlob(new Blob([bytes], { type: 'application/pdf' }), 'fluke287-report-preview.pdf');
        say('Pop-ups are blocked, so the PDF was downloaded instead');
      }
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    }).then((ok) => ok || tab?.close());
  };

  // Copies the graph as it is now (with its cursors) into the report as an element. Resolves to a message saying
  // what happened, for whoever asked (the graph card shows it there).
  async function copyGraph() {
    let message = '';
    await run(async () => {
      if (elements.length >= MAX_ELEMENTS) throw new Error(`A report holds at most ${MAX_ELEMENTS} elements`);
      const { section } = await getData();
      if (!section.points.length) throw new Error('The graph is empty, so there is nothing to copy yet');
      elements.push({ id: nextId++, type: 'graph', description: '', section, previewUrl: URL.createObjectURL(new Blob([section.image], { type: 'image/jpeg' })) });
      message = `Copied "${section.title}" to the report (${section.points.length} points)`;
      say(`${message}. Add a description if you like.`);
    });
    return message || els.message.textContent;
  }
  els.copyButton.onclick = copyGraph;

  els.resetButton.onclick = () => {
    if (!confirm('Reset the report page? The built-in layout comes back (your field names, entries and logo are cleared) and the graphs and tables you added are removed.')) return;
    for (const e of elements) if (e.previewUrl) URL.revokeObjectURL(e.previewUrl);
    elements = [];
    store.remove(template.id);
    template = store.list()[0];
    render();
    say('Reset the report page');
  };

  render();

  return {
    refresh,
    copyGraph,
    // Adds a copy of the Saved readings table to the report.
    addTable(rows) {
      if (elements.length >= MAX_ELEMENTS) return say(`A report holds at most ${MAX_ELEMENTS} elements.`, true);
      elements.push({ id: nextId++, type: 'table', description: '', rows: rows.map((r) => ({ ...r })) });
      renderElements();
      say(`Added a table of ${rows.length} reading${rows.length === 1 ? '' : 's'} to the report.`);
    },
  };
}
