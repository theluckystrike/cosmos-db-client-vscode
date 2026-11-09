'use strict';
// One Cosmos DB account: a thin layer over @azure/cosmos that keeps numbers exact and errors short.
// Network: only to the endpoint of this account (and Microsoft sign-in when the user picked Entra ID).
// No vscode import here (the Entra token callback is passed in), so tests can drive it against the emulator.

const path = require('path');
const https = require('https');
const { protect, restore, stringifyExact } = require('./core/bignum');
const { isLocalHost, friendly } = require('./core/connstr');
const { mergeMetrics, parseIndexMetrics, partitionKeyOf, errorText } = require('./core/nosql');

let sdkCache = null;
/** dist/sdk.js in the package (src/sdk.js in tests). Loaded on the first connect only. */
function sdk() {
  if (!sdkCache) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    sdkCache = require(path.join(__dirname, 'sdk.js'));
  }
  return sdkCache;
}

/** An HttpClient for the SDK: request bodies get exact numbers back, responses keep them as marker strings. */
function exactHttpClient(inner) {
  const base = inner || sdk().createDefaultHttpClient();
  return {
    async sendRequest(request) {
      if (typeof request.body === 'string') {
        const fixed = restore(request.body);
        if (fixed !== request.body) {
          request.body = fixed;
          if (request.headers && request.headers.has && request.headers.has('content-length')) request.headers.delete('content-length');
        }
      }
      const response = await base.sendRequest(request);
      if (typeof response.bodyAsText === 'string') response.bodyAsText = protect(response.bodyAsText);
      return response;
    },
  };
}

/**
 * conn: {endpoint, auth: 'key' | 'entra', allowSelfSigned?}
 * secret: the account key (auth 'key').
 * opts: {timeoutMs, getEntraToken: async (scope) => {token, expiresOnTimestamp}}
 */
class Account {
  constructor(conn, secret, opts = {}) {
    this.conn = conn;
    const local = isLocalHost(conn.endpoint);
    this.local = local;
    const timeoutMs = opts.timeoutMs || 15000;
    const options = {
      endpoint: conn.endpoint,
      httpClient: exactHttpClient(opts.innerHttpClient),
      userAgentSuffix: 'zovo-cosmos-db-client',
      connectionPolicy: {
        requestTimeout: timeoutMs,
        enableEndpointDiscovery: !local, // the emulator reports itself as the only region; no discovery round trips
        retryOptions: { maxRetryAttemptCount: 3, fixedRetryIntervalInMilliseconds: 0, maxWaitTimeInSeconds: Math.ceil(timeoutMs / 1000) },
      },
    };
    if (conn.auth === 'entra') {
      if (typeof opts.getEntraToken !== 'function') throw friendly('Microsoft Entra ID sign-in is not available here.');
      const scope = `${new URL(conn.endpoint).origin}/.default`;
      options.aadCredentials = { getToken: async () => opts.getEntraToken(scope) };
    } else {
      if (!secret) throw friendly('No account key is saved for this connection. Edit the connection and paste the key again.');
      options.key = secret;
    }
    // Self-signed certificates (the emulator's) are accepted only for localhost, never for a remote host.
    if (local && /^https:/i.test(conn.endpoint)) options.agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
    const { CosmosClient } = sdk();
    this.client = new CosmosClient(options);
    this.pkCache = new Map();
  }

  dispose() { try { this.client.dispose(); } catch { /* ignore */ } }

  /** Checks the endpoint and the key with one small request. Returns {regions, consistency}. */
  async ping() {
    const r = await this.client.getDatabaseAccount();
    const a = r.resource || {};
    return { regions: (a.readableLocations || []).map((l) => l.name).filter(Boolean), consistency: a.consistencyPolicy || '' };
  }

  async databases() {
    const { resources } = await this.client.databases.readAll().fetchAll();
    return resources.map((d) => d.id).sort((a, b) => a.localeCompare(b));
  }

  async containers(db) {
    const { resources } = await this.client.database(db).containers.readAll().fetchAll();
    for (const c of resources) this.pkCache.set(`${db}/${c.id}`, c.partitionKey || { paths: [] });
    return resources.map((c) => ({ id: c.id, partitionKey: c.partitionKey || { paths: [] }, defaultTtl: c.defaultTtl })).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Container definition with throughput. */
  async containerInfo(db, id) {
    const c = this.client.database(db).container(id);
    const { resource } = await c.read();
    this.pkCache.set(`${db}/${id}`, resource.partitionKey || { paths: [] });
    let throughput = null;
    try {
      const o = await c.readOffer();
      if (o.resource) throughput = offerText(o.resource);
    } catch { /* serverless or no permission */ }
    if (!throughput) {
      try { const o = await this.client.database(db).readOffer(); if (o.resource) throughput = `${offerText(o.resource)} (shared by the database)`; } catch { /* none */ }
    }
    return { resource, throughput: throughput || 'not set (serverless or shared)' };
  }

  async partitionKeyDef(db, id) {
    const k = `${db}/${id}`;
    if (!this.pkCache.has(k)) await this.containerInfo(db, id);
    return this.pkCache.get(k);
  }

  async scripts(db, id, kind) {
    const s = this.client.database(db).container(id).scripts;
    const src = kind === 'storedProcedures' ? s.storedProcedures : kind === 'triggers' ? s.triggers : s.userDefinedFunctions;
    const { resources } = await src.readAll().fetchAll();
    return resources.map((r) => ({ id: r.id, body: r.body, triggerType: r.triggerType, triggerOperation: r.triggerOperation })).sort((a, b) => a.id.localeCompare(b.id));
  }

  async executeStoredProcedure(db, id, sprocId, pk, params) {
    const r = await this.client.database(db).container(id).scripts.storedProcedure(sprocId).execute(pk, params || []);
    return { result: r.resource, charge: Number(r.requestCharge) || 0 };
  }

  /**
   * A query that pages on demand. next() reads one page: {items, charge, metrics, indexMetrics, hasMore, ms}.
   * opts: {maxItemCount, partitionKey, metrics, indexMetrics, abortSignal}
   */
  query(db, id, querySpec, opts = {}) {
    const feed = {
      maxItemCount: opts.maxItemCount || 100,
      populateQueryMetrics: opts.metrics !== false,
      populateIndexMetrics: !!opts.indexMetrics,
    };
    if (opts.partitionKey !== undefined) feed.partitionKey = opts.partitionKey;
    if (opts.abortSignal) feed.abortSignal = opts.abortSignal;
    const it = this.client.database(db).container(id).items.query(querySpec, feed);
    let pages = 0;
    let started = false;
    return {
      async next() {
        const t0 = Date.now();
        const r = await it.fetchNext();
        pages++;
        started = true;
        const headers = r.headers || {};
        return {
          items: r.resources || [],
          charge: Number(r.requestCharge) || 0,
          metrics: mergeMetrics(r.queryMetrics || headers['x-ms-documentdb-query-metrics']),
          indexMetrics: parseIndexMetrics(r.indexMetrics || headers['x-ms-cosmos-index-utilization']),
          hasMore: it.hasMoreResults(),
          continuation: r.continuationToken || '',
          page: pages,
          ms: Date.now() - t0,
        };
      },
      hasMore() { return !started || it.hasMoreResults(); },
    };
  }

  /** {doc, etag, charge, text}; doc keeps exact numbers as markers, text is the exact JSON. */
  async readItem(db, id, itemId, pk) {
    const r = await this.client.database(db).container(id).item(itemId, pkArg(pk)).read();
    if (r.statusCode === 404 || !r.resource) throw Object.assign(friendly(`Item "${itemId}" was not found. It may have been deleted.`), { code: 404 });
    return { doc: r.resource, etag: r.etag || r.resource._etag, charge: Number(r.requestCharge) || 0, text: stringifyExact(r.resource, 2) };
  }

  /** Replace by id string and the original partition key value, with an ETag check unless etag is null. */
  async replaceItem(db, id, itemId, pk, doc, etag) {
    const options = etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : {};
    const r = await this.client.database(db).container(id).item(itemId, pkArg(pk)).replace(doc, options);
    return { doc: r.resource, etag: r.etag || (r.resource && r.resource._etag), charge: Number(r.requestCharge) || 0 };
  }

  async createItem(db, id, doc) {
    const r = await this.client.database(db).container(id).items.create(doc);
    return { doc: r.resource, etag: r.etag || (r.resource && r.resource._etag), charge: Number(r.requestCharge) || 0 };
  }

  async deleteItem(db, id, itemId, pk) {
    const r = await this.client.database(db).container(id).item(itemId, pkArg(pk)).delete();
    return { charge: Number(r.requestCharge) || 0 };
  }

  /**
   * Upsert or create many documents. Uses the SDK's bulk API; falls back to parallel single requests when the
   * server does not support batch requests. Returns {ok, failed, charge, errors: [first messages]}.
   */
  async bulkWrite(db, id, docs, mode, pkDef) {
    const c = this.client.database(db).container(id);
    const { BulkOperationType } = sdk();
    const type = mode === 'create' ? BulkOperationType.Create : BulkOperationType.Upsert;
    let ok = 0; let failed = 0; let charge = 0; let conflicts = 0;
    const errors = [];
    if (!this.noBulk) {
      try {
        const ops = docs.map((d) => {
          const pk = partitionKeyOf(d, pkDef);
          return pk.none && !(pkDef && pkDef.paths && pkDef.paths.length) ? { operationType: type, resourceBody: d } : { operationType: type, resourceBody: d, partitionKey: pkArg(pk.none ? undefined : pk.value) };
        });
        const res = await c.items.executeBulkOperations(ops);
        res.forEach((r, i) => {
          const code = r.response ? r.response.statusCode : (r.error && (r.error.code || r.error.statusCode));
          charge += Number(r.response ? r.response.requestCharge : (r.error && r.error.requestCharge)) || 0;
          if (code >= 200 && code < 300) ok++;
          else {
            failed++;
            if (code === 409) conflicts++;
            if (errors.length < 5) errors.push(`item ${JSON.stringify(String(docs[i] && docs[i].id).slice(0, 60))}: ${code === 409 ? 'an item with this id already exists' : errorText(r.error || { code, message: `status ${code}` })}`);
          }
        });
        return { ok, failed, charge, errors, conflicts };
      } catch (e) {
        if (!/not supported|NotImplemented|BadRequest|batch/i.test(String(e && e.message)) || ok) throw e;
        this.noBulk = true; // the server refused batch requests: single requests from now on
      }
    }
    const queue = docs.slice();
    const worker = async () => {
      while (queue.length) {
        const d = queue.shift();
        try {
          const r = mode === 'create' ? await c.items.create(d) : await c.items.upsert(d);
          charge += Number(r.requestCharge) || 0;
          ok++;
        } catch (e) {
          failed++;
          if (e.code === 409) conflicts++;
          if (errors.length < 5) errors.push(`item ${JSON.stringify(String(d && d.id).slice(0, 60))}: ${e.code === 409 ? 'an item with this id already exists' : errorText(e)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return { ok, failed, charge, errors, conflicts };
  }

  async createDatabaseIfNotExists(db) {
    await this.client.databases.createIfNotExists({ id: db });
  }

  async createContainer(db, id, partitionKey, indexingPolicy) {
    const body = { id, partitionKey };
    if (indexingPolicy) body.indexingPolicy = indexingPolicy;
    const { resource } = await this.client.database(db).containers.createIfNotExists(body);
    this.pkCache.set(`${db}/${id}`, resource.partitionKey || partitionKey);
    return resource;
  }
}

/** The SDK's partition key argument. undefined = the item has no partition key value (NonePartitionKeyValue). */
function pkArg(v) {
  if (v === undefined) return sdk().NonePartitionKeyValue;
  return v;
}

function offerText(offer) {
  const c = offer.content || {};
  if (c.offerAutopilotSettings && c.offerAutopilotSettings.maxThroughput) return `autoscale up to ${c.offerAutopilotSettings.maxThroughput} RU/s`;
  if (c.offerThroughput) return `${c.offerThroughput} RU/s manual`;
  return null;
}

module.exports = { Account, exactHttpClient, pkArg, offerText, sdk };
