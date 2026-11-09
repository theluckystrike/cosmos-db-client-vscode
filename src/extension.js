'use strict';
// Cosmos DB Client & Azure Cosmos DB Explorer for VS Code (Zovo).
// Network: only to the Cosmos DB endpoints the user adds (and Microsoft sign-in, only for a connection the user
// sets up with Entra ID). No telemetry, no update check, no license server (the optional GitHub Sponsors unlock asks
// GitHub one question, only when the user clicks it). Nothing connects at startup: the SDK loads on the first use.

const vscode = require('vscode');
const path = require('path');
const { ConnectionStore, AccountManager } = require('./connections');
const { ExplorerProvider } = require('./tree');
const { ResultsPanel } = require('./results');
const { ItemFileSystem, itemUri, useMemento, SCHEME, SERVER_SCHEME, exactNumberDiagnostics, fmtRu } = require('./items');
const { prepareQuery, partitionKeyOf, errorText, parseParamValue, pkLabel } = require('./core/nosql');
const { EMULATOR_KEY, parseConnectionString, normalizeEndpoint, emulatorEndpoint, accountLabel } = require('./core/connstr');
const { stringifyExact } = require('./core/bignum');
const { KEYWORDS, FUNCTIONS, propertyItems, CompletionSource, sampleQuery } = require('./completion');
const { createRatingPrompt } = require('./rate');
const { registerSupport } = require('./support');
const pro = require('./pro');

const LANG = 'cosmos-nosql';
const BIND_KEY = 'zovoCosmos.bindings';
const INFO_SCHEME = 'cosmos-info';
const SCRIPT_SCHEME = 'cosmos-script';

let rating = { success() {}, failure() {} };
let accountsRef = null;

function settings() {
  const c = vscode.workspace.getConfiguration('zovoCosmos');
  return {
    pageSize: clamp(c.get('pageSize', 100), 1, 1000),
    maxLoadedItems: clamp(c.get('maxLoadedItems', 50000), 1000, 1000000),
    timeoutSeconds: clamp(c.get('timeoutSeconds', 30), 3, 600),
    emulatorPort: clamp(c.get('emulatorPort', 8081), 1, 65535),
    exportSystemProperties: !!c.get('exportSystemProperties', false),
    costReportMaxPages: clamp(c.get('costReportMaxPages', 200), 1, 10000),
    showSupportLinks: c.get('showSupportLinks', true) !== false,
  };
}
function clamp(v, lo, hi) { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }

function activate(context) {
  const t0 = Date.now();
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.zovo-cosmos-db-client', section: 'zovoCosmos', name: 'Cosmos DB Client' });
  registerSupport({ vscode, context, prefix: 'zovoCosmos', selfId: 'zovo.zovo-cosmos-db-client' });
  const proApi = pro.createPro(vscode, context);
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => proApi.license.handleUri(uri) }));

  const store = new ConnectionStore(vscode, context);
  const accounts = new AccountManager(vscode, store, settings);
  accountsRef = accounts;
  const tree = new ExplorerProvider(vscode, store, accounts);
  const treeView = vscode.window.createTreeView('zovoCosmos.explorer', { treeDataProvider: tree, showCollapseAll: true });
  const queryDiagnostics = vscode.languages.createDiagnosticCollection('zovoCosmos.query');
  const numberDiagnostics = vscode.languages.createDiagnosticCollection('zovoCosmos.numbers');
  const output = vscode.window.createOutputChannel('Cosmos DB Client');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'zovoCosmos.selectTarget';
  context.subscriptions.push(treeView, queryDiagnostics, numberDiagnostics, output, status, { dispose: () => accounts.dispose() });

  useMemento(context.workspaceState);
  const itemFs = new ItemFileSystem(vscode, store, accounts, { onWrite: () => rating.success() });
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(SCHEME, itemFs, { isCaseSensitive: true }));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SERVER_SCHEME, { provideTextDocumentContent: (uri) => itemFs.serverText(uri).catch((e) => `// ${errorText(e)}`) }));

  const infoDocs = new Map();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(INFO_SCHEME, { provideTextDocumentContent: (uri) => infoDocs.get(uri.toString()) || '' }));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCRIPT_SCHEME, { provideTextDocumentContent: (uri) => infoDocs.get(uri.toString()) || '' }));

  // ---------- exact-number hints in item documents ----------
  const checkNumbers = (doc) => { if (doc.uri.scheme === SCHEME) numberDiagnostics.set(doc.uri, exactNumberDiagnostics(vscode, doc)); };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(checkNumbers),
    vscode.workspace.onDidChangeTextDocument((e) => { checkNumbers(e.document); if (queryDiagnostics.has(e.document.uri)) queryDiagnostics.delete(e.document.uri); }),
    vscode.workspace.onDidCloseTextDocument((d) => numberDiagnostics.delete(d.uri)),
  );
  vscode.workspace.textDocuments.forEach(checkNumbers);

  // ---------- which container a query file runs on ----------
  const bindings = new Map(Object.entries(context.workspaceState.get(BIND_KEY, {})));
  const saveBindings = () => context.workspaceState.update(BIND_KEY, Object.fromEntries([...bindings].slice(-300)));
  const bindingOf = (doc) => { const b = bindings.get(doc.uri.toString()); return b && store.get(b.connId) ? b : null; };
  const bind = (doc, b) => { bindings.set(doc.uri.toString(), b); saveBindings(); updateStatus(); };
  const paramMemory = new Map();

  function updateStatus() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== LANG) { status.hide(); return; }
    const b = bindingOf(ed.document);
    const c = b && store.get(b.connId);
    status.text = c ? `$(database) ${c.name} › ${b.db} › ${b.container}${c.readOnly ? ' $(lock)' : ''}` : '$(database) Choose container';
    status.tooltip = c ? `Queries in this file run on ${b.container} (${c.endpoint}). Click to change.` : 'Pick the container this query file runs on.';
    status.show();
  }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatus), store.onDidChange(updateStatus));
  updateStatus();

  let running = 0;
  const setRunning = (d) => { running = Math.max(0, running + d); vscode.commands.executeCommand('setContext', 'zovoCosmos.running', running > 0); };

  const readOnlyGuard = (connId, what) => {
    const c = store.get(connId);
    if (c && c.readOnly) {
      vscode.window.showWarningMessage(`"${c.name}" is read-only, so ${what} is blocked. Right-click the connection and choose Toggle Read-Only to allow changes.`);
      return true;
    }
    return false;
  };

  // ---------- picking targets ----------
  async function pickConnection(title) {
    const list = store.list();
    if (!list.length) {
      const pick = await vscode.window.showInformationMessage('Add a Cosmos DB connection first.', 'Connect to Emulator', 'Add Connection');
      if (pick === 'Connect to Emulator') return connectEmulator();
      if (pick === 'Add Connection') return addConnection();
      return null;
    }
    const it = await vscode.window.showQuickPick(list.map((c) => ({ label: `$(database) ${c.name}`, description: accountLabel(c.endpoint), detail: c.readOnly ? 'read-only' : undefined, c })), { title: title || 'Which connection?' });
    return it ? it.c : null;
  }

  async function pickContainer(title, connId) {
    const c = connId ? store.get(connId) : await pickConnection(title);
    if (!c) return null;
    const a = await accounts.get(c.id);
    const dbs = await withBusy('Reading databases…', () => a.databases());
    if (!dbs.length) { vscode.window.showInformationMessage(`"${c.name}" has no databases yet.`); return null; }
    const db = dbs.length === 1 ? dbs[0] : (await vscode.window.showQuickPick(dbs, { title: `${title || 'Pick a container'}: database` }));
    if (!db) return null;
    const cs = await withBusy('Reading containers…', () => a.containers(db));
    if (!cs.length) { vscode.window.showInformationMessage(`Database "${db}" has no containers.`); return null; }
    const ct = cs.length === 1 ? cs[0] : (await vscode.window.showQuickPick(cs.map((x) => ({ label: x.id, description: (x.partitionKey.paths || []).join(', '), x })), { title: `${title || 'Pick a container'}: container` }) || {}).x;
    if (!ct) return null;
    return { connId: c.id, db, container: ct.id };
  }

  async function withBusy(title, fn) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Cosmos DB: ${title}` }, fn);
  }

  // ---------- connections ----------
  async function testAndSave(entry, key, opts = {}) {
    const probe = accounts.probe(entry, key);
    let err = null; let info = null;
    try {
      info = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Connecting to ${accountLabel(entry.endpoint)}…` }, async () => {
        const p = await probe.ping();
        const dbs = await probe.databases();
        return { ...p, dbs };
      });
    } catch (e) { err = e; } finally { probe.dispose(); }
    if (err) {
      if (opts.quietFail) return { error: err };
      const pick = await vscode.window.showErrorMessage(`Could not connect: ${err.friendly ? err.message : errorText(err)}`, 'Save Anyway', 'Cancel');
      if (pick !== 'Save Anyway') return null;
    }
    const saved = await store.save(entry, key);
    accounts.drop(saved.id);
    if (info) vscode.window.setStatusBarMessage(`Cosmos DB: connected to ${saved.name}, ${info.dbs.length} database${info.dbs.length === 1 ? '' : 's'}.`, 6000);
    tree.refresh();
    try { await vscode.commands.executeCommand('zovoCosmos.explorer.focus'); } catch { /* view not shown */ }
    return saved;
  }

  async function connectEmulator() {
    const port = settings().emulatorPort;
    const existing = store.list().find((c) => c.emulator && new URL(c.endpoint).port === String(port));
    for (const protocol of ['https', 'http']) {
      const endpoint = emulatorEndpoint(port, protocol);
      const entry = { id: existing && existing.endpoint === endpoint ? existing.id : undefined, name: existing ? existing.name : 'Local emulator', endpoint, auth: 'key', emulator: true, readOnly: existing ? existing.readOnly : false };
      const r = await testAndSave(entry, EMULATOR_KEY, { quietFail: true });
      if (r && !r.error) return r;
    }
    const cmd = `docker run -d -p ${port}:8081 -p 1234:1234 mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-preview`;
    const pick = await vscode.window.showErrorMessage(`No Cosmos DB emulator answered on localhost:${port} (https or http). Start the emulator, then try again. On Windows the installed emulator works too.`, 'Copy Docker Command', 'Try Again');
    if (pick === 'Copy Docker Command') { await vscode.env.clipboard.writeText(cmd); vscode.window.setStatusBarMessage('Docker command copied.', 4000); }
    if (pick === 'Try Again') return connectEmulator();
    return null;
  }

  async function addConnection() {
    const way = await vscode.window.showQuickPick([
      { label: '$(vm) Local emulator', description: 'one click, no account', detail: `https or http on localhost:${settings().emulatorPort} with the emulator's public key`, id: 'emu' },
      { label: '$(key) Connection string', description: 'AccountEndpoint=…;AccountKey=…;', detail: 'From Keys in the Azure portal. The key is kept in VS Code secret storage.', id: 'cs' },
      { label: '$(globe) Endpoint and key', description: 'https://<account>.documents.azure.com:443/', id: 'ek' },
      { label: '$(account) Microsoft Entra ID', description: 'sign in with your Microsoft account', detail: 'Uses VS Code\'s built-in Microsoft sign-in. Needs a Cosmos DB data role on the account.', id: 'entra' },
    ], { title: 'Add a Cosmos DB connection', placeHolder: 'How do you connect?' });
    if (!way) return null;
    if (way.id === 'emu') return connectEmulator();
    let endpoint; let key;
    try {
      if (way.id === 'cs') {
        const s = await vscode.window.showInputBox({ title: 'Connection string', prompt: 'Paste the PRIMARY or SECONDARY connection string (Azure portal > your account > Keys).', password: true, ignoreFocusOut: true, placeHolder: 'AccountEndpoint=https://…;AccountKey=…;', validateInput: (v) => { try { parseConnectionString(v); return null; } catch (e) { return v ? e.message : null; } } });
        if (!s) return null;
        ({ endpoint, key } = parseConnectionString(s));
      } else {
        const e = await vscode.window.showInputBox({ title: 'Account endpoint', prompt: 'The URI from Keys in the Azure portal.', placeHolder: 'https://<account>.documents.azure.com:443/', ignoreFocusOut: true, validateInput: (v) => { try { if (v) normalizeEndpoint(v); return null; } catch (x) { return x.message; } } });
        if (!e) return null;
        endpoint = normalizeEndpoint(e);
        if (way.id === 'ek') {
          key = await vscode.window.showInputBox({ title: 'Account key', prompt: 'The primary or secondary key. It is kept in VS Code secret storage.', password: true, ignoreFocusOut: true });
          if (!key) return null;
        }
      }
    } catch (e) { vscode.window.showErrorMessage(e.message); return null; }
    const name = await vscode.window.showInputBox({ title: 'Connection name', value: accountLabel(endpoint), ignoreFocusOut: true });
    if (name === undefined) return null;
    return testAndSave({ name: name || accountLabel(endpoint), endpoint, auth: way.id === 'entra' ? 'entra' : 'key' }, key);
  }

  async function editConnection(node) {
    const c = node ? store.get(node.connId) : await pickConnection('Edit which connection?');
    if (!c) return;
    const what = await vscode.window.showQuickPick([
      { label: 'Rename', id: 'name' },
      ...(c.auth === 'key' && !c.emulator ? [{ label: 'Replace the key or connection string', id: 'key' }] : []),
      { label: c.readOnly ? 'Allow changes (turn read-only off)' : 'Make read-only', id: 'ro' },
    ], { title: `Edit "${c.name}"` });
    if (!what) return;
    if (what.id === 'name') {
      const name = await vscode.window.showInputBox({ title: 'Connection name', value: c.name });
      if (name) await store.save({ ...c, name });
    } else if (what.id === 'key') {
      const s = await vscode.window.showInputBox({ title: 'Key or connection string', password: true, ignoreFocusOut: true, prompt: 'Paste a new account key, or a full connection string.' });
      if (!s) return;
      let key = s.trim(); let endpoint = c.endpoint;
      if (/AccountEndpoint=/i.test(key)) { try { ({ endpoint, key } = parseConnectionString(key)); } catch (e) { vscode.window.showErrorMessage(e.message); return; } }
      await testAndSave({ ...c, endpoint }, key);
    } else await store.setReadOnly(c.id, !c.readOnly);
    accounts.drop(c.id);
    tree.refresh();
  }

  // ---------- running queries ----------
  async function runQuery() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { vscode.window.showInformationMessage('Open a .nosql query file, or click a container in the Cosmos DB Explorer.'); return; }
    const doc = ed.document;
    let b = bindingOf(doc);
    if (!b) {
      try { b = await pickContainer('Run on which container?'); } catch (e) { vscode.window.showErrorMessage(e.friendly ? e.message : errorText(e)); return; }
      if (!b) return;
      bind(doc, b);
    }
    const sel = ed.selection;
    const base = sel.isEmpty ? 0 : doc.offsetAt(sel.start);
    const text = sel.isEmpty ? doc.getText() : doc.getText(sel);
    const prepared = prepareQuery(text);
    if (prepared.empty) { vscode.window.showInformationMessage('There is no query to run. Write one, for example SELECT * FROM c'); return; }
    const remembered = paramMemory.get(doc.uri.toString()) || {};
    for (const name of prepared.missing) {
      const v = await vscode.window.showInputBox({ title: `Value for ${name}`, prompt: `JSON (42, "text", true, [1,2]) or plain text. Tip: define it in the file with a line "-- ${name} = value".`, value: remembered[name] !== undefined ? remembered[name] : '', ignoreFocusOut: true });
      if (v === undefined) return;
      remembered[name] = v;
      prepared.parameters.push({ name, value: parseParamValue(v) });
    }
    paramMemory.set(doc.uri.toString(), remembered);
    queryDiagnostics.delete(doc.uri);
    const column = ed.viewColumn === vscode.ViewColumn.One || !ed.viewColumn ? vscode.ViewColumn.Beside : ed.viewColumn;
    const panel = ResultsPanel.forKey(deps, `doc:${doc.uri.toString()}`, `Results: ${b.container}`, column);
    const prev = panel.opts || {};
    try {
      await panel.run(b, prepared, {
        pageSize: prev.pageSize || settings().pageSize,
        partitionKey: prev.partitionKey,
        partitionKeyText: prev.partitionKeyText,
        onError: (e, pos) => markError(doc, base, prepared, e, pos),
        onDone: (ok) => { if (ok) rating.success(); },
      });
    } catch (e) {
      vscode.window.showErrorMessage(e.friendly ? e.message : errorText(e));
    }
  }

  function markError(doc, base, prepared, e, pos) {
    const queryError = (pos && Number.isFinite(pos.start)) || e.code === 400;
    if (!queryError) { // a timeout or a network error is not a mistake in the query: no red marks in the editor
      if (!e.code || e.code >= 500 || e.code === 408 || e.code === 401) rating.failure();
      return;
    }
    let range;
    if (pos && Number.isFinite(pos.start)) {
      const s = doc.positionAt(base + Math.min(pos.start, prepared.query.length));
      const end = doc.positionAt(base + Math.min(Number.isFinite(pos.end) && pos.end > pos.start ? pos.end : pos.start + 1, prepared.query.length));
      range = new vscode.Range(s, end.isEqual(s) ? s.translate(0, 1) : end);
    } else range = new vscode.Range(doc.positionAt(base), doc.positionAt(base + prepared.query.length));
    const d = new vscode.Diagnostic(range, pos && pos.message ? pos.message : errorText(e), vscode.DiagnosticSeverity.Error);
    d.source = 'Cosmos DB';
    queryDiagnostics.set(doc.uri, [d]);
    const net = !e.code || e.code >= 500 || e.code === 408 || e.code === 401;
    if (net && !(pos && Number.isFinite(pos.start))) rating.failure();
  }

  async function newQuery(node, autoRun) {
    let b = node && node.container ? { connId: node.connId, db: node.db, container: node.container } : null;
    if (!b) {
      try { b = await pickContainer('New query on which container?', node && node.connId); } catch (e) { vscode.window.showErrorMessage(e.friendly ? e.message : errorText(e)); return; }
      if (!b) return;
    }
    const conn = store.get(b.connId);
    const content = `-- ${b.container} · ${b.db} · ${conn ? conn.name : ''}\n-- Ctrl+Enter (Cmd+Enter on macOS) runs the query. Parameters: a line like  -- @status = "open"\nSELECT * FROM c\n`;
    const doc = await vscode.workspace.openTextDocument({ language: LANG, content });
    bind(doc, b);
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    const last = doc.lineAt(doc.lineCount - 2);
    ed.selection = new vscode.Selection(last.range.end, last.range.end);
    if (autoRun) await runQuery();
  }

  // ---------- items ----------
  async function openItem(binding, doc, pkDef) {
    const conn = store.get(binding.connId);
    const pk = partitionKeyOf(doc, pkDef);
    if (pk.unsafe) { vscode.window.showWarningMessage('This item\'s partition key is a number with more digits than JavaScript can hold, so it cannot be addressed safely. View it in the JSON pane.'); return; }
    if (typeof doc.id !== 'string') { vscode.window.showInformationMessage('This result has no item id (a projection or an aggregate), so it cannot be opened as an item.'); return; }
    const uri = itemUri(vscode, conn, binding.db, binding.container, { id: doc.id, pk: pk.none ? undefined : pk.value });
    const td = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(td, { preview: false, viewColumn: vscode.ViewColumn.Active });
    rating.success();
  }

  async function deleteItem(binding, doc, pkDef) {
    if (readOnlyGuard(binding.connId, 'deleting')) return false;
    if (typeof doc.id !== 'string') { vscode.window.showInformationMessage('This result has no item id, so there is nothing to delete.'); return false; }
    const pk = partitionKeyOf(doc, pkDef);
    if (pk.unsafe) { vscode.window.showWarningMessage('The partition key is a number with more digits than JavaScript can hold; this item cannot be deleted safely from here.'); return false; }
    const ok = await vscode.window.showWarningMessage(`Delete item "${doc.id}" from ${binding.container}?`, { modal: true, detail: `Partition key: ${pkLabel(pk.none ? undefined : pk.value)}\nThis cannot be undone.` }, 'Delete');
    if (ok !== 'Delete') return false;
    try {
      const a = await accounts.get(binding.connId);
      const r = await a.deleteItem(binding.db, binding.container, doc.id, pk.none ? undefined : pk.value);
      vscode.window.setStatusBarMessage(`Cosmos DB: deleted "${doc.id}" (${fmtRu(r.charge)} RU).`, 6000);
      return true;
    } catch (e) {
      vscode.window.showErrorMessage(`Not deleted: ${errorText(e)}`);
      return false;
    }
  }

  async function newItem(node) {
    let b = node && node.container ? node : null;
    if (!b) b = await pickContainer('New item in which container?');
    if (!b) return;
    if (readOnlyGuard(b.connId, 'creating items')) return;
    const a = await accounts.get(b.connId);
    const pkDef = await a.partitionKeyDef(b.db, b.container);
    const values = [];
    for (const p of pkDef.paths || []) {
      if (p === '/id') { values.push(undefined); continue; }
      const v = await vscode.window.showInputBox({ title: `Partition key value for ${p}`, prompt: 'Every item needs it; it decides the partition. JSON (42, "text") or plain text.', ignoreFocusOut: true });
      if (v === undefined) return;
      values.push(parseParamValue(v));
    }
    const uri = itemFs.newItemUri(store.get(b.connId), b.db, b.container, pkDef, (pkDef.paths || []).length > 1 ? values : values[0]);
    const td = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(td, { preview: false });
    vscode.window.setStatusBarMessage('Cosmos DB: edit the new item, then save (Ctrl+S) to create it.', 8000);
  }

  // ---------- export and import ----------
  async function exportResults(binding, spec, opts = {}, format) {
    const fmt = format || (await vscode.window.showQuickPick([{ label: 'JSONL', description: 'one item per line, streams well', id: 'jsonl' }, { label: 'JSON', description: 'one array', id: 'json' }, { label: 'CSV', description: 'columns from the first page', id: 'csv' }], { title: 'Export format' }) || {}).id;
    if (!fmt) return;
    const folder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri : undefined;
    const target = await vscode.window.showSaveDialog({ title: `Export every item of the query to ${fmt.toUpperCase()}`, defaultUri: folder ? vscode.Uri.joinPath(folder, `${binding.container}.${fmt}`) : undefined, filters: { [fmt.toUpperCase()]: [fmt] } });
    if (!target) return;
    const { exportQuery } = require('./transfer');
    const a = await accounts.get(binding.connId);
    const pkDef = await a.partitionKeyDef(binding.db, binding.container);
    let res;
    try {
      res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting ${binding.container}`, cancellable: true }, (progress, token) => exportQuery(a, binding.db, binding.container, { query: spec.query, parameters: spec.parameters }, target.fsPath, {
        format: fmt, pageSize: 1000, partitionKey: opts.partitionKey, system: settings().exportSystemProperties, pkDef,
        isCancelled: () => token.isCancellationRequested,
        onProgress: ({ count, charge }) => progress.report({ message: `${count.toLocaleString('en-US')} items · ${fmtRu(charge)} RU` }),
      }));
    } catch (e) { vscode.window.showErrorMessage(`Export failed: ${errorText(e)}`); return; }
    const extra = res.extraColumns ? ` ${res.extraColumns.toLocaleString('en-US')} items had fields that are not CSV columns (columns come from the first page); JSONL keeps everything.` : '';
    const pick = await vscode.window.showInformationMessage(`${res.cancelled ? 'Export stopped' : 'Exported'}: ${res.count.toLocaleString('en-US')} items to ${path.basename(target.fsPath)} (${fmtRu(res.charge)} RU).${extra}`, 'Open File', 'Reveal');
    if (pick === 'Open File') await vscode.commands.executeCommand('vscode.open', target);
    if (pick === 'Reveal') await vscode.commands.executeCommand('revealFileInOS', target);
  }

  async function exportContainer(node) {
    const b = node && node.container ? node : await pickContainer('Export which container?');
    if (!b) return;
    await exportResults({ connId: b.connId, db: b.db, container: b.container }, { query: 'SELECT * FROM c', parameters: [] }, {});
  }

  async function importItems(node) {
    const b = node && node.container ? node : await pickContainer('Import into which container?');
    if (!b) return;
    if (readOnlyGuard(b.connId, 'importing')) return;
    const files = await vscode.window.showOpenDialog({ title: 'Import items from JSON or JSONL', canSelectMany: false, filters: { 'JSON / JSONL': ['json', 'jsonl', 'ndjson'] } });
    if (!files || !files.length) return;
    const file = files[0].fsPath;
    const { importFile, countValues } = require('./transfer');
    let total = 0;
    try { total = await withBusy('Counting items…', () => countValues(file)); } catch (e) { vscode.window.showErrorMessage(`Cannot read ${path.basename(file)}: ${e.message}`); return; }
    if (!total) { vscode.window.showInformationMessage(`${path.basename(file)} holds no items.`); return; }
    const mode = await vscode.window.showWarningMessage(`Import ${total.toLocaleString('en-US')} items from ${path.basename(file)} into ${b.container}?`, { modal: true, detail: 'Upsert replaces items that have the same id and partition key. Create only skips them and reports them as failed.' }, 'Upsert', 'Create Only');
    if (!mode) return;
    const a = await accounts.get(b.connId);
    let res;
    try {
      res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Importing into ${b.container}`, cancellable: true }, async (progress, token) => {
        let last = 0;
        return importFile(a, b.db, b.container, file, {
          mode: mode === 'Upsert' ? 'upsert' : 'create', batch: 100,
          isCancelled: () => token.isCancellationRequested,
          onProgress: ({ read, ok, failed, charge }) => {
            const pct = Math.min(100, (read / total) * 100);
            progress.report({ increment: pct - last, message: `${read.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} · ${ok.toLocaleString('en-US')} written${failed ? `, ${failed.toLocaleString('en-US')} failed` : ''} · ${fmtRu(charge)} RU` });
            last = pct;
          },
        });
      });
    } catch (e) { vscode.window.showErrorMessage(`Import stopped: ${errorText(e)}`); return; }
    const msg = `${res.cancelled ? 'Import stopped' : 'Import done'}: ${res.ok.toLocaleString('en-US')} written, ${res.failed.toLocaleString('en-US')} failed, ${fmtRu(res.charge)} RU.`;
    if (res.errors.length) {
      output.appendLine(`[${new Date().toISOString()}] ${msg}`);
      for (const e of res.errors) output.appendLine(`  ${e}`);
      const pick = await vscode.window.showWarningMessage(`${msg} First problem: ${res.errors[0]}`, 'Show Details');
      if (pick) output.show(true);
    } else vscode.window.showInformationMessage(msg);
    tree.refresh();
  }

  // ---------- settings, scripts ----------
  async function showContainerSettings(node) {
    const b = node && node.container ? node : await pickContainer('Settings of which container?');
    if (!b) return;
    try {
      const a = await accounts.get(b.connId);
      const info = await withBusy('Reading container settings…', () => a.containerInfo(b.db, b.container));
      const r = info.resource;
      const doc = { id: r.id, partitionKey: r.partitionKey, throughput: info.throughput, defaultTtl: r.defaultTtl === undefined ? 'off' : r.defaultTtl, indexingPolicy: r.indexingPolicy, uniqueKeyPolicy: r.uniqueKeyPolicy, conflictResolutionPolicy: r.conflictResolutionPolicy, analyticalStorageTtl: r.analyticalStorageTtl };
      const uri = vscode.Uri.from({ scheme: INFO_SCHEME, path: `/${b.container} settings (read-only).json`, query: `${b.connId}/${b.db}/${b.container}/${Date.now()}` });
      infoDocs.set(uri.toString(), `${JSON.stringify(doc, null, 2)}\n`);
      const td = await vscode.workspace.openTextDocument(uri);
      await vscode.languages.setTextDocumentLanguage(td, 'json');
      await vscode.window.showTextDocument(td, { preview: true });
    } catch (e) { vscode.window.showErrorMessage(e.friendly ? e.message : errorText(e)); }
  }

  async function openScript(node) {
    if (!node || !node.id) return;
    const uri = vscode.Uri.from({ scheme: SCRIPT_SCHEME, path: `/${node.container}/${node.id}.js`, query: `${node.connId}/${node.db}/${node.scriptKind}/${Date.now()}` });
    infoDocs.set(uri.toString(), String(node.body || ''));
    const td = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(td, 'javascript');
    await vscode.window.showTextDocument(td, { preview: true });
  }

  async function executeStoredProcedure(node) {
    if (!node || node.scriptKind !== 'storedProcedures') return;
    if (readOnlyGuard(node.connId, 'running a stored procedure (it can write)')) return;
    const pkText = await vscode.window.showInputBox({ title: `Run ${node.id}: partition key value`, prompt: 'A stored procedure runs inside one partition. JSON or plain text.', ignoreFocusOut: true });
    if (pkText === undefined) return;
    const params = await vscode.window.showInputBox({ title: `Run ${node.id}: parameters`, prompt: 'A JSON array, e.g. ["a", 2]. Empty = no parameters.', value: '[]', ignoreFocusOut: true, validateInput: (v) => { try { if (v.trim()) { const x = JSON.parse(v); if (!Array.isArray(x)) return 'Use a JSON array.'; } return null; } catch (e) { return e.message; } } });
    if (params === undefined) return;
    try {
      const a = await accounts.get(node.connId);
      const r = await withBusy(`Running ${node.id}…`, () => a.executeStoredProcedure(node.db, node.container, node.id, pkText.trim() ? parseParamValue(pkText) : undefined, params.trim() ? JSON.parse(params) : []));
      const td = await vscode.workspace.openTextDocument({ language: 'json', content: `${stringifyExact(r.result === undefined ? null : r.result, 2)}\n` });
      await vscode.window.showTextDocument(td, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      vscode.window.setStatusBarMessage(`Cosmos DB: ${node.id} ran (${fmtRu(r.charge)} RU).`, 6000);
    } catch (e) { vscode.window.showErrorMessage(`${node.id} failed: ${errorText(e)}`); }
  }

  // ---------- Pro: Query Cost Report ----------
  async function costReport() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== LANG) { vscode.window.showInformationMessage('Open a .nosql query file first (New Query on a container), then run the cost report from it.'); return; }
    const doc = ed.document;
    let b = bindingOf(doc);
    if (!b) { b = await pickContainer('Report on which container?'); if (!b) return; bind(doc, b); }
    const prepared = prepareQuery(ed.selection.isEmpty ? doc.getText() : doc.getText(ed.selection));
    if (prepared.empty) { vscode.window.showInformationMessage('There is no query in this file.'); return; }
    if (prepared.missing.length) { vscode.window.showInformationMessage(`Define ${prepared.missing.join(', ')} in the file first, e.g. a line "-- ${prepared.missing[0]} = 42".`); return; }
    if (!(await proApi.allow('Query Cost Report', 'The Query Cost Report runs the query to the end and shows its request units, documents loaded against returned, index use and the indexes the server suggests, with a ready indexing policy.'))) return;
    const conn = store.get(b.connId);
    const a = await accounts.get(b.connId);
    const maxPages = settings().costReportMaxPages;
    let result;
    try {
      result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Query cost report', cancellable: true }, async (progress, token) => {
        const info = await a.containerInfo(b.db, b.container);
        const it = a.query(b.db, b.container, { query: prepared.query, parameters: prepared.parameters }, { maxItemCount: 1000, metrics: true, indexMetrics: true });
        const pages = []; let indexMetrics = null; let truncated = false;
        while (it.hasMore()) {
          if (token.isCancellationRequested || pages.length >= maxPages) { truncated = true; break; }
          const p = await it.next();
          if (!indexMetrics && p.indexMetrics) indexMetrics = p.indexMetrics;
          pages.push({ page: p.page, items: p.items.length, charge: p.charge, ms: p.ms, metrics: p.metrics });
          const items = pages.reduce((x, y) => x + y.items, 0);
          progress.report({ message: `${pages.length} pages · ${items.toLocaleString('en-US')} items · ${fmtRu(pages.reduce((x, y) => x + y.charge, 0))} RU` });
          if (!p.hasMore) break;
        }
        return { info, pages, indexMetrics, truncated };
      });
    } catch (e) {
      vscode.window.showErrorMessage(`Cost report failed: ${errorText(e)}`);
      return;
    }
    const md = pro.costReportMarkdown({ target: { conn: conn.name, db: b.db, container: b.container }, query: prepared.query.replace(/^\s*\n/gm, ''), parameters: prepared.parameters, ...result });
    const td = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.window.showTextDocument(td, { preview: false, viewColumn: vscode.ViewColumn.Active });
    try { await vscode.commands.executeCommand('markdown.showPreview', td.uri); } catch { /* the text stays open */ }
  }

  // ---------- Pro: Copy Container ----------
  async function copyContainer(node) {
    const src = node && node.container ? node : await pickContainer('Copy which container?');
    if (!src) return;
    const dstConn = await pickConnection(`Copy ${src.container} to which connection?`);
    if (!dstConn) return;
    if (readOnlyGuard(dstConn.id, 'copying into it')) return;
    let dst;
    try { dst = await accounts.get(dstConn.id); } catch (e) { vscode.window.showErrorMessage(errorText(e)); return; }
    let dbs = [];
    try { dbs = await withBusy('Reading databases…', () => dst.databases()); } catch (e) { vscode.window.showErrorMessage(errorText(e)); return; }
    const dbPick = await vscode.window.showQuickPick([{ label: '$(add) New database…', id: '' }, ...dbs.map((d) => ({ label: d, id: d }))], { title: 'Target database' });
    if (!dbPick) return;
    let dstDb = dbPick.id;
    if (!dstDb) { dstDb = await vscode.window.showInputBox({ title: 'New database name', value: src.db }); if (!dstDb) return; }
    const dstName = await vscode.window.showInputBox({ title: 'Target container', prompt: 'A new name creates the container with the same partition key and indexing policy. An existing container must have the same partition key.', value: dstConn.id === src.connId && dstDb === src.db ? `${src.container}-copy` : src.container, ignoreFocusOut: true });
    if (!dstName) return;
    if (dstConn.id === src.connId && dstDb === src.db && dstName === src.container) { vscode.window.showWarningMessage('The target is the source container. Pick another name or database.'); return; }
    const go = await vscode.window.showWarningMessage(`Copy every item of ${src.container} to ${dstConn.name} › ${dstDb} › ${dstName}?`, { modal: true, detail: 'Items with the same id and partition key in the target are replaced. The source is only read. Reads and writes use request units on both accounts.' }, 'Copy');
    if (go !== 'Copy') return;
    if (!(await proApi.allow('Copy Container', 'Copy Container streams every item of a container to another container, in the same or another account (for example from production to the emulator), with progress and the RU used.'))) return;
    const { copyContainer: copy } = require('./transfer');
    let res;
    try {
      const s = await accounts.get(src.connId);
      res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Copying ${src.container}`, cancellable: true }, (progress, token) => copy(s, src.db, src.container, dst, dstDb, dstName, {
        isCancelled: () => token.isCancellationRequested,
        onProgress: ({ read, ok, failed, readCharge, writeCharge }) => progress.report({ message: `${read.toLocaleString('en-US')} read · ${ok.toLocaleString('en-US')} written${failed ? ` · ${failed} failed` : ''} · ${fmtRu(readCharge + writeCharge)} RU` }),
      }));
    } catch (e) { vscode.window.showErrorMessage(`Copy stopped: ${e.friendly ? e.message : errorText(e)}`); return; }
    const msg = `${res.cancelled ? 'Copy stopped' : 'Copy done'}: ${res.ok.toLocaleString('en-US')} of ${res.read.toLocaleString('en-US')} items written to ${dstName}${res.created ? ' (new container)' : ''}, ${res.failed} failed. ${fmtRu(res.readCharge)} RU read, ${fmtRu(res.writeCharge)} RU written.`;
    if (res.errors.length) { output.appendLine(msg); for (const e of res.errors) output.appendLine(`  ${e}`); vscode.window.showWarningMessage(`${msg} First problem: ${res.errors[0]}`, 'Show Details').then((p) => p && output.show(true)); } else vscode.window.showInformationMessage(msg);
    tree.refresh();
  }

  // ---------- autocomplete ----------
  const completion = new CompletionSource(async (b) => {
    const a = await accounts.get(b.connId);
    const it = a.query(b.db, b.container, { query: sampleQuery(), parameters: [] }, { maxItemCount: 100, metrics: false });
    const p = await it.next();
    return p.items;
  });
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: LANG }, {
    async provideCompletionItems(doc, pos) {
      const line = doc.lineAt(pos.line).text.slice(0, pos.character);
      if (/^\s*--/.test(line)) return [];
      const m = /([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_$][A-Za-z0-9_$]*|\["[^"]*"\])*)\.([A-Za-z0-9_$]*)$/.exec(line);
      const b = bindingOf(doc);
      if (m && b) {
        let paths;
        try { paths = await completion.paths(b); } catch { return []; }
        const prefix = m[2] ? `${m[2].replace(/^\./, '')}.` : '';
        return propertyItems(paths, prefix).map((p) => {
          const ci = new vscode.CompletionItem(p.label, vscode.CompletionItemKind.Field);
          ci.detail = p.detail;
          if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p.label)) { ci.insertText = `["${p.label}"]`; ci.filterText = p.label; }
          return ci;
        });
      }
      if (m) return [];
      return [
        ...KEYWORDS.map((k) => new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword)),
        ...FUNCTIONS.map((f) => { const ci = new vscode.CompletionItem(f, vscode.CompletionItemKind.Function); ci.insertText = new vscode.SnippetString(`${f}($0)`); return ci; }),
      ];
    },
  }, '.'));

  const deps = {
    vscode, context, store, accounts, settings, setRunning, rating,
    showSupportLinks: () => settings().showSupportLinks,
    openItem, deleteItem, exportResults,
  };

  async function deleteFromEditor() {
    const ed = vscode.window.activeTextEditor;
    const t = ed && ed.document.uri.scheme === SCHEME ? itemFs.target(ed.document.uri) : null;
    if (!t || t.isNew) { vscode.window.showInformationMessage('Open a saved item first.'); return; }
    if (readOnlyGuard(t.connId, 'deleting')) return;
    const ok = await vscode.window.showWarningMessage(`Delete item "${t.id}" from ${t.container}?`, { modal: true, detail: `Partition key: ${pkLabel(t.pk)}\nThis cannot be undone.` }, 'Delete');
    if (ok !== 'Delete') return;
    try {
      const a = await accounts.get(t.connId);
      const r = await a.deleteItem(t.db, t.container, t.id, t.pk);
      vscode.window.setStatusBarMessage(`Cosmos DB: deleted "${t.id}" (${fmtRu(r.charge)} RU).`, 6000);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    } catch (e) { vscode.window.showErrorMessage(`Not deleted: ${errorText(e)}`); }
  }

  async function selectTarget() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    let b;
    try { b = await pickContainer('Run this file on which container?'); } catch (e) { vscode.window.showErrorMessage(errorText(e)); return; }
    if (b) bind(ed.document, b);
  }

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
    try { return await fn(...args); } catch (e) { vscode.window.showErrorMessage(e && e.friendly ? e.message : errorText(e)); return undefined; }
  }));
  reg('zovoCosmos.addConnection', addConnection);
  reg('zovoCosmos.connectEmulator', connectEmulator);
  reg('zovoCosmos.editConnection', editConnection);
  reg('zovoCosmos.deleteConnection', async (node) => {
    const c = node ? store.get(node.connId) : await pickConnection('Delete which connection?');
    if (!c) return;
    const ok = await vscode.window.showWarningMessage(`Delete the connection "${c.name}"?`, { modal: true, detail: 'Only the saved connection and its key are removed from VS Code. Nothing changes in the account.' }, 'Delete');
    if (ok !== 'Delete') return;
    accounts.drop(c.id);
    await store.remove(c.id);
  });
  reg('zovoCosmos.toggleReadOnly', async (node) => {
    const c = node ? store.get(node.connId) : await pickConnection('Toggle read-only for which connection?');
    if (!c) return;
    await store.setReadOnly(c.id, !c.readOnly);
    vscode.window.setStatusBarMessage(`Cosmos DB: "${c.name}" is ${c.readOnly ? 'writable' : 'read-only'} now.`, 5000);
  });
  reg('zovoCosmos.disconnect', (node) => { if (node) { accounts.drop(node.connId); tree.refresh(); } });
  reg('zovoCosmos.refresh', (node) => { completion.clear(); if (node && node.kind === 'connection') accounts.drop(node.connId); tree.refresh(); });
  reg('zovoCosmos.newQuery', (node) => newQuery(node, false));
  reg('zovoCosmos.queryContainer', (node) => newQuery(node, true));
  reg('zovoCosmos.runQuery', runQuery);
  reg('zovoCosmos.selectTarget', selectTarget);
  reg('zovoCosmos.stop', () => { for (const p of ResultsPanel.all()) p.stopFlag = true; });
  reg('zovoCosmos.newItem', newItem);
  reg('zovoCosmos.deleteItem', deleteFromEditor);
  reg('zovoCosmos.exportContainer', exportContainer);
  reg('zovoCosmos.importItems', importItems);
  reg('zovoCosmos.showContainerSettings', showContainerSettings);
  reg('zovoCosmos.openScript', openScript);
  reg('zovoCosmos.executeStoredProcedure', executeStoredProcedure);
  reg('zovoCosmos.costReport', costReport);
  reg('zovoCosmos.copyContainer', copyContainer);
  reg('zovoCosmos.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.zovo-cosmos-db-client#zovoCosmos.start', false));
  reg('zovoCosmos.copyPath', async (node) => { if (node) await vscode.env.clipboard.writeText(node.container || node.db || ''); });

  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((d) => {
    if (bindings.has(d.uri.toString()) && d.isUntitled) { bindings.delete(d.uri.toString()); saveBindings(); }
  }));
  if (process.env.ZOVO_COSMOS_ACTIVATION_LOG) console.log(`[zovo-cosmos] activated in ${Date.now() - t0} ms`); // eslint-disable-line no-console
  return { activationMs: Date.now() - t0 };
}

function deactivate() { if (accountsRef) accountsRef.dispose(); }

module.exports = { activate, deactivate };
