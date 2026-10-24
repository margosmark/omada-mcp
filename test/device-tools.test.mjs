import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { DEVICE_DATASETS, DEVICE_TYPE_DATASETS } from '../src/datasets.mjs';
import { deviceToolSpecs } from '../src/device-tools.mjs';
import {
  DEVICE_ID_PATTERN,
  assertDeviceId,
  duplexLabel,
  indexBySwitchPort,
  indexClientsBySwitchPort,
  linkSpeedLabel,
  normalizeDevice,
  normalizeDeviceId,
  normalizeSwitchPort,
  parseUptimeSeconds,
  portsEnvelope,
} from '../src/devices.mjs';
import { OmadaClient } from '../src/omada-client.mjs';
import { buildSitePath } from '../src/write-guard.mjs';
import { createToolRegistrar } from '../src/tool.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const SITE = '6610bd1ceb88fe7f28c101ab';
const BACKYARD_SWITCH = '20-23-51-5E-4A-BA';
const MAIN_SWITCH = '28-87-BA-98-7C-12';
const BASEMENT_AP = '54-AF-97-0A-62-E4';
const GATEWAY = '5C-62-8B-31-36-11';

// Fixtures below are the live controller's own rows, trimmed to the fields the
// normalizers read. Anything the fixtures omit is treated as absent by the
// code under test — which is the point: Omada omits keys rather than sending
// null, and "not exposed" must survive as null rather than become a guess.

/** A /devices list row for an online switch. */
function switchRow(overrides = {}) {
  return {
    mac: BACKYARD_SWITCH,
    name: 'Backyard Switch',
    type: 'switch',
    model: 'SG2008P v3.20',
    modelName: 'SG2008P',
    ip: '192.168.0.5',
    uptime: '20day(s) 7h 5m 17s',
    status: 1,
    detailStatus: 14,
    modelVersion: '3.20',
    lastSeen: 1792813082935,
    cpuUtil: 4,
    memUtil: 53,
    sn: '2243662000647',
    firmwareVersion: '3.20.24 Build 20260509 Rel.23533',
    ...overrides,
  };
}

/** A /devices list row for the offline AP: no uptime, no CPU/memory. */
function offlineApRow(overrides = {}) {
  return {
    mac: '28-87-BA-C0-4E-4A',
    name: 'Backyard AP',
    type: 'ap',
    model: 'EAP650(US) v1.0',
    modelName: 'EAP650',
    ip: '192.168.0.14',
    status: 0,
    detailStatus: 0,
    modelVersion: '1.0',
    lastSeen: 1792728992678,
    firmwareVersion: '1.1.0 Build 20240830 Rel. 50826',
    ...overrides,
  };
}

/** The /switches/{mac} detail row for that switch. */
function switchDetail(overrides = {}) {
  return {
    mac: BACKYARD_SWITCH,
    ip: '192.168.0.5',
    model: 'SG2008P v3.20',
    firmwareVersion: '3.20.24 Build 20260509 Rel.23533',
    version: '3.20.24',
    hwVersion: '3.20',
    cpuUtil: 4,
    memUtil: 53,
    uptime: '20 days 07:05:17',
    portList: Array.from({ length: 8 }, (_, i) => ({ port: i + 1, name: `Port${i + 1}` })),
    ...overrides,
  };
}

/** The /aps/{mac} detail row for an online AP. */
function apDetail(overrides = {}) {
  return {
    type: 'ap',
    mac: BASEMENT_AP,
    name: 'Basement AP',
    ip: '192.168.0.10',
    showModel: 'EAP650(US) v1.0',
    firmwareVersion: '1.3.11 Build 20260703 Rel. 16605',
    cpuUtil: 17,
    memUtil: 67,
    uptimeLong: 4433306,
    status: 14,
    statusCategory: 1,
    ...overrides,
  };
}

/** The /aps/{mac} detail row for an offline AP: no uptime, no CPU/memory. */
function offlineApDetail(overrides = {}) {
  return {
    type: 'ap',
    mac: '28-87-BA-C0-4E-4A',
    name: 'Backyard AP',
    ip: '192.168.0.14',
    showModel: 'EAP650(US) v1.0',
    firmwareVersion: '1.1.0 Build 20240830 Rel. 50826',
    status: 0,
    statusCategory: 0,
    ...overrides,
  };
}

/** The /gateways/{mac} detail row. */
function gatewayDetail(overrides = {}) {
  return {
    mac: GATEWAY,
    showModel: 'ER8411 v1.0',
    firmwareVersion: '1.4.5 Build 20260831 Rel.65396',
    ip: '192.168.0.1',
    uptime: '2 days 10:15:42',
    temp: 54,
    cpuUtil: 5,
    memUtil: 65,
    lastSeen: 1792813083092,
    ...overrides,
  };
}

/** A /switches/ports/counters row: link up, PoE-capable, one client. */
function countersRow(overrides = {}) {
  return {
    port: 3,
    portName: 'Port3',
    switchMac: BACKYARD_SWITCH,
    switchName: 'Backyard Switch',
    connectedStatus: 1,
    supportPoe: true,
    poe: 1,
    poeDisplayType: 4,
    portStatus: {
      port: 3,
      linkStatus: 1,
      linkSpeed: 2,
      duplex: 2,
      poe: false,
      poePower: 0,
      tx: 26370965742,
      rx: 1486163504074,
      txRate: 133200,
      rxRate: 4528616,
      stp: 'Forwarding',
      stpDiscarding: false,
    },
    linkSpeed: 0,
    duplex: 0,
    txBytes: 26370965742,
    txErrors: 0,
    rxBytes: 1486163504074,
    rxErrors: 1,
    ...overrides,
  };
}

/** The matching /switches/ports/poe-info row, with the '--' class sentinel. */
function poeInfoRow(overrides = {}) {
  return {
    port: 3,
    portName: 'Port3',
    switchMac: BACKYARD_SWITCH,
    switchName: 'Backyard Switch',
    connectedStatus: 1,
    supportPoe: true,
    poe: 1,
    poeDisplayType: 4,
    portStatus: { port: 3, linkStatus: 1, linkSpeed: 2, duplex: 2, poe: false, poePower: 0 },
    pdClass: '--',
    power: 0,
    voltage: 0,
    current: 0,
    ...overrides,
  };
}

/** A wired /clients row. */
function clientRow(overrides = {}) {
  return {
    mac: 'EC-71-DB-28-65-A0',
    name: 'Play Room Camera',
    deviceType: 'IPC',
    wireless: false,
    switchMac: BACKYARD_SWITCH,
    switchName: 'Backyard Switch',
    port: 3,
    ip: '10.10.100.13',
    ...overrides,
  };
}

// --- Registry ----------------------------------------------------------------

test('the device dataset registry exposes only verified endpoints', () => {
  assert.deepEqual(
    Object.keys(DEVICE_DATASETS),
    ['switchDetail', 'apDetail', 'gatewayDetail', 'switchPorts', 'switchPortPoe'],
  );
  // The controller has no generic /devices/{mac} route (it answers 404), so
  // each device type has its own detail endpoint and the id is a path
  // parameter, not a caller-built path.
  assert.equal(DEVICE_DATASETS.switchDetail.path, '/switches/{deviceId}');
  assert.equal(DEVICE_DATASETS.apDetail.path, '/aps/{deviceId}');
  assert.equal(DEVICE_DATASETS.gatewayDetail.path, '/gateways/{deviceId}');
  assert.equal(DEVICE_DATASETS.switchPorts.path, '/switches/ports/counters');
  assert.equal(DEVICE_DATASETS.switchPortPoe.path, '/switches/ports/poe-info');

  // Only the port endpoints are paginated, and only `switchMac` is a filter
  // the controller actually implements on them.
  assert.deepEqual(Object.keys(DEVICE_TYPE_DATASETS), ['switch', 'ap', 'gateway']);
  assert.equal(DEVICE_TYPE_DATASETS.switch, 'switchDetail');
  for (const kind of ['switchPorts', 'switchPortPoe']) {
    assert.equal(DEVICE_DATASETS[kind].paginated, true);
    assert.deepEqual(DEVICE_DATASETS[kind].filters, ['switchMac']);
  }
});

// --- Device identifiers ------------------------------------------------------

test('a device id must match the controller MAC shape', () => {
  assert.ok(DEVICE_ID_PATTERN.test('20-23-51-5E-4A-BA'));
  assert.ok(DEVICE_ID_PATTERN.test('20-23-51-5e-4a-ba'));
  assert.equal(normalizeDeviceId('20-23-51-5e-4a-ba'), BACKYARD_SWITCH);
  assert.equal(assertDeviceId('28-87-BA-C0-4E-4A'), '28-87-BA-C0-4E-4A');
});

test('the device id rule and the write-path SAFE_ID rule agree', () => {
  // The same value can land in a path segment (detail read) or a query filter
  // (switch-port read), so both must accept and reject the same things.
  for (const id of ['20-23-51-5E-4A-BA', 'a', 'A1', 'a_b', 'x-y_z-1']) {
    assert.doesNotThrow(() => buildSitePath('/switches/{deviceId}', { deviceId: id }));
    assert.doesNotThrow(() => assertDeviceId(id));
  }
  for (const id of ['../../etc/passwd', 'a/b', 'a b', 'a:b', '', '..', '.']) {
    assert.throws(() => buildSitePath('/switches/{deviceId}', { deviceId: id }), /Unsafe|Invalid/);
    assert.throws(() => assertDeviceId(id), /Invalid deviceId/);
  }
});

test('an invalid device id is rejected with an actionable message', () => {
  for (const bad of ['../../etc/passwd', 'aa:bb:cc:dd:ee:ff', 'a b', '', null, 42, 'x/../y']) {
    assert.throws(() => normalizeDeviceId(bad), /Invalid deviceId/, `should reject ${JSON.stringify(bad)}`);
  }
});

// --- Uptime parsing ----------------------------------------------------------

test('parseUptimeSeconds reads all three controller uptime formats', () => {
  // /devices list row: "51day(s) 7h 28m 26s"
  assert.equal(parseUptimeSeconds('51day(s) 7h 28m 26s'), 51 * 86400 + 7 * 3600 + 28 * 60 + 26);
  // /switches/{mac}: "20 days 07:05:17"
  assert.equal(parseUptimeSeconds('20 days 07:05:17'), 20 * 86400 + 7 * 3600 + 5 * 60 + 17);
  // /gateways/{mac}: "2 days 10:15:42"
  assert.equal(parseUptimeSeconds('2 days 10:15:42'), 2 * 86400 + 10 * 3600 + 15 * 60 + 42);
  // A bare clock (no days) still parses.
  assert.equal(parseUptimeSeconds('10:15:42'), 10 * 3600 + 15 * 60 + 42);
});

test('parseUptimeSeconds returns null rather than guessing', () => {
  assert.equal(parseUptimeSeconds('n/a'), null);
  assert.equal(parseUptimeSeconds(''), null);
  assert.equal(parseUptimeSeconds(null), null);
  assert.equal(parseUptimeSeconds(undefined), null);
  assert.equal(parseUptimeSeconds(1234), null);
  assert.equal(parseUptimeSeconds('20 days'), null);
});

// --- Enum labels -------------------------------------------------------------

test('link speed and duplex labels are only emitted for known codes', () => {
  assert.equal(linkSpeedLabel(1000), '1 Gbps');
  assert.equal(linkSpeedLabel(100), '100 Mbps');
  assert.equal(linkSpeedLabel(10), '10 Mbps');
  assert.equal(linkSpeedLabel(null), null);
  assert.equal(duplexLabel(2), 'full');
  assert.equal(duplexLabel(1), 'half');
  // 0 is only ever seen on down ports; it is not a real duplex setting.
  assert.equal(duplexLabel(0), null);
  assert.equal(duplexLabel(9), null);
});

// --- Device normalization ----------------------------------------------------

test('normalizeDevice merges the list row and the switch detail row', () => {
  const device = normalizeDevice({ row: switchRow(), detail: switchDetail() });
  assert.equal(device.deviceId, BACKYARD_SWITCH);
  assert.equal(device.name, 'Backyard Switch');
  assert.equal(device.type, 'switch');
  assert.equal(device.model, 'SG2008P v3.20');
  assert.equal(device.ip, '192.168.0.5');
  assert.equal(device.firmwareVersion, '3.20.24 Build 20260509 Rel.23533');
  assert.equal(device.firmwareVersionShort, '3.20.24');
  assert.equal(device.status, 'online');
  assert.equal(device.statusCode, 1);
  assert.equal(device.statusDetail, 'Connected');
  assert.equal(device.statusDetailCode, 14);
  assert.equal(device.cpuUtil, 4);
  assert.equal(device.memUtil, 53);
  assert.equal(device.sn, '2243662000647');
  assert.equal(device.portCount, 8);
  // The detail row's clock format wins over the list row's compact one.
  assert.equal(device.uptimeSeconds, 20 * 86400 + 7 * 3600 + 5 * 60 + 17);
  assert.equal(device.uptime, '20 days 07:05:17');
  assert.equal(device.lastSeen, new Date(1792813082935).toISOString());
  // A switch has no temperature reading.
  assert.equal(device.temperature, null);
});

test('normalizeDevice uses uptimeLong and detail status for an AP', () => {
  const row = switchRow({ mac: BASEMENT_AP, name: 'Basement AP', type: 'ap', model: 'EAP650(US) v1.0', modelName: 'EAP650', uptime: '51day(s) 7h 28m 26s', cpuUtil: 17, memUtil: 67 });
  const device = normalizeDevice({ row, detail: apDetail() });
  assert.equal(device.status, 'online');
  // uptimeLong is the AP detail's own seconds field and beats any string.
  assert.equal(device.uptimeSeconds, 4433306);
  assert.equal(device.portCount, null, 'an AP has no portList');
  assert.equal(device.temperature, null);
});

test('normalizeDevice keeps an offline device honestly sparse', () => {
  const device = normalizeDevice({ row: offlineApRow(), detail: offlineApDetail() });
  assert.equal(device.status, 'offline');
  assert.equal(device.statusCode, 0);
  assert.equal(device.statusDetail, 'Disconnected');
  assert.equal(device.statusDetailCode, 0);
  // The controller exposes no uptime or CPU/memory for an offline AP.
  assert.equal(device.uptimeSeconds, null);
  assert.equal(device.uptime, null);
  assert.equal(device.cpuUtil, null);
  assert.equal(device.memUtil, null);
});

test('normalizeDevice reports gateway-only fields and falls back to row data', () => {
  const device = normalizeDevice({ row: { mac: GATEWAY, type: 'gateway', status: 1 }, detail: gatewayDetail() });
  assert.equal(device.temperature, 54);
  assert.equal(device.model, 'ER8411 v1.0');
  assert.equal(device.status, 'online');
  assert.equal(device.uptimeSeconds, 2 * 86400 + 10 * 3600 + 15 * 60 + 42);
  assert.equal(device.portCount, null, 'the gateway detail has no portList');

  // With no detail row at all, the list row still yields a device.
  const fromRow = normalizeDevice({ row: switchRow() });
  assert.equal(fromRow.deviceId, BACKYARD_SWITCH);
  assert.equal(fromRow.status, 'online');
  assert.equal(fromRow.firmwareVersionShort, null);
});

test('normalizeDevice reports unknown status when neither code space resolves', () => {
  const device = normalizeDevice({ row: { mac: 'AA-BB' }, detail: {} });
  assert.equal(device.status, 'unknown');
  assert.equal(device.statusCode, null);
  assert.equal(device.statusCategory, null);
  assert.equal(device.statusDetail, null);
});

// --- Switch port normalization ----------------------------------------------

test('normalizeSwitchPort reports link, speed, PoE and counters', () => {
  const port = normalizeSwitchPort({
    countersRow: countersRow(),
    poeRow: poeInfoRow(),
    clientRows: [clientRow()],
  });
  assert.equal(port.switchMac, BACKYARD_SWITCH);
  assert.equal(port.switchName, 'Backyard Switch');
  assert.equal(port.port, 3);
  assert.equal(port.portName, 'Port3');
  assert.equal(port.linkUp, true);
  assert.equal(port.linkSpeedCode, 2);
  assert.equal(port.linkSpeedMbps, 100);
  assert.equal(port.linkSpeed, '100 Mbps');
  assert.equal(port.duplex, 'full');
  assert.equal(port.duplexCode, 2);
  assert.equal(port.poeSupported, true);
  assert.equal(port.poeMode, 1);
  assert.equal(port.poeActive, false);
  assert.equal(port.txErrors, 0);
  assert.equal(port.rxErrors, 1);
  assert.equal(port.txBytes, 26370965742);
  assert.equal(port.stp, 'Forwarding');
  assert.equal(port.clientConnected, true);
  assert.equal(port.clients, 1);
  assert.equal(port.clientMac, 'EC-71-DB-28-65-A0');
  assert.equal(port.clientName, 'Play Room Camera');
  assert.equal(port.clientIp, '10.10.100.13');
  assert.equal(port.clientType, 'IPC');
});

test('normalizeSwitchPort reports null rather than a fabricated zero for PoE', () => {
  // A non-PoE port: the controller sends no power/voltage/current at all.
  const port = normalizeSwitchPort({
    countersRow: countersRow({
      port: 8,
      portName: 'Port8',
      supportPoe: false,
      poeDisplayType: -1,
      portStatus: { port: 8, linkStatus: 1, linkSpeed: 3, duplex: 2, poe: false },
    }),
    poeRow: null,
    clientRows: [],
  });
  assert.equal(port.poeSupported, false);
  assert.equal(port.poePowerW, null, 'a non-PoE port has no draw reading');
  assert.equal(port.poeVoltage, null);
  assert.equal(port.poeCurrent, null);
  assert.equal(port.poeClass, null);
  assert.equal(port.linkSpeedMbps, 1000);
  assert.equal(port.linkSpeed, '1 Gbps');
  // The port link flag is true (an uplink carries a switch) but no *clients*
  // are on it, so the client fields stay null rather than inventing one.
  assert.equal(port.clientConnected, true);
  assert.equal(port.clients, 0);
  assert.equal(port.clientMac, null);
});

test('normalizeSwitchPort turns the PoE class sentinel into null', () => {
  const port = normalizeSwitchPort({ countersRow: countersRow(), poeRow: poeInfoRow(), clientRows: [] });
  // '--' means "no powered device attached", not a class name.
  assert.equal(port.poeClass, null);
  // With a real class reported, it passes through.
  const withClass = normalizeSwitchPort({
    countersRow: countersRow(),
    poeRow: poeInfoRow({ pdClass: 'Class 4', power: 6.7, voltage: 53.1, current: 126 }),
    clientRows: [],
  });
  assert.equal(withClass.poeClass, 'Class 4');
  assert.equal(withClass.poePowerW, 6.7);
  assert.equal(withClass.poeVoltage, 53.1);
  assert.equal(withClass.poeCurrent, 126);
});

test('normalizeSwitchPort withholds a speed claim for an unmapped code', () => {
  // Code 5 is observed on the SG3428X uplink ports, but the controller
  // disagrees with itself about what it means (see LINK_SPEEDS), so the port
  // keeps the raw code and claims no rate.
  const port = normalizeSwitchPort({
    countersRow: countersRow({ portStatus: { port: 27, linkStatus: 1, linkSpeed: 5, duplex: 2 } }),
    poeRow: null,
    clientRows: [],
  });
  assert.equal(port.linkUp, true);
  assert.equal(port.linkSpeedCode, 5);
  assert.equal(port.linkSpeedMbps, null);
  assert.equal(port.linkSpeed, null);
  assert.equal(port.duplex, 'full');
});

test('normalizeSwitchPort handles a down port and a missing portStatus block', () => {
  const down = normalizeSwitchPort({
    countersRow: countersRow({
      connectedStatus: 0,
      portStatus: { port: 3, linkStatus: 0, linkSpeed: 1, duplex: 2, poe: false },
    }),
    poeRow: poeInfoRow(),
    clientRows: [],
  });
  assert.equal(down.linkUp, false);
  // A down port reporting code 1 is not "10 Mbps"; the code is kept raw and no
  // speed is claimed.
  assert.equal(down.linkSpeedCode, 1);
  assert.equal(down.linkSpeedMbps, null);
  assert.equal(down.linkSpeed, null);
  assert.equal(down.clientConnected, false);

  // A row with no portStatus block at all must not throw.
  const bare = normalizeSwitchPort({ countersRow: { port: 1, switchMac: 'AA-BB', switchName: 'X', portName: 'Port1' }, poeRow: null, clientRows: [] });
  assert.equal(bare.linkUp, false);
  assert.equal(bare.linkSpeedCode, null);
  assert.equal(bare.duplex, null);
  assert.equal(bare.duplexCode, null);
  assert.equal(bare.txBytes, null);
});

// --- Indexes and envelope ----------------------------------------------------

test('index helpers key rows by switch MAC and port', () => {
  const poe = indexBySwitchPort([poeInfoRow({ port: 1 }), poeInfoRow({ port: 2 }), { port: 1 }]);
  assert.equal(poe.size, 2, 'a row with no switchMac is skipped');
  assert.equal(poe.get(`${BACKYARD_SWITCH}#1`).port, 1);

  const clients = indexClientsBySwitchPort([
    clientRow({ port: 3, mac: 'AA' }),
    clientRow({ port: 3, mac: 'BB' }),
    clientRow({ port: 4, mac: 'CC' }),
    { mac: 'DD' },
  ]);
  assert.deepEqual(clients.get(`${BACKYARD_SWITCH}#3`).map((c) => c.mac), ['AA', 'BB']);
  assert.equal(clients.get(`${BACKYARD_SWITCH}#4`).length, 1);
});

test('portsEnvelope tallies per-switch totals in controller order', () => {
  const ports = [
    normalizeSwitchPort({ countersRow: countersRow(), poeRow: poeInfoRow(), clientRows: [clientRow()] }),
    normalizeSwitchPort({ countersRow: countersRow({ port: 4, portName: 'Port4', connectedStatus: 0 }), clientRows: [] }),
    normalizeSwitchPort({ countersRow: countersRow({ switchMac: MAIN_SWITCH, switchName: 'Main Switch', port: 22 }), clientRows: [] }),
  ];
  const envelope = portsEnvelope({ siteId: SITE, deviceId: null, ports });
  assert.equal(envelope.siteId, SITE);
  assert.equal(envelope.deviceId, null);
  assert.equal(envelope.portCount, 3);
  assert.equal(envelope.switchCount, 2);
  assert.deepEqual(envelope.switches, [
    { mac: BACKYARD_SWITCH, name: 'Backyard Switch', ports: 2, linksUp: 2, clients: 1 },
    { mac: MAIN_SWITCH, name: 'Main Switch', ports: 1, linksUp: 1, clients: 0 },
  ]);
});

// --- Handler level: a stub client, no sockets -------------------------------

const STUB_SITE = { siteId: SITE, name: 'Home' };

/** A client stub returning the fixture rows for the site. */
function stubClient(overrides = {}) {
  return {
    async listSites() {
      return [STUB_SITE];
    },
    async listDevices(siteId) {
      assert.equal(siteId, SITE);
      return [switchRow(), switchRow({ mac: MAIN_SWITCH, name: 'Main Switch', model: 'SG3428X v1.30' }), offlineApRow(), switchRow({ mac: BASEMENT_AP, name: 'Basement AP', type: 'ap', model: 'EAP650(US) v1.0' })];
    },
    async listClients() {
      return [clientRow()];
    },
    async readDeviceDetail(siteId, kind, deviceId) {
      return { complete: true, result: kind === 'switchDetail' ? switchDetail() : apDetail({ mac: deviceId }) };
    },
    async readSwitchPortDataset(siteId, kind) {
      return { complete: true, records: kind === 'switchPorts' ? [countersRow()] : [poeInfoRow()] };
    },
    ...overrides,
  };
}

function deviceSpecs(stub, secrets = []) {
  return deviceToolSpecs({ getClient: () => stub, secrets: () => secrets });
}

async function handlerFor(stub, name, secrets = []) {
  const spec = deviceSpecs(stub, secrets).find((s) => s.name === name);
  assert.ok(spec, `no handler named ${name}`);
  return spec.handler;
}

test('getDevice returns the merged device record', async () => {
  const handler = await handlerFor(stubClient(), 'getDevice');
  const result = await handler({ siteId: SITE, deviceId: BACKYARD_SWITCH });
  assert.equal(result.siteId, SITE);
  assert.equal(result.device.deviceId, BACKYARD_SWITCH);
  assert.equal(result.device.name, 'Backyard Switch');
  assert.equal(result.device.status, 'online');
  assert.equal(result.device.portCount, 8);
});

test('getDevice accepts a lower-case id and reads the switch detail', async () => {
  const seen = {};
  const stub = stubClient({
    async readDeviceDetail(siteId, kind, deviceId) {
      Object.assign(seen, { siteId, kind, deviceId });
      return { complete: true, result: switchDetail() };
    },
  });
  const handler = await handlerFor(stub, 'getDevice');
  await handler({ siteId: SITE, deviceId: BACKYARD_SWITCH.toLowerCase() });
  assert.equal(seen.kind, 'switchDetail', 'a switch resolves to the switch detail dataset');
  assert.equal(seen.deviceId, BACKYARD_SWITCH, 'the MAC sent back is the controller spelling');
});

test('getDevice resolves each device type to its own detail endpoint', async () => {
  const kinds = [];
  const stub = stubClient({
    async listDevices() {
      return [switchRow(), switchRow({ mac: BASEMENT_AP, type: 'ap' })];
    },
    async readDeviceDetail(siteId, kind, deviceId) {
      kinds.push(kind);
      return { complete: true, result: kind === 'ap' ? apDetail() : switchDetail() };
    },
  });
  const handler = await handlerFor(stub, 'getDevice');
  await handler({ siteId: SITE, deviceId: BASEMENT_AP });
  assert.deepEqual(kinds, ['apDetail']);
});

test('getDevice without a deviceId is a visible error', async () => {
  const handler = await handlerFor(stubClient(), 'getDevice');
  await assert.rejects(() => handler({ siteId: SITE }), /requires deviceId/);
});

test('getDevice rejects an unknown device id instead of returning an empty device', async () => {
  const handler = await handlerFor(stubClient(), 'getDevice');
  await assert.rejects(
    () => handler({ siteId: SITE, deviceId: '00-00-00-00-00-00' }),
    /Unknown deviceId/,
  );
});

test('getDevice rejects an invalid identifier before any request', async () => {
  let contacted = false;
  const stub = stubClient({
    async listSites() {
      contacted = true;
      return [STUB_SITE];
    },
  });
  const handler = await handlerFor(stub, 'getDevice');
  await assert.rejects(
    () => handler({ siteId: SITE, deviceId: '../../etc/passwd' }),
    /Invalid deviceId/,
  );
  await assert.rejects(() => handler({ siteId: SITE, deviceId: 'aa:bb:cc:dd:ee:ff' }), /Invalid deviceId/);
  assert.equal(contacted, false, 'an invalid id must be rejected before any controller call');
});

test('getDevice rejects an unsupported device type', async () => {
  const stub = stubClient({
    async listDevices() {
      return [{ ...switchRow(), type: 'controller' }];
    },
  });
  const handler = await handlerFor(stub, 'getDevice');
  await assert.rejects(() => handler({ siteId: SITE, deviceId: BACKYARD_SWITCH }), /unsupported type/);
});

test('getDevice refuses a site the credential cannot see before any read', async () => {
  let devicesRead = false;
  const stub = stubClient({
    async listDevices() {
      devicesRead = true;
      return [];
    },
  });
  const handler = await handlerFor(stub, 'getDevice');
  await assert.rejects(() => handler({ siteId: 'other', deviceId: BACKYARD_SWITCH }), /accessible site list/);
  assert.equal(devicesRead, false);
});

test('getDevice surfaces a controller failure rather than an empty device', async () => {
  const stub = stubClient({
    async readDeviceDetail() {
      throw new Error('HTTP 500 from /switches/20-23-51-5E-4A-BA');
    },
  });
  const handler = await handlerFor(stub, 'getDevice');
  await assert.rejects(() => handler({ siteId: SITE, deviceId: BACKYARD_SWITCH }), /HTTP 500/);
});

test('getSwitchPorts returns every port of every switch when no id is given', async () => {
  const handler = await handlerFor(stubClient(), 'getSwitchPorts');
  const result = await handler({ siteId: SITE });
  assert.equal(result.portCount, 1);
  assert.equal(result.switchCount, 1);
  assert.equal(result.deviceId, null);
  assert.equal(result.ports[0].switchMac, BACKYARD_SWITCH);
  assert.equal(result.ports[0].clientMac, 'EC-71-DB-28-65-A0');
});

test('getSwitchPorts narrows server-side only after resolving the id', async () => {
  const calls = [];
  const stub = stubClient({
    async readSwitchPortDataset(siteId, kind, options) {
      calls.push({ kind, options });
      return { complete: true, records: kind === 'switchPorts' ? [countersRow()] : [poeInfoRow()] };
    },
  });
  const handler = await handlerFor(stub, 'getSwitchPorts');
  const result = await handler({ siteId: SITE, deviceId: BACKYARD_SWITCH.toLowerCase() });
  // The MAC handed to the filter is the controller's own spelling, uppercased.
  assert.deepEqual(calls.map((c) => [c.kind, c.options.switchMac]), [
    ['switchPorts', BACKYARD_SWITCH],
    ['switchPortPoe', BACKYARD_SWITCH],
  ]);
  assert.equal(result.deviceId, BACKYARD_SWITCH);
  assert.equal(result.ports[0].port, 3);
});

test('getSwitchPorts rejects an id that is not a switch', async () => {
  const handler = await handlerFor(stubClient(), 'getSwitchPorts');
  await assert.rejects(
    () => handler({ siteId: SITE, deviceId: BASEMENT_AP }),
    /is a ap, not a switch/,
  );
});

test('getSwitchPorts rejects an unknown id instead of returning no ports', async () => {
  const handler = await handlerFor(stubClient(), 'getSwitchPorts');
  await assert.rejects(() => handler({ siteId: SITE, deviceId: '00-00-00-00-00-00' }), /Unknown deviceId/);
});

test('getSwitchPorts rejects an invalid identifier before any request', async () => {
  let contacted = false;
  const stub = stubClient({
    async listSites() {
      contacted = true;
      return [STUB_SITE];
    },
  });
  const handler = await handlerFor(stub, 'getSwitchPorts');
  await assert.rejects(() => handler({ siteId: SITE, deviceId: 'aa/bb' }), /Invalid deviceId/);
  assert.equal(contacted, false);
});

test('a truncated port read surfaces as an error, never a short port list', async () => {
  const stub = stubClient({
    async readSwitchPortDataset(siteId, kind) {
      if (kind === 'switchPorts') throw new Error('API repeated a page; result is incomplete.');
      return { complete: true, records: [] };
    },
  });
  const handler = await handlerFor(stub, 'getSwitchPorts');
  await assert.rejects(() => handler({ siteId: SITE }), /repeated a page/);
});

test('a site the credential cannot see is refused before any port read', async () => {
  let read = false;
  const stub = stubClient({
    async readSwitchPortDataset() {
      read = true;
      return { complete: true, records: [] };
    },
  });
  const handler = await handlerFor(stub, 'getSwitchPorts');
  await assert.rejects(() => handler({ siteId: 'other' }), /accessible site list/);
  assert.equal(read, false);
});

test('secrets in device and port output are redacted before the handler returns', async () => {
  const secret = 'supersecret';
  const deviceHandler = await handlerFor(stubClient(), 'getDevice', [secret]);
  const deviceResult = await deviceHandler({ siteId: SITE, deviceId: BACKYARD_SWITCH });
  assert.ok(!JSON.stringify(deviceResult).includes(secret));

  const portHandler = await handlerFor(
    stubClient({
      async listClients() {
        return [clientRow({ name: `cam ${secret}` })];
      },
    }),
    'getSwitchPorts',
    [secret],
  );
  const portResult = await portHandler({ siteId: SITE });
  assert.ok(!JSON.stringify(portResult).includes(secret));
  assert.ok(portResult.ports[0].clientName.includes('[REDACTED]'));
});

// --- Client level: the request that actually goes out -----------------------

/** A client whose request() records the call instead of opening a socket. */
function recordingClient(pages) {
  const client = new OmadaClient({ baseUrl: 'https://x', omadacId: 'o', agent: undefined, accessToken: 't' });
  const calls = [];
  client.request = async (method, path, options = {}) => {
    calls.push({ method, path, params: options.params, version: options.version });
    return typeof pages === 'function' ? pages(calls.length) : pages;
  };
  return { client, calls };
}

test('readDeviceDetail builds the fixed path from the registry', async () => {
  const { client, calls } = recordingClient({ mac: BACKYARD_SWITCH });
  const result = await client.readDeviceDetail(SITE, 'switchDetail', BACKYARD_SWITCH);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].version, 'v1');
  // request() adds the /openapi/{version}/{omadacId} prefix itself.
  assert.equal(calls[0].path, `/sites/${SITE}/switches/${BACKYARD_SWITCH}`);
  assert.deepEqual(result, { complete: true, result: { mac: BACKYARD_SWITCH } });
});

test('readDeviceDetail rejects a non-detail dataset and an unknown kind', async () => {
  const { client, calls } = recordingClient({});
  await assert.rejects(() => client.readDeviceDetail(SITE, 'switchPorts', BACKYARD_SWITCH), /Not a device detail dataset/);
  await assert.rejects(() => client.readDeviceDetail(SITE, 'nonsense', BACKYARD_SWITCH), /Not a device detail dataset/);
  assert.equal(calls.length, 0, 'no request is made for an invalid kind');
});

test('readDeviceDetail refuses an id that could traverse the path', async () => {
  const { client, calls } = recordingClient({});
  await assert.rejects(() => client.readDeviceDetail(SITE, 'switchDetail', '../../sites/other/switches/x'), /Invalid path parameter|Unsafe/);
  assert.equal(calls.length, 0, 'no request is made for an unsafe id');
});

test('readSwitchPortDataset sends the switchMac filter only when given', async () => {
  const { client, calls } = recordingClient({ totalRows: 0, data: [] });
  await client.readSwitchPortDataset(SITE, 'switchPorts', { switchMac: BACKYARD_SWITCH.toLowerCase() });
  assert.equal(calls[0].path, `/sites/${SITE}/switches/ports/counters`);
  assert.equal(calls[0].params['filters.switchMac'], BACKYARD_SWITCH, 'the MAC is normalized to controller case');
  assert.equal(calls[0].params.page, 1);
  assert.equal(calls[0].params.pageSize, 100);

  await client.readSwitchPortDataset(SITE, 'switchPortPoe', {});
  assert.equal(calls[1].params['filters.switchMac'], undefined, 'no filter when no switch is named');
  assert.equal(calls[1].path, `/sites/${SITE}/switches/ports/poe-info`);
});

test('readSwitchPortDataset rejects a filter-carrying id and a wrong dataset', async () => {
  const { client, calls } = recordingClient({ totalRows: 0, data: [] });
  // A value that would smuggle a second query parameter must not survive.
  await assert.rejects(
    () => client.readSwitchPortDataset(SITE, 'switchPorts', { switchMac: 'AA&filters.module=Device' }),
    /Invalid switchMac/,
  );
  await assert.rejects(() => client.readSwitchPortDataset(SITE, 'apDetail', {}), /Not a switch-port dataset/);
  await assert.rejects(() => client.readSwitchPortDataset(SITE, 'nope', {}), /Not a switch-port dataset/);
  assert.equal(calls.length, 0);
});

test('readSwitchPortDataset walks pages and refuses a repeated page', async () => {
  const first = { totalRows: 4, data: [{ port: 1 }, { port: 2 }] };
  const second = { totalRows: 4, data: [{ port: 3 }, { port: 4 }] };
  const { client } = recordingClient((n) => (n === 1 ? first : second));
  const result = await client.readSwitchPortDataset(SITE, 'switchPorts', {});
  assert.equal(result.complete, true);
  assert.deepEqual(result.records.map((r) => r.port), [1, 2, 3, 4]);

  const repeated = recordingClient(() => first);
  await assert.rejects(
    () => repeated.client.readSwitchPortDataset(SITE, 'switchPorts', {}),
    /repeated a page/,
  );

  const malformed = recordingClient(() => ({ totalRows: 4 }));
  await assert.rejects(
    () => malformed.client.readSwitchPortDataset(SITE, 'switchPorts', {}),
    /Unexpected pagination schema/,
  );
});

// --- MCP level (the fake-transport pattern the repo already uses) ------------

async function connectDeviceServer(stub) {
  const server = new McpServer({ name: 't', version: '1' });
  const tool = createToolRegistrar(server, (value) => value);
  for (const spec of deviceToolSpecs({ getClient: () => stub })) {
    tool(spec.name, spec.description, spec.schema, spec.handler);
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('the MCP tool list includes getDevice and getSwitchPorts, marked read-only', async () => {
  const { client } = await connectDeviceServer(stubClient());
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('getDevice'), `tools list should include getDevice, got ${names}`);
  assert.ok(names.includes('getSwitchPorts'), `tools list should include getSwitchPorts, got ${names}`);
  assert.equal(names.filter((n) => n.startsWith('write')).length, 0);
  for (const name of ['getDevice', 'getSwitchPorts']) {
    const spec = tools.find((t) => t.name === name);
    assert.equal(spec.annotations.readOnlyHint, true, `${name} should be marked read-only`);
    assert.equal(spec.annotations.destructiveHint, false);
  }
  await client.close();
});

test('getDevice over MCP returns the device as JSON text', async () => {
  const { client } = await connectDeviceServer(stubClient());
  const result = await client.callTool({ name: 'getDevice', arguments: { siteId: SITE, deviceId: BACKYARD_SWITCH } });
  assert.notEqual(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.siteId, SITE);
  assert.equal(payload.device.deviceId, BACKYARD_SWITCH);
  assert.equal(payload.device.status, 'online');
  assert.equal(payload.device.type, 'switch');
  await client.close();
});

test('getSwitchPorts over MCP returns the envelope as JSON text', async () => {
  const { client } = await connectDeviceServer(stubClient());
  const result = await client.callTool({ name: 'getSwitchPorts', arguments: { siteId: SITE, deviceId: BACKYARD_SWITCH } });
  assert.notEqual(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.deviceId, BACKYARD_SWITCH);
  assert.equal(payload.portCount, 1);
  assert.equal(payload.ports[0].linkUp, true);
  await client.close();
});

test('device errors over MCP are visible, never an empty success', async () => {
  const { client } = await connectDeviceServer(stubClient());
  const unknown = await client.callTool({ name: 'getDevice', arguments: { siteId: SITE, deviceId: '00-00-00-00-00-00' } });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown deviceId/);

  // The schema's own pattern rejects a malformed id; either layer's message
  // is fine, but it must be an error and it must name the constraint.
  const invalid = await client.callTool({ name: 'getDevice', arguments: { siteId: SITE, deviceId: '../../etc/passwd' } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /deviceId|Device MAC/);

  const missing = await client.callTool({ name: 'getDevice', arguments: { siteId: SITE } });
  assert.equal(missing.isError, true);

  const notASwitch = await client.callTool({ name: 'getSwitchPorts', arguments: { siteId: SITE, deviceId: BASEMENT_AP } });
  assert.equal(notASwitch.isError, true);
  assert.match(notASwitch.content[0].text, /not a switch/);
  await client.close();
});

test('a controller failure over MCP is a visible error for both tools', async () => {
  const stub = stubClient({
    async listSites() {
      return [STUB_SITE];
    },
    async readSwitchPortDataset() {
      throw new Error('HTTP 500 from /sites/x/switches/ports/counters');
    },
    async readDeviceDetail() {
      throw new Error('HTTP 500 from /sites/x/devices');
    },
  });
  const { client } = await connectDeviceServer(stub);
  for (const [name, args] of [
    ['getDevice', { siteId: SITE, deviceId: BACKYARD_SWITCH }],
    ['getSwitchPorts', { siteId: SITE }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} must report the failure`);
    assert.doesNotMatch(result.content[0].text, /"portCount": 0/);
  }
  await client.close();
});

test('the schema rejects an unknown field', async () => {
  const { client } = await connectDeviceServer(stubClient());
  const result = await client.callTool({
    name: 'getDevice',
    arguments: { siteId: SITE, deviceId: BACKYARD_SWITCH, extra: true },
  });
  assert.equal(result.isError, true);
  await client.close();
});

// --- The real server ---------------------------------------------------------

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

test('the real server starts with zero config and lists both device tools', async () => {
  const client = await connectRealServer();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('getDevice'), `tools list should include getDevice, got ${names}`);
  assert.ok(names.includes('getSwitchPorts'), `tools list should include getSwitchPorts, got ${names}`);
  await client.close();
});

test('getConnectionStatus reports the device dataset count', async () => {
  const client = await connectRealServer();
  const status = await client.callTool({ name: 'getConnectionStatus', arguments: {} });
  const payload = JSON.parse(status.content[0].text);
  assert.equal(payload.deviceDatasets, 5);
  await client.close();
});

test('a misconfigured server reports the missing config per call, not at startup', async () => {
  const client = await connectRealServer();
  const result = await client.callTool({ name: 'getDevice', arguments: { siteId: SITE, deviceId: BACKYARD_SWITCH } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /configure|missing|credentials|config/i);
  await client.close();
});
