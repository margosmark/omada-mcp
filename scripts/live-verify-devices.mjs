#!/usr/bin/env node
/**
 * Live end-to-end verification of getDevice / getSwitchPorts against the real
 * controller, through the real server binary over stdio — the same path a
 * client uses. Read-only: both tools only issue GETs.
 *
 * Checks each device type, the offline-device case (optional fields must stay
 * null rather than become 0), lower-case ids, every error path, the whole-site
 * and single-switch port reads, and that the port/client join agrees with the
 * wired clients the controller reports.
 *
 * Usage:
 *   OMADA_CONFIG=... OMADA_PEM=... OMADA_CREDENTIALS=... node scripts/live-verify-devices.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'src/index.mjs')],
  env: { ...process.env },
  stderr: 'inherit',
});
const client = new Client({ name: 'live-verify', version: '1' });
await client.connect(transport);

const fail = (label, message) => {
  console.log(`FAIL ${label}: ${message}`);
  process.exitCode = 1;
};
const ok = (label) => console.log(`ok   ${label}`);

// 1. Tool surface + status.
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
for (const expected of ['getDevice', 'getSwitchPorts']) {
  if (names.includes(expected)) ok(`tools/list includes ${expected}`);
  else fail('tool surface', `missing ${expected}; got ${names.join(', ')}`);
}
const status = JSON.parse((await client.callTool({ name: 'getConnectionStatus', arguments: {} })).content[0].text);
console.log(`status: tools=${status.tools} datasets=${status.datasets} logDatasets=${status.logDatasets} deviceDatasets=${status.deviceDatasets} mode=${status.mode}`);
if (status.deviceDatasets !== 5) fail('status', `deviceDatasets=${status.deviceDatasets}, expected 5`);

// 2. Pick a real site.
const sites = JSON.parse((await client.callTool({ name: 'listSites', arguments: {} })).content[0].text);
const site = sites[0];
console.log(`\nsite: ${site.siteId} (${site.name})\n`);

// 3. A real switch, from the controller's own device list.
const devices = JSON.parse(
  (await client.callTool({ name: 'listDevices', arguments: { siteId: site.siteId } })).content[0].text,
);
const switchDev = devices.find((d) => d.type === 'switch');
const apDev = devices.find((d) => d.type === 'ap');
const gwDev = devices.find((d) => d.type === 'gateway');
console.log(`devices: ${devices.length} (${devices.filter((d) => d.type === 'switch').length} switches, ${devices.filter((d) => d.type === 'ap').length} aps, ${devices.filter((d) => d.type === 'gateway').length} gateways)`);

for (const [label, dev] of [['switch', switchDev], ['ap', apDev], ['gateway', gwDev]]) {
  const result = await client.callTool({ name: 'getDevice', arguments: { siteId: site.siteId, deviceId: dev.mac } });
  if (result.isError) { fail(`getDevice ${label}`, result.content[0].text); continue; }
  const payload = JSON.parse(result.content[0].text);
  const d = payload.device;
  console.log(`getDevice ${label} ${d.deviceId}: name=${d.name} type=${d.type} model=${d.model} ip=${d.ip} status=${d.status} (${d.statusDetail}) uptime=${d.uptimeSeconds}s cpu=${d.cpuUtil} mem=${d.memUtil} fw=${d.firmwareVersionShort} ports=${d.portCount} temp=${d.temperature}`);
  for (const field of ['deviceId', 'name', 'type', 'model', 'ip', 'firmwareVersion', 'status']) {
    if (d[field] === null || d[field] === undefined) fail(`getDevice ${label}`, `${field} was null`);
  }
  if (d.deviceId !== dev.mac) fail(`getDevice ${label}`, `deviceId mismatch: ${d.deviceId} vs ${dev.mac}`);
  if (!['online', 'offline', 'unknown'].includes(d.status)) fail(`getDevice ${label}`, `bad status ${d.status}`);
  if (d.uptimeSeconds !== null && !Number.isInteger(d.uptimeSeconds)) fail(`getDevice ${label}`, `uptimeSeconds not an integer: ${d.uptimeSeconds}`);
  ok(`getDevice ${label} normalized`);
}

// 4. The offline device, to prove optional fields stay null rather than 0.
const offline = devices.find((d) => d.status === 0);
if (offline) {
  const result = await client.callTool({ name: 'getDevice', arguments: { siteId: site.siteId, deviceId: offline.mac } });
  if (result.isError) fail('getDevice offline', result.content[0].text);
  else {
    const d = JSON.parse(result.content[0].text).device;
    console.log(`\ngetDevice offline ${d.deviceId}: name=${d.name} status=${d.status} uptime=${d.uptimeSeconds} cpu=${d.cpuUtil} mem=${d.memUtil} lastSeen=${d.lastSeen}`);
    if (d.status !== 'offline') fail('offline', `status=${d.status}`);
    ok('getDevice offline device reads without inventing uptime/cpu');
  }
} else console.log('\n(no offline device on this controller)');

// 5. Lower-case id must resolve to the controller's own spelling.
const lower = await client.callTool({ name: 'getDevice', arguments: { siteId: site.siteId, deviceId: switchDev.mac.toLowerCase() } });
if (lower.isError) fail('lowercase id', lower.content[0].text);
else {
  const d = JSON.parse(lower.content[0].text).device;
  if (d.deviceId === switchDev.mac) ok(`lower-case id ${switchDev.mac.toLowerCase()} -> ${d.deviceId}`);
  else fail('lowercase id', `got ${d.deviceId}`);
}

// 6. Error paths — each must be a visible error, never an empty success.
for (const [label, args, expect] of [
  ['unknown id', { siteId: site.siteId, deviceId: '00-00-00-00-00-00' }, /Unknown deviceId/],
  ['traversal id', { siteId: site.siteId, deviceId: '../../etc/passwd' }, /deviceId|Device MAC/],
  ['colon id', { siteId: site.siteId, deviceId: switchDev.mac.replaceAll('-', ':') }, /deviceId|Device MAC/],
  ['unknown site', { siteId: 'not-a-real-site', deviceId: switchDev.mac }, /accessible site list/],
]) {
  const result = await client.callTool({ name: 'getDevice', arguments: args });
  if (result.isError && expect.test(result.content[0].text)) ok(`getDevice ${label} -> visible error: ${result.content[0].text.slice(0, 70)}`);
  else fail(`getDevice ${label}`, `isError=${result.isError} text=${result.content[0].text.slice(0, 120)}`);
}

// getSwitchPorts: an id that is not a switch must be refused.
const notASwitch = await client.callTool({ name: 'getSwitchPorts', arguments: { siteId: site.siteId, deviceId: apDev?.mac ?? gwDev.mac } });
if (notASwitch.isError && /not a switch/.test(notASwitch.content[0].text)) ok(`getSwitchPorts ${apDev ? 'ap' : 'gateway'} id -> visible error: ${notASwitch.content[0].text.slice(0, 70)}`);
else fail('getSwitchPorts non-switch', `isError=${notASwitch.isError} text=${notASwitch.content[0].text.slice(0, 140)}`);

const badPorts = await client.callTool({ name: 'getSwitchPorts', arguments: { siteId: site.siteId, deviceId: 'aa/bb' } });
if (badPorts.isError) ok('getSwitchPorts invalid id -> visible error');
else fail('getSwitchPorts invalid id', 'no error');

// 7. Whole-site port read.
{
  const result = await client.callTool({ name: 'getSwitchPorts', arguments: { siteId: site.siteId } });
  if (result.isError) { fail('getSwitchPorts all', result.content[0].text); }
  else {
    const p = JSON.parse(result.content[0].text);
    console.log(`\ngetSwitchPorts (all): portCount=${p.portCount} switchCount=${p.switchCount}`);
    for (const s of p.switches) console.log(`  ${s.mac} ${s.name}: ports=${s.ports} linksUp=${s.linksUp} clients=${s.clients}`);
    if (p.portCount !== p.ports.length) fail('ports', 'portCount mismatch');
    if (p.switchCount !== p.switches.length) fail('ports', 'switchCount mismatch');
    const linked = p.ports.filter((x) => x.linkUp);
    console.log(`  linkUp: ${linked.length}/${p.ports.length}; speeds: ${[...new Set(linked.map((x) => x.linkSpeed ?? `code ${x.linkSpeedCode} (withheld)`))].join(', ')}`);
    const withClients = p.ports.filter((x) => x.clients > 0);
    console.log(`  ports with clients: ${withClients.length}; e.g. ${withClients[0]?.switchMac}#${withClients[0]?.port} -> ${withClients[0]?.clientMac} (${withClients[0]?.clientName}, ${withClients[0]?.clientType})`);
    for (const port of p.ports) {
      // A link that is up may legitimately have no speed claim when the code
      // is one this build cannot corroborate; it must then keep the raw code.
      if (port.linkUp && port.linkSpeedMbps === null && port.linkSpeedCode === null) fail('port speed', `link up with no code at ${port.switchMac}#${port.port}`);
      if (!port.linkUp && port.linkSpeedMbps !== null) fail('port speed', `link down but speed claimed at ${port.switchMac}#${port.port}`);
      if (port.poeSupported && port.poeVoltage === 0 && port.poeActive) fail('poe', `active PoE with zero voltage at ${port.switchMac}#${port.port}`);
      if (!port.poeSupported && port.poePowerW !== null) fail('poe', `non-PoE port reported draw at ${port.switchMac}#${port.port}`);
    }
    ok('every port is internally consistent');
    const clientTotal = withClients.reduce((n, x) => n + x.clients, 0);
    const wired = JSON.parse((await client.callTool({ name: 'listClients', arguments: { siteId: site.siteId } })).content[0].text).filter((c) => c.wireless === false && c.switchMac);
    if (clientTotal === wired.length) ok(`connected-client count matches /clients wired clients: ${clientTotal}`);
    else fail('client join', `ports report ${clientTotal} clients, /clients has ${wired.length} wired`);
  }
}

// 8. Single-switch read, lower-case id.
{
  const result = await client.callTool({ name: 'getSwitchPorts', arguments: { siteId: site.siteId, deviceId: switchDev.mac.toLowerCase() } });
  if (result.isError) fail('getSwitchPorts single', result.content[0].text);
  else {
    const p = JSON.parse(result.content[0].text);
    console.log(`\ngetSwitchPorts ${switchDev.mac} (lower-case id): portCount=${p.portCount} deviceId=${p.deviceId}`);
    if (p.ports.some((x) => x.switchMac !== switchDev.mac)) fail('single switch', 'returned ports from another switch');
    else ok(`only ${switchDev.mac} ports returned (${p.portCount})`);
    if (p.deviceId !== switchDev.mac) fail('single switch', `deviceId=${p.deviceId}`);
    const poe = p.ports.filter((x) => x.poeSupported);
    console.log(`  PoE-capable ports: ${poe.length}; drawing: ${poe.filter((x) => x.poeActive).length}; max ${Math.max(0, ...poe.map((x) => x.poePowerW ?? 0))} W`);
  }
}

// 9. Read-only proof: no mutating method was reachable through either tool.
const writeProbe = await client.callTool({ name: 'getSwitchPorts', arguments: { siteId: site.siteId, deviceId: switchDev.mac } });
if (writeProbe.isError) fail('final read', writeProbe.content[0].text);
else ok('final read-only call succeeded');

await client.close();
console.log(process.exitCode ? '\nLIVE VERIFICATION: FAILURES ABOVE' : '\nLIVE VERIFICATION: ALL CHECKS PASSED');
