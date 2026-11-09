'use strict';
// Saved connections: names and endpoints in globalState, account keys in VS Code SecretStorage only.
// Accounts (SDK clients) are created on the first use of a connection, never at startup.

const crypto = require('crypto');
const { Account } = require('./cosmos');
const { accountLabel, isLocalHost } = require('./core/connstr');

const LIST_KEY = 'zovoCosmos.connections';
const secretKey = (id) => `zovoCosmos.key.${id}`;

class ConnectionStore {
  constructor(vscode, context) {
    this.vscode = vscode;
    this.context = context;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  list() {
    const x = this.context.globalState.get(LIST_KEY, []);
    return Array.isArray(x) ? x : [];
  }

  get(id) { return this.list().find((c) => c.id === id) || null; }

  /** c: {id?, name, endpoint, auth, readOnly, emulator}; key goes to SecretStorage. */
  async save(c, key) {
    const list = this.list();
    const id = c.id || crypto.randomUUID();
    const entry = {
      id,
      name: c.name || accountLabel(c.endpoint),
      endpoint: c.endpoint,
      auth: c.auth === 'entra' ? 'entra' : 'key',
      readOnly: !!c.readOnly,
      emulator: !!c.emulator,
      local: isLocalHost(c.endpoint),
      added: c.added || new Date().toISOString(),
    };
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list[i] = { ...list[i], ...entry }; else list.push(entry);
    await this.context.globalState.update(LIST_KEY, list);
    if (key !== undefined && entry.auth === 'key') await this.context.secrets.store(secretKey(id), key);
    if (entry.auth === 'entra') await this.context.secrets.delete(secretKey(id));
    this.emitter.fire();
    return entry;
  }

  async setReadOnly(id, on) {
    const list = this.list().map((c) => (c.id === id ? { ...c, readOnly: !!on } : c));
    await this.context.globalState.update(LIST_KEY, list);
    this.emitter.fire();
  }

  async remove(id) {
    await this.context.globalState.update(LIST_KEY, this.list().filter((c) => c.id !== id));
    await this.context.secrets.delete(secretKey(id));
    this.emitter.fire();
  }

  async key(id) { return this.context.secrets.get(secretKey(id)); }
}

class AccountManager {
  constructor(vscode, store, settings) {
    this.vscode = vscode;
    this.store = store;
    this.settings = settings;
    this.accounts = new Map();
  }

  async getEntraToken(scope, interactive) {
    const s = await this.vscode.authentication.getSession('microsoft', [scope], interactive ? { createIfNone: true } : { silent: true });
    if (!s) throw Object.assign(new Error('Sign in with Microsoft to use this connection (command: Cosmos DB: Connect).'), { friendly: true });
    return { token: s.accessToken, expiresOnTimestamp: Date.now() + 45 * 60 * 1000 };
  }

  /** The Account for a connection id, created on first use. */
  async get(id) {
    const c = this.store.get(id);
    if (!c) throw Object.assign(new Error('This connection was deleted.'), { friendly: true });
    const have = this.accounts.get(id);
    if (have && have.endpoint === c.endpoint && have.auth === c.auth) return have.account;
    if (have) have.account.dispose();
    const key = c.auth === 'key' ? await this.store.key(id) : undefined;
    const account = new Account(c, key, {
      timeoutMs: this.settings().timeoutSeconds * 1000,
      getEntraToken: (scope) => this.getEntraToken(scope, true),
    });
    this.accounts.set(id, { account, endpoint: c.endpoint, auth: c.auth });
    return account;
  }

  /** A throwaway Account for "Test connection" (not cached). */
  probe(conn, key) {
    return new Account(conn, key, { timeoutMs: Math.min(this.settings().timeoutSeconds, 10) * 1000, getEntraToken: (scope) => this.getEntraToken(scope, true) });
  }

  drop(id) {
    const have = this.accounts.get(id);
    if (have) { have.account.dispose(); this.accounts.delete(id); }
  }

  isConnected(id) { return this.accounts.has(id); }

  dispose() { for (const id of [...this.accounts.keys()]) this.drop(id); }
}

module.exports = { ConnectionStore, AccountManager, LIST_KEY, secretKey };
