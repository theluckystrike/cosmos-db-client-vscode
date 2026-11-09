'use strict';
// Autocomplete for Cosmos DB NoSQL queries: property paths from a 100-item sample of the bound container
// (read once on the first completion request, kept 10 minutes), plus keywords and built-in functions.

const KEYWORDS = ['SELECT', 'VALUE', 'TOP', 'DISTINCT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'ESCAPE', 'ORDER BY', 'ASC', 'DESC', 'GROUP BY', 'OFFSET', 'LIMIT', 'JOIN', 'AS', 'EXISTS', 'ARRAY', 'UNDEFINED', 'NULL', 'TRUE', 'FALSE'];
const FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ARRAY_CONTAINS', 'ARRAY_LENGTH', 'ARRAY_SLICE', 'CONTAINS', 'STARTSWITH', 'ENDSWITH', 'LOWER', 'UPPER', 'LENGTH', 'SUBSTRING', 'CONCAT', 'INDEX_OF', 'REPLACE', 'TRIM', 'LTRIM', 'RTRIM', 'IS_DEFINED', 'IS_NULL', 'IS_NUMBER', 'IS_STRING', 'IS_ARRAY', 'IS_OBJECT', 'IS_BOOL', 'ABS', 'CEILING', 'FLOOR', 'ROUND', 'GetCurrentDateTime', 'GetCurrentTimestamp', 'DateTimeAdd', 'DateTimeDiff', 'DateTimePart', 'ST_DISTANCE', 'ST_WITHIN', 'StringEquals', 'RegexMatch', 'ToString', 'StringToNumber', 'DOCUMENTID', 'VectorDistance', 'FullTextContains'];

function sampleQuery() { return 'SELECT TOP 100 * FROM c'; }

/** Completion entries from sampled paths: [{label, detail, kind: 'property'}] for the text after "alias." */
function propertyItems(paths, prefix) {
  const pre = String(prefix || '');
  const out = [];
  const seen = new Set();
  for (const p of paths) {
    if (!p.path.startsWith(pre)) continue;
    const rest = p.path.slice(pre.length);
    const next = rest.split(/[.[]/)[0];
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push({ label: next, detail: `${p.types.join(' | ')} · in ${p.count} of the sample`, path: pre + next });
  }
  return out;
}

class CompletionSource {
  constructor(sampler) {
    this.sampler = sampler; // async (binding) => items
    this.cache = new Map();
  }

  async paths(binding) {
    const key = `${binding.connId}/${binding.db}/${binding.container}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.paths;
    const { samplePaths } = require('./core/nosql');
    const items = await this.sampler(binding);
    const paths = samplePaths(items);
    this.cache.set(key, { at: Date.now(), paths });
    return paths;
  }

  clear() { this.cache.clear(); }
}

module.exports = { KEYWORDS, FUNCTIONS, propertyItems, CompletionSource, sampleQuery };
