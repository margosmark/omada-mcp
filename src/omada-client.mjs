import https from 'node:https';
import { URL } from 'node:url';

import { accessTokenHeader, assertReadOnly, collectPages } from './core.mjs';

/**
 * Minimal, read-only Omada Open API client.
 *
 * Deliberately self-contained: it has no write methods, so no configuration change
 * is reachable through it. Every outbound request passes assertReadOnly, which
 * permits only GET plus the single OAuth token endpoint.
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

  constructor({ baseUrl, omadacId, agent, accessToken, clientId, clientSecret, timeout = 15_000 }) {
    if (!baseUrl || !omadacId) throw new Error('baseUrl and omadacId are required.');
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#omadacId = omadacId;
    this.#agent = agent;
    this.#timeout = timeout;
    this.#accessToken = accessToken;
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
  }

  /** True when credentials were supplied but no token is cached yet. */
  get authMode() {
    return this.#accessToken ? 'access-token' : 'client-credentials';
  }

  #url(version, path) {
    return `${this.#baseUrl}/openapi/${version}/${encodeURIComponent(this.#omadacId)}${path}`;
  }

  /** Low-level request. Returns the parsed JSON envelope. */
  async request(method, path, { params, body, version = 'v1' } = {}) {
    assertReadOnly(method, path);
    const url = new URL(this.#url(version, path));
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    const isTokenRequest = method.toUpperCase() === 'POST';
    if (isTokenRequest) {
      // Token endpoint: OAuth body auth, no bearer header.
    } else {
      Object.assign(headers, accessTokenHeader(await this.#token()));
    }

    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (payload) headers['Content-Length'] = payload.length;

    const raw = await this.#send({ method, url, headers, payload });
    return this.#envelope(raw, method, url.pathname);
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

  #envelope(raw, method, path) {
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
    if (parsed.result === undefined) {
      throw new Error(`${method} ${path} returned no result; refusing to treat it as empty.`);
    }
    return parsed.result;
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
}
