'use strict';
// Streamed reading of JSON and JSONL files for import: one item text at a time, never the whole file in memory.
// A .json file may hold one array of objects, one object, or objects one after another. Pure Node, no vscode.

const fs = require('fs');

/**
 * Yields {text, index} for each top-level value: the elements of a top-level array, or each top-level value.
 * Works on chunks; memory is bounded by the largest single item.
 */
async function* jsonValues(file, opts = {}) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: opts.chunk || 1 << 20 });
  let buf = '';
  let depth = 0; // depth inside the current value (0 = between values)
  let inStr = false;
  let esc = false;
  let start = -1;
  let arrayMode = null; // true when the file starts with '[' (elements are depth 1 values)
  let index = 0;
  let pos = 0; // scan position in buf
  let first = true;
  for await (let chunk of stream) {
    if (first) { chunk = chunk.replace(/^﻿/, ''); first = false; }
    buf += chunk;
    for (; pos < buf.length; pos++) {
      const c = buf[pos];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (arrayMode === null) {
        if (/\s/.test(c)) continue;
        arrayMode = c === '[';
        if (arrayMode) continue; // the outer array itself is not a value we yield
      }
      const base = arrayMode ? 0 : 0;
      if (c === '"') { inStr = true; if (depth === base && start < 0) start = pos; continue; }
      if (c === '{' || c === '[') { if (depth === base && start < 0) start = pos; depth++; continue; }
      if (c === '}' || c === ']') {
        if (depth === 0) { // the closing bracket of the outer array
          if (arrayMode && c === ']' && start >= 0) { yield { text: buf.slice(start, pos), index: index++ }; start = -1; }
          continue;
        }
        depth--;
        if (depth === base && start >= 0) { yield { text: buf.slice(start, pos + 1), index: index++ }; start = -1; }
        continue;
      }
      if (depth === base) {
        if (c === ',' || /\s/.test(c)) {
          if (start >= 0) { yield { text: buf.slice(start, pos), index: index++ }; start = -1; }
          continue;
        }
        if (start < 0) start = pos; // a bare scalar (number, true, null)
      }
    }
    // drop what is consumed
    const keep = start >= 0 ? start : pos;
    buf = buf.slice(keep);
    pos -= keep;
    if (start >= 0) start = 0;
  }
  if (start >= 0 && buf.slice(start).trim()) yield { text: buf.slice(start).trim(), index: index++ };
}

/** Yields {text, index, line} for each non-empty line of a JSONL / NDJSON file. */
async function* jsonlValues(file) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let line = 0;
  let index = 0;
  for await (let l of rl) {
    line++;
    if (line === 1) l = l.replace(/^﻿/, '');
    if (!l.trim()) continue;
    yield { text: l, index: index++, line };
  }
}

function isJsonl(file) { return /\.(jsonl|ndjson|jsonlines)$/i.test(file); }

module.exports = { jsonValues, jsonlValues, isJsonl };
