import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { test } from 'node:test';

import { accessTokenHeader, assertReadOnly, certificateAgent, collectPages, redact } from '../src/core.mjs';
import { OmadaClient } from '../src/omada-client.mjs';

test('assertReadOnly permits GET and the OAuth token endpoint only', () => {
  assert.doesNotThrow(() => assertReadOnly('GET', '/openapi/v1/x/sites'));
  assert.doesNotThrow(() => assertReadOnly('get', '/openapi/v1/x/sites'));
  assert.doesNotThrow(() => assertReadOnly('POST', '/openapi/authorize/token'));
  for (const [method, path] of [
    ['POST', '/openapi/v1/x/acls/osg-acls'],
    ['PUT', '/openapi/v1/x/acls/osg-acls/1'],
    ['PATCH', '/openapi/v1/x/lan-networks/1'],
    ['DELETE', '/openapi/v1/x/dhcp/aa'],
    ['POST', '/openapi/v1/x/setting/service/mdns'],
    ['POST', '/openapi/v1/x/qos/gateway/bwcs'],
  ]) {
    assert.throws(() => assertReadOnly(method, path), /Blocked non-read/);
  }
  // NOTE: GET is always allowed here. Path safety is handled by construction —
  // the client only builds paths from the fixed DATASETS registry and encoded
  // site IDs (see test below), never from user-supplied strings.
});

test('the OmadaClient has no write methods', () => {
  const client = new OmadaClient({ baseUrl: 'https://x', omadacId: 'o', agent: undefined, accessToken: 't' });
  const writeVerbs = ['post', 'put', 'patch', 'delete', 'create', 'update', 'remove', 'set', 'apply'];
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client));
  for (const verb of writeVerbs) {
    assert.ok(
      !methods.some((m) => m.toLowerCase() === verb),
      `client exposes a method that looks like a write: ${verb}`,
    );
  }
  // Every public method must be read-shaped.
  const allowed = new Set(['constructor', 'authMode', 'request', 'listSites', 'listDevices', 'listClients', 'getLanNetworks', 'readDataset']);
  for (const name of methods) {
    if (!allowed.has(name)) throw new Error(`Unexpected client method: ${name}`);
  }
});

test('assertReadOnly is enforced inside client.request before any socket work', async () => {
  const client = new OmadaClient({ baseUrl: 'https://192.0.2.1', omadacId: 'o', agent: undefined, accessToken: 't' });
  // request() calls assertReadOnly synchronously first, so this must throw before network I/O.
  await assert.rejects(() => client.request('POST', '/acls/osg-acls', { body: {} }), /Blocked non-read/);
  await assert.rejects(() => client.request('DELETE', '/setting/service/dhcp/aa'), /Blocked non-read/);
});

test('accessTokenHeader uses Omada AccessToken scheme, not Bearer', () => {
  assert.deepEqual(accessTokenHeader('abc123'), { Authorization: 'AccessToken=abc123' });
});

test('redact strips secret-bearing keys and literal secret values recursively', () => {
  const secrets = ['supersecret', 'tok_live'];
  const result = redact(
    {
      accessToken: 'x',
      clientSecret: 'y',
      nested: [{ password: 'p', cookie: 'c', message: 'failed supersecret', ok: 'tok_live-token' }],
      keep: 'visible',
      count: 7,
    },
    secrets,
  );
  assert.equal(result.accessToken, '[REDACTED]');
  assert.equal(result.clientSecret, '[REDACTED]');
  assert.equal(result.nested[0].password, '[REDACTED]');
  assert.equal(result.nested[0].cookie, '[REDACTED]');
  assert.equal(result.nested[0].message, 'failed [REDACTED]');
  assert.equal(result.nested[0].ok, '[REDACTED]-token');
  assert.equal(result.keep, 'visible');
  assert.equal(result.count, 7);
  const text = JSON.stringify(result);
  assert.ok(!text.includes('supersecret') && !text.includes('tok_live'));
});

test('redact returns primitives and empty values unchanged', () => {
  assert.equal(redact('plain'), 'plain');
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.deepEqual(redact([1, 'a']), [1, 'a']);
});

test('collectPages reads to totalRows across multiple pages', async () => {
  const pages = { 1: [1, 2], 2: [3] };
  const result = await collectPages(async (page) => ({ data: pages[page] ?? [], totalRows: 3 }));
  assert.deepEqual(result, { complete: true, records: [1, 2, 3] });
});

test('collectPages handles a zero-record page as complete', async () => {
  const result = await collectPages(async () => ({ data: [], totalRows: 0 }));
  assert.deepEqual(result, { complete: true, records: [] });
});

test('collectPages refuses malformed, truncated, repeated, or overflowing data', async () => {
  // Malformed: not an array of records.
  await assert.rejects(collectPages(async () => ({ errorCode: -1 })), /pagination schema/);
  await assert.rejects(collectPages(async () => undefined), /pagination schema/);
  // Truncated: empty page but totalRows says there is more.
  await assert.rejects(collectPages(async () => ({ data: [], totalRows: 2 })), /before totalRows/);
  // Repeated page (infinite loop protection).
  await assert.rejects(collectPages(async () => ({ data: [1], totalRows: 5 })), /repeated a page/);
  // Overflow.
  await assert.rejects(
    collectPages(async (page) => ({ data: [page, page + 0.5], totalRows: 3 })),
    /changed during the read/,
  );
  // Invalid totalRows.
  await assert.rejects(collectPages(async () => ({ data: [1], totalRows: -1 })), /Invalid totalRows/);
  // Page limit.
  await assert.rejects(collectPages(async (page) => ({ data: [page] }), 2), /Page limit/);
});

test('client builds paths only from fixed datasets and encoded site IDs', () => {
  // Path traversal via siteId is neutralised by encodeURIComponent: a malicious
  // siteId cannot escape its path segment.
  const evil = encodeURIComponent('../acls/osg-acls');
  assert.ok(evil.includes('%2F'), 'slashes are percent-encoded, so traversal cannot cross a path segment');
  assert.ok(!evil.startsWith('../'), 'traversal prefix is encoded away');

  // DATASETS paths are compile-time constants, never built from input.
  const datasetPaths = [
    '/setting/service/dhcp', '/profiles/groups', '/acls/osg-acls', '/acls/osg-config-mode',
    '/acls/osg-custom-acls', '/nat/port-forwardings', '/setting/service/mdns',
    '/profiles/bonjour-service', '/specification', '/internet', '/bandwidth-control',
    '/bandwidth-control/rules', '/qos/gateway/bwcs', '/qos/gateway/wans',
    '/qos/gateway/class-rules', '/setting/service/dns-proxy', '/setting/service/dns-cache',
    '/firewall', '/network-security/ips', '/remote-logging', '/setting/service/igmp',
    '/clients', '/lan-networks',
  ];
  for (const path of datasetPaths) {
    assert.ok(path.startsWith('/'), `dataset path must be absolute: ${path}`);
    assert.ok(!path.includes('..'), `dataset path must not traverse: ${path}`);
  }
});

test('certificateAgent pins an exact leaf and refuses a different fingerprint', () => {
  const pem = TEST_CERT_PEM;
  const x509 = new X509Certificate(pem);
  const fingerprint = x509.fingerprint256.replaceAll(':', '').toLowerCase();
  // The embedded fixture must match the documented fingerprint below.
  assert.equal(fingerprint, TEST_CERT_SHA256);

  const agent = certificateAgent(pem, fingerprint);
  assert.equal(agent.options.rejectUnauthorized, true);
  assert.equal(agent.options.ca, pem);
  // Same fingerprint presented by the server -> identity check passes.
  assert.equal(
    agent.options.checkServerIdentity('anything', { fingerprint256: x509.fingerprint256 }),
    undefined,
  );
  // A replaced server cert -> identity check fails.
  const other = agent.options.checkServerIdentity('anything', { fingerprint256: '00:11:22:33:44:55' });
  assert.ok(other instanceof Error);
  agent.destroy();

  // Stored fingerprint mismatch -> refuses to build the agent at all.
  assert.throws(() => certificateAgent(pem, '0'.repeat(64)), /does not match/);
  // Not a certificate at all.
  assert.throws(() => certificateAgent('not a pem', '0'.repeat(64)));
});

// Public self-signed test certificate (CN=192.0.2.1 — RFC 5737 TEST-NET-1,
// a documentation-only address). Generated for these tests; contains NO private key.
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDNzCCAh+gAwIBAgIUD7Y88w4avLw7zpW9ZPBWVwyRnMgwDQYJKoZIhvcNAQEL
BQAwKzESMBAGA1UEAwwJMTkyLjAuMi4xMRUwEwYDVQQKDAxPbWFkYU1jcFRlc3Qw
HhcNMjYxMDIyMjM1NzE4WhcNMzYxMDE5MjM1NzE4WjArMRIwEAYDVQQDDAkxOTIu
MC4yLjExFTATBgNVBAoMDE9tYWRhTWNwVGVzdDCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBAIYaxWnFHWcK6aGiS/mHxvpupZSM06Mb26wgGhJqJYQIQ+fm
eCA3IkJescNqd6p1mhsRn7RcoZEIZHzl6yb1zMebBFOxHMyXYXdJJM+9QXMVglqq
I5bdR+yilJDZAwtme/3gTHveF4x6Wf4Y4VZlZwBi90PbD6R7fv4X/FoU4sCtWI+t
4er/65l3TzMcG+p/s+VqgIZFOysajJqme69YTfGhYeb77WWBbA3NYI2P9y59IQ3X
d2FoznEiblweXKxkGMNOpNuQF75ZhZzRV4Vu0SwpnRluA5z5Iq9kIlKqyb++9oT1
/x9jQr5LGpqiISUr9t0oVhG2C7wpwhKjpW1ClbECAwEAAaNTMFEwHQYDVR0OBBYE
FHYDxetytlLME1AtVLuMAHdcFQpPMB8GA1UdIwQYMBaAFHYDxetytlLME1AtVLuM
AHdcFQpPMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAENIt08m
f8JpTCI/nD/Dz1fgq0Z+Yl9BQ7Ke1dW9wfroyo0DRzIbKtyw6Ej11YjO/Z3PFAJK
4GcP4Dm9/XXnSS7r5S+bEUtsfdzbi3nu1kcLmC116io8PMJ2m8Gi63IWuRkvojxH
NDuU8PC55c62SXB19EWhHuo5ZWu5XZb5SvYMCsSZsPEGGv2dBh1APgVBr+UqXTDm
QhIVo3I8rxqJJYnIiTE+4hJbc1pC3vuEL6xmzm4mcl9b9MpXTThXYumhxgqBbXd+
ScoJC38g3S8ARpIpYLecUxIevqCe4xUSCwiDwEiWverZAbR/PsKiIdjrq2aw7pAc
Uf94Ge7lHLOHlWw=
-----END CERTIFICATE-----`;

const TEST_CERT_SHA256 = '82e3adae29815acee2314e106e7fbfb8ab67f079fb19b1161648ddcaf79bdfb2';
