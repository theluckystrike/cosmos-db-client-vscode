'use strict';
// Exact numbers for Cosmos DB JSON.
// JSON.parse turns 9007199254740993 into 9007199254740992 and 0.12345678901234567890 into 0.12345678901234568.
// Cosmos stores JSON as sent, so a client that parses and writes back would silently change stored values.
// The fix lives in the HTTP layer (src/cosmos.js):
// - protect(text): every number token that a JavaScript number cannot hold exactly becomes a marker string
//   "\u0000ZN:<the exact digits>" before the SDK parses the response.
// - restore(text): every marker string in a request body becomes the bare number again before it is sent.
// So a document read, edited in another field and saved keeps the exact digits; the grid, the JSON view and the
// exports show the exact digits with a warning badge. Pure functions, no vscode, no SDK: unit-tested directly.

const MARK = '\u0000ZN:';
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** {d, p}: value = 0.d x 10^p with d free of leading and trailing zeros ('' for zero). */
function normalize(tok) {
  let s = String(tok).trim();
  if (s[0] === '-' || s[0] === '+') s = s.slice(1);
  let e = 0;
  const ei = s.search(/[eE]/);
  if (ei >= 0) { e = parseInt(s.slice(ei + 1), 10) || 0; s = s.slice(0, ei); }
  const [ip, fp = ''] = s.split('.');
  let d = ip + fp;
  let p = ip.length + e;
  let i = 0;
  while (i < d.length && d[i] === '0') i++;
  d = d.slice(i); p -= i;
  d = d.replace(/0+$/, '');
  if (!d) return { d: '', p: 0 };
  return { d, p };
}

/** True when a JSON number token does not survive a round trip through a JavaScript number. */
function isLossy(tok) {
  if (/^-?\d+$/.test(tok)) {
    if (tok.replace('-', '').length < 16) return false;
    let v = BigInt(tok);
    if (v < 0n) v = -v;
    return v >= MAX_SAFE; // the brief's rule: at or above Number.MAX_SAFE_INTEGER gets the badge
  }
  const n = Number(tok);
  if (!Number.isFinite(n)) return true;
  const a = normalize(tok);
  const b = normalize(String(n));
  return a.d !== b.d || a.p !== b.p;
}

/** Quick test: can the text hold a lossy number at all? 16 digits in a row (dots allowed) is the minimum. */
function mayHaveLossy(text) {
  return /\d[\d.]{15,}/.test(text) || /\d[eE][+-]?\d{3,}/.test(text);
}

/**
 * Walk the number tokens of a JSON text outside strings. cb(start, end, token) for each.
 * Tolerant: stops quietly at the end; does not validate the JSON.
 */
function scanNumbers(text, cb) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34) { // "
      i++;
      while (i < n) {
        const k = text.charCodeAt(i);
        if (k === 92) { i += 2; continue; } // backslash
        if (k === 34) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === 45 || (c >= 48 && c <= 57)) { // - or digit
      const start = i;
      i++;
      while (i < n) {
        const k = text.charCodeAt(i);
        if ((k >= 48 && k <= 57) || k === 46 || k === 101 || k === 69 || k === 43 || k === 45) i++; else break;
      }
      cb(start, i, text.slice(start, i));
      continue;
    }
    i++;
  }
}

/** Response text -> the same text with lossy numbers as marker strings. Unchanged (same string) when none. */
function protect(text) {
  if (typeof text !== 'string' || !text || !mayHaveLossy(text)) return text;
  let out = '';
  let last = 0;
  let hit = false;
  scanNumbers(text, (s, e, tok) => {
    if (!isLossy(tok)) return;
    hit = true;
    out += text.slice(last, s) + JSON.stringify(MARK + tok);
    last = e;
  });
  return hit ? out + text.slice(last) : text;
}

// JSON.stringify writes U+0000 as \u0000 (lowercase hex). Accept both cases.
const RESTORE_RE = /"\\u0000ZN:(-?[0-9][0-9.eE+-]*)"/gi;

/** Request text -> marker strings back to bare numbers. */
function restore(text) {
  if (typeof text !== 'string' || text.indexOf('ZN:') < 0) return text;
  return text.replace(RESTORE_RE, '$1');
}

const isMarker = (v) => typeof v === 'string' && v.startsWith(MARK) && /^-?[0-9][0-9.eE+-]*$/.test(v.slice(MARK.length));
const markerText = (v) => v.slice(MARK.length);
const toMarker = (tok) => MARK + tok;

/** JSON.parse that keeps lossy numbers as markers. */
function parseExact(text) { return JSON.parse(protect(text)); }

/** JSON.stringify that writes markers as bare exact numbers. */
function stringifyExact(value, space) { return restore(JSON.stringify(value, null, space)); }

/** [{start, end, token}] of lossy numbers in a JSON text (for editor diagnostics). */
function lossyRanges(text) {
  const out = [];
  if (!mayHaveLossy(text)) return out;
  scanNumbers(text, (s, e, tok) => { if (isLossy(tok)) out.push({ start: s, end: e, token: tok }); });
  return out;
}

/** Count markers inside a parsed value (for badges and messages). */
function countMarkers(v, depth = 0) {
  if (depth > 64) return 0;
  if (isMarker(v)) return 1;
  if (Array.isArray(v)) return v.reduce((a, x) => a + countMarkers(x, depth + 1), 0);
  if (v && typeof v === 'object') { let a = 0; for (const k of Object.keys(v)) a += countMarkers(v[k], depth + 1); return a; }
  return 0;
}

module.exports = { MARK, normalize, isLossy, mayHaveLossy, scanNumbers, protect, restore, isMarker, markerText, toMarker, parseExact, stringifyExact, lossyRanges, countMarkers };
