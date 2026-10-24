#!/usr/bin/env node
/**
 * Live smoke check: start the real server over stdio, complete the MCP
 * handshake, list the tools, and call getAlerts + getEvents against the
 * controller.
 *
 * Usage:
 *   OMADA_CONFIG=... OMADA_PEM=... OMADA_CREDENTIALS=... node scripts/live-log-test.mjs
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
const client = new Client({ name: 'live-log-test', version: '1' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
console.log('tool count:', tools.length);
console.log('write tools exposed:', tools.filter((t) => t.name.startsWith('write')).length);

const siteResult = await client.callTool({ name: 'listSites', arguments: {} });
if (siteResult.isError) throw new Error(`listSites failed: ${siteResult.content[0].text}`);
const siteId = JSON.parse(siteResult.content[0].text)[0].siteId;
console.log('site:', siteId);

const status = await client.callTool({ name: 'getConnectionStatus', arguments: {} });
console.log('getConnectionStatus:', JSON.parse(status.content[0].text).tools, 'tools reported');

for (const name of ['getAlerts', 'getEvents']) {
  const result = await client.callTool({ name, arguments: { siteId, limit: 3 } });
  if (result.isError) {
    console.log(`${name} -> ERROR ${result.content[0].text}`);
    continue;
  }
  const payload = JSON.parse(result.content[0].text);
  console.log(
    `${name} -> kind=${payload.kind} returned=${payload.returned} totalRows=${payload.totalRows} limited=${payload.limited} limit=${payload.limit}`,
  );
  for (const record of payload.records.slice(0, 2)) {
    console.log(`   ${JSON.stringify(record).slice(0, 220)}`);
  }
}

// A filter the endpoint does not implement must be a visible error.
const badSeverity = await client.callTool({
  name: 'getEvents',
  arguments: { siteId, severity: 'Error' },
});
console.log('getEvents with severity ->', badSeverity.isError === true ? 'visible error (expected)' : 'NOT AN ERROR');
if (badSeverity.isError) console.log('   ', badSeverity.content[0].text.slice(0, 200));

// The server-side filters must actually narrow the result set.
for (const args of [
  { name: 'getAlerts', arguments: { siteId, limit: 5, severity: 'Warning' } },
  { name: 'getAlerts', arguments: { siteId, limit: 5, severity: 'Error' } },
  { name: 'getAlerts', arguments: { siteId, limit: 5, category: 'Device' } },
  { name: 'getAlerts', arguments: { siteId, limit: 5, resolved: true } },
  { name: 'getAlerts', arguments: { siteId, limit: 5, resolved: false } },
  { name: 'getEvents', arguments: { siteId, limit: 5, category: 'Client' } },
]) {
  const result = await client.callTool(args);
  if (result.isError) {
    console.log(`${args.name} ${JSON.stringify(args.arguments)} -> ERROR ${result.content[0].text.slice(0, 160)}`);
    continue;
  }
  const payload = JSON.parse(result.content[0].text);
  console.log(
    `${args.name} ${JSON.stringify(args.arguments)} -> returned=${payload.returned} totalRows=${payload.totalRows}` +
      ` severities=${JSON.stringify([...new Set(payload.records.map((r) => r.severity))])}` +
      ` categories=${JSON.stringify([...new Set(payload.records.map((r) => r.category))])}`,
  );
}

// The limit bounds the read; the envelope reports the controller's own total.
for (const limit of [1, 200]) {
  const result = await client.callTool({ name: 'getEvents', arguments: { siteId, limit } });
  const payload = JSON.parse(result.content[0].text);
  const times = payload.records.map((r) => Date.parse(r.time));
  const newestFirst = times.every((t, i) => i === 0 || times[i - 1] >= t);
  console.log(
    `getEvents limit=${limit} -> returned=${payload.returned} totalRows=${payload.totalRows} limited=${payload.limited} newestFirst=${newestFirst}`,
  );
}

// An explicit window must narrow the read and be reported back.
const windowed = await client.callTool({
  name: 'getAlerts',
  arguments: { siteId, limit: 5, since: '2026-10-01T00:00:00Z' },
});
const windowedPayload = JSON.parse(windowed.content[0].text);
console.log('getAlerts since=2026-10-01 ->', JSON.stringify(windowedPayload.window), 'returned=', windowedPayload.returned);

await client.close();
