'use strict';
// Results webview: virtualized grid and JSON list (only the visible rows are in the DOM), a detail pane with the
// selected item, request charge and query metrics per page. No network: everything comes from the extension.
/* global acquireVsCodeApi, document, window */

const vscode = acquireVsCodeApi();
const boot = JSON.parse(document.getElementById('zovo-data').textContent || '{}');
const MARK = '\u0000ZN:';
const ROW_H = 22;
const SYS = ['_rid', '_self', '_etag', '_attachments', '_ts'];

const st = {
  items: [], columns: [], view: 'grid', sel: -1, showSys: false, stats: null, totalPages: 0, loadingAll: false,
  target: null, error: null, running: false, pageSize: boot.pageSize || 100, pk: '', bigCount: 0,
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c !== null && c !== undefined) e.append(c);
  return e;
};

const isMarker = (v) => typeof v === 'string' && v.startsWith(MARK);
/** Exact JSON: markers are written as bare numbers. */
function exactJson(v, space) {
  return JSON.stringify(v, null, space).replace(/"\\u0000ZN:(-?[0-9][0-9.eE+-]*)"/gi, '$1');
}
function fmt(n, d = 2) { return (Math.round((Number(n) || 0) * 10 ** d) / 10 ** d).toLocaleString('en-US'); }
function int(n) { return (Number(n) || 0).toLocaleString('en-US'); }

// ---------------------------------------------------------------- layout

const app = document.getElementById('app');
app.className = 'results';
const toolbar = el('div', { class: 'toolbar', role: 'toolbar' });
const banner = el('div', { class: 'banner', role: 'status', 'aria-live': 'polite' });
const statsLine = el('div', { class: 'stats', 'aria-live': 'polite' });
const metricsBox = el('details', { class: 'metrics' });
const main = el('div', { class: 'main' });
const viewport = el('div', { class: 'viewport', tabindex: '0', role: 'grid', 'aria-label': 'Query results' });
const spacer = el('div', { class: 'spacer' });
const rowsBox = el('div', { class: 'rows' });
const headerRow = el('div', { class: 'hrow', role: 'row' });
viewport.append(headerRow, spacer);
spacer.append(rowsBox);
const detail = el('div', { class: 'detail', 'aria-label': 'Selected item' });
main.append(viewport, detail);
const empty = el('div', { class: 'empty' }, 'Run a query: Ctrl+Enter (Cmd+Enter on macOS) in a .nosql file, or click a container in the Cosmos DB Explorer.');
app.append(toolbar, banner, statsLine, metricsBox, main, empty);

const btn = (label, title, on, cls = '') => el('button', { class: `btn ${cls}`, title, type: 'button', onclick: on }, label);
const bRerun = btn('Run again', 'Run the query again from the first page', () => rerun());
const bMore = btn('Load more', 'Read the next page (continuation token)', () => { setRunning(true); vscode.postMessage({ type: 'more' }); }, 'primary');
const bAll = btn('Load all', 'Keep reading pages until the end. Stop any time.', () => vscode.postMessage({ type: 'all' }));
const bStop = btn('Stop', 'Stop reading pages', () => vscode.postMessage({ type: 'stop' }), 'danger');
const inSize = el('input', { class: 'num', type: 'number', min: '1', max: '1000', value: String(st.pageSize), title: 'Items per page (max item count)', 'aria-label': 'Items per page' });
const inPk = el('input', { class: 'pk', type: 'text', placeholder: 'all partitions', title: 'Partition key value: empty = query across all partitions. Hierarchical keys: a JSON array, e.g. ["acme","eu"].', 'aria-label': 'Partition key value' });
inPk.addEventListener('keydown', (e) => { if (e.key === 'Enter') rerun(); });
inSize.addEventListener('keydown', (e) => { if (e.key === 'Enter') rerun(); });
const cbSys = el('input', { type: 'checkbox', id: 'cb-sys' });
cbSys.addEventListener('change', () => { st.showSys = cbSys.checked; renderHeader(); renderRows(true); });
const segGrid = btn('Grid', 'Show items as a table', () => setView('grid'), 'seg on');
const segJson = btn('JSON', 'Show items as JSON lines', () => setView('json'), 'seg');
const expSel = el('select', { title: 'Export every item of this query (streamed to a file)', 'aria-label': 'Export' },
  el('option', { value: '' }, 'Export…'), el('option', { value: 'json' }, 'JSON'), el('option', { value: 'jsonl' }, 'JSONL'), el('option', { value: 'csv' }, 'CSV'));
expSel.addEventListener('change', () => { if (expSel.value) vscode.postMessage({ type: 'export', format: expSel.value }); expSel.value = ''; });
const bNew = btn('New item', 'Create an item in this container', () => vscode.postMessage({ type: 'newItem' }));
toolbar.append(bRerun, bMore, bAll, bStop,
  el('span', { class: 'sep' }), el('label', { class: 'lab' }, 'Page ', inSize),
  el('label', { class: 'lab' }, 'Partition key ', inPk),
  el('span', { class: 'sep' }), segGrid, segJson,
  el('label', { class: 'lab cb', for: 'cb-sys' }, cbSys, ' system properties'),
  el('span', { class: 'grow' }), bNew, expSel);

function rerun() {
  setRunning(true);
  vscode.postMessage({ type: 'rerun', pageSize: Number(inSize.value) || st.pageSize, partitionKey: inPk.value });
}

function setView(v) {
  st.view = v;
  segGrid.classList.toggle('on', v === 'grid');
  segJson.classList.toggle('on', v === 'json');
  renderHeader();
  renderRows(true);
}

function setRunning(on) {
  st.running = on;
  app.classList.toggle('busy', on);
}

function updateButtons() {
  const s = st.stats;
  const more = !!(s && s.hasMore);
  bMore.disabled = !more || st.loadingAll || st.running;
  bAll.disabled = !more || st.loadingAll || st.running;
  bStop.hidden = !st.loadingAll;
  bAll.hidden = st.loadingAll;
  bNew.disabled = !st.target || st.target.readOnly;
  bNew.title = st.target && st.target.readOnly ? 'This connection is read-only' : 'Create an item in this container';
}

// ---------------------------------------------------------------- columns and cells

function visibleColumns() {
  return st.columns.filter((c) => st.showSys || !SYS.includes(c));
}

const widths = new Map();
function colWidth(c) {
  if (widths.has(c)) return widths.get(c);
  let w = Math.max(60, c.length * 8 + 24);
  for (let i = 0; i < Math.min(st.items.length, 60); i++) {
    const t = cellText(st.items[i] && st.items[i][c]);
    w = Math.max(w, Math.min(320, t.length * 7 + 20));
  }
  w = Math.min(w, 320);
  widths.set(c, w);
  return w;
}

function cellText(v) {
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (isMarker(v)) return v.slice(MARK.length);
  if (typeof v === 'object') { const s = exactJson(v); return s.length > 300 ? `${s.slice(0, 300)}…` : s; }
  const s = String(v);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

function cell(v) {
  const td = el('div', { class: 'cell', role: 'gridcell' });
  if (v === undefined) { td.classList.add('undef'); return td; }
  if (v === null) { td.classList.add('null'); td.textContent = 'null'; return td; }
  if (isMarker(v)) {
    td.classList.add('num', 'big');
    td.append(el('span', { class: 'badge', title: 'Exact value: more digits than a JavaScript number holds. Shown and saved exactly as stored.' }, '⚠'), v.slice(MARK.length));
    return td;
  }
  if (typeof v === 'number') td.classList.add('num');
  else if (typeof v === 'boolean') td.classList.add('bool');
  else if (typeof v === 'object') td.classList.add('obj');
  td.textContent = cellText(v);
  return td;
}

// ---------------------------------------------------------------- rendering (virtualized)

function renderHeader() {
  headerRow.textContent = '';
  if (st.view !== 'grid') { headerRow.hidden = true; return; }
  headerRow.hidden = false;
  headerRow.append(el('div', { class: 'cell idx' }, '#'));
  for (const c of visibleColumns()) {
    const h = el('div', { class: 'cell head', role: 'columnheader', title: c }, c);
    h.style.width = `${colWidth(c)}px`;
    headerRow.append(h);
  }
}

let lastRange = '';
function renderRows(force) {
  const n = st.items.length;
  empty.hidden = n > 0 || !!st.error || !!st.stats;
  spacer.style.height = `${n * ROW_H}px`;
  const top = Math.max(0, viewport.scrollTop - (headerRow.hidden ? 0 : ROW_H));
  const h = viewport.clientHeight || 600;
  const from = Math.max(0, Math.floor(top / ROW_H) - 10);
  const to = Math.min(n, Math.ceil((top + h) / ROW_H) + 10);
  const key = `${from}:${to}:${st.view}:${st.sel}:${n}`;
  if (!force && key === lastRange) return;
  lastRange = key;
  rowsBox.textContent = '';
  rowsBox.style.transform = `translateY(${from * ROW_H}px)`;
  const cols = visibleColumns();
  const frag = document.createDocumentFragment();
  for (let i = from; i < to; i++) {
    const it = st.items[i];
    const row = el('div', { class: `row${i === st.sel ? ' sel' : ''}`, role: 'row', 'data-i': String(i), 'aria-selected': i === st.sel ? 'true' : 'false' });
    row.append(el('div', { class: 'cell idx' }, String(i + 1)));
    if (st.view === 'grid') {
      for (const c of cols) { const td = cell(it ? it[c] : undefined); td.style.width = `${colWidth(c)}px`; row.append(td); }
    } else {
      const shown = st.showSys ? it : stripSys(it);
      let s = exactJson(shown);
      if (s.length > 2000) s = `${s.slice(0, 2000)}…`;
      row.append(el('div', { class: 'cell jsonline' }, s));
    }
    frag.append(row);
  }
  rowsBox.append(frag);
}

function stripSys(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  const out = {};
  for (const k of Object.keys(o)) if (!SYS.includes(k)) out[k] = o[k];
  return out;
}

function renderDetail() {
  detail.textContent = '';
  const it = st.items[st.sel];
  if (!it) { detail.hidden = true; return; }
  detail.hidden = false;
  const ro = st.target && st.target.readOnly;
  const bar = el('div', { class: 'dbar' },
    el('strong', { class: 'did', title: String(it.id) }, String(it.id)),
    el('span', { class: 'grow' }),
    btn('Open', 'Open the item in an editor; Ctrl+S saves it back (ETag checked)', () => vscode.postMessage({ type: 'open', index: st.sel }), 'primary'),
    btn('Copy', 'Copy the item JSON (exact numbers)', () => vscode.postMessage({ type: 'copy', index: st.sel, system: st.showSys })),
    btn('Delete', ro ? 'This connection is read-only' : 'Delete this item (asks first)', () => vscode.postMessage({ type: 'delete', index: st.sel }), 'danger'),
    btn('×', 'Close the detail pane', () => { st.sel = -1; renderDetail(); renderRows(true); }));
  bar.querySelectorAll('.btn')[2].disabled = !!ro;
  let text = exactJson(st.showSys ? it : stripSys(it), 2);
  let note = null;
  if (text.length > 262144) { text = `${text.slice(0, 262144)}\n…`; note = el('div', { class: 'note' }, 'Large item: the first 256 KB are shown. Open it to see and edit all of it.'); }
  const big = countBig(it);
  const parts = [bar, big ? el('div', { class: 'note warn' }, `⚠ ${big} number${big > 1 ? 's have' : ' has'} more digits than JavaScript holds. They are shown and saved exactly as stored.`) : null, note, el('pre', { class: 'json' }, text)];
  detail.append(...parts.filter(Boolean)); // append(null) would print the word null
}

function countBig(v, d = 0) {
  if (d > 40) return 0;
  if (isMarker(v)) return 1;
  if (Array.isArray(v)) return v.reduce((a, x) => a + countBig(x, d + 1), 0);
  if (v && typeof v === 'object') return Object.values(v).reduce((a, x) => a + countBig(x, d + 1), 0);
  return 0;
}

function renderStats() {
  const s = st.stats;
  statsLine.textContent = '';
  if (!s) return;
  const m = s.metrics || {};
  const parts = [
    el('span', { class: 'kv strong', title: 'Items read so far' }, `${int(s.read)} items`),
    el('span', { class: 'kv', title: 'Pages read through the continuation token' }, `${int(s.pagesRead)} page${s.pagesRead === 1 ? '' : 's'}`),
    el('span', { class: 'kv ru', title: 'Request units of all pages of this query' }, `${fmt(s.totalCharge)} RU total`),
    el('span', { class: 'kv ru', title: 'Request units of the last page' }, `last page ${fmt(s.charge)} RU · ${int(s.items)} items · ${int(s.ms)} ms`),
  ];
  if (m.retrievedDocumentCount !== undefined) parts.push(el('span', { class: 'kv', title: 'Documents the engine loaded vs. documents returned (last page)' }, `retrieved ${int(m.retrievedDocumentCount)} / output ${int(m.outputDocumentCount)}`));
  if (m.indexHitRatio !== undefined) parts.push(el('span', { class: 'kv', title: 'Share of retrieved documents that matched through the index (last page)' }, `index hit ${fmt(m.indexHitRatio * 100, 0)} %`));
  if (s.hasMore) parts.push(el('span', { class: 'kv more' }, 'more results available'));
  else parts.push(el('span', { class: 'kv done' }, 'end of results'));
  if (s.capped || s.read > s.loaded) parts.push(el('span', { class: 'kv warn', title: 'Setting zovoCosmos.maxLoadedItems' }, `${int(s.loaded)} kept in this view (limit ${int(s.max)}); Export streams every item`));
  if (st.bigCount) parts.push(el('span', { class: 'kv warn' }, `⚠ ${int(st.bigCount)} exact big number${st.bigCount > 1 ? 's' : ''}`));
  for (const p of parts) statsLine.append(p);
  renderMetrics();
}

const METRIC_LABELS = {
  totalExecutionTimeInMs: 'Execution time (ms)', queryCompileTimeInMs: 'Compile time (ms)', queryLogicalPlanBuildTimeInMs: 'Logical plan (ms)',
  queryPhysicalPlanBuildTimeInMs: 'Physical plan (ms)', queryOptimizationTimeInMs: 'Optimization (ms)', indexLookupTimeInMs: 'Index lookup (ms)',
  documentLoadTimeInMs: 'Document load (ms)', VMExecutionTimeInMs: 'Runtime execution (ms)', documentWriteTimeInMs: 'Document write (ms)',
  retrievedDocumentCount: 'Retrieved documents', retrievedDocumentSize: 'Retrieved size (bytes)', outputDocumentCount: 'Output documents',
  outputDocumentSize: 'Output size (bytes)', indexHitRatio: 'Index hit ratio', partitions: 'Partition ranges',
};

function renderMetrics() {
  const s = st.stats;
  metricsBox.textContent = '';
  const m = (s && s.metrics) || null;
  metricsBox.append(el('summary', {}, m ? `Query metrics, page ${s.page}` : 'Query metrics: none returned for this page'));
  if (!m) return;
  const tbl = el('table', { class: 'mt' });
  for (const [k, label] of Object.entries(METRIC_LABELS)) {
    if (m[k] === undefined) continue;
    const v = k === 'indexHitRatio' ? `${fmt(m[k] * 100, 1)} %` : /Ms$/.test(k) ? fmt(m[k], 3) : int(m[k]);
    tbl.append(el('tr', {}, el('th', {}, label), el('td', {}, v)));
  }
  tbl.append(el('tr', {}, el('th', {}, 'Request charge (RU)'), el('td', {}, fmt(s.charge))));
  metricsBox.append(tbl);
}

// ---------------------------------------------------------------- events

viewport.addEventListener('scroll', () => window.requestAnimationFrame(() => renderRows(false)), { passive: true });
window.addEventListener('resize', () => renderRows(true));
rowsBox.addEventListener('click', (e) => {
  const r = e.target.closest('.row');
  if (!r) return;
  st.sel = Number(r.dataset.i);
  renderRows(true);
  renderDetail();
});
rowsBox.addEventListener('dblclick', (e) => {
  const r = e.target.closest('.row');
  if (r) vscode.postMessage({ type: 'open', index: Number(r.dataset.i) });
});
viewport.addEventListener('keydown', (e) => {
  const n = st.items.length;
  if (!n) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    st.sel = Math.max(0, Math.min(n - 1, (st.sel < 0 ? -1 : st.sel) + (e.key === 'ArrowDown' ? 1 : -1)));
    const y = st.sel * ROW_H;
    if (y < viewport.scrollTop) viewport.scrollTop = y;
    else if (y + ROW_H * 2 > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = y - viewport.clientHeight + ROW_H * 2;
    renderRows(true); renderDetail();
  } else if (e.key === 'Enter' && st.sel >= 0) vscode.postMessage({ type: 'open', index: st.sel });
  else if (e.key === 'Delete' && st.sel >= 0 && !(st.target && st.target.readOnly)) vscode.postMessage({ type: 'delete', index: st.sel });
});

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || typeof m.type !== 'string') return;
  if (m.type === 'start') {
    st.items = []; st.columns = []; st.sel = -1; st.stats = null; st.error = null; st.bigCount = 0; widths.clear();
    st.target = m.target;
    inSize.value = String(m.pageSize || st.pageSize);
    inPk.value = m.partitionKey || '';
    banner.className = 'banner info';
    banner.textContent = `${m.target.conn} › ${m.target.db} › ${m.target.container}${m.target.readOnly ? ' · read-only' : ''} · partition key ${m.target.pkPaths.join(', ') || 'none'}`;
    banner.title = m.query;
    viewport.scrollTop = 0;
    setRunning(true);
    renderHeader(); renderRows(true); renderDetail(); renderStats(); updateButtons();
    return;
  }
  if (m.type === 'page') {
    setRunning(false);
    if (m.columns) { st.columns = m.columns; }
    for (const it of m.items) { st.items.push(it); st.bigCount += countBig(it); }
    st.stats = m.stats;
    if (m.columns || m.start === 0) renderHeader();
    renderRows(true); renderStats(); updateButtons();
    return;
  }
  if (m.type === 'error') {
    setRunning(false);
    st.error = m.message;
    banner.className = 'banner error';
    banner.textContent = m.message + (m.position && m.position.start !== null && m.position.start !== undefined ? ` (at character ${m.position.start + 1})` : '');
    renderRows(true); updateButtons();
    return;
  }
  if (m.type === 'note') { banner.className = 'banner info'; banner.textContent = m.message; return; }
  if (m.type === 'loadingAll') { st.loadingAll = m.on; setRunning(m.on); updateButtons(); return; }
  if (m.type === 'deleted') {
    st.items.splice(m.index, 1);
    if (st.sel >= st.items.length) st.sel = st.items.length - 1;
    if (st.stats) { st.stats.loaded = st.items.length; }
    renderRows(true); renderDetail(); renderStats();
  }
});

detail.hidden = true;
bStop.hidden = true;
updateButtons();
renderRows(true);
vscode.postMessage({ type: 'ready' });
