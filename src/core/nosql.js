'use strict';
// Cosmos DB NoSQL query helpers: comments and parameters, error positions, query metrics, partition keys,
// property names for autocomplete, CSV rows. Pure functions, no vscode, no SDK.

const { isMarker, markerText, stringifyExact, parseExact } = require('./bignum');

const SYSTEM_PROPS = ['_rid', '_self', '_etag', '_attachments', '_ts'];

/**
 * Prepare a query file for the server.
 * - Lines "-- @name = value" (or "// @name = value") define a parameter. The value is JSON when it parses
 *   (number, "string", true, null, [array], {object}); anything else is taken as a plain string.
 * - Comments (-- and //, to the end of the line, outside strings) are replaced by spaces, so error positions
 *   from the server still point at the right character of the file.
 * Returns {query, parameters: [{name, value}], used: [names in the query], missing: [used but not defined]}.
 */
function prepareQuery(text) {
  const src = String(text || '');
  const defs = new Map();
  const lineRe = /^[ \t]*(?:--|\/\/)[ \t]*(@[A-Za-z_][A-Za-z0-9_]*)[ \t]*[=:][ \t]*(.*?)[ \t]*$/gm;
  let m;
  while ((m = lineRe.exec(src))) defs.set(m[1], parseParamValue(m[2]));
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < n && src[j] !== q) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if ((c === '-' && src[i + 1] === '-') || (c === '/' && src[i + 1] === '/')) {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  const used = [];
  const useRe = /@[A-Za-z_][A-Za-z0-9_]*/g;
  const stripped = out.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (s) => ' '.repeat(s.length));
  while ((m = useRe.exec(stripped))) if (!used.includes(m[0])) used.push(m[0]);
  const parameters = used.filter((u) => defs.has(u)).map((u) => ({ name: u, value: defs.get(u) }));
  const missing = used.filter((u) => !defs.has(u));
  return { query: out, parameters, used, missing, empty: !out.trim() };
}

function parseParamValue(raw) {
  const s = String(raw).trim();
  if (!s) return '';
  try { return parseExact(s); } catch { return s; }
}

/**
 * The position of a query error, from the Cosmos error message or body:
 * {"errors":[{"severity":"Error","location":{"start":7,"end":11},"code":"SC1001","message":"Syntax error, ..."}]}
 * Returns {start, end, message} or null. Offsets are into the query text sent.
 */
function errorPosition(err) {
  const texts = [];
  if (err && err.body && Array.isArray(err.body.errors) && err.body.errors.length) { // the emulator sends the list as the body
    const e = err.body.errors.find((x) => x && x.location) || err.body.errors[0];
    return { start: e.location ? Number(e.location.start) : null, end: e.location ? Number(e.location.end) : null, message: e.message || 'Query error', code: e.code || '' };
  }
  if (err) {
    if (err.body && typeof err.body.message === 'string') texts.push(err.body.message);
    if (typeof err.message === 'string') texts.push(err.message);
  }
  for (const t of texts) {
    const at = t.indexOf('{"errors"');
    if (at >= 0) {
      const json = balanced(t, at);
      if (json) {
        try {
          const o = JSON.parse(json);
          const e = (o.errors || []).find((x) => x && x.location) || (o.errors || [])[0];
          if (e) return { start: e.location ? Number(e.location.start) : null, end: e.location ? Number(e.location.end) : null, message: e.message || 'Query error', code: e.code || '' };
        } catch { /* fall through */ }
      }
    }
    const loc = /"location"\s*:\s*\{\s*"start"\s*:\s*(\d+)\s*,\s*"end"\s*:\s*(\d+)/.exec(t);
    if (loc) {
      const msg = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t.slice(loc.index));
      return { start: Number(loc[1]), end: Number(loc[2]), message: msg ? JSON.parse(`"${msg[1]}"`) : 'Query error', code: '' };
    }
  }
  return null;
}

function balanced(s, at) {
  let depth = 0;
  let inS = false;
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    if (inS) { if (c === '\\') i++; else if (c === '"') inS = false; continue; }
    if (c === '"') inS = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(at, i + 1); }
  }
  return null;
}

/** One short line for a Cosmos error: status, code and the first useful sentence; never the whole JSON. */
function errorText(err) {
  if (!err) return 'Unknown error';
  const pos = errorPosition(err);
  if (pos && pos.message) return `${pos.message}${pos.code ? ` (${pos.code})` : ''}`;
  const code = err.code || err.statusCode;
  let msg = (err.body && err.body.message) || err.message || String(err);
  msg = String(msg).replace(/\r?\n/g, ' ');
  const cut = msg.search(/ActivityId:|, Request URI:|RequestStartTime:/);
  if (cut > 0) msg = msg.slice(0, cut);
  msg = msg.replace(/^Message:\s*/, '').replace(/\s+/g, ' ').trim().replace(/[,;\s]+$/, '');
  if (msg.length > 400) msg = msg.slice(0, 400) + '…';
  if (code === 401 || code === 403) {
    if (/key|signature|authorization/i.test(msg)) return `The account key was refused (${code}). Check the key or connection string.`;
    return `Access denied (${code}): ${msg}`;
  }
  if (code === 404) return `Not found (404): ${msg}`;
  if (code === 408) return 'The request timed out (408). The account or emulator did not answer in time.';
  if (code === 412) return 'The item changed on the server since you opened it (ETag mismatch, 412).';
  if (code === 413) return 'The item is too large (413). Cosmos DB allows at most 2 MB per item.';
  if (code === 429) return 'Too many requests (429): the request units per second of this container are used up. Wait a moment or raise the throughput.';
  const sys = err.code && typeof err.code === 'string' ? err.code : (err.cause && err.cause.code) || '';
  if (/ECONNREFUSED/.test(sys + msg)) return 'Connection refused. Is the account endpoint right, and is the emulator running?';
  if (/ENOTFOUND|EAI_AGAIN/.test(sys + msg)) return 'The host name was not found. Check the endpoint (and your network).';
  if (/ECONNRESET|socket hang up/.test(sys + msg)) return 'The connection was closed by the other side (the emulator may have stopped).';
  if (/self.signed|SELF_SIGNED|UNABLE_TO_VERIFY|CERT_/.test(sys + msg)) return 'The server certificate is not trusted. Self-signed certificates are accepted only for localhost (the emulator).';
  if (/Timeout Error|ETIMEDOUT|timed out/i.test(msg + sys)) return 'The request timed out. The account or emulator did not answer in time.';
  return code ? `${msg} (${code})` : msg;
}

const METRIC_KEYS = {
  totalExecutionTimeInMs: 'Execution time (ms)',
  queryCompileTimeInMs: 'Compile time (ms)',
  queryLogicalPlanBuildTimeInMs: 'Logical plan (ms)',
  queryPhysicalPlanBuildTimeInMs: 'Physical plan (ms)',
  queryOptimizationTimeInMs: 'Optimization (ms)',
  indexLookupTimeInMs: 'Index lookup (ms)',
  documentLoadTimeInMs: 'Document load (ms)',
  VMExecutionTimeInMs: 'Runtime execution (ms)',
  documentWriteTimeInMs: 'Document write (ms)',
  retrievedDocumentCount: 'Retrieved documents',
  retrievedDocumentSize: 'Retrieved size (bytes)',
  outputDocumentCount: 'Output documents',
  outputDocumentSize: 'Output size (bytes)',
  indexHitRatio: 'Index hit ratio',
  indexUtilizationRatio: 'Index utilization ratio',
};

/** "a=1;b=2.5" -> {a:1, b:2.5}. */
function parseMetricString(s) {
  const out = {};
  for (const part of String(s || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = Number(part.slice(eq + 1));
    if (k && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Query metrics from a FeedResponse: a header string, or an object of strings / QueryMetrics per partition range.
 * Counts and times are added up; the index hit ratio is weighted by retrieved documents.
 */
function mergeMetrics(raw) {
  if (!raw) return null;
  const list = [];
  if (typeof raw === 'string') list.push(parseMetricString(raw));
  else if (typeof raw === 'object') {
    for (const v of Object.values(raw)) {
      if (typeof v === 'string') list.push(parseMetricString(v));
      else if (v && typeof v === 'object') list.push(flattenQueryMetricsObject(v));
    }
  }
  if (!list.length) return null;
  const sum = {};
  let hitW = 0; let hitN = 0;
  for (const m of list) {
    for (const [k, v] of Object.entries(m)) {
      if (k === 'indexHitRatio' || k === 'indexUtilizationRatio') continue;
      sum[k] = (sum[k] || 0) + v;
    }
    const r = m.indexHitRatio !== undefined ? m.indexHitRatio : m.indexUtilizationRatio;
    if (r !== undefined) { const w = m.retrievedDocumentCount || 1; hitW += r * w; hitN += w; }
  }
  if (hitN) sum.indexHitRatio = hitW / hitN;
  sum.partitions = list.length;
  return sum;
}

/** The SDK's QueryMetrics class -> flat keys (best effort; fields differ between SDK versions). */
function flattenQueryMetricsObject(o) {
  const out = {};
  const ms = (t) => (t && typeof t.totalMilliseconds === 'function' ? t.totalMilliseconds() : (t && typeof t === 'object' && 'ticks' in t ? t.ticks / 10000 : Number(t)));
  if (o.retrievedDocumentCount !== undefined) out.retrievedDocumentCount = Number(o.retrievedDocumentCount);
  if (o.retrievedDocumentSize !== undefined) out.retrievedDocumentSize = Number(o.retrievedDocumentSize);
  if (o.outputDocumentCount !== undefined) out.outputDocumentCount = Number(o.outputDocumentCount);
  if (o.outputDocumentSize !== undefined) out.outputDocumentSize = Number(o.outputDocumentSize);
  if (o.indexHitDocumentCount !== undefined && o.retrievedDocumentCount) out.indexHitRatio = Number(o.indexHitDocumentCount) / Number(o.retrievedDocumentCount);
  if (o.totalQueryExecutionTime !== undefined) out.totalExecutionTimeInMs = ms(o.totalQueryExecutionTime);
  if (o.indexLookupTime !== undefined) out.indexLookupTimeInMs = ms(o.indexLookupTime);
  if (o.documentLoadTime !== undefined) out.documentLoadTimeInMs = ms(o.documentLoadTime);
  if (o.vmExecutionTime !== undefined) out.VMExecutionTimeInMs = ms(o.vmExecutionTime);
  for (const k of Object.keys(out)) if (!Number.isFinite(out[k])) delete out[k];
  return out;
}

/** Index metrics header (base64 JSON or JSON) -> object, or null. */
function parseIndexMetrics(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const s = String(raw).trim();
  const tryJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
  return tryJson(s) || tryJson(Buffer.from(s, 'base64').toString('utf8')) || tryJson(decodeURIComponent(s));
}

/** "/a/b" -> ['a', 'b'] (handles "/\"a b\"/c"). */
function pathParts(p) {
  const out = [];
  const re = /\/(?:"((?:[^"\\]|\\.)*)"|([^/]+))/g;
  let m;
  while ((m = re.exec(String(p || '')))) out.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2]);
  return out;
}

const NONE = Symbol('none');

/** The value at a partition key path, or NONE when a part is missing. */
function valueAt(doc, path) {
  let v = doc;
  for (const part of pathParts(path)) {
    if (v === null || typeof v !== 'object' || !(part in v)) return NONE;
    v = v[part];
  }
  return v;
}

/**
 * The partition key value of a document for a container definition {paths, kind}.
 * Returns {value, missing, unsafe}: value is a single value for Hash, an array for MultiHash; missing lists the
 * paths the document does not have; unsafe is true when a value is a number with more digits than JavaScript holds.
 */
function partitionKeyOf(doc, pkDef) {
  const paths = (pkDef && pkDef.paths) || [];
  if (!paths.length) return { value: undefined, missing: [], unsafe: false, none: true };
  const vals = [];
  const missing = [];
  let unsafe = false;
  for (const p of paths) {
    const v = valueAt(doc, p);
    if (v === NONE) { missing.push(p); vals.push(undefined); continue; }
    if (isMarker(v)) unsafe = true;
    vals.push(v);
  }
  const multi = paths.length > 1 || (pkDef && pkDef.kind === 'MultiHash');
  return { value: multi ? vals : vals[0], missing, unsafe, none: missing.length === paths.length };
}

function setAt(doc, path, value) {
  const parts = pathParts(path);
  let o = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  if (parts.length) o[parts[parts.length - 1]] = value;
}

/** Label for a partition key value in messages and tooltips. */
function pkLabel(v) {
  if (v === undefined) return '(none)';
  return stringifyExact(v);
}

/**
 * Property paths for autocomplete from sample items: {path, count, types}. Depth 3, arrays looked into (first 5),
 * at most 2,000 paths. Paths use dot notation; names that are not identifiers use ["name"].
 */
function samplePaths(items, maxDepth = 3) {
  const map = new Map();
  const add = (path, v) => {
    if (map.size >= 2000 && !map.has(path)) return;
    const e = map.get(path) || { path, count: 0, types: new Set() };
    e.count++;
    e.types.add(isMarker(v) ? 'number' : Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
    map.set(path, e);
  };
  const seg = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? `.${k}` : `["${k.replace(/"/g, '\\"')}"]`);
  const walk = (v, path, depth) => {
    if (depth >= maxDepth || v === null || typeof v !== 'object' || isMarker(v)) return;
    if (Array.isArray(v)) { for (const x of v.slice(0, 5)) walk(x, `${path}[0]`, depth + 1); return; }
    for (const [k, x] of Object.entries(v)) {
      if (depth === 0 && SYSTEM_PROPS.includes(k)) continue;
      const p = `${path}${seg(k)}`;
      add(p.replace(/^\./, ''), x);
      walk(x, p, depth + 1);
    }
  };
  for (const it of items || []) walk(it, '', 0);
  return [...map.values()].map((e) => ({ path: e.path, count: e.count, types: [...e.types] })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

/** Grid columns from items: id first, then partition key fields, then the rest by first appearance; system props last. */
function columnsOf(items, pkDef, max = 200) {
  const seen = new Set();
  const order = [];
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    for (const k of Object.keys(it)) if (!seen.has(k)) { seen.add(k); order.push(k); }
    if (order.length > max * 2) break;
  }
  const pkTop = ((pkDef && pkDef.paths) || []).map((p) => pathParts(p)[0]).filter(Boolean);
  const first = ['id', ...pkTop.filter((k) => k !== 'id')].filter((k) => seen.has(k));
  const sys = SYSTEM_PROPS.filter((k) => seen.has(k));
  const rest = order.filter((k) => !first.includes(k) && !SYSTEM_PROPS.includes(k));
  return [...first, ...rest].slice(0, max).concat(sys);
}

/** A cell for CSV: strings as is, numbers exact, objects as JSON. */
function csvCell(v) {
  if (v === undefined || v === null) return '';
  let s;
  if (isMarker(v)) s = markerText(v);
  else if (typeof v === 'object') s = stringifyExact(v);
  else s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`; // no formula injection when opened in a spreadsheet
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(values) { return values.map(csvCell).join(','); }

function stripSystem(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (!SYSTEM_PROPS.includes(k)) out[k] = v;
  return out;
}

module.exports = {
  SYSTEM_PROPS, METRIC_KEYS, NONE, prepareQuery, parseParamValue, errorPosition, errorText, parseMetricString, mergeMetrics,
  parseIndexMetrics, pathParts, valueAt, partitionKeyOf, setAt, pkLabel, samplePaths, columnsOf, csvCell, csvRow, stripSystem,
};
