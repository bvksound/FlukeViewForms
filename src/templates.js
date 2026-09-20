// Report templates: what a report looks like (page, logo, title, fields to fill in, content blocks, footer).
// Stored as JSON in the browser and importable/exportable as files, so they are validated on every way in.

export const PAGE_SIZES = { A4: [595.28, 841.89], Letter: [612, 792] };
export const FIELD_TYPES = ['text', 'multiline', 'date', 'choice'];
export const MAX_FIELDS = 30;
export const DEFAULT_SUBTITLE = 'Fluke 287 Data Logger';
// Earlier builds saved the default in lowercase; layouts stored in the browser are corrected when they load.
const OLD_SUBTITLE = 'Fluke 287 data logger';
const MAX_LOGO_CHARS = 400_000; // a downscaled JPEG data URL is far smaller than this
const FORMAT = 'fluke287-templates';

// Only JPEG data URLs of a sane size are accepted as logos; the PDF embeds them as they are.
const jpegDataUrl = (v) => (typeof v === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= MAX_LOGO_CHARS ? v : null);
const text = (v, max, fallback = '') => (typeof v === 'string' ? v.slice(0, max) : fallback);
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

export function newId(prefix = 'tpl') {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// The built-in minimalist report: a few fields to fill in, the graph and its summary. (The Fluke logo at the top and the
// BVK logo in the footer are built into every report; a template can add one more logo of its own.)
export function defaultTemplate() {
  return normalizeTemplate({
    name: 'Minimal report',
    header: { title: 'Measurement report', subtitle: DEFAULT_SUBTITLE },
    fields: [
      { label: 'Customer', type: 'text' },
      { label: 'Location', type: 'text' },
      { label: 'Operator', type: 'text' },
      { label: 'Comment', type: 'multiline' },
    ],
  });
}

// Coerces anything (imported JSON, an older version, a half-edited draft) into a valid template.
export function normalizeTemplate(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const header = r.header ?? {};
  const blocks = r.blocks ?? {};
  const rows = Number.parseInt(r.table?.maxRows, 10);
  return {
    version: 1,
    id: typeof r.id === 'string' && /^[\w-]{1,48}$/.test(r.id) ? r.id : newId(),
    name: text(r.name, 80, 'Untitled template').trim() || 'Untitled template',
    page: {
      size: oneOf(r.page?.size, Object.keys(PAGE_SIZES), 'A4'),
      orientation: oneOf(r.page?.orientation, ['portrait', 'landscape'], 'portrait'),
    },
    header: {
      title: text(header.title, 120),
      subtitle: text(header.subtitle, 200) === OLD_SUBTITLE ? DEFAULT_SUBTITLE : text(header.subtitle, 200),
      showDate: bool(header.showDate, true),
    },
    fields: (Array.isArray(r.fields) ? r.fields : []).slice(0, MAX_FIELDS).map((f) => ({
      id: typeof f?.id === 'string' && /^[\w-]{1,48}$/.test(f.id) ? f.id : newId('f'),
      label: text(f?.label, 60, 'Field').trim() || 'Field',
      type: oneOf(f?.type, FIELD_TYPES, 'text'),
      options: text(f?.options, 300),
      value: text(f?.value, 2000),
    })),
    blocks: {
      meter: bool(blocks.meter, true),
      graph: bool(blocks.graph, true),
      summary: bool(blocks.summary, true),
      table: bool(blocks.table, false),
    },
    table: { maxRows: Number.isFinite(rows) ? Math.min(Math.max(rows, 10), 5000) : 200 },
    extraLogo: jpegDataUrl(r.extraLogo), // optional, shown top right, e.g. a customer's logo
  };
}

// Page size in points, honouring orientation.
export function pageSize(template) {
  const [w, h] = PAGE_SIZES[template.page.size] ?? PAGE_SIZES.A4;
  return template.page.orientation === 'landscape' ? [h, w] : [w, h];
}

export const choiceOptions = (field) => field.options.split(',').map((o) => o.trim()).filter(Boolean);

// Templates in browser storage (or any getItem/setItem store). If storage is unavailable they live in memory for
// the session, and `persistent` says so, so the page can warn.
export class TemplateStore {
  #storage;
  #key;
  #memory = null;
  persistent = true;

  constructor(storage, key = 'fluke287.templates') {
    this.#storage = storage;
    this.#key = key;
  }

  #read() {
    if (this.#memory) return this.#memory;
    try {
      const parsed = JSON.parse(this.#storage.getItem(this.#key) ?? 'null');
      if (Array.isArray(parsed)) return parsed.map(normalizeTemplate);
    } catch {
      /* unreadable or blocked: start over */
    }
    return [];
  }

  #write(list) {
    try {
      this.#storage.setItem(this.#key, JSON.stringify(list));
      this.persistent = true;
      this.#memory = null;
    } catch {
      this.persistent = false;
      this.#memory = list;
    }
  }

  // Always at least one template.
  list() {
    const list = this.#read();
    if (!list.length) {
      const first = defaultTemplate();
      this.#write([first]);
      return [first];
    }
    return list;
  }

  get(id) {
    return this.list().find((t) => t.id === id) ?? null;
  }

  save(template) {
    const clean = normalizeTemplate(template);
    const list = this.list();
    const at = list.findIndex((t) => t.id === clean.id);
    if (at >= 0) list[at] = clean;
    else list.push(clean);
    this.#write(list);
    return clean;
  }

  remove(id) {
    this.#write(this.list().filter((t) => t.id !== id));
  }

  duplicate(id) {
    const source = this.get(id);
    if (!source) return null;
    return this.save({ ...structuredClone(source), id: newId(), name: `${source.name} (copy)`.slice(0, 80) });
  }

  // Templates as a file's text. Field values are kept: they are the defaults for the next report.
  exportJson(ids = null) {
    const templates = this.list().filter((t) => !ids || ids.includes(t.id));
    return JSON.stringify({ format: FORMAT, version: 1, templates }, null, 2);
  }

  // Adds templates from a file's text under new ids; returns the templates added.
  importJson(source) {
    if (typeof source !== 'string' || source.length > 3_000_000) throw new Error('That file is too large to be a template');
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error('That file is not valid JSON');
    }
    const items = parsed?.format === FORMAT && Array.isArray(parsed.templates) ? parsed.templates : parsed?.name ? [parsed] : null;
    if (!items?.length) throw new Error('No templates found in that file');
    const existing = new Set(this.list().map((t) => t.name));
    return items.slice(0, 50).map((raw) => {
      const t = normalizeTemplate({ ...raw, id: undefined });
      if (existing.has(t.name)) t.name = `${t.name} (imported)`.slice(0, 80);
      existing.add(t.name);
      return this.save(t);
    });
  }
}
