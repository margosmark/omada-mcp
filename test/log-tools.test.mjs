import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { LOG_DATASETS } from '../src/datasets.mjs';
import { alertsHandler, eventsHandler, logToolSpecs } from '../src/log-tools.mjs';
import {
  ALERT_LEVELS,
  DEFAULT_LOG_LIMIT,
  LOG_MODULES,
  MAX_LOG_LIMIT,
  buildLogParams,
  clampLogLimit,
  extractMacs,
  filterWindow,
  normalizeAlert,
  normalizeEvent,
  sortNewestFirst,
  toEpochMs,
} from '../src/logs.mjs';
import { createToolRegistrar } from '../src/tool.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const SITE = 'site-1';
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);

/** A controller alert row exactly as the live API returns it. */
function alertRow(overrides = {}) {
  return {
    id: '6adc0145cba0277ef81e7cf5',
    key: 'DEVICE_MONITOR_STATUS_LINK_DOWN',
    module: 'Device',
    content: '[ap:28-87-BA-A2-73-62] reported monitor link down.',
    time: NOW - 1000,
    level: 'Warning',
    ...overrides,
  };
}

/** A controller event row exactly as the live API returns it. */
function eventRow(overrides = {}) {
  return {
    id: '6adc15d5cba0277ef81eb785',
    key: 'OSG_DHCP_S',
    module: 'Device',
    content: 'DHCP Server allocated IP address 192.168.20.115 for the [client:B4-22-00-0B-23-77 ].',
    time: NOW - 1000,
    ...overrides,
  };
}

/**
 * Build a stand-in for the client's readLogDataset() result.
 * The handler only ever sees this shape, so the tests never need a socket.
 */
function logResult({ records = [], totalRows = records.length, kind = 'alerts', limited = false } = {}) {
  return {
    kind,
    totalRows,
    limited,
    limit: records.length,
    window: { since: new Date(NOW - 7 * 86400e3).toISOString(), until: new Date(NOW).toISOString() },
    records,
  };
}

// --- Unit level: helpers -----------------------------------------------------

test('the log dataset registry exposes only the two verified site log endpoints', () => {
  assert.deepEqual(Object.keys(LOG_DATASETS), ['alerts', 'events']);
  assert.equal(LOG_DATASETS.alerts.path, '/logs/alerts');
  assert.equal(LOG_DATASETS.events.path, '/logs/events');
  // The controller silently ignores a filter it does not implement, so the
  // registry records exactly which filters each endpoint honours.
  assert.deepEqual(LOG_DATASETS.alerts.filters, ['module', 'level', 'resolved']);
  assert.deepEqual(LOG_DATASETS.events.filters, ['module']);
});

test('toEpochMs reads bare dates and offset timestamps as UTC', () => {
  assert.equal(toEpochMs('2026-10-23'), Date.UTC(2026, 9, 23));
  assert.equal(toEpochMs('2026-10-23T12:00:00Z'), Date.UTC(2026, 9, 23, 12));
  assert.equal(toEpochMs('2026-10-23T14:00:00+02:00'), Date.UTC(2026, 9, 23, 12));
  assert.equal(toEpochMs('2026-10-23T12:00:00'), Date.UTC(2026, 9, 23, 12));
  assert.throws(() => toEpochMs('not-a-date'), /Invalid ISO-8601/);
});

test('clampLogLimit bounds the limit to [1, MAX_LOG_LIMIT]', () => {
  assert.equal(clampLogLimit(undefined), DEFAULT_LOG_LIMIT);
  assert.equal(clampLogLimit(0), 1);
  assert.equal(clampLogLimit(-5), 1);
  assert.equal(clampLogLimit(10), 10);
  assert.equal(clampLogLimit(MAX_LOG_LIMIT), MAX_LOG_LIMIT);
  assert.equal(clampLogLimit(MAX_LOG_LIMIT + 1000), MAX_LOG_LIMIT);
  assert.equal(clampLogLimit('abc'), DEFAULT_LOG_LIMIT);
});

test('buildLogParams always sends the required time window and page bounds', () => {
  const { params } = buildLogParams({ since: '2026-10-23', until: '2026-10-24' }, LOG_DATASETS.alerts);
  assert.equal(params['filters.timeStart'], Date.UTC(2026, 9, 23));
  assert.equal(params['filters.timeEnd'], Date.UTC(2026, 9, 24));
});

test('buildLogParams defaults to a bounded 7 day look-back window', () => {
  const before = Date.now();
  const { params, startMs, endMs } = buildLogParams({}, LOG_DATASETS.events);
  assert.ok(endMs >= before && endMs <= Date.now(), 'window ends now');
  assert.equal(endMs - startMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(params['filters.timeStart'], startMs);
  assert.equal(params['filters.timeEnd'], endMs);
});

test('buildLogParams maps category/severity/resolved onto the controller filters', () => {
  const { params } = buildLogParams(
    { category: 'Device', severity: 'Warning', resolved: false },
    LOG_DATASETS.alerts,
  );
  assert.equal(params['filters.module'], 'Device');
  assert.equal(params['filters.level'], 'Warning');
  assert.equal(params['filters.resolved'], false);
});

test('buildLogParams refuses a filter the endpoint does not implement', () => {
  // The event log has no severity and no resolved state; sending those would
  // return an unfiltered log that looks filtered.
  assert.throws(
    () => buildLogParams({ severity: 'Error' }, LOG_DATASETS.events),
    /does not support severity/,
  );
  assert.throws(
    () => buildLogParams({ resolved: true }, LOG_DATASETS.events),
    /does not support resolved/,
  );
});

test('buildLogParams refuses an unknown filter value instead of matching nothing', () => {
  // The controller accepts an unknown level value and returns 0 rows, which
  // looks like "no such alerts" rather than "you typed it wrong".
  assert.throws(() => buildLogParams({ severity: 'warning' }, LOG_DATASETS.alerts), /Unknown severity/);
  assert.throws(() => buildLogParams({ severity: 'NotALevel' }, LOG_DATASETS.alerts), /Unknown severity/);
  assert.throws(() => buildLogParams({ category: 'Bogus' }, LOG_DATASETS.alerts), /Unknown category/);
});

test('buildLogParams refuses an inverted window', () => {
  assert.throws(
    () => buildLogParams({ since: '2026-10-24', until: '2026-10-23' }, LOG_DATASETS.alerts),
    /must not be later than/,
  );
});

test('normalizeAlert maps the controller row onto the documented shape', () => {
  const record = normalizeAlert(alertRow());
  assert.equal(record.id, '6adc0145cba0277ef81e7cf5');
  assert.equal(record.key, 'DEVICE_MONITOR_STATUS_LINK_DOWN');
  assert.equal(record.severity, 'Warning');
  assert.equal(record.category, 'Device');
  assert.equal(record.message, '[ap:28-87-BA-A2-73-62] reported monitor link down.');
  assert.equal(record.time, new Date(NOW - 1000).toISOString());
  // The controller stores ONE occurrence timestamp, so first/last seen mirror it.
  assert.equal(record.firstSeen, record.time);
  assert.equal(record.lastSeen, record.time);
  assert.deepEqual(record.deviceMacs, ['28-87-BA-A2-73-62']);
  assert.deepEqual(record.clientMacs, []);
});

test('normalizeEvent carries no severity and no resolved state', () => {
  const record = normalizeEvent(eventRow());
  assert.equal(record.severity, undefined);
  assert.equal(record.resolved, undefined);
  assert.equal(record.category, 'Device');
  assert.equal(record.message, 'DHCP Server allocated IP address 192.168.20.115 for the [client:B4-22-00-0B-23-77 ].');
  assert.deepEqual(record.clientMacs, ['B4-22-00-0B-23-77']);
  assert.deepEqual(record.deviceMacs, []);
});

test('extractMacs separates device MACs from client MACs and normalises them', () => {
  const { deviceMacs, clientMacs } = extractMacs(
    '[gateway:5C-62-8B-31-36-11] client[98:4e:8a:93:80:2a] used a conflicted IP',
  );
  assert.deepEqual(deviceMacs, ['5C-62-8B-31-36-11']);
  assert.deepEqual(clientMacs, ['98-4E-8A-93-80-2A']);
});

test('filterWindow keeps only records inside the requested window', () => {
  const records = [
    { time: new Date(NOW - 3000).toISOString() },
    { time: new Date(NOW).toISOString() },
    { time: new Date(NOW + 3000).toISOString() },
  ];
  const kept = filterWindow(records, NOW - 1000, NOW + 1000);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].time, new Date(NOW).toISOString());
});

test('sortNewestFirst orders by time descending and keeps ties stable', () => {
  const a = { id: 'a', time: new Date(NOW - 1000).toISOString() };
  const b = { id: 'b', time: new Date(NOW).toISOString() };
  const c = { id: 'c', time: new Date(NOW - 1000).toISOString() };
  assert.deepEqual(sortNewestFirst([a, b, c]).map((r) => r.id), ['b', 'a', 'c']);
});

// --- Handler level ------------------------------------------------------------

test('getAlerts returns a bounded envelope with the controller total', async () => {
  const read = async () => logResult({ records: [alertRow()], totalRows: 39, kind: 'alerts' });
  const result = await alertsHandler({ read, siteId: SITE, limit: 50 });
  assert.equal(result.kind, 'alerts');
  assert.equal(result.siteId, SITE);
  assert.equal(result.limit, 50);
  assert.equal(result.returned, 1);
  assert.equal(result.totalRows, 39);
  // The controller holds more rows than we returned -> the read was bounded.
  assert.equal(result.limited, true);
  assert.equal(result.records[0].severity, 'Warning');
  assert.ok(result.window.since && result.window.until);
});

test('getEvents returns a bounded envelope with the controller total', async () => {
  const read = async () => logResult({ records: [eventRow()], totalRows: 7355, kind: 'events' });
  const result = await eventsHandler({ read, siteId: SITE, limit: 50 });
  assert.equal(result.kind, 'events');
  assert.equal(result.totalRows, 7355);
  assert.equal(result.limited, true);
  assert.equal(result.records[0].category, 'Device');
});

test('the limit is clamped and the effective limit is reported back', async () => {
  let seen;
  const read = async (options) => {
    seen = options;
    return logResult({ records: [alertRow()], totalRows: 1 });
  };
  const result = await alertsHandler({ read, siteId: SITE, limit: 100000 });
  assert.equal(seen.limit, MAX_LOG_LIMIT);
  assert.equal(result.limit, MAX_LOG_LIMIT);
  assert.equal(result.returned, 1);
});

test('the returned records are newest-first and bounded to the limit', async () => {
  const read = async () => logResult({
    records: [
      alertRow({ id: 'old', time: NOW - 5000 }),
      alertRow({ id: 'new', time: NOW - 1000 }),
      alertRow({ id: 'mid', time: NOW - 3000 }),
    ],
    totalRows: 3,
  });
  const result = await alertsHandler({ read, siteId: SITE, limit: 2 });
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((r) => r.id), ['new', 'mid']);
});

test('a category filter is applied server-side and re-checked locally', async () => {
  let seen;
  const read = async (options) => {
    seen = options;
    // A controller that ignored the filter would return a Client row here.
    return logResult({ records: [alertRow({ module: 'Client' })], totalRows: 1 });
  };
  const result = await alertsHandler({ read, siteId: SITE, limit: 50, category: 'Device' });
  assert.equal(seen.category, 'Device');
  // The row does not match the requested category, so it is not handed back.
  assert.equal(result.returned, 0);
  assert.equal(result.totalRows, 1);
});

test('a severity filter is applied server-side and re-checked locally', async () => {
  let seen;
  const read = async (options) => {
    seen = options;
    return logResult({ records: [alertRow({ level: 'Information' })], totalRows: 1 });
  };
  const result = await alertsHandler({ read, siteId: SITE, limit: 50, severity: 'Warning' });
  assert.equal(seen.severity, 'Warning');
  assert.equal(result.returned, 0);
});

test('a read failure surfaces as an error instead of an empty result', async () => {
  const read = async () => {
    throw new Error('API repeated a page; result is incomplete.');
  };
  await assert.rejects(
    () => alertsHandler({ read, siteId: SITE, limit: 50 }),
    /repeated a page/,
  );
  await assert.rejects(
    () => eventsHandler({ read, siteId: SITE, limit: 50 }),
    /repeated a page/,
  );
});

test('secrets in the result are redacted before the handler returns', async () => {
  const read = async () => logResult({
    records: [alertRow({ content: 'login failed for token supersecret' })],
    totalRows: 1,
  });
  const result = await alertsHandler({ read, siteId: SITE, limit: 50, secrets: ['supersecret'] });
  assert.ok(!JSON.stringify(result).includes('supersecret'));
  assert.ok(result.records[0].message.includes('[REDACTED]'));
});

// --- MCP level (the fake-transport pattern the repo already uses) ------------

/**
 * Build an MCP server with the log tools registered through the same shared
 * `tool()` helper the real server uses, and a client stub in place of the
 * controller.
 */
async function connectLogServer(stub) {
  const server = new McpServer({ name: 't', version: '1' });
  const tool = createToolRegistrar(server, (value) => value);
  for (const spec of logToolSpecs({ getClient: () => stub })) {
    tool(spec.name, spec.description, spec.schema, spec.handler);
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const STUB_SITE = { siteId: SITE, name: 'Home' };

test('the MCP tool list includes getAlerts and getEvents', async () => {
  const stub = {
    async listSites() {
      return [STUB_SITE];
    },
    async readLogDataset() {
      return logResult({ records: [], totalRows: 0 });
    },
  };
  const { client } = await connectLogServer(stub);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('getAlerts'), `tools list should include getAlerts, got ${names}`);
  assert.ok(names.includes('getEvents'), `tools list should include getEvents, got ${names}`);
  // No write tool may be exposed by the read-only log tools.
  assert.equal(names.filter((n) => n.startsWith('write')).length, 0);
  // Both are marked read-only.
  for (const name of ['getAlerts', 'getEvents']) {
    const spec = tools.find((t) => t.name === name);
    assert.equal(spec.annotations.readOnlyHint, true, `${name} should be marked read-only`);
  }
  await client.close();
});

test('getAlerts over MCP returns the envelope as JSON text', async () => {
  const stub = {
    async listSites() {
      return [STUB_SITE];
    },
    async readLogDataset(siteId, kind, options) {
      assert.equal(siteId, SITE);
      assert.equal(kind, 'alerts');
      assert.equal(options.limit, 50);
      return logResult({ records: [alertRow()], totalRows: 39, kind: 'alerts' });
    },
  };
  const { client } = await connectLogServer(stub);
  const result = await client.callTool({ name: 'getAlerts', arguments: { siteId: SITE } });
  assert.notEqual(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.kind, 'alerts');
  assert.equal(payload.returned, 1);
  assert.equal(payload.totalRows, 39);
  assert.equal(payload.limited, true);
  assert.equal(payload.records[0].severity, 'Warning');
  await client.close();
});

test('a controller failure over MCP is a visible error, never "0 results"', async () => {
  const stub = {
    async listSites() {
      return [STUB_SITE];
    },
    async readLogDataset() {
      throw new Error('GET /sites/x/logs/alerts failed: HTTP 500');
    },
  };
  const { client } = await connectLogServer(stub);
  const result = await client.callTool({ name: 'getAlerts', arguments: { siteId: SITE } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 500/);
  assert.doesNotMatch(result.content[0].text, /"returned": 0/);
  await client.close();
});

test('the schema rejects an out-of-range limit and an unknown severity', async () => {
  const stub = {
    async listSites() {
      return [STUB_SITE];
    },
    async readLogDataset() {
      throw new Error('should not be reached');
    },
  };
  const { client } = await connectLogServer(stub);
  const tooBig = await client.callTool({ name: 'getAlerts', arguments: { siteId: SITE, limit: 5000 } });
  assert.equal(tooBig.isError, true);
  const badSeverity = await client.callTool({
    name: 'getAlerts',
    arguments: { siteId: SITE, severity: 'warning' },
  });
  assert.equal(badSeverity.isError, true);
  const unknownField = await client.callTool({
    name: 'getEvents',
    arguments: { siteId: SITE, severity: 'Error' },
  });
  assert.equal(unknownField.isError, true);
  await client.close();
});

test('a site the credential cannot see is refused before any log read', async () => {
  let readCalled = false;
  const stub = {
    async listSites() {
      return [STUB_SITE];
    },
    async readLogDataset() {
      readCalled = true;
      return logResult({ records: [] });
    },
  };
  const { client } = await connectLogServer(stub);
  const result = await client.callTool({ name: 'getAlerts', arguments: { siteId: 'other-site' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /accessible site list/);
  assert.equal(readCalled, false);
  await client.close();
});

// --- The real server ---------------------------------------------------------

/**
 * Start the actual server binary over stdio with no controller config, so the
 * handshake, the tool list and the status report are exercised end to end.
 */
async function connectRealServer(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, 'src/index.mjs')],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OMADA_CONFIG: '/nonexistent/controller.json',
      OMADA_PEM: '/nonexistent/controller.pem',
      OMADA_CREDENTIALS: '/nonexistent/credentials.json',
      ...env,
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'server-test', version: '1' });
  await client.connect(transport);
  return client;
}

test('the real server starts with zero controller config and lists both log tools', async () => {
  const client = await connectRealServer();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('getAlerts'), `tools list should include getAlerts, got ${names}`);
  assert.ok(names.includes('getEvents'), `tools list should include getEvents, got ${names}`);
  await client.close();
});

test('the real server exposes no write tool while OMADA_ENABLE_WRITES is unset', async () => {
  const client = await connectRealServer();
  const { tools } = await client.listTools();
  const writeTools = tools.filter((t) => /^write|^(create|update|delete|reorder)/.test(t.name));
  assert.deepEqual(writeTools.map((t) => t.name), [], 'read-only server must expose no write tools');
  await client.close();
});

test('getConnectionStatus reports the tool count it actually registered', async () => {
  const client = await connectRealServer();
  const { tools } = await client.listTools();
  const status = await client.callTool({ name: 'getConnectionStatus', arguments: {} });
  const payload = JSON.parse(status.content[0].text);
  assert.equal(payload.tools, tools.length, 'reported tool count must match the real tool list');
  assert.equal(payload.writesEnabled, false);
  assert.equal(payload.mode, 'read-only');
  assert.equal(payload.logDatasets, 2);
  await client.close();
});

test('getConnectionStatus stays honest when write mode is enabled', async () => {
  const client = await connectRealServer({ OMADA_ENABLE_WRITES: 'true' });
  const { tools } = await client.listTools();
  const status = await client.callTool({ name: 'getConnectionStatus', arguments: {} });
  const payload = JSON.parse(status.content[0].text);
  assert.equal(payload.tools, tools.length, 'reported tool count must match the real tool list');
  assert.equal(payload.writesEnabled, true);
  assert.equal(payload.mode, 'write-enabled');
  assert.ok(tools.length > payload.logDatasets, 'write mode must register more than the read tools');
  await client.close();
});

test('a log call with no controller config is a visible error, not an empty log', async () => {
  const client = await connectRealServer();
  const result = await client.callTool({ name: 'getAlerts', arguments: { siteId: 'any' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Missing baseUrl/);
  assert.doesNotMatch(result.content[0].text, /"returned": 0/);
  await client.close();
});
