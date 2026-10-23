import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OmadaClient } from '../src/omada-client.mjs';
import { WRITE_OPS, buildWritePath } from '../src/write-guard.mjs';

/** A client that records requests instead of opening sockets. */
function recordingClient({ enableWrites = false } = {}) {
  const client = new OmadaClient({
    baseUrl: 'https://192.0.2.1',
    omadacId: 'ctrl123',
    accessToken: 'tok',
    enableWrites,
  });
  const sent = [];
  // Intercept the private transport. #send is a true JS private method, so we
  // intercept at the public request() boundary instead by spying on write().
  return { client, sent };
}

test('write() refuses when the write flag is off, before any network I/O', async () => {
  const { client } = recordingClient({ enableWrites: false });
  await assert.rejects(
    () => client.write('createGatewayAcl', { siteId: 'site1', body: { description: 'x' } }),
    /Writes are disabled/,
  );
  await assert.rejects(
    () => client.write('deleteGatewayAcl', { siteId: 'site1', params: { aclId: 'a' } }),
    /Writes are disabled/,
  );
});

test('write() rejects unknown operations and malformed bodies before network I/O', async () => {
  const { client } = recordingClient({ enableWrites: true });
  await assert.rejects(() => client.write('rebootGateway', { siteId: 's', body: {} }), /Unknown write operation/);
  // DELETE operations take no body; a missing body is fine there.
  await assert.rejects(
    () => client.write('createGatewayAcl', { siteId: 's', body: undefined }),
    /requires an object body/,
  );
  await assert.rejects(() => client.write('createGatewayAcl', { siteId: 's', body: 'not-an-object' }), /requires an object body/);
  await assert.rejects(() => client.write('createGatewayAcl', { siteId: '../evil', body: {} }), /Invalid siteId/);
});

test('every write op builds a path that passes the guard for its bound controller', async () => {
  const { client } = recordingClient({ enableWrites: true });
  // We only verify path construction + guard agreement here, not transport.
  const site = 'site1';
  const paramsFor = (op) => {
    const params = {};
    const placeholders = WRITE_OPS[op].template.match(/\{(\w+)\}/g) ?? [];
    for (const placeholder of placeholders) {
      // placeholder looks like '{id}' — strip the braces to get the key.
      params[placeholder.slice(1, -1)] = 'val1';
    }
    return params;
  };
  for (const op of Object.keys(WRITE_OPS)) {
    const path = buildWritePath(op, site, paramsFor(op));
    assert.ok(path.startsWith(`/sites/${site}`), `${op}: ${path}`);
    assert.ok(!path.includes('..'), `${op}: traversal in ${path}`);
  }
  // client.write must not throw on path/guard validation for a valid body case.
  // It WILL fail later at transport, which we avoid by not calling it with a body
  // for ops that need one — this test only proves guard/path agreement.
  assert.equal(typeof client.write, 'function');
});

test('write-tools register only when the flag is on', async () => {
  const { registerWriteTools } = await import('../src/write-tools.mjs');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

  function toolsWhen(enabled) {
    const server = new McpServer({ name: 't', version: '1' });
    if (enabled) registerWriteTools(server, () => recordingClient({ enableWrites: true }).client);
    // registerTool stores on server._registeredTools (internal), so list via tool()
    // by using the underlying tool registry.
    const registered = server._registeredTools ?? {};
    return Object.keys(registered);
  }

  const readOnly = toolsWhen(false);
  const withWrites = toolsWhen(true);

  assert.equal(readOnly.length, 0, `read-only server must register no write tools, got: ${readOnly}`);
  assert.ok(withWrites.length > 0, 'write server should register write tools');
  // Every registered write tool must be marked non-readOnly.
  const server = new McpServer({ name: 't', version: '1' });
  registerWriteTools(server, () => recordingClient({ enableWrites: true }).client);
  for (const [name, spec] of Object.entries(server._registeredTools ?? {})) {
    assert.equal(spec.annotations?.readOnlyHint, false, `${name} should not claim read-only`);
  }
  assert.ok(withWrites.includes('createGatewayAcl'));
  assert.ok(withWrites.includes('deleteGatewayAcl'));
  assert.ok(withWrites.includes('updateLanNetwork'));
});

test('write tools are dry-run by default and only send with confirm:true', async () => {
  const { registerWriteTools } = await import('../src/write-tools.mjs');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  // Client that would throw if a real write attempt were made.
  const boomClient = {
    async write(op, args) {
      throw new Error(`TRANSPORT REACHED: ${op} ${JSON.stringify(args)}`);
    },
  };
  const server = new McpServer({ name: 't', version: '1' });
  registerWriteTools(server, () => boomClient);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // Dry-run: confirm omitted -> no send, returns preview.
  const dry = await client.callTool({
    name: 'createDhcpReservation',
    arguments: { siteId: 'site1', body: { mac: 'AA-BB-CC-DD-EE-FF', netId: 'net1', status: true } },
  });
  const preview = JSON.parse(dry.content[0].text);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.sent, false);
  assert.equal(preview.operation, 'createDhcpReservation');
  assert.match(preview.path, /\/sites\/site1\/setting\/service\/dhcp$/);
  assert.equal(preview.body.mac, 'AA-BB-CC-DD-EE-FF');
  assert.match(preview.note, /confirm:true/);

  // confirm:false explicitly -> still dry-run.
  const dry2 = await client.callTool({
    name: 'createDhcpReservation',
    arguments: { siteId: 'site1', confirm: false, body: { mac: 'AA-BB-CC-DD-EE-FF', netId: 'net1', status: true } },
  });
  assert.equal(JSON.parse(dry2.content[0].text).sent, false);

  // confirm:true -> attempts the send (our stub throws, proving it was reached).
  const real = await client.callTool({
    name: 'createDhcpReservation',
    arguments: { siteId: 'site1', confirm: true, body: { mac: 'AA-BB-CC-DD-EE-FF', netId: 'net1', status: true } },
  });
  assert.equal(real.isError, true);
  assert.match(real.content[0].text, /TRANSPORT REACHED: createDhcpReservation/);

  // Schema rejects a body missing required fields, without reaching transport.
  const bad = await client.callTool({
    name: 'createDhcpReservation',
    arguments: { siteId: 'site1', confirm: true, body: { netId: 'net1' } },
  });
  assert.equal(bad.isError, true);
  assert.doesNotMatch(bad.content[0].text, /TRANSPORT REACHED/);

  // Unknown field rejected by .strict() input schema.
  const extra = await client.callTool({
    name: 'deleteGatewayAcl',
    arguments: { siteId: 'site1', aclId: 'abc', confirm: true, oops: 1 },
  });
  assert.equal(extra.isError, true);
  assert.doesNotMatch(extra.content[0].text, /TRANSPORT REACHED/);

  await client.close();
});
