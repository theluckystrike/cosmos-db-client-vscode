'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// A tiny vscode stand-in for the Pro gate (the license facade only needs these parts at creation).
const shown = [];
const fakeVscode = {
  window: { setStatusBarMessage: (m) => { shown.push(m); }, showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, onDidChangeWindowState: () => ({ dispose() {} }) },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
  env: { openExternal: async () => true, uriScheme: 'vscode', appName: 'Visual Studio Code' },
  Uri: { parse: (s) => ({ toString: () => s }) },
  authentication: { getSession: async () => undefined },
  EventEmitter: class { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(x) { this.l.forEach((f) => f(x)); } dispose() {} },
};
const origLoad = Module._load;
Module._load = function load(request, ...rest) { if (request === 'vscode') return fakeVscode; return origLoad.call(this, request, ...rest); };
const pro = require('../src/pro');

function memento() {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); }, keys: () => [...m.keys()], setKeysForSync() {} };
}
function context() {
  const secrets = new Map();
  return { globalState: memento(), workspaceState: memento(), subscriptions: [], secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); }, onDidChange: () => ({ dispose() {} }) }, extension: { id: 'zovo.zovo-cosmos-db-client', packageJSON: { version: '0.1.0' } } };
}

test('VERP3: 3 free tries per tool, each counted only when done() runs, then the unlock question', async () => {
  assert.strictEqual(pro.PRO_ENABLED, true);
  assert.strictEqual(pro.FREE_TRIES, 3);
  const ctx = context();
  const p = pro.createPro(fakeVscode, ctx);
  p.license.requirePro = async () => false; // the user closes the explanation
  for (let i = 0; i < 5; i++) assert.ok(await p.allow('Query Cost Report', 'x'), 'a start that fails or is cancelled uses no try');
  assert.deepStrictEqual(ctx.globalState.get('zovoCosmos.proTries', {}), {});
  for (let i = 1; i <= 3; i++) { const g = await p.allow('Query Cost Report', 'x'); assert.ok(g, `try ${i}`); await g.done(); await g.done(); }
  assert.deepStrictEqual(ctx.globalState.get('zovoCosmos.proTries', {}), { 'Query Cost Report': 3 }, 'done() counts once per run');
  assert.match(shown[shown.length - 1], /Free try 3 of 3/);
  assert.strictEqual(p.triesLeft('Query Cost Report'), 0);
  assert.strictEqual(await p.allow('Query Cost Report', 'x'), false, 'the 4th start asks to unlock');
  assert.ok(await p.allow('Copy Container', 'x'), 'tries are counted per tool');
  p.license.requirePro = async () => true; // unlocked in the explanation
  const g = await p.allow('Query Cost Report', 'x'); assert.ok(g); await g.done();
  assert.deepStrictEqual(ctx.globalState.get('zovoCosmos.proTries', {}), { 'Query Cost Report': 3 }, 'no count after an unlock');
});
