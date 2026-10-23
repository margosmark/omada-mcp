#!/usr/bin/env node
/**
 * One-shot recovery: delete the throwaway ZZ_MCP_LIVE_WRITE_TEST group if a
 * prior live test aborted between create and delete. Idempotent — reports and
 * exits 0 if the group is already gone.
 *
 * Same gates as live-write-test: OMADA_ENABLE_WRITES=true + --apply.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(join(root, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const [siteId, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');
if (!siteId || !/^[A-Za-z0-9_-]+$/.test(siteId)) {
  console.error('Usage: node scripts/cleanup-test-group.mjs <siteId> [--apply]');
  process.exit(2);
}
if (process.env.OMADA_ENABLE_WRITES?.toLowerCase() !== 'true') {
  console.error('Refusing: OMADA_ENABLE_WRITES must be true.');
  process.exit(2);
}
const GROUP_NAME = 'ZZ_MCP_LIVE_WRITE_TEST';

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'src/index.mjs')],
    env: process.env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'cleanup', version: '1.0.0' });
  try {
    await client.connect(transport);
    const read = async () => {
      const r = await client.callTool({
        name: 'readSiteConfiguration',
        arguments: { siteId, dataset: 'groups' },
      });
      const obj = JSON.parse(r.content[0].text);
      return obj.records ?? obj.result ?? [];
    };
    const before = await read();
    const hits = before.filter((g) => g.name === GROUP_NAME);
    console.log(`Found ${hits.length} group(s) named ${GROUP_NAME} (total ${before.length}).`);
    if (!hits.length) {
      console.log('Nothing to clean up.');
      return;
    }
    for (const g of hits) {
      console.log(`  - ${g.groupId} (type ${g.type})`);
    }
    if (!apply) {
      console.log('\nDRY RUN: pass --apply to delete them.');
      return;
    }
    for (const g of hits) {
      const res = await client.callTool({
        name: 'deleteGroupProfile',
        arguments: { siteId, confirm: true, type: String(g.type), id: g.groupId },
      });
      if (res.isError) throw new Error(`delete ${g.groupId} failed: ${res.content[0].text}`);
      const ack = JSON.parse(res.content[0].text);
      console.log(`Deleted ${g.groupId}: ${JSON.stringify(ack.controllerAck)}`);
    }
    const after = await read();
    const remaining = after.filter((g) => g.name === GROUP_NAME).length;
    console.log(`Read-back: ${remaining} test group(s) remain; total ${after.length}.`);
    if (remaining !== 0) throw new Error('Cleanup did not remove all test groups.');
    console.log('Cleanup verified.');
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(`Cleanup failed: ${e.message}`);
  process.exitCode = 1;
});
