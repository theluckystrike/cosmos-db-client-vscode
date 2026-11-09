'use strict';
// Items open as JSON documents on the cosmos-item: scheme. Save (Ctrl+S) writes the item back to Cosmos DB.
// Safety rules:
// - The replace uses the item id string and the partition key value as they were when the item was opened,
//   never values taken from the edited text, and an ETag check: a change on the server since then stops the save.
// - Numbers are kept exactly as stored (src/core/bignum.js): editing one field never rewrites another field's digits.
// - Changing the id or the partition key value is refused with a message (that would be a new item).
// - Read-only connections refuse every write.

const { parseExact, stringifyExact, lossyRanges } = require('./core/bignum');
const { partitionKeyOf, errorText, pkLabel, setAt, SYSTEM_PROPS } = require('./core/nosql');

const SCHEME = 'cosmos-item';
const SERVER_SCHEME = 'cosmos-item-server';

// Item uris carry a short reference (?ref=...), so VS Code's messages stay readable. The reference maps to
// {c: connection id, d: database, k: container, id, pk} in memory and in workspaceState (restored tabs after a reload).
const REFS_KEY = 'zovoCosmos.itemRefs';
const refs = new Map();
let memento = null;
function useMemento(m) { memento = m; }

function itemUri(vscode, conn, db, container, state) {
  const full = { c: conn.id, d: db, k: container, ...state };
  const ref = require('crypto').createHash('sha256').update(JSON.stringify(full)).digest('base64url').slice(0, 12);
  refs.set(ref, full);
  if (memento) {
    const saved = memento.get(REFS_KEY, {});
    saved[ref] = full;
    const keys = Object.keys(saved);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete saved[k];
    memento.update(REFS_KEY, saved);
  }
  const name = state.isNew ? `new-item-${state.n}.json` : `${safeName(state.id)}.json`;
  return vscode.Uri.from({ scheme: SCHEME, path: `/${safeName(conn.name)}/${safeName(db)}/${safeName(container)}/${name}`, query: `ref=${ref}` });
}

function safeName(s) { return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || '_'; }

function refOf(uri) { return new URLSearchParams(uri.query || '').get('ref') || ''; }

function stateOf(uri) {
  const ref = refOf(uri);
  if (ref) return refs.get(ref) || (memento && memento.get(REFS_KEY, {})[ref]) || null;
  try { return JSON.parse(decodeURIComponent(uri.query)); } catch { return null; }
}

class ItemFileSystem {
  constructor(vscode, store, accounts, hooks = {}) {
    this.vscode = vscode;
    this.store = store;
    this.accounts = accounts;
    this.hooks = hooks;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.emitter.event;
    this.meta = new Map(); // uri string -> {etag, mtime, size, id, pk, created}
    this.newCount = 0;
    this.templates = new Map();
  }

  watch() { return new this.vscode.Disposable(() => {}); }

  stat(uri) {
    const m = this.meta.get(uri.toString());
    return { type: this.vscode.FileType.File, ctime: m ? m.ctime : Date.now(), mtime: m ? m.mtime : Date.now(), size: m ? m.size : 0 };
  }

  readDirectory() { return []; }
  createDirectory() { throw this.vscode.FileSystemError.NoPermissions('Folders are not supported here.'); }
  delete() { throw this.vscode.FileSystemError.NoPermissions('Use "Delete Item" to delete an item.'); }
  rename() { throw this.vscode.FileSystemError.NoPermissions('Cosmos DB cannot rename an item. Create a new item and delete the old one.'); }

  /** A new, unsaved item: a template with an id and the partition key fields. */
  newItemUri(conn, db, container, pkDef, pkValue) {
    const n = ++this.newCount;
    const doc = { id: cryptoId() };
    const paths = (pkDef && pkDef.paths) || [];
    const values = Array.isArray(pkValue) ? pkValue : [pkValue];
    paths.forEach((p, i) => { if (p !== '/id') setAt(doc, p, values[i] !== undefined ? values[i] : ''); });
    const uri = itemUri(this.vscode, conn, db, container, { isNew: true, n });
    this.templates.set(uri.toString(), stringifyExact(doc, 2));
    return uri;
  }

  async readFile(uri) {
    const key = uri.toString();
    const s = stateOf(uri);
    if (!s) throw this.vscode.FileSystemError.FileNotFound(uri);
    const m = this.meta.get(key);
    if (s.isNew && !(m && m.created)) {
      const t = this.templates.get(key) || '{\n  "id": ""\n}';
      const buf = Buffer.from(t, 'utf8');
      this.meta.set(key, { ...(m || {}), ctime: Date.now(), mtime: (m && m.mtime) || Date.now(), size: buf.length });
      return buf;
    }
    const id = m && m.created ? m.id : s.id;
    const pk = m && m.created ? m.pk : s.pk;
    const a = await this.accounts.get(s.c);
    try {
      const r = await a.readItem(s.d, s.k, id, pk);
      const buf = Buffer.from(r.text, 'utf8');
      this.meta.set(key, { ...(m || {}), etag: r.etag, id, pk, ctime: (m && m.ctime) || Date.now(), mtime: Date.now(), size: buf.length });
      return buf;
    } catch (e) {
      if (e.code === 404) throw this.vscode.FileSystemError.FileNotFound(`Item "${id}" was not found in ${s.k}. It may have been deleted.`);
      throw new this.vscode.FileSystemError(e.friendly ? e.message : errorText(e));
    }
  }

  async writeFile(uri, content) {
    const v = this.vscode;
    const key = uri.toString();
    const s = stateOf(uri);
    if (!s) throw v.FileSystemError.FileNotFound(uri);
    const conn = this.store.get(s.c);
    if (!conn) throw new v.FileSystemError('This connection was deleted.');
    if (conn.readOnly) throw v.FileSystemError.NoPermissions(`"${conn.name}" is read-only. Turn read-only off for this connection to save changes.`);
    let doc;
    try { doc = parseExact(Buffer.from(content).toString('utf8')); } catch (e) { throw new v.FileSystemError(`The item is not valid JSON: ${e.message}`); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new v.FileSystemError('An item must be one JSON object.');
    if (typeof doc.id !== 'string' || !doc.id) throw new v.FileSystemError('The item needs an "id" string.');
    const a = await this.accounts.get(s.c);
    const pkDef = await a.partitionKeyDef(s.d, s.k);
    const pkNow = partitionKeyOf(doc, pkDef);
    if (pkNow.unsafe) throw new v.FileSystemError('The partition key value is a number with more digits than JavaScript can hold. Store it as a string.');
    const m = this.meta.get(key) || {};
    try {
      if (s.isNew && !m.created) {
        if (pkNow.missing.length && pkDef.paths.length) {
          const go = await v.window.showWarningMessage(`The item has no value for ${pkNow.missing.join(', ')}. It will be stored without a partition key value.`, { modal: true }, 'Create anyway');
          if (go !== 'Create anyway') throw new v.FileSystemError('Not created.');
        }
        const r = await a.createItem(s.d, s.k, doc);
        this.meta.set(key, { ...m, created: true, id: doc.id, pk: pkNow.none ? undefined : pkNow.value, etag: r.etag, mtime: Date.now(), size: content.length });
        v.window.setStatusBarMessage(`Cosmos DB: created item "${doc.id}" (${fmtRu(r.charge)} RU).`, 6000);
        if (this.hooks.onWrite) this.hooks.onWrite();
        setTimeout(() => this.emitter.fire([{ type: v.FileChangeType.Changed, uri }]), 50);
        return;
      }
      const origId = m.created ? m.id : s.id;
      const origPk = m.created ? m.pk : s.pk;
      if (doc.id !== origId) throw new v.FileSystemError(`The id changed from "${origId}" to "${doc.id}". Cosmos DB cannot rename an item: create a new item (New Item) and delete this one.`);
      const pkVal = pkNow.none ? undefined : pkNow.value;
      if (stringifyExact(pkVal) !== stringifyExact(origPk)) throw new v.FileSystemError(`The partition key value changed from ${pkLabel(origPk)} to ${pkLabel(pkVal)}. Cosmos DB cannot move an item to another partition: create a new item and delete this one.`);
      for (const p of SYSTEM_PROPS) if (p !== '_ts') delete doc[p]; // the server sets these; sending stale ones is pointless
      const r = await a.replaceItem(s.d, s.k, origId, origPk, doc, m.etag || null);
      this.meta.set(key, { ...m, etag: r.etag, mtime: Date.now(), size: content.length });
      v.window.setStatusBarMessage(`Cosmos DB: saved "${origId}" (${fmtRu(r.charge)} RU).`, 6000);
      if (this.hooks.onWrite) this.hooks.onWrite();
      // Re-read so the editor shows the server's new _etag and _ts.
      setTimeout(() => this.emitter.fire([{ type: v.FileChangeType.Changed, uri }]), 50);
    } catch (e) {
      if (e instanceof v.FileSystemError) throw e;
      if (e.code === 412) {
        this.offerConflictChoices(uri, doc).catch(() => {});
        throw new v.FileSystemError('Not saved: the item changed on the server since you opened it (ETag mismatch). Your text is still here; compare it with the server version.');
      }
      if (e.code === 404) throw new v.FileSystemError('Not saved: the item no longer exists on the server (deleted by someone else?).');
      if (e.code === 409) throw new v.FileSystemError(`Not created: an item with id "${doc.id}" already exists in this partition.`);
      throw new v.FileSystemError(`Not saved: ${errorText(e)}`);
    }
  }

  async offerConflictChoices(uri, doc) {
    const v = this.vscode;
    const pick = await v.window.showWarningMessage('Someone changed this item on the server after you opened it. Your edits are not saved yet.', 'Compare with Server', 'Overwrite Server Version');
    if (pick === 'Compare with Server') {
      const server = uri.with({ scheme: SERVER_SCHEME, query: `${uri.query}&t=${Date.now()}` });
      await v.commands.executeCommand('vscode.diff', server, uri, `${uri.path.split('/').pop()}: server ↔ yours`);
    } else if (pick === 'Overwrite Server Version') {
      const sure = await v.window.showWarningMessage('Replace the server version with yours? The other change is lost.', { modal: true }, 'Overwrite');
      if (sure !== 'Overwrite') return;
      const key = uri.toString();
      const m = this.meta.get(key) || {};
      this.meta.set(key, { ...m, etag: null }); // the next save skips the ETag check once
      const ed = v.workspace.textDocuments.find((d) => d.uri.toString() === key);
      if (ed) await ed.save();
      const m2 = this.meta.get(key);
      if (m2 && m2.etag === null) this.meta.set(key, { ...m2, etag: m.etag });
    }
  }

  /** Text of the server version for the diff view. */
  async serverText(uri) {
    const base = uri.with({ scheme: SCHEME, query: `ref=${refOf(uri)}` });
    const s = stateOf(base);
    const m = this.meta.get(base.toString()) || {};
    const a = await this.accounts.get(s.c);
    const r = await a.readItem(s.d, s.k, m.created ? m.id : s.id, m.created ? m.pk : s.pk);
    return r.text;
  }

  /** {conn, db, container, id, pk} of an open item document, or null. */
  target(uri) {
    const s = stateOf(uri);
    if (!s) return null;
    const m = this.meta.get(uri.toString()) || {};
    if (s.isNew && !m.created) return { connId: s.c, db: s.d, container: s.k, isNew: true };
    return { connId: s.c, db: s.d, container: s.k, id: m.created ? m.id : s.id, pk: m.created ? m.pk : s.pk };
  }
}

/** Information diagnostics on numbers that keep more digits than a JavaScript number. */
function exactNumberDiagnostics(vscode, doc) {
  return lossyRanges(doc.getText()).map((r) => {
    const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)), `Exact value kept: ${r.token} has more digits than a JavaScript number holds. It is saved exactly as written here.`, vscode.DiagnosticSeverity.Information);
    d.source = 'Cosmos DB';
    return d;
  });
}

function cryptoId() { return require('crypto').randomUUID(); }
function fmtRu(n) { return (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US'); }

module.exports = { ItemFileSystem, itemUri, stateOf, useMemento, SCHEME, SERVER_SCHEME, exactNumberDiagnostics, fmtRu };
