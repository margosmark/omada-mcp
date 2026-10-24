#!/usr/bin/env node
/**
 * Probe: the server must start with zero controller config.
 * The MCP handshake succeeds and tools/list returns; a tool call that needs
 * the controller fails with a visible message rather than crashing the server.
 *
 * Usage: node scripts/zero-config-probe.mjs
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
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OMADA_CONFIG: '/nonexistent/controller.json',
    OMADA_PEM: '/nonexistent/controller.pem',
    OMADA_CREDENTIALS: '/nonexistent/credentials.json',
  },
  stderr: 'inherit',
});
const client = new Client({ name: 'probe', version: '1' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
console.log('write tools exposed:', tools.filter((t) => t.name.startsWith('write')).length);

const status = await client.callTool({ name: 'getConnectionStatus', arguments: {} });
const payload = JSON.parse(status.content[0].text);
console.log('reported tools:', payload.tools, '| mode:', payload.mode, '| writesEnabled:', payload.writesEnabled);

// A log call with no config must fail visibly, not report an empty log.
const logs = await client.callTool({ name: 'getAlerts', arguments: { siteId: 'x' } });
console.log('getAlerts with no config ->', logs.isError === true ? 'visible error' : 'NOT AN ERROR');
if (logs.isError) console.log('   ', logs.content[0].text.slice(0, 160));

await client.close();
