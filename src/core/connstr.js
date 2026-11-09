'use strict';
// Connection strings and endpoints. Pure functions, no vscode.

// The documented, public key of the Azure Cosmos DB emulator (the same on every machine; not a secret).
const EMULATOR_KEY = 'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';
const EMULATOR_PORT = 8081;

/** "AccountEndpoint=https://x.documents.azure.com:443/;AccountKey=abc==;" -> {endpoint, key}. Throws a friendly Error. */
function parseConnectionString(s) {
  const text = String(s || '').trim().replace(/^["']|["']$/g, '');
  if (!text) throw friendly('Paste a connection string: AccountEndpoint=https://<account>.documents.azure.com:443/;AccountKey=<key>;');
  const parts = {};
  for (const seg of text.split(';')) {
    const t = seg.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    parts[t.slice(0, eq).trim().toLowerCase()] = t.slice(eq + 1).trim(); // keys end in '=' padding: split at the first '='
  }
  const endpoint = parts.accountendpoint;
  const key = parts.accountkey;
  if (!endpoint) {
    if (/^mongodb(\+srv)?:\/\//i.test(text)) throw friendly('This is a MongoDB connection string. This extension speaks the Cosmos DB NoSQL API: copy the "PRIMARY CONNECTION STRING" from Keys in the Azure portal (it starts with AccountEndpoint=).');
    throw friendly('The connection string has no AccountEndpoint=. Copy it from Keys in the Azure portal, or from the emulator.');
  }
  if (!key) throw friendly('The connection string has no AccountKey=. Use the primary or secondary connection string, or use Microsoft Entra ID sign-in instead.');
  return { endpoint: normalizeEndpoint(endpoint), key };
}

/** https://acct.documents.azure.com:443/ -> https://acct.documents.azure.com:443/ (trailing slash, valid URL). */
function normalizeEndpoint(raw) {
  let s = String(raw || '').trim();
  if (!s) throw friendly('Enter the account endpoint, for example https://<account>.documents.azure.com:443/');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw friendly(`"${raw}" is not a valid endpoint URL.`); }
  if (!u.hostname) throw friendly(`"${raw}" has no host name.`);
  return `${u.protocol}//${u.host}/`;
}

function isLocalHost(endpoint) {
  try {
    const h = new URL(endpoint).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
  } catch { return false; }
}

function emulatorEndpoint(port, protocol) {
  return `${protocol || 'https'}://localhost:${port || EMULATOR_PORT}/`;
}

/** Account name for labels: "acct" from https://acct.documents.azure.com/, "localhost:8081" otherwise. */
function accountLabel(endpoint) {
  try {
    const u = new URL(endpoint);
    const m = /^([^.]+)\.documents\.azure\.(com|us|cn)$/i.exec(u.hostname);
    return m ? m[1] : u.host;
  } catch { return String(endpoint); }
}

function friendly(message) { return Object.assign(new Error(message), { friendly: true }); }

module.exports = { EMULATOR_KEY, EMULATOR_PORT, parseConnectionString, normalizeEndpoint, isLocalHost, emulatorEndpoint, accountLabel, friendly };
