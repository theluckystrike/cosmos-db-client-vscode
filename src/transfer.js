'use strict';
// Streamed export (JSON, JSONL, CSV), import (JSON, JSONL) and container copy. No vscode import: progress and
// cancellation come in as callbacks, so the tests run these against the emulator.
// Memory stays flat: one page (export, copy) or one batch (import) at a time; file writes respect backpressure.

const fs = require('fs');
const { stringifyExact, parseExact } = require('./core/bignum');
const { columnsOf, csvRow, stripSystem, errorText, partitionKeyOf } = require('./core/nosql');
const { jsonValues, jsonlValues, isJsonl } = require('./core/jsonstream');

function isTimeout(e) { return !!e && (e.code === 408 || e.name === 'TimeoutError' || /Timeout Error|timed out/i.test(String(e.message))); }

/** it.next() with up to `retries` more tries when a page times out (a slow page, not a broken query). */
async function nextPage(it, retries = 2, onRetry) {
  for (let i = 0; ; i++) {
    try { return await it.next(); } catch (e) {
      if (!isTimeout(e) || i >= retries) throw e;
      if (onRetry) onRetry(i + 1, e);
    }
  }
}

function writer(file) {
  const out = fs.createWriteStream(file, { encoding: 'utf8' });
  let failed = null;
  let wake = null;
  out.on('error', (e) => { failed = e; if (wake) wake(); });
  out.on('drain', () => { if (wake) wake(); });
  return {
    async write(s) {
      if (failed) throw failed;
      if (!out.write(s)) await new Promise((r) => { wake = () => { wake = null; r(); }; });
      if (failed) throw failed;
    },
    async close() {
      if (failed) throw failed;
      await new Promise((r, j) => { out.end(() => (failed ? j(failed) : r())); });
    },
    destroy() { out.destroy(); },
  };
}

/**
 * Export every item of a query. opts: {format: json|jsonl|csv, pageSize, partitionKey, system (keep _rid ...),
 * onProgress({count, charge}), isCancelled()}. Returns {count, charge, cancelled, extraColumns}.
 */
async function exportQuery(account, db, container, spec, file, opts = {}) {
  const format = opts.format || 'jsonl';
  const feed = { maxItemCount: opts.pageSize || 1000, metrics: false };
  if (opts.partitionKey !== undefined) feed.partitionKey = opts.partitionKey;
  const it = account.query(db, container, spec, feed);
  const w = writer(file);
  let count = 0; let charge = 0; let cols = null; let extra = 0; let first = true;
  const pkDef = opts.pkDef || null;
  try {
    if (format === 'json') await w.write('[');
    while (it.hasMore()) {
      if (opts.isCancelled && opts.isCancelled()) {
        if (format === 'json') await w.write('\n]\n');
        await w.close();
        return { count, charge, cancelled: true, extraColumns: extra };
      }
      const page = await nextPage(it, 2, opts.onRetry);
      charge += page.charge;
      let chunk = '';
      for (const raw of page.items) {
        const doc = opts.system ? raw : stripSystem(raw);
        if (format === 'csv') {
          if (!cols) {
            cols = columnsOf(page.items.map((x) => (opts.system ? x : stripSystem(x))), pkDef);
            chunk += `${cols.map((c) => csvRow([c])).join(',')}\n`;
          }
          if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
            for (const k of Object.keys(doc)) if (!cols.includes(k)) { extra++; break; }
            chunk += `${csvRow(cols.map((c) => doc[c]))}\n`;
          } else chunk += `${csvRow([doc])}\n`;
        } else if (format === 'json') {
          chunk += `${first ? '\n' : ',\n'}${stringifyExact(doc)}`;
          first = false;
        } else chunk += `${stringifyExact(doc)}\n`;
        count++;
      }
      if (chunk) await w.write(chunk);
      if (opts.onProgress) opts.onProgress({ count, charge });
      if (!page.hasMore) break;
    }
    if (format === 'json') await w.write(first ? ']\n' : '\n]\n');
    await w.close();
    return { count, charge, cancelled: false, extraColumns: extra };
  } catch (e) {
    w.destroy();
    throw e;
  }
}

/**
 * Import a JSON or JSONL file with bulk writes. opts: {mode: upsert|create, batch, pkDef, onProgress({read, ok,
 * failed, charge}), isCancelled()}. Items without an "id" get none added: the server refuses them, and they count
 * as failed with a clear message. Returns {read, ok, failed, charge, errors, cancelled, badLines}.
 */
async function importFile(account, db, container, file, opts = {}) {
  const batchSize = opts.batch || 100;
  const pkDef = opts.pkDef || (await account.partitionKeyDef(db, container));
  const src = isJsonl(file) ? jsonlValues(file) : jsonValues(file);
  let read = 0; let ok = 0; let failed = 0; let charge = 0; let conflicts = 0;
  const errors = [];
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const r = await account.bulkWrite(db, container, batch, opts.mode || 'upsert', pkDef);
    ok += r.ok; failed += r.failed; charge += r.charge; conflicts += r.conflicts || 0;
    for (const e of r.errors) if (errors.length < 8) errors.push(e);
    batch = [];
    if (opts.onProgress) opts.onProgress({ read, ok, failed, charge });
  };
  for await (const v of src) {
    if (opts.isCancelled && opts.isCancelled()) { await flush(); return { read, ok, failed, charge, errors, conflicts, cancelled: true }; }
    read++;
    let doc;
    try { doc = parseExact(v.text); } catch (e) {
      failed++;
      if (errors.length < 8) errors.push(`${v.line ? `line ${v.line}` : `value ${v.index + 1}`}: not valid JSON (${e.message})`);
      continue;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { failed++; if (errors.length < 8) errors.push(`${v.line ? `line ${v.line}` : `value ${v.index + 1}`}: not a JSON object`); continue; }
    if (typeof doc.id !== 'string' || !doc.id) {
      if (typeof doc.id === 'number') doc.id = String(doc.id);
      else { failed++; if (errors.length < 8) errors.push(`${v.line ? `line ${v.line}` : `value ${v.index + 1}`}: no "id" string`); continue; }
    }
    if (partitionKeyOf(doc, pkDef).unsafe) { failed++; if (errors.length < 8) errors.push(`item "${doc.id}": the partition key is a number with more digits than JavaScript holds`); continue; }
    batch.push(stripSystem(doc));
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  return { read, ok, failed, charge, errors, conflicts, cancelled: false };
}

/** Count items of a JSON / JSONL file without keeping them (for the confirmation). Stops at limit. */
async function countValues(file, limit = 5000000) {
  let n = 0;
  const src = isJsonl(file) ? jsonlValues(file) : jsonValues(file);
  for await (const _ of src) { n++; if (n >= limit) break; } // eslint-disable-line no-unused-vars
  return n;
}

/**
 * Copy every item of a container to another container (any account). The target container is created with the
 * source's partition key and indexing policy when it does not exist. opts: {mode, onProgress, isCancelled, pageSize}.
 */
async function copyContainer(src, srcDb, srcContainer, dst, dstDb, dstContainer, opts = {}) {
  const info = await src.containerInfo(srcDb, srcContainer);
  const pkDef = info.resource.partitionKey;
  await dst.createDatabaseIfNotExists(dstDb);
  let created = false;
  try { await dst.containerInfo(dstDb, dstContainer); } catch (e) {
    if (e.code !== 404) throw e;
    const ip = info.resource.indexingPolicy ? { ...info.resource.indexingPolicy } : undefined;
    await dst.createContainer(dstDb, dstContainer, { paths: pkDef.paths, kind: pkDef.kind, version: pkDef.version }, ip);
    created = true;
  }
  const dstPk = await dst.partitionKeyDef(dstDb, dstContainer);
  if (JSON.stringify(dstPk.paths) !== JSON.stringify(pkDef.paths)) {
    throw Object.assign(new Error(`The target container's partition key (${dstPk.paths.join(', ')}) differs from the source's (${pkDef.paths.join(', ')}). Pick a new container name, or one with the same key.`), { friendly: true });
  }
  const it = src.query(srcDb, srcContainer, { query: 'SELECT * FROM c', parameters: [] }, { maxItemCount: opts.pageSize || 500, metrics: false });
  let read = 0; let ok = 0; let failed = 0; let readCharge = 0; let writeCharge = 0;
  const errors = [];
  while (it.hasMore()) {
    if (opts.isCancelled && opts.isCancelled()) return { read, ok, failed, readCharge, writeCharge, errors, created, cancelled: true };
    const page = await nextPage(it, 2, opts.onRetry);
    readCharge += page.charge;
    read += page.items.length;
    if (page.items.length) {
      const r = await dst.bulkWrite(dstDb, dstContainer, page.items.map(stripSystem), opts.mode || 'upsert', dstPk);
      ok += r.ok; failed += r.failed; writeCharge += r.charge;
      for (const e of r.errors) if (errors.length < 8) errors.push(e);
    }
    if (opts.onProgress) opts.onProgress({ read, ok, failed, readCharge, writeCharge });
    if (!page.hasMore) break;
  }
  return { read, ok, failed, readCharge, writeCharge, errors, created, cancelled: false };
}

module.exports = { nextPage, isTimeout, exportQuery, importFile, countValues, copyContainer, errorText };
