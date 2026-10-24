import https from 'node:https';
import { URL } from 'node:url';

import { accessTokenHeader, assertReadOnly, collectPages } from './core.mjs';
import { LOG_DATASETS, DEVICE_DATASETS } from './datasets.mjs';
import { assertDeviceId } from './devices.mjs';
import { buildLogParams, clampLogLimit } from './logs.mjs';
import { WRITE_OPS, assertWriteAllowed, buildSitePath, buildWritePath, writesEnabled } from './write-guard.mjs';

/**
 * Omada Open API client.
 *
 * Read-only by default: every request passes assertReadOnly, which permits only
 * GET plus the single OAuth token endpoint.
 *
 * Writes are available only when OMADA_ENABLE_WRITES=true. Even then, only the
 * operations in WRITE_OPS are reachable, paths are built from validated
 * identifiers, and the method guard re-checks every mutating request. Tool calls
 * additionally default to dry-run; see src/write-tools.mjs.
 */
export class OmadaClient {
  #baseUrl;
  #omadacId;
  #agent;
  #timeout;
  #accessToken;
  #clientId;
  #clientSecret;
  #pendingToken;
  #writesEnabled;

  constructor({ baseUrl, omadacId, agent, accessToken, clientId, clientSecret, timeout = 15_000, enableWrites = false }) {
    if (!baseUrl || !omadacId) throw new Error('baseUrl and omadacId are required.');
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#omadacId = omadacId;
    this.#agent = agent;
    this.#timeout = timeout;
    this.#accessToken = accessToken;
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#writesEnabled = enableWrites === true;
  }

  /** True when credentials were supplied but no token is cached yet. */
  get authMode() {
    return this.#accessToken ? 'access-token' : 'client-credentials';
  }

  /** Whether this client was constructed with write capability enabled. */
  get writesEnabled() {
    return this.#writesEnabled;
  }

  #url(version, path) {
    return `${this.#baseUrl}/openapi/${version}/${encodeURIComponent(this.#omadacId)}${path}`;
  }

  /** Low-level request. Returns the parsed JSON envelope. */
  async request(method, path, { params, body, version = 'v1' } = {}) {
    const m = String(method).toUpperCase();
    // Build the URL once; the guard takes pathname only (a full https:// URL
    // would trip the '//' safety check that exists to block protocol-relative
    // paths like //evil.example).
    const url = new URL(this.#url(version, path));
    if (m === 'GET') {
      assertReadOnly(m, url.pathname);
    } else {
      // Defence in depth: re-checks the fully-built path against WRITE_OPS.
      if (!this.#writesEnabled) assertReadOnly(m, url.pathname);
      assertWriteAllowed(m, url.pathname, this.#omadacId);
    }
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    const isTokenRequest = m === 'POST' && url.pathname === '/openapi/authorize/token';
    if (isTokenRequest) {
      // Token endpoint: OAuth body auth, no bearer header.
    } else {
      Object.assign(headers, accessTokenHeader(await this.#token()));
    }

    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (payload) headers['Content-Length'] = payload.length;

    const raw = await this.#send({ method: m, url, headers, payload });
    // Reads must return data; writes may legitimately return no result field
    // (e.g. reorder uses OperationResponseWithoutResult).
    return this.#envelope(raw, m, url.pathname, { requireResult: m === 'GET' });
  }

  /**
   * Perform one allowlisted write. Throws before any network I/O if writes are
   * disabled or the operation is unknown.
   */
  async write(opName, { siteId, params = {}, body }) {
    if (!this.#writesEnabled) {
      throw new Error('Writes are disabled. Start the server with OMADA_ENABLE_WRITES=true to allow them.');
    }
    const op = WRITE_OPS[opName];
    if (!op) throw new Error(`Unknown write operation: ${opName}`);
    // DELETE endpoints take no request body; POST/PUT/PATCH require one. Passing
    // a body to DELETE would send an unexpected entity to the controller.
    const isDelete = op.method === 'DELETE';
    if (!isDelete && (body === undefined || body === null || typeof body !== 'object')) {
      throw new Error(`write(${opName}) requires an object body.`);
    }
    const path = buildWritePath(opName, siteId, params);
    return this.request(op.method, path, { body: isDelete ? undefined : body, version: op.version });
  }

  #send({ method, url, headers, payload }) {
    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          method,
          hostname: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          headers,
          agent: this.#agent,
          timeout: this.#timeout,
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      request.on('timeout', () => request.destroy(new Error('Request timed out.')));
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  #envelope(raw, method, path, { requireResult = true } = {}) {
    if (raw.status < 200 || raw.status >= 300) {
      throw new Error(`${method} ${path} failed: HTTP ${raw.status}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.text);
    } catch {
      throw new Error(`${method} ${path} returned a non-JSON response.`);
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.errorCode !== 'number') {
      throw new Error(`${method} ${path} returned an unexpected response shape.`);
    }
    if (parsed.errorCode !== 0) {
      throw new Error(`${method} ${path} returned error ${parsed.errorCode}: ${parsed.msg || 'unknown error'}`);
    }
    if (requireResult && parsed.result === undefined) {
      throw new Error(`${method} ${path} returned no result; refusing to treat it as empty.`);
    }
    return parsed.result ?? {};
  }

  /** Resolve an access token, fetching via client credentials only if needed. */
  async #token() {
    if (this.#accessToken) return this.#accessToken;
    if (!this.#clientId || !this.#clientSecret) {
      throw new Error('No access token and no OAuth client credentials configured.');
    }
    // Share one in-flight token request across concurrent reads.
    this.#pendingToken ??= this.#fetchToken().finally(() => {
      this.#pendingToken = undefined;
    });
    return this.#pendingToken;
  }

  async #fetchToken() {
    const url = new URL(`${this.#baseUrl}/openapi/authorize/token`);
    url.searchParams.set('grant_type', 'client_credentials');
    const payload = Buffer.from(
      JSON.stringify({
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        omadacId: this.#omadacId,
      }),
    );
    const raw = await this.#send({
      method: 'POST',
      url,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      },
      payload,
    });
    const parsed = await this.#envelope(raw, 'POST', url.pathname);
    if (!parsed.accessToken) throw new Error('Token endpoint returned no accessToken.');
    this.#accessToken = parsed.accessToken;
    return parsed.accessToken;
  }

  // ---- Reads ---------------------------------------------------------------

  async #read(version, path, params) {
    return this.request('GET', path, { version, params });
  }

  async #readAll(version, path, params = {}) {
    return collectPages((page) => this.#read(version, path, { ...params, page, pageSize: 100 }));
  }

  #site(siteId) {
    if (!siteId) throw new Error('siteId is required.');
    return `/sites/${encodeURIComponent(siteId)}`;
  }

  async listSites() {
    return (await this.#readAll('v1', '/sites')).records;
  }

  async listDevices(siteId) {
    return (await this.#readAll('v1', `${this.#site(siteId)}/devices`)).records;
  }

  async listClients(siteId) {
    return (await this.#readAll('v1', `${this.#site(siteId)}/clients`)).records;
  }

  /** Non-paginated first-page read used for LAN networks (v2 endpoint). */
  async getLanNetworks(siteId) {
    const result = await this.#read('v2', `${this.#site(siteId)}/lan-networks`, { page: 1, pageSize: 100 });
    if (!Array.isArray(result.data)) throw new Error('LAN networks returned an unexpected pagination schema.');
    return result.data;
  }

  /**
   * Read one fixed dataset. `definition` is { path, version, paginated }.
   * Unknown paths are rejected by the caller before reaching here.
   */
  async readDataset(siteId, definition) {
    const base = this.#site(siteId);
    if (definition.paginated) {
      return await this.#readAll(definition.version ?? 'v1', `${base}${definition.path}`);
    }
    const result = await this.#read(definition.version ?? 'v1', `${base}${definition.path}`);
    return { complete: true, result };
  }

  /**
   * Read the detail record of one adopted device.
   *
   * `kind` must be a key of DEVICE_DATASETS holding a `{deviceId}` template —
   * there is no generic /devices/{mac} route (verified live: 404), so the
   * caller resolves the device type from the site device list first. The
   * identifier is validated by the same SAFE_ID path-traversal rule the write
   * paths use, so a device id can never inject a path segment.
   */
  async readDeviceDetail(siteId, kind, deviceId) {
    const definition = DEVICE_DATASETS[kind];
    if (!definition || definition.paginated !== false || !definition.path.includes('{deviceId}')) {
      throw new Error(`Not a device detail dataset: ${kind}`);
    }
    const path = buildSitePath(definition.path, { deviceId });
    const result = await this.#read(definition.version ?? 'v1', `${this.#site(siteId)}${path}`);
    return { complete: true, result };
  }

  /**
   * Read one switch-port dataset (`switchPorts` counters or `switchPortPoe`
   * PoE info) through the fixed registry.
   *
   * `switchMac` is passed as the controller's own `filters.switchMac` query
   * filter, which is verified to narrow these endpoints server-side; it is
   * validated with SAFE_ID first so it cannot carry a second filter. When it
   * is omitted the whole site's ports are collected — through collectPages(),
   * so a truncated or repeated page surfaces as an error, never a short list.
   */
  async readSwitchPortDataset(siteId, kind, options = {}) {
    const definition = DEVICE_DATASETS[kind];
    if (!definition || definition.paginated !== true || !definition.filters?.includes('switchMac')) {
      throw new Error(`Not a switch-port dataset: ${kind}`);
    }
    const params = {};
    if (options.switchMac !== undefined && options.switchMac !== null) {
      params['filters.switchMac'] = assertDeviceId(options.switchMac, 'switchMac');
    }
    return await this.#readAll(definition.version ?? 'v1', `${this.#site(siteId)}${definition.path}`, params);
  }

  /**
   * Read a bounded window of a site log (alerts or events).
   *
   * `kind` is a key of the fixed LOG_DATASETS registry; there is no way to
   * reach an arbitrary path. The read uses the same #read()/collectPages()
   * path as every other read, so a malformed, repeated or truncated response
   * surfaces as an error instead of an empty list.
   *
   * The controller requires `page` and `pageSize` on both log endpoints
   * (omitting either is an HTTP 400), so the page size is derived from the
   * caller's limit: at most one page is needed to satisfy the limit, and a
   * larger limit simply walks more pages through collectPages().
   *
   * Records are collected from the first page onwards — the controller returns
   * logs newest-first, and that ordering continues across pages — so the
   * bounded result is the newest records in the window.
   */
  async readLogDataset(siteId, kind, options = {}) {
    const definition = LOG_DATASETS[kind];
    if (!definition) throw new Error(`Unknown log dataset: ${kind}`);
    const limit = clampLogLimit(options.limit);
    const { params, startMs, endMs } = buildLogParams(options, definition);
    const pageSize = Math.min(limit, definition.maxPageSize);
    const path = `${this.#site(siteId)}${definition.path}`;
    let totalRows;
    const collected = await collectPages(
      async (page) => {
        const result = await this.#read(definition.version ?? 'v1', path, { ...params, page, pageSize });
        if (totalRows === undefined && Number.isInteger(result?.totalRows)) totalRows = result.totalRows;
        return result;
      },
      100,
      { limit },
    );
    return {
      kind,
      totalRows: totalRows ?? null,
      limited: collected.limited === true,
      limit,
      window: { since: new Date(startMs).toISOString(), until: new Date(endMs).toISOString() },
      records: collected.records,
    };
  }
}
