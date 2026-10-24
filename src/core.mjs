import { X509Certificate } from 'node:crypto';
import https from 'node:https';

/**
 * Build an https.Agent that pins the controller's leaf certificate.
 *
 * TLS verification stays enabled. We trust this exact leaf rather than the system
 * CA store, which lets a LAN controller with a self-signed cert work without
 * disabling verification. A changed certificate fails closed.
 */
export function certificateAgent(pem, expectedSha256) {
  const certificate = new X509Certificate(pem);
  const expected = expectedSha256.toLowerCase();
  const actual = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
  if (actual !== expected) {
    throw new Error('Stored controller certificate does not match its recorded fingerprint.');
  }
  return new https.Agent({
    ca: pem,
    rejectUnauthorized: true,
    checkServerIdentity(_host, peer) {
      if (peer.fingerprint256?.replaceAll(':', '').toLowerCase() !== expected) {
        return new Error('Controller TLS certificate changed; refusing credentials.');
      }
    },
  });
}

/** The header Omada expects for a pre-fetched OAuth access token. */
export function accessTokenHeader(token) {
  return { Authorization: `AccessToken=${token}` };
}

/**
 * Guard against any configuration write. Only GETs and the single OAuth token
 * endpoint are permitted; the MCP exposes no write path and this enforces it at
 * the transport layer as defence in depth.
 */
export function assertReadOnly(method, path) {
  const m = String(method).toUpperCase();
  if (m === 'GET') return;
  if (m === 'POST' && path === '/openapi/authorize/token') return;
  throw new Error(`Blocked non-read request: ${m} ${path}`);
}

const SENSITIVE_KEY = /password|secret|token|cookie|authorizedkeys|private.?key|api.?key|psk|community|bearer/i;

/** Recursively redact secret-bearing keys and any literal secret values. */
export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    return secrets.filter(Boolean).reduce((result, secret) => result.split(secret).join('[REDACTED]'), value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(child, secrets),
      ]),
    );
  }
  return value;
}

/**
 * Fetch every page of a paginated endpoint. Refuses to report success on a
 * truncated, repeated, or malformed read so an error is never mistaken for an
 * empty list.
 *
 * `limit` (optional) stops the walk early once that many records are
 * collected — used by the log endpoints, where the caller asked for a bounded
 * window rather than the whole history. The returned `limited` flag says the
 * walk stopped early; the truncation was requested, not detected, so it is
 * reported instead of thrown. Without `limit` the behaviour is unchanged and
 * the result is exactly `{ complete: true, records }`.
 */
export async function collectPages(fetchPage, maxPages = 100, { limit } = {}) {
  const records = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const result = await fetchPage(page);
    if (!result || !Array.isArray(result.data)) {
      throw new Error('Unexpected pagination schema; cannot claim a complete inventory.');
    }
    const total = result.totalRows;
    if (total !== undefined && (!Number.isInteger(total) || total < 0)) {
      throw new Error('Invalid totalRows in API response.');
    }
    const fingerprint = JSON.stringify(result.data);
    if (result.data.length && seen.has(fingerprint)) {
      throw new Error('API repeated a page; result is incomplete.');
    }
    seen.add(fingerprint);
    records.push(...result.data);
    if (total !== undefined && records.length > total) {
      throw new Error('Pagination changed during the read; retry.');
    }
    if (total !== undefined && records.length === total) return { complete: true, records };
    if (limit !== undefined && records.length >= limit) {
      return { complete: true, limited: true, records: records.slice(0, limit) };
    }
    if (!result.data.length) {
      if (total !== undefined && records.length !== total) {
        throw new Error('API ended before totalRows; result is incomplete.');
      }
      return { complete: true, records };
    }
  }
  throw new Error('Page limit reached; result is incomplete.');
}
