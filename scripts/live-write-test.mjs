#!/usr/bin/env node
/**
 * Opt-in live write test against a REAL Omada controller.
 *
 * Creates a throwaway IP Group, reads it back, deletes it, then verifies the
 * group list is byte-for-byte restored. This is the only way to prove the write
 * path works end to end (payload accepted by Omada, delete path correct,
 * read-back consistent) — unit tests stub the transport.
 *
 * It is NOT part of `npm test`: it mutates a live controller and must never run
 * in CI. It requires every gate the server enforces plus an explicit --apply:
 *
 *   OMADA_ENABLE_WRITES=true  (server-side registration gate)
 *   --apply                   (explicit human intent; without it, dry-run only)
 *
 * Usage:
 *   OMADA_CONFIG=... OMADA_PEM=... OMADA_CREDENTIALS=... \
 *   node scripts/live-write-test.mjs <siteId> [--apply]
 *
 * Env may point at existing files (recommended) so no secret is duplicated:
 *   OMADA_CONFIG       controller.json path
 *   OMADA_PEM          controller.pem path
 *   OMADA_CREDENTIALS  credentials JSON path ({clientId, clientSecret})
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  console.error('Usage: node scripts/live-write-test.mjs <siteId> [--apply]');
  process.exit(2);
}
if (!process.env.OMADA_ENABLE_WRITES || process.env.OMADA_ENABLE_WRITES.toLowerCase() !== 'true') {
  console.error('Refusing: OMADA_ENABLE_WRITES must be set to true for a live write test.');
  process.exit(2);
}
for (const key of ['OMADA_CONFIG', 'OMADA_PEM', 'OMADA_CREDENTIALS']) {
  if (!process.env[key]) {
    console.error(`Refusing: ${key} must point at an existing file.`);
    process.exit(2);
  }
}

// A fresh, unlikely-to-collide name. RFC 5737 TEST-NET-1 address (192.0.2.0/24)
// is documentation-only, so it can never match a real host.
const GROUP_NAME = 'ZZ_MCP_LIVE_WRITE_TEST';
const TEST_IP = { ip: '192.0.2.1', mask: 32 };

function canonical(obj) {
  // Stable stringification so ordering differences don't fake a change.
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  if (obj && typeof obj === 'object') {
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(obj);
}

function groupsFrom(result) {
  if (result?.records) return result.records;
  if (Array.isArray(result?.result)) return result.result;
  throw new Error(`Unexpected groups payload: ${JSON.stringify(result).slice(0, 200)}`);
}

function planOf(groups) {
  // Everything except our test group, keyed by groupId — used to prove the
  // test did not disturb any pre-existing group.
  return new Map(
    groups.filter((g) => g.name !== GROUP_NAME).map((g) => [g.groupId, canonical(g)]),
  );
}

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const env = {
    ...process.env,
    OMADA_ENABLE_WRITES: 'true',
    OMADA_CONFIG: process.env.OMADA_CONFIG,
    OMADA_PEM: process.env.OMADA_PEM,
    OMADA_CREDENTIALS: process.env.OMADA_CREDENTIALS,
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'src/index.mjs')],
    env,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(`  [server] ${text}`);
  });

  const client = new Client({ name: 'live-write-test', version: '1.0.0' });
  const readGroups = async () => groupsFrom(
    JSON.parse((await client.callTool({
      name: 'readSiteConfiguration',
      arguments: { siteId, dataset: 'groups' },
    })).content[0].text),
  );
  // Always surface isError payloads as failures instead of crashing on JSON.parse.
  const callWrite = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.[0]?.text ?? '';
    if (result.isError) throw new Error(`${name} errored: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${name} returned non-JSON: ${text.slice(0, 300)}`);
    }
  };

  try {
    await client.connect(transport);

    console.log(`\nLive write test — site ${siteId}${apply ? '' : ' (DRY RUN: no writes)'}`);

    // 1. Baseline.
    const before = await readGroups();
    const beforePlan = planOf(before);
    const collision = before.some((g) => g.name === GROUP_NAME);
    console.log(`\n[1] Baseline: ${before.length} groups; collision=${collision}`);
    check('no pre-existing group with our test name', !collision);
    const ipGroups = before.filter((g) => g.type === 0).length;
    console.log(`    IP Groups (type 0): ${ipGroups}`);

    if (collision) throw new Error('Test group name already exists; refusing to touch it.');

    // 2. Preview — ALWAYS dry-run (confirm:false), regardless of --apply.
    console.log('\n[2] createGroupProfile — preview (dry-run, confirm:false)');
    const previewObj = await callWrite('createGroupProfile', {
      siteId, confirm: false,
      body: { name: GROUP_NAME, type: 0, ipList: [TEST_IP] },
    });
    console.log(`    ${JSON.stringify({ dryRun: previewObj.dryRun, sent: previewObj.sent, path: previewObj.path })}`);
    check('dry-run reports sent=false', previewObj.sent === false, JSON.stringify(previewObj));
    check('dry-run path is the group endpoint', previewObj.path === `/sites/${siteId}/profiles/groups`);

    if (!apply) {
      console.log('\nDRY RUN complete — nothing was sent. Re-run with --apply to perform the live test.');
      console.log(`Result: ${passed} passed, ${failed} failed`);
      process.exitCode = failed ? 1 : 0;
      return;
    }

    // 3. Create for real.
    console.log('\n[3] createGroupProfile — apply (confirm:true)');
    const createObj = await callWrite('createGroupProfile', {
      siteId, confirm: true,
      body: { name: GROUP_NAME, type: 0, ipList: [TEST_IP] },
    });
    check('controller acknowledged create (sent=true)', createObj.sent === true, JSON.stringify(createObj));
    check('create returned an Omada ack object', createObj.controllerAck && typeof createObj.controllerAck === 'object');

    // 4. Read back and verify exact contents.
    console.log('\n[4] read back after create');
    const afterCreate = await readGroups();
    const matches = afterCreate.filter((g) => g.name === GROUP_NAME);
    check('exactly one group with our name', matches.length === 1, `found ${matches.length}`);
    const createdGroup = matches[0];
    if (createdGroup) {
      check('created group is type 0 (IP Group)', createdGroup.type === 0, `type=${createdGroup.type}`);
      check('created group has our exact IP', canonical(createdGroup.ipList ?? []) === canonical([TEST_IP]),
        JSON.stringify(createdGroup.ipList));
      check('created group has a real groupId', typeof createdGroup.groupId === 'string' && createdGroup.groupId.length > 0);
    }
    check('total group count increased by one', afterCreate.length === before.length + 1,
      `${before.length} -> ${afterCreate.length}`);
    check('every pre-existing group unchanged after create',
      canonical(planOf(afterCreate)) === canonical(beforePlan));

    if (!createdGroup) throw new Error('Create did not yield a verifiable group; stopping before delete.');

    // 5. Delete it.
    console.log('\n[5] deleteGroupProfile — apply (confirm:true)');
    const deleteObj = await callWrite('deleteGroupProfile', {
      siteId, confirm: true,
      type: String(createdGroup.type),
      id: createdGroup.groupId,
    });
    check('controller acknowledged delete (sent=true)', deleteObj.sent === true, JSON.stringify(deleteObj));
    check('delete path used group type + id',
      deleteObj.path === `/sites/${siteId}/profiles/groups/${createdGroup.type}/${createdGroup.groupId}`,
      deleteObj.path);

    // 6. Read back and verify full restoration.
    console.log('\n[6] read back after delete');
    const afterDelete = await readGroups();
    check('test group is gone', afterDelete.filter((g) => g.name === GROUP_NAME).length === 0);
    check('total group count restored', afterDelete.length === before.length,
      `${before.length} -> ${afterDelete.length}`);
    check('every pre-existing group byte-identical after delete',
      canonical(planOf(afterDelete)) === canonical(beforePlan));
    const finalIpGroups = afterDelete.filter((g) => g.type === 0).length;
    check('IP Group count restored', finalIpGroups === ipGroups, `${ipGroups} -> ${finalIpGroups}`);
  } finally {
    await client.close().catch(() => {});
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(`\nLive write test aborted: ${error.message}`);
  console.error('If a group was created but not deleted, remove it manually in Omada (Profiles > Groups).');
  process.exitCode = 1;
});
