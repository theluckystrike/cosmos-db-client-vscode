'use strict';
// Unit tests: exact numbers, connection strings, query preparation, error positions, metrics, partition keys,
// CSV, streamed JSON reading, the HTTP rewrite, the cost report and the webview CSP. No network, no vscode.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bn = require('../src/core/bignum');
const cs = require('../src/core/connstr');
const nq = require('../src/core/nosql');
const js = require('../src/core/jsonstream');
const { exactHttpClient } = require('../src/cosmos');
const pro = require('../src/pro');
const { buildHtml } = require('../src/html');
const { propertyItems } = require('../src/completion');

test('isLossy: integers at or above MAX_SAFE_INTEGER, decimals that lose digits', () => {
  assert.equal(bn.isLossy('9007199254740993'), true);
  assert.equal(bn.isLossy('9007199254740991'), true); // the brief: at or above MAX_SAFE_INTEGER gets the badge
  assert.equal(bn.isLossy('9007199254740990'), false);
  assert.equal(bn.isLossy('-9007199254740993'), true);
  assert.equal(bn.isLossy('123'), false);
  assert.equal(bn.isLossy('0.1'), false);
  assert.equal(bn.isLossy('1.0'), false);
  assert.equal(bn.isLossy('1e3'), false);
  assert.equal(bn.isLossy('2.5E-3'), false);
  assert.equal(bn.isLossy('0.12345678901234567890'), true);
  assert.equal(bn.isLossy('12345678.123456789'), true);
  assert.equal(bn.isLossy('1e400'), true);
  assert.equal(bn.isLossy('3.141592653589793'), false);
});

test('protect/restore round trip keeps every digit; other text unchanged', () => {
  const raw = '{"id":"a","n":9007199254740993,"s":"9007199254740993","f":0.12345678901234567890,"ok":42,"arr":[1,18446744073709551615]}';
  const p = bn.protect(raw);
  const doc = JSON.parse(p);
  assert.equal(doc.n, `${bn.MARK}9007199254740993`);
  assert.equal(doc.s, '9007199254740993', 'strings are never touched');
  assert.equal(doc.ok, 42);
  assert.equal(doc.arr[1], `${bn.MARK}18446744073709551615`);
  doc.name = 'changed';
  const out = bn.stringifyExact(doc);
  assert.match(out, /"n":9007199254740993,/);
  assert.match(out, /"f":0\.12345678901234567890,/);
  assert.match(out, /18446744073709551615\]/);
  assert.equal(bn.protect('{"a":1}'), '{"a":1}');
  assert.equal(bn.restore('{"a":"x"}'), '{"a":"x"}');
});

test('protect skips numbers inside strings with escapes', () => {
  const raw = '{"t":"say \\"9007199254740993\\" ok","n":1}';
  assert.equal(bn.protect(raw), raw);
});

test('lossyRanges points at the tokens; countMarkers counts nested', () => {
  const t = '{\n  "n": 9007199254740993,\n  "x": [12345678901234567890]\n}';
  const r = bn.lossyRanges(t);
  assert.equal(r.length, 2);
  assert.equal(t.slice(r[0].start, r[0].end), '9007199254740993');
  assert.equal(bn.countMarkers(bn.parseExact(t)), 2);
});

test('exactHttpClient rewrites request bodies and response texts', async () => {
  let seen = null;
  const inner = { async sendRequest(req) { seen = req.body; return { status: 200, bodyAsText: '{"n":9007199254740993,"m":1}', headers: { toJSON: () => ({}) } }; } };
  const c = exactHttpClient(inner);
  const body = JSON.stringify({ id: 'x', n: `${bn.MARK}9007199254740993` });
  const res = await c.sendRequest({ body, headers: new Map() });
  assert.equal(seen, '{"id":"x","n":9007199254740993}');
  assert.equal(JSON.parse(res.bodyAsText).n, `${bn.MARK}9007199254740993`);
});

test('connection strings', () => {
  const r = cs.parseConnectionString('AccountEndpoint=https://acct.documents.azure.com:443/;AccountKey=abc/def==;');
  assert.equal(r.endpoint, 'https://acct.documents.azure.com/');
  assert.equal(r.key, 'abc/def==');
  const e = cs.parseConnectionString(`AccountEndpoint=https://localhost:8081/;AccountKey=${cs.EMULATOR_KEY}`);
  assert.equal(e.key, cs.EMULATOR_KEY);
  assert.throws(() => cs.parseConnectionString('mongodb://x'), /MongoDB/);
  assert.throws(() => cs.parseConnectionString('AccountKey=abc'), /AccountEndpoint/);
  assert.throws(() => cs.parseConnectionString('AccountEndpoint=https://a.documents.azure.com/'), /AccountKey/);
  assert.equal(cs.isLocalHost('https://localhost:8081/'), true);
  assert.equal(cs.isLocalHost('https://127.0.0.1:8081/'), true);
  assert.equal(cs.isLocalHost('https://acct.documents.azure.com/'), false);
  assert.equal(cs.isLocalHost('https://localhost.evil.com/'), false);
  assert.equal(cs.accountLabel('https://acct.documents.azure.com:443/'), 'acct');
  assert.equal(cs.normalizeEndpoint('acct.documents.azure.com'), 'https://acct.documents.azure.com/');
});

test('prepareQuery: parameters from comment lines, comments blanked with offsets kept', () => {
  const src = '-- note\n-- @status = "open"\n-- @min = 9007199254740993\nSELECT * FROM c WHERE c.status = @status AND c.n > @min AND c.t = @missing -- trailing\n';
  const p = nq.prepareQuery(src);
  assert.equal(p.query.length, src.length);
  assert.equal(p.query.indexOf('SELECT'), src.indexOf('SELECT'));
  assert.deepEqual(p.parameters.map((x) => x.name), ['@status', '@min']);
  assert.equal(p.parameters[0].value, 'open');
  assert.equal(p.parameters[1].value, `${bn.MARK}9007199254740993`);
  assert.deepEqual(p.missing, ['@missing']);
  assert.ok(!p.query.includes('trailing'));
  const q = nq.prepareQuery("SELECT * FROM c WHERE c.a = '--not a comment' AND c.b = \"@notparam\"");
  assert.ok(q.query.includes('--not a comment'));
  assert.deepEqual(q.used, []);
  assert.equal(nq.prepareQuery('-- only a comment\n').empty, true);
});

test('errorPosition and errorText from Cosmos errors', () => {
  const err = { code: 400, body: { message: 'Message: {"errors":[{"severity":"Error","location":{"start":9,"end":13},"code":"SC1001","message":"Syntax error, incorrect syntax near \'FORM\'."}]}\r\nActivityId: 1' } };
  const p = nq.errorPosition(err);
  assert.equal(p.start, 9);
  assert.equal(p.end, 13);
  assert.match(p.message, /FORM/);
  assert.match(nq.errorText(err), /Syntax error/);
  assert.match(nq.errorText({ code: 401, message: 'The input authorization token can\'t serve the request. The wrong key is being used' }), /key was refused/);
  assert.match(nq.errorText({ code: 412, message: 'precondition' }), /ETag/);
  assert.match(nq.errorText({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8081' }), /emulator running/);
  assert.match(nq.errorText({ code: 429, message: 'x' }), /request units/);
});

test('metrics: string and per-partition objects are merged', () => {
  const a = 'totalExecutionTimeInMs=1.5;retrievedDocumentCount=100;outputDocumentCount=10;indexHitRatio=0.5;retrievedDocumentSize=1000';
  const b = 'totalExecutionTimeInMs=0.5;retrievedDocumentCount=300;outputDocumentCount=30;indexHitRatio=1';
  const m = nq.mergeMetrics({ 0: a, 1: b });
  assert.equal(m.retrievedDocumentCount, 400);
  assert.equal(m.outputDocumentCount, 40);
  assert.equal(m.totalExecutionTimeInMs, 2);
  assert.equal(m.partitions, 2);
  assert.ok(Math.abs(m.indexHitRatio - 0.875) < 1e-9);
  assert.equal(nq.mergeMetrics(a).retrievedDocumentSize, 1000);
  assert.equal(nq.mergeMetrics(null), null);
  const im = nq.parseIndexMetrics(Buffer.from(JSON.stringify({ PotentialCompositeIndexes: [] })).toString('base64'));
  assert.deepEqual(im, { PotentialCompositeIndexes: [] });
});

test('partition keys: single, hierarchical, missing, unsafe; paths with quotes', () => {
  assert.deepEqual(nq.pathParts('/a/b'), ['a', 'b']);
  assert.deepEqual(nq.pathParts('/"a b"/c'), ['a b', 'c']);
  const doc = { id: '1', tenant: 'acme', region: { code: 'eu' }, big: `${bn.MARK}9007199254740993` };
  assert.deepEqual(nq.partitionKeyOf(doc, { paths: ['/tenant'] }), { value: 'acme', missing: [], unsafe: false, none: false });
  assert.deepEqual(nq.partitionKeyOf(doc, { paths: ['/tenant', '/region/code'], kind: 'MultiHash' }).value, ['acme', 'eu']);
  assert.equal(nq.partitionKeyOf(doc, { paths: ['/nope'] }).none, true);
  assert.equal(nq.partitionKeyOf(doc, { paths: ['/big'] }).unsafe, true);
  const d2 = {};
  nq.setAt(d2, '/x/y', 3);
  assert.deepEqual(d2, { x: { y: 3 } });
});

test('columns, sample paths, CSV cells', () => {
  const items = [{ _rid: 'r', name: 'a', id: '1', pk: 'p', nested: { a: 1 } }, { id: '2', extra: true, 'ünï code': 1 }];
  assert.deepEqual(nq.columnsOf(items, { paths: ['/pk'] }), ['id', 'pk', 'name', 'nested', 'extra', 'ünï code', '_rid']);
  const paths = nq.samplePaths(items);
  assert.ok(paths.find((p) => p.path === 'nested.a'));
  assert.ok(paths.find((p) => p.path === '["ünï code"]'));
  assert.ok(!paths.find((p) => p.path === '_rid'));
  assert.equal(nq.csvRow(['a,b', 'q"x', null, `${bn.MARK}9007199254740993`, { k: 1 }, '=SUM(A1)']), '"a,b","q""x",,9007199254740993,"{""k"":1}",\'=SUM(A1)');
  const props = propertyItems(paths, '');
  assert.ok(props.find((p) => p.label === 'nested'));
  assert.deepEqual(propertyItems(paths, 'nested.').map((p) => p.label), ['a']);
});

test('jsonValues streams array elements, objects and scalars; jsonlValues lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcos-'));
  try {
    const f1 = path.join(dir, 'a.json');
    fs.writeFileSync(f1, '﻿[ {"id":"1","s":"a]b,{c"}, {"id":"2","n":9007199254740993} ,\n {"id":"3","arr":[1,[2]]} ]');
    const out = [];
    for await (const v of js.jsonValues(f1, { chunk: 7 })) out.push(bn.parseExact(v.text));
    assert.equal(out.length, 3);
    assert.equal(out[0].s, 'a]b,{c');
    assert.equal(out[1].n, `${bn.MARK}9007199254740993`);
    const f2 = path.join(dir, 'b.json');
    fs.writeFileSync(f2, '{"id":"x"}\n{"id":"y"}');
    const o2 = [];
    for await (const v of js.jsonValues(f2, { chunk: 3 })) o2.push(JSON.parse(v.text).id);
    assert.deepEqual(o2, ['x', 'y']);
    const f3 = path.join(dir, 'c.jsonl');
    fs.writeFileSync(f3, '{"id":"1"}\n\n{"id":"2"}\r\n');
    const o3 = [];
    for await (const v of js.jsonlValues(f3)) o3.push(v.line);
    assert.deepEqual(o3, [1, 3]);
    assert.equal(js.isJsonl(f3), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cost report: summary, index advice, suggested policy, hints, markdown', () => {
  const pages = [
    { page: 1, items: 10, charge: 50, ms: 20, metrics: { retrievedDocumentCount: 5000, outputDocumentCount: 10, indexHitRatio: 0.002, totalExecutionTimeInMs: 30, partitions: 4 } },
    { page: 2, items: 5, charge: 25, ms: 10, metrics: { retrievedDocumentCount: 2500, outputDocumentCount: 5, indexHitRatio: 0.002, partitions: 4 } },
  ];
  const s = pro.summarize(pages);
  assert.equal(s.charge, 75);
  assert.equal(s.items, 15);
  assert.equal(s.retrieved, 7500);
  const im = { UtilizedSingleIndexes: [{ IndexSpec: '/status/?' }], PotentialCompositeIndexes: [{ IndexSpecs: ['/customer ASC', '/total DESC'] }], PotentialSingleIndexes: [{ IndexSpec: '/total/?' }] };
  const adv = pro.indexAdvice(im);
  assert.deepEqual(adv.composite, [['/customer ASC', '/total DESC']]);
  const policy = { indexingMode: 'consistent', includedPaths: [{ path: '/status/?' }], excludedPaths: [{ path: '/*' }] };
  const sug = pro.suggestedPolicy(policy, adv);
  assert.deepEqual(sug.compositeIndexes, [[{ path: '/customer', order: 'ascending' }, { path: '/total', order: 'descending' }]]);
  assert.ok(sug.includedPaths.find((p) => p.path === '/total/?'));
  const info = { throughput: '400 RU/s manual', resource: { partitionKey: { paths: ['/customer'] }, indexingPolicy: policy } };
  const h = pro.hints(s, info, 'SELECT * FROM c WHERE c.status = "open" ORDER BY c.total DESC', adv);
  assert.ok(h.some((x) => /loaded 7,500 documents to return 15/.test(x)));
  assert.ok(h.some((x) => /no filter on the partition key/.test(x)));
  assert.ok(h.some((x) => /excludes "\/\*"/.test(x)));
  assert.equal(pro.throughputNumber('autoscale up to 4,000 RU/s'), 4000);
  const md = pro.costReportMarkdown({ target: { conn: 'Local', db: 'shop', container: 'orders' }, query: 'SELECT * FROM c', parameters: [], pages, info, indexMetrics: im, truncated: false, when: '2026-11-09 21:00' });
  assert.match(md, /\*\*75 RU\*\*/);
  assert.match(md, /compositeIndexes/);
  assert.match(md, /Runs per second at that throughput \| about 5\.33/);
});

test('webview HTML: strict CSP, nonce scripts, no remote origins', () => {
  const html = buildHtml({ cspSource: 'vscode-resource:', scriptUri: 'vscode-resource:/w.js', styleUri: 'vscode-resource:/s.css', title: 'T <x>', page: 'results', data: { a: '</script>' } });
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-[^']+'/);
  assert.match(html, /img-src vscode-resource: blob: data:/);
  assert.ok(!/https?:\/\/(?!www\.paypal\.com|marketplace\.visualstudio\.com|open-vsx\.org)/.test(html.replace(/href="https:\/\/(www\.paypal\.com|marketplace\.visualstudio\.com|open-vsx\.org)[^"]*"/g, '')));
  assert.ok(!html.includes('</script>"'));
  assert.match(html, /T &lt;x&gt;/);
});

test('package.json: name rule, engines, activation, Pro titles, no USD 15', () => {
  const pk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pk.displayName.startsWith('Cosmos DB Client & Azure Cosmos DB Explorer'));
  assert.ok(pk.displayName.includes('CosmosDB'));
  assert.equal(pk.engines.vscode, '^1.90.0');
  assert.ok(!pk.activationEvents.includes('*'));
  assert.ok(!JSON.stringify(pk).includes('USD 15'));
  const titles = pk.contributes.commands.map((c) => c.title);
  assert.ok(titles.includes('Query Cost Report (Pro)'));
  assert.ok(titles.some((t) => /Copy Container.*\(Pro\)/.test(t)));
  for (const c of pk.contributes.commands) assert.ok(c.command.startsWith('zovoCosmos.'));
});

test('source: no telemetry modules, no eval, SDK loaded lazily', () => {
  const src = fs.readdirSync(path.join(__dirname, '..', 'src')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
  assert.ok(!/applicationinsights|telemetry-reporter|\beval\(/i.test(src));
  const ext = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
  assert.ok(!/require\(['"]@azure\/cosmos['"]\)/.test(ext));
  assert.equal(pro.PRO_ENABLED, true);
  assert.equal(pro.FREE_TRIES, 3);
});

test('item uris carry a short reference that maps back to the item, also after a reload', () => {
  const items = require('../src/items');
  const store = new Map();
  items.useMemento({ get: (k, d) => (store.has(k) ? store.get(k) : d), update: (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); return Promise.resolve(); } });
  const Uri = { from: (o) => ({ ...o, toString: () => `${o.scheme}:${o.path}?${o.query}`, with: (x) => Uri.from({ ...o, ...x }) }) };
  const u = items.itemUri({ Uri }, { id: 'c1', name: 'Local emulator' }, 'shop', 'orders', { id: 'a/b', pk: ['acme', 'eu'] });
  assert.match(u.query, /^ref=[\w-]{12}$/);
  assert.equal(u.path, '/Local emulator/shop/orders/a_b.json');
  assert.deepEqual(items.stateOf(u), { c: 'c1', d: 'shop', k: 'orders', id: 'a/b', pk: ['acme', 'eu'] });
  assert.ok(Object.keys(store.get('zovoCosmos.itemRefs')).length === 1);
});

test('nextPage retries a timed-out page, not other errors', async () => {
  const { nextPage } = require('../src/transfer');
  let n = 0;
  const flaky = { next: async () => { n++; if (n < 3) throw Object.assign(new Error('Timeout Error! Request took more than 30000 ms'), { name: 'TimeoutError' }); return { items: [1] }; } };
  assert.deepEqual((await nextPage(flaky, 2)).items, [1]);
  let m = 0;
  const bad = { next: async () => { m++; throw Object.assign(new Error('Syntax error'), { code: 400 }); } };
  await assert.rejects(() => nextPage(bad, 2));
  assert.equal(m, 1);
  let k = 0;
  const slow = { next: async () => { k++; throw Object.assign(new Error('x'), { code: 408 }); } };
  await assert.rejects(() => nextPage(slow, 2));
  assert.equal(k, 3);
});
