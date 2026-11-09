'use strict';
// Query results panel: grid and JSON view, request charge and query metrics per page, "Load more" through the
// continuation token, "Load all" with a stop button. The webview keeps at most maxLoadedItems; reading goes on
// and counts beyond that, and exports stream every item to the file.

const { buildHtml } = require('./html');
const { columnsOf, errorText, errorPosition, parseParamValue, partitionKeyOf, stripSystem } = require('./core/nosql');
const { stringifyExact } = require('./core/bignum');
const { commandUris } = require('./support');
const { itemUri } = require('./items');

const panels = new Map();

class ResultsPanel {
  static forKey(deps, key, title, column) {
    let p = panels.get(key);
    if (p && !p.disposed) { p.panel.title = title; p.panel.reveal(column, true); return p; }
    p = new ResultsPanel(deps, key, title, column);
    panels.set(key, p);
    return p;
  }

  static all() { return [...panels.values()].filter((p) => !p.disposed); }

  constructor(deps, key, title, column) {
    const { vscode, context } = deps;
    this.deps = deps;
    this.key = key;
    this.vscode = vscode;
    this.items = [];
    this.columns = [];
    this.pages = [];
    this.running = false;
    this.stopFlag = false;
    this.read = 0;
    this.totalCharge = 0;
    this.panel = vscode.window.createWebviewPanel('zovoCosmos.results', title, { viewColumn: column, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      enableCommandUris: commandUris('zovoCosmos'),
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    const w = this.panel.webview;
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
    w.html = buildHtml({
      cspSource: w.cspSource,
      scriptUri: w.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js')).toString(),
      styleUri: w.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.css')).toString(),
      title,
      showSupportLinks: deps.showSupportLinks(),
      page: 'results',
      data: { pageSize: deps.settings().pageSize, maxLoaded: deps.settings().maxLoadedItems },
    });
    w.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.post({ type: 'error', message: e.friendly ? e.message : errorText(e) })));
    this.panel.onDidDispose(() => { this.disposed = true; this.stopFlag = true; panels.delete(key); });
  }

  post(m) { if (!this.disposed) this.panel.webview.postMessage(m); }

  /**
   * binding: {connId, db, container}; spec: {query, parameters}; opts: {pageSize, partitionKey, onError(err), onDone(ok)}
   */
  async run(binding, spec, opts = {}) {
    this.binding = binding;
    this.spec = spec;
    this.opts = opts;
    this.stopFlag = true; // stops a Load all that is still running
    while (this.running) await new Promise((r) => setTimeout(r, 50));
    this.stopFlag = false;
    this.items = []; this.columns = []; this.pages = []; this.read = 0; this.totalCharge = 0;
    const conn = this.deps.store.get(binding.connId);
    const account = await this.deps.accounts.get(binding.connId);
    this.pkDef = await account.partitionKeyDef(binding.db, binding.container);
    await this.ready;
    this.post({
      type: 'start',
      target: { conn: conn.name, db: binding.db, container: binding.container, readOnly: !!conn.readOnly, pkPaths: this.pkDef.paths || [] },
      query: spec.query.trim().slice(0, 300),
      pageSize: opts.pageSize,
      partitionKey: opts.partitionKeyText || '',
    });
    const feed = { maxItemCount: opts.pageSize };
    if (opts.partitionKey !== undefined) feed.partitionKey = opts.partitionKey;
    this.iter = account.query(binding.db, binding.container, { query: spec.query, parameters: spec.parameters }, feed);
    return this.page();
  }

  /** Read one page. Returns true when it worked. quietTimeout: a timeout returns 'timeout' without showing an error. */
  async page(quietTimeout) {
    if (!this.iter || this.running) return false;
    this.running = true;
    this.deps.setRunning(1);
    try {
      const r = await this.iter.next();
      this.absorb(r);
      if (this.opts.onDone) this.opts.onDone(true);
      return true;
    } catch (e) {
      if (quietTimeout && isTimeout(e)) return 'timeout';
      const pos = errorPosition(e);
      this.post({ type: 'error', message: e.friendly ? e.message : errorText(e), position: pos });
      if (this.opts.onError) this.opts.onError(e, pos);
      if (this.opts.onDone) this.opts.onDone(false);
      return false;
    } finally {
      this.running = false;
      this.deps.setRunning(-1);
    }
  }

  absorb(r) {
    const max = this.deps.settings().maxLoadedItems;
    this.read += r.items.length;
    this.totalCharge += r.charge;
    const room = Math.max(0, max - this.items.length);
    const keep = r.items.slice(0, room);
    const start = this.items.length;
    for (const it of keep) this.items.push(it);
    const before = this.columns.length;
    if (keep.length) {
      const cols = columnsOf(this.items.length < 2000 ? this.items : keep, this.pkDef);
      const have = new Set(this.columns);
      if (!this.columns.length) this.columns = cols;
      else for (const c of cols) if (!have.has(c)) this.columns.push(c);
    }
    const stat = { page: r.page, items: r.items.length, charge: r.charge, ms: r.ms, metrics: r.metrics };
    this.pages.push(stat);
    if (this.pages.length > 2000) this.pages.shift();
    this.post({
      type: 'page',
      items: keep,
      start,
      columns: this.columns.length !== before || start === 0 ? this.columns : undefined,
      stats: { ...stat, read: this.read, loaded: this.items.length, totalCharge: this.totalCharge, hasMore: r.hasMore, pagesRead: r.page, capped: this.items.length >= max && r.items.length > keep.length, max },
    });
    this.hasMore = r.hasMore;
  }

  async loadAll() {
    if (this.running) return;
    this.stopFlag = false;
    this.post({ type: 'loadingAll', on: true });
    let pagesSincePost = 0;
    try {
      let retries = 0;
      while (this.hasMore && !this.stopFlag && !this.disposed) {
        const ok = await this.page(retries < 2);
        if (ok === 'timeout') { retries++; this.post({ type: 'note', message: `A page took longer than the timeout; trying it again (${retries} of 2).` }); continue; }
        if (!ok) break;
        retries = 0;
        if (++pagesSincePost % 20 === 0) await new Promise((r) => setTimeout(r, 0)); // keep the host responsive
      }
    } finally {
      this.post({ type: 'loadingAll', on: false, stopped: this.stopFlag });
    }
  }

  itemAt(i) { return this.items[i]; }

  async onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    const v = this.vscode;
    if (m.type === 'ready') { this.resolveReady(); return; }
    if (m.type === 'more') { await this.page(); return; }
    if (m.type === 'all') { await this.loadAll(); return; }
    if (m.type === 'stop') { this.stopFlag = true; return; }
    if (m.type === 'rerun') {
      if (!this.binding) return;
      const pageSize = Math.max(1, Math.min(1000, Math.floor(Number(m.pageSize) || this.opts.pageSize || 100)));
      const pkText = String(m.partitionKey || '').trim();
      const opts = { ...this.opts, pageSize, partitionKeyText: pkText, partitionKey: pkText ? parseParamValue(pkText) : undefined };
      await this.run(this.binding, this.spec, opts);
      return;
    }
    if (m.type === 'open') {
      const doc = this.itemAt(m.index);
      if (!doc) return;
      await this.deps.openItem(this.binding, doc, this.pkDef);
      return;
    }
    if (m.type === 'copy') {
      const doc = this.itemAt(m.index);
      if (doc) { await v.env.clipboard.writeText(stringifyExact(m.system ? doc : stripSystem(doc), 2)); v.window.setStatusBarMessage('Item JSON copied.', 3000); }
      return;
    }
    if (m.type === 'delete') {
      const doc = this.itemAt(m.index);
      if (!doc) return;
      const ok = await this.deps.deleteItem(this.binding, doc, this.pkDef);
      if (ok) { this.items.splice(m.index, 1); this.post({ type: 'deleted', index: m.index }); }
      return;
    }
    if (m.type === 'export') { await this.deps.exportResults(this.binding, this.spec, this.opts, m.format); return; }
    if (m.type === 'newItem') { await v.commands.executeCommand('zovoCosmos.newItem', { connId: this.binding.connId, db: this.binding.db, container: this.binding.container }); return; }
    if (m.type === 'pro') { await v.commands.executeCommand(m.command); }
  }
}

function isTimeout(e) { return !!e && (e.code === 408 || e.name === 'TimeoutError' || /Timeout Error|timed out/i.test(String(e.message))); }

/** For tests and the item editor: the uri an item opens at. */
function uriForItem(vscode, conn, binding, doc, pkDef) {
  const pk = partitionKeyOf(doc, pkDef);
  return itemUri(vscode, conn, binding.db, binding.container, { id: doc.id, pk: pk.none ? undefined : pk.value });
}

module.exports = { ResultsPanel, uriForItem };
