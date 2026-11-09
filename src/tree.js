'use strict';
// Cosmos DB Explorer tree: connections > databases > containers > settings, stored procedures, triggers, UDFs.
// A level is read when the user expands it, never before. Errors show as a row, not as a popup storm.

const { errorText } = require('./core/nosql');
const { accountLabel } = require('./core/connstr');

const SCRIPT_KINDS = [
  ['storedProcedures', 'Stored Procedures', 'symbol-method'],
  ['triggers', 'Triggers', 'zap'],
  ['userDefinedFunctions', 'User Defined Functions', 'symbol-function'],
];

class ExplorerProvider {
  constructor(vscode, store, accounts) {
    this.vscode = vscode;
    this.store = store;
    this.accounts = accounts;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    store.onDidChange(() => this.refresh());
  }

  refresh(node) { this.emitter.fire(node); }

  getTreeItem(n) {
    const v = this.vscode;
    const T = v.TreeItem;
    const C = v.TreeItemCollapsibleState;
    const icon = (id) => new v.ThemeIcon(id);
    if (n.kind === 'connection') {
      const c = this.store.get(n.connId);
      const t = new T(c ? c.name : 'Connection', C.Collapsed);
      t.id = `conn:${n.connId}`;
      t.description = `${c.emulator ? 'emulator · ' : ''}${accountLabel(c.endpoint)}${c.readOnly ? ' · read-only' : ''}`;
      t.tooltip = new v.MarkdownString(`**${escapeMd(c.name)}**\n\n${escapeMd(c.endpoint)}\n\nSign-in: ${c.auth === 'entra' ? 'Microsoft Entra ID' : 'account key (in VS Code secret storage)'}${c.readOnly ? '\n\nRead-only: edits, deletes and imports are blocked.' : ''}`);
      t.iconPath = icon(c.readOnly ? 'lock' : this.accounts.isConnected(n.connId) ? 'database' : 'plug');
      t.contextValue = `connection${c.readOnly ? '.ro' : ''}`;
      return t;
    }
    if (n.kind === 'database') {
      const t = new T(n.db, C.Collapsed);
      t.id = `db:${n.connId}/${n.db}`;
      t.iconPath = icon('database');
      t.contextValue = 'database';
      return t;
    }
    if (n.kind === 'container') {
      const t = new T(n.container, C.Collapsed);
      t.id = `ct:${n.connId}/${n.db}/${n.container}`;
      const paths = (n.partitionKey && n.partitionKey.paths) || [];
      t.description = paths.length ? paths.join(', ') : 'no partition key';
      t.tooltip = new v.MarkdownString(`**${escapeMd(n.container)}**\n\nPartition key: \`${paths.join(', ') || 'none'}\`${paths.length > 1 ? ' (hierarchical)' : ''}\n\nClick to query, or right-click for more.`);
      t.iconPath = icon('table');
      t.contextValue = 'container';
      t.command = { command: 'zovoCosmos.queryContainer', title: 'Query', arguments: [n] };
      return t;
    }
    if (n.kind === 'settings') {
      const t = new T('Settings', C.None);
      t.id = `set:${n.connId}/${n.db}/${n.container}`;
      t.description = 'partition key, throughput, indexing';
      t.iconPath = icon('settings-gear');
      t.contextValue = 'settings';
      t.command = { command: 'zovoCosmos.showContainerSettings', title: 'Show settings', arguments: [n] };
      return t;
    }
    if (n.kind === 'scripts') {
      const k = SCRIPT_KINDS.find((x) => x[0] === n.scriptKind);
      const t = new T(k[1], C.Collapsed);
      t.id = `sk:${n.connId}/${n.db}/${n.container}/${n.scriptKind}`;
      t.iconPath = icon('folder');
      t.contextValue = `scripts.${n.scriptKind}`;
      return t;
    }
    if (n.kind === 'script') {
      const k = SCRIPT_KINDS.find((x) => x[0] === n.scriptKind);
      const t = new T(n.id, C.None);
      t.id = `sc:${n.connId}/${n.db}/${n.container}/${n.scriptKind}/${n.id}`;
      if (n.triggerType) t.description = `${n.triggerType} ${n.triggerOperation || ''}`.trim();
      t.iconPath = icon(k[2]);
      t.contextValue = `script.${n.scriptKind}`;
      t.command = { command: 'zovoCosmos.openScript', title: 'Open', arguments: [n] };
      return t;
    }
    const t = new T(n.label, C.None);
    t.iconPath = icon(n.error ? 'warning' : 'info');
    if (n.error) { t.tooltip = n.label; t.contextValue = 'error'; t.command = { command: 'zovoCosmos.refresh', title: 'Retry', arguments: [n.parent] }; }
    return t;
  }

  async getChildren(n) {
    if (!n) return this.store.list().map((c) => ({ kind: 'connection', connId: c.id }));
    try {
      if (n.kind === 'connection') {
        const a = await this.accounts.get(n.connId);
        const dbs = await a.databases();
        this.refreshIcon(n);
        if (!dbs.length) return [{ kind: 'message', label: 'No databases yet.' }];
        return dbs.map((db) => ({ kind: 'database', connId: n.connId, db }));
      }
      if (n.kind === 'database') {
        const a = await this.accounts.get(n.connId);
        const cs = await a.containers(n.db);
        if (!cs.length) return [{ kind: 'message', label: 'No containers.' }];
        return cs.map((c) => ({ kind: 'container', connId: n.connId, db: n.db, container: c.id, partitionKey: c.partitionKey }));
      }
      if (n.kind === 'container') {
        const base = { connId: n.connId, db: n.db, container: n.container };
        return [{ kind: 'settings', ...base }, ...SCRIPT_KINDS.map(([k]) => ({ kind: 'scripts', scriptKind: k, ...base }))];
      }
      if (n.kind === 'scripts') {
        const a = await this.accounts.get(n.connId);
        const list = await a.scripts(n.db, n.container, n.scriptKind);
        if (!list.length) return [{ kind: 'message', label: 'None.' }];
        return list.map((s) => ({ kind: 'script', scriptKind: n.scriptKind, connId: n.connId, db: n.db, container: n.container, ...s }));
      }
    } catch (e) {
      if (n.kind === 'connection') this.accounts.drop(n.connId);
      return [{ kind: 'message', error: true, label: e.friendly ? e.message : errorText(e), parent: n }];
    }
    return [];
  }

  refreshIcon() { /* the connection icon updates on the next render; no extra refresh to avoid a second request */ }
}

function escapeMd(s) { return String(s).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&'); }

module.exports = { ExplorerProvider, SCRIPT_KINDS };
