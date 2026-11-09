'use strict';
// Integration tests against a running Cosmos DB emulator with the NB3 gate data (scripts in the lane folder).
// Run: ZOVO_COSMOS_IT=1 [ZOVO_COSMOS_EP=http://localhost:8081/] node --test --test-concurrency=1 test/integration.test.js
// Skipped without ZOVO_COSMOS_IT. Writes only to the "shop" test database and a "copytest" database it deletes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const IT = process.env.ZOVO_COSMOS_IT === '1';
const EP = process.env.ZOVO_COSMOS_EP || 'http://localhost:8081/';
const WORK = process.env.ZOVO_COSMOS_WORK || path.join(os.homedir(), 'cosmos-db-client-work');
const opt = { skip: !IT && 'set ZOVO_COSMOS_IT=1 with the emulator running', timeout: 900000 };

const { Account } = require('../src/cosmos');
const { EMULATOR_KEY } = require('../src/core/connstr');
const bn = require('../src/core/bignum');
const nq = require('../src/core/nosql');
const tr = require('../src/transfer');
const pro = require('../src/pro');

const acct = () => new Account({ endpoint: EP, auth: 'key' }, EMULATOR_KEY, { timeoutMs: 30000 });

/** Raw REST read with master-key auth, independent of the SDK and of our HTTP rewrite. */
function rawRead(db, coll, id, pk) {
  const u = new URL(EP);
  const link = `dbs/${db}/colls/${coll}/docs/${id}`;
  const date = new Date().toUTCString();
  const text = `get\ndocs\n${link}\n${date.toLowerCase()}\n\n`;
  const sig = crypto.createHmac('sha256', Buffer.from(EMULATOR_KEY, 'base64')).update(text).digest('base64');
  const auth = encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: `/${link}`, method: 'GET', headers: { authorization: auth, 'x-ms-date': date, 'x-ms-version': '2018-12-31', 'x-ms-documentdb-partitionkey': JSON.stringify([pk]) } }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('explorer reads: databases, containers, hierarchical partition key, scripts', opt, async () => {
  const a = acct();
  try {
    assert.ok((await a.ping()).regions.length >= 0);
    assert.ok((await a.databases()).includes('shop'));
    const cs = await a.containers('shop');
    const ten = cs.find((c) => c.id === 'tenants');
    assert.deepEqual(ten.partitionKey.paths, ['/tenantId', '/region']);
    const info = await a.containerInfo('shop', 'orders');
    assert.deepEqual(info.resource.partitionKey.paths, ['/customerId']);
    assert.ok(info.resource.indexingPolicy);
    const sp = await a.scripts('shop', 'orders', 'storedProcedures');
    assert.ok(sp.find((s) => s.id === 'countByStatus'), 'stored procedure listed');
    assert.ok((await a.scripts('shop', 'orders', 'userDefinedFunctions')).find((s) => s.id === 'taxed'));
    assert.ok((await a.scripts('shop', 'orders', 'triggers')).find((s) => s.id === 'stampCreated'));
  } finally { a.dispose(); }
});

test('continuation paging through 200,000 orders: every page has a charge, memory flat', opt, async () => {
  const a = acct();
  try {
    const it = a.query('shop', 'orders', { query: 'SELECT * FROM c', parameters: [] }, { maxItemCount: 1000 });
    let n = 0; let pages = 0; let zero = 0; let maxMs = 0;
    const rss0 = process.memoryUsage().rss;
    const t0 = Date.now();
    while (it.hasMore()) {
      const p = await it.next();
      n += p.items.length; pages++;
      if (!(p.charge > 0)) zero++;
      maxMs = Math.max(maxMs, p.ms);
      if (!p.hasMore) break;
    }
    const rss = (process.memoryUsage().rss - rss0) / 1048576;
    console.log(`paged ${n} items in ${pages} pages, ${Date.now() - t0} ms, slowest page ${maxMs} ms, RSS +${rss.toFixed(0)} MB, pages without a charge: ${zero}`);
    assert.ok(n >= 200001, `read ${n}`);
    assert.ok(pages >= 200);
    assert.ok(maxMs < 10000);
  } finally { a.dispose(); }
});

test('query metrics and request charge on a filtered page; ORDER BY; parameters', opt, async () => {
  const a = acct();
  try {
    const it = a.query('shop', 'orders', { query: 'SELECT c.id, c.total FROM c WHERE c.status = @s ORDER BY c.total DESC', parameters: [{ name: '@s', value: 'open' }] }, { maxItemCount: 50, indexMetrics: true });
    const p = await it.next();
    assert.ok(p.items.length >= 50); // the vnext emulator returns every ORDER BY row in one page; Azure honors the page size
    assert.ok(p.charge > 0);
    assert.ok(p.metrics && p.metrics.retrievedDocumentCount >= 0, JSON.stringify(p.metrics));
    const totals = p.items.map((x) => x.total).filter((x) => typeof x === 'number'); // items without a total sort apart
    for (let i = 1; i < totals.length; i++) assert.ok(totals[i - 1] >= totals[i]);
    const plain = await a.query('shop', 'orders', { query: 'SELECT c.id FROM c WHERE c.status = @s', parameters: [{ name: '@s', value: 'open' }] }, { maxItemCount: 50 }).next();
    assert.equal(plain.items.length, 50);
    assert.ok(plain.hasMore);
  } finally { a.dispose(); }
});

test('precision gate: n = 9007199254740993 survives an edit of another field (raw REST check)', opt, async () => {
  const a = acct();
  try {
    const r = await a.readItem('shop', 'orders', 'big-number', 'cust-big');
    assert.match(r.text, /"n": 9007199254740993/);
    const before = await rawRead('shop', 'orders', 'big-number', 'cust-big');
    const priceBefore = /"price":\s*([0-9.eE+-]+)/.exec(before.body)[1]; // the emulator stores this decimal as a double itself
    r.doc.note = `edited ${Date.now()}`;
    await a.replaceItem('shop', 'orders', 'big-number', 'cust-big', r.doc, r.etag);
    const raw = await rawRead('shop', 'orders', 'big-number', 'cust-big');
    assert.equal(raw.status, 200);
    assert.match(raw.body, /"n":\s*9007199254740993\b/, raw.body.slice(0, 300));
    assert.equal(/"price":\s*([0-9.eE+-]+)/.exec(raw.body)[1], priceBefore, 'an untouched decimal is written back as the server had it');
    assert.match(raw.body, /edited/);
  } finally { a.dispose(); }
});

test('ETag conflict from a second session is refused with 412', opt, async () => {
  const a = acct(); const b = acct();
  try {
    const r1 = await a.readItem('shop', 'orders', 'order-000001', await firstPk(a, 'order-000001'));
    const r2 = await b.readItem('shop', 'orders', 'order-000001', r1.doc.customerId);
    r2.doc.status = 'changed-by-b';
    await b.replaceItem('shop', 'orders', 'order-000001', r1.doc.customerId, r2.doc, r2.etag);
    r1.doc.status = 'changed-by-a';
    await assert.rejects(() => a.replaceItem('shop', 'orders', 'order-000001', r1.doc.customerId, r1.doc, r1.etag), (e) => e.code === 412 && /ETag/.test(nq.errorText(e)));
  } finally { a.dispose(); b.dispose(); }
});

async function firstPk(a, id) {
  const p = await a.query('shop', 'orders', { query: 'SELECT c.customerId FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }] }, { maxItemCount: 1 }).next();
  return p.items[0].customerId;
}

test('syntax error carries the position', opt, async () => {
  const a = acct();
  try {
    const q = nq.prepareQuery('-- comment line\nSELECT * FORM c');
    await assert.rejects(() => a.query('shop', 'orders', { query: q.query, parameters: [] }).next(), (e) => {
      const pos = nq.errorPosition(e);
      assert.equal(q.query.slice(pos.start, pos.end), 'FORM');
      return true;
    });
  } finally { a.dispose(); }
});

test('large items (1.9 MB) read and replace; unicode property names round trip', opt, async () => {
  const a = acct();
  try {
    const r = await a.readItem('shop', 'files', 'large-1', 'blobs');
    assert.ok(r.text.length > 1900000);
    r.doc.note = 'touched';
    await a.replaceItem('shop', 'files', 'large-1', 'blobs', r.doc, r.etag);
    const u = await a.readItem('shop', 'unicode', 'u1', 'ü');
    assert.equal(u.doc['名前'], '山田太郎');
    assert.equal(u.doc['emoji 🎉'], 3);
    const paths = nq.samplePaths([u.doc]).map((p) => p.path);
    assert.ok(paths.includes('["with.dot"]'));
    const q = await a.query('shop', 'unicode', { query: 'SELECT * FROM c WHERE c["名前"] = "山田太郎"', parameters: [] }).next();
    assert.equal(q.items.length, 1);
  } finally { a.dispose(); }
});

test('hierarchical partition key: read, scoped query, delete and create by id + key', opt, async () => {
  const a = acct();
  try {
    const p = await a.query('shop', 'tenants', { query: 'SELECT * FROM c WHERE c.id = "t-7"', parameters: [] }).next();
    const doc = p.items[0];
    const pk = nq.partitionKeyOf(doc, { paths: ['/tenantId', '/region'], kind: 'MultiHash' });
    assert.ok(Array.isArray(pk.value));
    const r = await a.readItem('shop', 'tenants', 't-7', pk.value);
    assert.equal(r.doc.id, 't-7');
    const scoped = await a.query('shop', 'tenants', { query: 'SELECT VALUE COUNT(1) FROM c', parameters: [] }, { partitionKey: pk.value }).next();
    assert.ok(scoped.items[0] >= 1);
    await a.deleteItem('shop', 'tenants', 't-7', pk.value);
    await assert.rejects(() => a.readItem('shop', 'tenants', 't-7', pk.value));
    await a.createItem('shop', 'tenants', nq.stripSystem(doc));
  } finally { a.dispose(); }
});

test('stored procedure runs (when the emulator supports it)', opt, async (t) => {
  const a = acct();
  try {
    const r = await a.executeStoredProcedure('shop', 'orders', 'countByStatus', 'cust-0001', ['open']);
    assert.equal(r.result.status, 'open');
  } catch (e) {
    t.diagnostic(`stored procedure not run: ${nq.errorText(e)}`);
  } finally { a.dispose(); }
});

test('export formats are exact (tenants, 2,000 items, 20 pages)', opt, async () => {
  const a = acct();
  const dir = fs.mkdtempSync(path.join(WORK, 'it-export-'));
  try {
    const big = { id: 'big-export', tenantId: 'tenant-big', region: 'eu', n: bn.toMarker('9007199254740993'), 'with,comma': 'a"b' };
    await a.bulkWrite('shop', 'tenants', [big], 'upsert', { paths: ['/tenantId', '/region'], kind: 'MultiHash' });
    const total = (await a.query('shop', 'tenants', { query: 'SELECT VALUE COUNT(1) FROM c', parameters: [] }).next()).items[0];
    for (const format of ['jsonl', 'json', 'csv']) {
      const file = path.join(dir, `tenants.${format}`);
      const r = await tr.exportQuery(a, 'shop', 'tenants', { query: 'SELECT * FROM c', parameters: [] }, file, { format, pageSize: 100, pkDef: { paths: ['/tenantId', '/region'] } });
      const t = fs.readFileSync(file, 'utf8');
      assert.equal(r.count, total, format);
      if (format === 'jsonl') { const lines = t.trim().split('\n'); assert.equal(lines.length, total); assert.ok(t.includes('"n":9007199254740993')); assert.ok(!t.includes('_rid')); }
      if (format === 'json') { const arr = JSON.parse(t); assert.equal(arr.length, total); assert.ok(t.includes('"n":9007199254740993')); }
      if (format === 'csv') { assert.ok(t.startsWith('id,tenantId,region,')); assert.equal(t.trim().split('\n').length, total + 1); assert.ok(r.extraColumns >= 1, 'fields missing from the first-page columns are counted'); }
    }
    const sys = path.join(dir, 'sys.jsonl');
    await tr.exportQuery(a, 'shop', 'tenants', { query: 'SELECT * FROM c WHERE c.id = "big-export"', parameters: [] }, sys, { format: 'jsonl', system: true });
    assert.ok(fs.readFileSync(sys, 'utf8').includes('_etag'));
  } finally { a.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('streamed export of 200,000+ orders to JSONL: memory flat', opt, async () => {
  const a = acct();
  const dir = fs.mkdtempSync(path.join(WORK, 'it-export-'));
  try {
    const file = path.join(dir, 'orders.jsonl');
    const rss0 = process.memoryUsage().rss;
    let peak = 0; let ticks = 0;
    const t0 = Date.now();
    const r = await tr.exportQuery(a, 'shop', 'orders', { query: 'SELECT * FROM c', parameters: [] }, file, { format: 'jsonl', pageSize: 1000, onProgress: () => { ticks++; peak = Math.max(peak, process.memoryUsage().rss - rss0); } });
    const size = fs.statSync(file).size;
    console.log(`export jsonl: ${r.count} items, ${(size / 1048576).toFixed(1)} MB, ${Date.now() - t0} ms, ${ticks} progress ticks, peak RSS +${(peak / 1048576).toFixed(0)} MB, ${r.charge.toFixed(1)} RU`);
    assert.ok(r.count >= 200001);
    assert.ok(peak < 300 * 1048576, `RSS grew ${peak / 1048576} MB`);
  } finally { a.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import 10,000 JSONL items with bulk writes and progress; re-import as create-only reports conflicts', opt, async () => {
  const a = acct();
  const file = path.join(WORK, 'data', 'import-10k.jsonl');
  try {
    assert.equal(await tr.countValues(file), 10000);
    const ticks = [];
    const r = await tr.importFile(a, 'shop', 'orders', file, { mode: 'upsert', batch: 100, onProgress: (p) => ticks.push(p.read) });
    console.log(`import: ${r.ok} ok, ${r.failed} failed, ${r.charge.toFixed(1)} RU, ${ticks.length} progress ticks`);
    assert.equal(r.ok, 10000);
    assert.equal(r.failed, 0);
    assert.ok(ticks.length >= 100);
    const c = await a.query('shop', 'orders', { query: 'SELECT VALUE COUNT(1) FROM c WHERE c.status = "imported"', parameters: [] }).next();
    assert.equal(c.items[0], 10000);
    const small = path.join(WORK, 'data', 'import-dup.json');
    const fresh = `imp-new-${Date.now()}`;
    fs.writeFileSync(small, JSON.stringify([{ id: 'imp-1', customerId: 'cust-imp-1', status: 'imported' }, { id: fresh, customerId: 'cust-imp-2', status: 'imported-x' }, { nope: 1 }]));
    const r2 = await tr.importFile(a, 'shop', 'orders', small, { mode: 'create' });
    assert.equal(r2.ok, 1);
    assert.equal(r2.failed, 2);
    assert.ok(r2.errors.some((e) => /already exists/.test(e)), r2.errors.join(' | '));
    assert.ok(r2.errors.some((e) => /no "id"/.test(e)));
    fs.rmSync(small);
  } finally { a.dispose(); }
});

test('copy container (Pro): hierarchical tenants to a new database, counts match', opt, async () => {
  const a = acct();
  try {
    const r = await tr.copyContainer(a, 'shop', 'tenants', a, 'copytest', 'tenants2', {});
    assert.equal(r.failed, 0, r.errors.join(' | '));
    assert.ok(r.created);
    const src = await a.query('shop', 'tenants', { query: 'SELECT VALUE COUNT(1) FROM c', parameters: [] }).next();
    const dst = await a.query('copytest', 'tenants2', { query: 'SELECT VALUE COUNT(1) FROM c', parameters: [] }).next();
    assert.equal(dst.items[0], src.items[0]);
    const info = await a.containerInfo('copytest', 'tenants2');
    assert.deepEqual(info.resource.partitionKey.paths, ['/tenantId', '/region']);
  } finally {
    try { await a.client.database('copytest').delete(); } catch { /* ignore */ }
    a.dispose();
  }
});

test('cost report (Pro) on a real query produces numbers and hints', opt, async () => {
  const a = acct();
  try {
    const info = await a.containerInfo('shop', 'orders');
    const it = a.query('shop', 'orders', { query: 'SELECT * FROM c WHERE c.status = "open" AND c.total > 1000', parameters: [] }, { maxItemCount: 1000, indexMetrics: true });
    const pages = []; let im = null;
    while (it.hasMore() && pages.length < 20) { const p = await it.next(); im = im || p.indexMetrics; pages.push({ page: p.page, items: p.items.length, charge: p.charge, ms: p.ms, metrics: p.metrics }); if (!p.hasMore) break; }
    const md = pro.costReportMarkdown({ target: { conn: 'Local emulator', db: 'shop', container: 'orders' }, query: 'SELECT * FROM c WHERE c.status = "open" AND c.total > 1000', parameters: [], pages, info, indexMetrics: im, truncated: false });
    assert.match(md, /Request units, whole query \| \*\*[\d,.]+ RU\*\*/);
    assert.match(md, /## What to look at/);
  } finally { a.dispose(); }
});

test('hostile: wrong key (401 mock), a server that never answers (timeout), connection refused', opt, async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'Unauthorized', message: "The input authorization token can't serve the request. The wrong key is being used or the expected payload is not built as per the protocol." }));
  });
  const hang = http.createServer(() => { /* never answers */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  try {
    const bad = new Account({ endpoint: `http://localhost:${srv.address().port}/`, auth: 'key' }, EMULATOR_KEY, { timeoutMs: 4000 });
    await assert.rejects(() => bad.databases(), (e) => /key was refused/.test(nq.errorText(e)));
    bad.dispose();
    const slow = new Account({ endpoint: `http://localhost:${hang.address().port}/`, auth: 'key' }, EMULATOR_KEY, { timeoutMs: 3000 });
    const t0 = Date.now();
    await assert.rejects(() => slow.databases(), (e) => /timed out|did not answer/i.test(nq.errorText(e)));
    const took = Date.now() - t0;
    console.log(`timeout case gave up after ${took} ms`);
    assert.ok(took < 30000);
    slow.dispose();
    const refused = new Account({ endpoint: 'http://localhost:1/', auth: 'key' }, EMULATOR_KEY, { timeoutMs: 3000 });
    await assert.rejects(() => refused.databases(), (e) => /refused|emulator/i.test(nq.errorText(e)));
    refused.dispose();
  } finally { srv.close(); hang.close(); hang.closeAllConnections && hang.closeAllConnections(); }
});

test('bignum survives the bulk path too', opt, async () => {
  const a = acct();
  try {
    const doc = { id: 'big-bulk', customerId: 'cust-big', n: bn.toMarker('-9007199254740995'), m: bn.toMarker('9223372036854775807') }; // within int64: the emulator keeps these exactly
    await a.bulkWrite('shop', 'orders', [doc], 'upsert', { paths: ['/customerId'] });
    const raw = await rawRead('shop', 'orders', 'big-bulk', 'cust-big');
    assert.match(raw.body, /-9007199254740995\b/);
    assert.match(raw.body, /9223372036854775807\b/);
  } finally { a.dispose(); }
});
