'use strict';
// Zovo Pro tools: the Query Cost Report (request units and metrics of a whole query, with indexing advice) and
// Copy Container (to any container, in any account). Everything else is free and stays free: connections,
// the explorer, queries with RU and metrics on every page, paging, editing, create, delete, export and import.
// Each Pro tool can be used 3 times for free; after that one explanation offers the unlock (GitHub Sponsors or a
// license key, both checked without a server of ours). PRO_ENABLED = false makes every Pro tool free.

const { createLicense } = require('./license');
const { pathParts } = require('./core/nosql');

const PRO_ENABLED = true;
const FREE_TRIES = 3;
const SKU = 'cosmos-db-client-pro';
const TRIES_KEY = 'zovoCosmos.proTries';

function createPro(vscode, context) {
  // name 'Zovo' makes the label "Zovo Pro": one purchase for every Zovo extension.
  const license = createLicense({ vscode, context, sku: SKU, name: 'Zovo', commandPrefix: 'zovoCosmos', product: 'Cosmos DB Client' });

  /** True when the user may run the tool now (unlocked, a free try left, or unlocked in the dialog). */
  async function allow(feature, detail) {
    if (!PRO_ENABLED) return true;
    await license.ready;
    if (license.isPro(SKU)) { license.refresh().catch(() => {}); return true; }
    const tries = context.globalState.get(TRIES_KEY, {});
    const used = Number(tries[feature] || 0);
    if (used < FREE_TRIES) {
      tries[feature] = used + 1;
      await context.globalState.update(TRIES_KEY, tries);
      const left = FREE_TRIES - used - 1;
      vscode.window.setStatusBarMessage(`Cosmos DB: ${feature} is a Zovo Pro tool. Free try ${used + 1} of ${FREE_TRIES}${left ? ` (${left} left)` : ', the last one'}.`, 8000);
      return true;
    }
    return license.requirePro(feature, `${detail} You used your ${FREE_TRIES} free tries. Zovo Pro is USD 19 once and unlocks the Pro tools in every Zovo extension. Queries, editing, export, import and unlimited connections stay free.`);
  }

  function triesLeft(feature) {
    if (!PRO_ENABLED || license.isPro(SKU)) return Infinity;
    const tries = context.globalState.get(TRIES_KEY, {});
    return Math.max(0, FREE_TRIES - Number(tries[feature] || 0));
  }

  return { license, allow, triesLeft, enabled: PRO_ENABLED };
}

// ---------------------------------------------------------------- Query Cost Report

/** Add up page stats: {pages, items, charge, min, max, metrics totals, hit ratio weighted}. */
function summarize(pages) {
  const s = { pages: pages.length, items: 0, charge: 0, minPage: Infinity, maxPage: 0, ms: 0, retrieved: 0, retrievedBytes: 0, output: 0, outputBytes: 0, execMs: 0, indexLookupMs: 0, loadMs: 0, partitions: 0, hitW: 0, hitN: 0 };
  for (const p of pages) {
    s.items += p.items;
    s.charge += p.charge;
    s.minPage = Math.min(s.minPage, p.charge);
    s.maxPage = Math.max(s.maxPage, p.charge);
    s.ms += p.ms || 0;
    const m = p.metrics || {};
    s.retrieved += m.retrievedDocumentCount || 0;
    s.retrievedBytes += m.retrievedDocumentSize || 0;
    s.output += m.outputDocumentCount || 0;
    s.outputBytes += m.outputDocumentSize || 0;
    s.execMs += m.totalExecutionTimeInMs || 0;
    s.indexLookupMs += m.indexLookupTimeInMs || 0;
    s.loadMs += m.documentLoadTimeInMs || 0;
    s.partitions = Math.max(s.partitions, m.partitions || 0);
    if (m.indexHitRatio !== undefined) { const w = m.retrievedDocumentCount || 1; s.hitW += m.indexHitRatio * w; s.hitN += w; }
  }
  if (!pages.length) s.minPage = 0;
  s.hit = s.hitN ? s.hitW / s.hitN : null;
  return s;
}

/** Index advice from the index metrics header (JSON form) -> {single: [path], composite: [[spec]], utilized: [...], text}. */
function indexAdvice(im) {
  const out = { single: [], composite: [], utilized: [], text: '' };
  if (!im) return out;
  if (typeof im === 'string') { out.text = im; return out; }
  const pick = (o, ...keys) => { for (const k of keys) if (o[k] !== undefined) return o[k]; return undefined; };
  for (const x of pick(im, 'PotentialSingleIndexes', 'potentialSingleIndexes') || []) {
    const spec = pick(x, 'IndexSpec', 'indexSpec');
    if (spec) out.single.push(spec);
  }
  for (const x of pick(im, 'PotentialCompositeIndexes', 'potentialCompositeIndexes') || []) {
    const specs = pick(x, 'IndexSpecs', 'indexSpecs');
    if (specs && specs.length) out.composite.push(specs);
  }
  for (const x of pick(im, 'UtilizedSingleIndexes', 'utilizedSingleIndexes') || []) { const spec = pick(x, 'IndexSpec', 'indexSpec'); if (spec) out.utilized.push(spec); }
  for (const x of pick(im, 'UtilizedCompositeIndexes', 'utilizedCompositeIndexes') || []) { const specs = pick(x, 'IndexSpecs', 'indexSpecs'); if (specs) out.utilized.push(specs.join(', ')); }
  return out;
}

/** A suggested indexing policy: the current one plus the composite indexes the server says would help. */
function suggestedPolicy(policy, advice) {
  if (!policy || (!advice.composite.length && !advice.single.length)) return null;
  const p = JSON.parse(JSON.stringify(policy));
  for (const k of ['_rid', '_self', '_etag', '_ts']) delete p[k];
  if (advice.composite.length) {
    p.compositeIndexes = p.compositeIndexes || [];
    for (const specs of advice.composite) {
      const entry = specs.map((s) => { const [path, order] = String(s).trim().split(/\s+/); return { path, order: /desc/i.test(order || '') ? 'descending' : 'ascending' }; });
      const key = JSON.stringify(entry);
      if (!p.compositeIndexes.some((e) => JSON.stringify(e) === key)) p.compositeIndexes.push(entry);
    }
  }
  if (advice.single.length) {
    p.includedPaths = p.includedPaths || [];
    for (const s of advice.single) {
      const path = String(s).replace(/\/\?$/, '/?');
      if (!p.includedPaths.some((x) => x.path === path || x.path === '/*')) p.includedPaths.push({ path });
    }
  }
  return p;
}

/** Plain hints from the numbers. */
function hints(sum, info, query, advice) {
  const out = [];
  const perItem = sum.items ? sum.charge / sum.items : 0;
  const pkPaths = (info && info.resource && info.resource.partitionKey && info.resource.partitionKey.paths) || [];
  const policy = info && info.resource && info.resource.indexingPolicy;
  if (sum.retrieved && sum.output && sum.retrieved / Math.max(1, sum.output) >= 10) {
    out.push(`The engine loaded ${n(sum.retrieved)} documents to return ${n(sum.output)} (${n(sum.retrieved / Math.max(1, sum.output), 0)} to 1). A filter in the WHERE clause is not served by the index, or uses a function such as LOWER(), CONTAINS() or a type check on every document.`);
  }
  if (sum.hit !== null && sum.hit < 0.9 && sum.retrieved) out.push(`Index hit ratio is ${n(sum.hit * 100, 0)} %: ${n(100 - sum.hit * 100, 0)} % of the loaded documents were thrown away after loading. Range and equality filters on indexed paths keep it near 100 %.`);
  if (advice.composite.length) out.push(`The server says these composite indexes would help: ${advice.composite.map((c) => `(${c.join(', ')})`).join('; ')}. A composite index is needed for ORDER BY on two or more properties, and it lowers the cost of a filter plus ORDER BY.`);
  if (advice.single.length) out.push(`The server says these paths should be indexed: ${advice.single.join(', ')}.`);
  if (policy && policy.indexingMode === 'none') out.push('Indexing is turned off for this container (indexingMode "none"): every query reads every document.');
  if (policy && (policy.excludedPaths || []).some((x) => x.path === '/*')) out.push('The indexing policy excludes "/*" (everything not listed in includedPaths): filters on other properties are full scans.');
  const q = String(query || '');
  if (pkPaths.length) {
    const pkProp = pathParts(pkPaths[0]).join('.');
    const filtersPk = new RegExp(`\\bc\\.${pkProp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(=|IN\\b)`, 'i').test(q);
    if (!filtersPk && sum.partitions > 1) out.push(`The query has no filter on the partition key (${pkPaths.join(', ')}), so it ran on ${n(sum.partitions)} partition ranges. If you know the value, add WHERE c.${pkProp} = @value, or set "Partition key" in the results toolbar.`);
  }
  if (/select\s+\*/i.test(q) && sum.outputBytes > 1024 * 1024) out.push(`SELECT * returned ${mb(sum.outputBytes)} of data. Selecting only the properties you use (SELECT c.id, c.total ...) lowers the charge and the transfer.`);
  if (/order\s+by/i.test(q) && !advice.composite.length && perItem > 1 && sum.items > 100) out.push('ORDER BY with a filter often costs less with a composite index on (filter property, order property).');
  if (/\bcount\s*\(|\bsum\s*\(|\bavg\s*\(/i.test(q) && sum.charge > 1000) out.push('Aggregates over many documents cost RU on every run. If the number is read often, keep a running total (a change feed function, or a counter item) instead.');
  if (/offset\s+\d+\s+limit/i.test(q)) out.push('OFFSET ... LIMIT still reads and skips every item before the offset, so deep pages cost more each time. Continuation tokens (Load more) do not have this cost.');
  if (!out.length) out.push('Nothing stands out: the index serves this query and the charge per item is low.');
  return out;
}

/** RU/s of a throughput text such as "400 RU/s manual" or "autoscale up to 4000 RU/s". */
function throughputNumber(text) {
  const m = /(\d[\d,]*)\s*RU\/s/i.exec(String(text || ''));
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** The report as Markdown. */
function costReportMarkdown({ target, query, parameters, pages, info, indexMetrics, truncated, when }) {
  const sum = summarize(pages);
  const advice = indexAdvice(indexMetrics);
  const rus = throughputNumber(info && info.throughput);
  const policy = info && info.resource && info.resource.indexingPolicy;
  const suggestion = suggestedPolicy(policy, advice);
  const L = [];
  L.push(`# Query cost report: ${target.container}`);
  L.push('');
  L.push(`${target.conn} › ${target.db} › ${target.container} · ${when || localStamp(new Date())} · Zovo Pro`);
  L.push('');
  L.push('```sql');
  L.push(String(query).trim());
  L.push('```');
  if (parameters && parameters.length) L.push('', `Parameters: ${parameters.map((p) => `${p.name} = ${JSON.stringify(p.value)}`).join(', ')}`);
  L.push('', '## Cost', '');
  L.push('| Measure | Value |', '|---|---|');
  L.push(`| Request units, whole query | **${n(sum.charge)} RU** |`);
  L.push(`| Items returned | ${n(sum.items, 0)} |`);
  L.push(`| RU per returned item | ${sum.items ? n(sum.charge / sum.items, 3) : '-'} |`);
  L.push(`| Pages | ${n(sum.pages, 0)} (RU per page: min ${n(sum.minPage)}, average ${n(sum.pages ? sum.charge / sum.pages : 0)}, max ${n(sum.maxPage)}) |`);
  L.push(`| Documents loaded / returned | ${n(sum.retrieved, 0)} / ${n(sum.output, 0)} |`);
  L.push(`| Data loaded / returned | ${mb(sum.retrievedBytes)} / ${mb(sum.outputBytes)} |`);
  if (sum.hit !== null) L.push(`| Index hit ratio | ${n(sum.hit * 100, 1)} % |`);
  L.push(`| Server time (execution, index lookup, document load) | ${n(sum.execMs)} ms, ${n(sum.indexLookupMs)} ms, ${n(sum.loadMs)} ms |`);
  L.push(`| Round-trip time, all pages | ${n(sum.ms, 0)} ms |`);
  if (sum.partitions) L.push(`| Partition ranges touched (largest page) | ${n(sum.partitions, 0)} |`);
  L.push(`| Container throughput | ${info ? info.throughput : 'unknown'} |`);
  if (rus && sum.charge) L.push(`| Runs per second at that throughput | about ${n(rus / sum.charge, rus / sum.charge < 10 ? 2 : 0)} (with nothing else running) |`);
  if (sum.charge) L.push(`| RU for 1,000 runs | ${n(sum.charge * 1000, 0)} |`);
  if (truncated) L.push('', `Stopped after ${n(sum.pages, 0)} pages (${n(sum.items, 0)} items): the numbers cover that part only.`);
  L.push('', '## What to look at', '');
  for (const h of hints(sum, info, query, advice)) L.push(`- ${h}`);
  L.push('', '## Index use', '');
  if (advice.utilized.length) L.push(`Indexes used: ${advice.utilized.map((x) => `\`${x}\``).join(', ')}`); else if (!advice.text) L.push('The server returned no index utilization data for this query.');
  if (advice.text) L.push('', '```', advice.text.trim(), '```');
  if (suggestion) {
    L.push('', 'Suggested indexing policy (the current one plus the indexes above). Review it, then apply it in the Azure portal or with your deployment template; changing a policy re-indexes the container in the background and uses RU while it runs:', '', '```json', JSON.stringify(suggestion, null, 2), '```');
  }
  L.push('', '## Pages', '', '| Page | Items | RU | ms | Loaded | Returned |', '|---|---|---|---|---|---|');
  const shown = pages.length > 60 ? [...pages.slice(0, 30), null, ...pages.slice(-30)] : pages;
  for (const p of shown) {
    if (!p) { L.push('| … | | | | | |'); continue; }
    const m = p.metrics || {};
    L.push(`| ${p.page} | ${n(p.items, 0)} | ${n(p.charge)} | ${n(p.ms, 0)} | ${m.retrievedDocumentCount !== undefined ? n(m.retrievedDocumentCount, 0) : '-'} | ${m.outputDocumentCount !== undefined ? n(m.outputDocumentCount, 0) : '-'} |`);
  }
  if (policy) L.push('', '## Current indexing policy', '', '```json', JSON.stringify(cleanPolicy(policy), null, 2), '```');
  L.push('');
  return L.join('\n');
}

function localStamp(d) { const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function cleanPolicy(p) { const c = { ...p }; for (const k of ['_rid', '_self', '_etag', '_ts']) delete c[k]; return c; }
function n(v, d = 2) { return (Math.round((Number(v) || 0) * 10 ** d) / 10 ** d).toLocaleString('en-US'); }
function mb(b) { const v = Number(b) || 0; return v >= 1048576 ? `${n(v / 1048576)} MB` : v >= 1024 ? `${n(v / 1024, 1)} KB` : `${n(v, 0)} B`; }

module.exports = { createPro, summarize, indexAdvice, suggestedPolicy, hints, throughputNumber, costReportMarkdown, PRO_ENABLED, FREE_TRIES, SKU, TRIES_KEY };
