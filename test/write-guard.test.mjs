import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  WRITE_OPS,
  assertWriteAllowed,
  buildSitePath,
  buildWritePath,
  isWriteMethod,
  writesEnabled,
} from '../src/write-guard.mjs';

const OMADAC = 'controller123';
const SITE = 'siteABC';

test('writesEnabled defaults to false and only accepts explicit true', () => {
  assert.equal(writesEnabled({}), false);
  assert.equal(writesEnabled({ OMADA_ENABLE_WRITES: '' }), false);
  assert.equal(writesEnabled({ OMADA_ENABLE_WRITES: 'false' }), false);
  assert.equal(writesEnabled({ OMADA_ENABLE_WRITES: '1' }), false);
  assert.equal(writesEnabled({ OMADA_ENABLE_WRITES: 'yes' }), false);
  assert.equal(writesEnabled({ OMADA_ENABLE_WRITES: 'TRUE' }), true);
  assert.equal(writesEnabled({ OMADA_ENABLE_WRITES: ' true ' }), true);
});

test('isWriteMethod covers mutating verbs only', () => {
  for (const verb of ['post', 'POST', 'put', 'PATCH', 'delete']) assert.equal(isWriteMethod(verb), true);
  for (const verb of ['GET', 'get', 'OPTIONS', 'HEAD']) assert.equal(isWriteMethod(verb), false);
});

test('every whitelist entry uses an allowlisted verb and declared version', () => {
  const allowedMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const allowedVersions = new Set(['v1', 'v2']);
  for (const [name, op] of Object.entries(WRITE_OPS)) {
    assert.ok(allowedMethods.has(op.method), `${name}: bad method ${op.method}`);
    assert.ok(allowedVersions.has(op.version), `${name}: bad version ${op.version}`);
    assert.ok(op.template.startsWith('/'), `${name}: template must be absolute`);
    assert.ok(!op.template.includes('..'), `${name}: template must not traverse`);
  }
});

test('ACL delete uses the documented separate path, not the update path', () => {
  // Update is /acls/osg-acls/{aclId}; delete is /acls/{aclId}. A prior bug class is
  // assuming they are the same resource path.
  assert.equal(WRITE_OPS.updateGatewayAcl.template, '/acls/osg-acls/{aclId}');
  assert.equal(WRITE_OPS.deleteGatewayAcl.template, '/acls/{aclId}');
  assert.notEqual(WRITE_OPS.updateGatewayAcl.template, WRITE_OPS.deleteGatewayAcl.template);
  assert.equal(WRITE_OPS.updateGatewayAcl.method, 'PUT');
  assert.equal(WRITE_OPS.deleteGatewayAcl.method, 'DELETE');
});

test('LAN update uses v2 while LAN reads/creates can be v1', () => {
  assert.equal(WRITE_OPS.updateLanNetwork.version, 'v2');
  assert.equal(WRITE_OPS.createPortForward.version, 'v1');
});

test('buildSitePath rejects traversal and non-identifier segments', () => {
  // Valid substitution.
  assert.equal(buildSitePath('/acls/{id}', { id: '6ad9abc123' }), '/acls/6ad9abc123');
  assert.equal(
    buildSitePath('/profiles/groups/{type}/{id}', { type: '0', id: 'grp_1' }),
    '/profiles/groups/0/grp_1',
  );
  // Traversal attempts.
  for (const bad of ['..', '../x', 'a/b', 'a/../b', 'a..b'.replace('..', '..'), '%2e%2e', 'a b']) {
    assert.throws(() => buildSitePath('/acls/{id}', { id: bad }), /Invalid path parameter/, `should reject ${JSON.stringify(bad)}`);
  }
  // Missing param leaves the placeholder -> caught as unresolved.
  assert.throws(() => buildSitePath('/acls/{id}', {}), /Invalid path parameter/);
  // Unknown placeholder name.
  assert.throws(() => buildSitePath('/acls/{nope}', { id: 'x' }), /Invalid path parameter/);
});

test('buildSitePath rejects an injected literal segment', () => {
  // The template itself is fixed, but guard against a future template containing // or ..
  assert.throws(() => buildSitePath('//evil', {}), /unsafe path|Invalid path parameter|Unresolved/);
});

test('buildWritePath validates siteId and composes the full site-relative path', () => {
  assert.equal(
    buildWritePath('createGatewayAcl', SITE),
    `/sites/${SITE}/acls/osg-acls`,
  );
  assert.equal(
    buildWritePath('updateGatewayAcl', SITE, { aclId: 'aaa' }),
    `/sites/${SITE}/acls/osg-acls/aaa`,
  );
  assert.equal(
    buildWritePath('updateLanNetwork', SITE, { id: 'net1' }),
    `/sites/${SITE}/lan-networks/net1`,
  );
  // Traversal in siteId.
  assert.throws(() => buildWritePath('createGatewayAcl', '../evil'), /Invalid siteId/);
  // Traversal in an id param.
  assert.throws(() => buildWritePath('updateGatewayAcl', SITE, { aclId: '../x' }), /Invalid path parameter/);
  // Unknown operation refused.
  assert.throws(() => buildWritePath('rebootEverything', SITE), /Unknown write operation/);
});

test('assertWriteAllowed permits only matching verb+path+version', () => {
  const url = (v, site, path) => `/openapi/${v}/${OMADAC}/sites/${site}${path}`;

  // Allowed cases.
  assert.doesNotThrow(() => assertWriteAllowed('POST', url('v1', SITE, '/acls/osg-acls'), OMADAC));
  assert.doesNotThrow(() => assertWriteAllowed('PUT', url('v1', SITE, '/acls/osg-acls/abc'), OMADAC));
  assert.doesNotThrow(() => assertWriteAllowed('DELETE', url('v1', SITE, '/acls/abc'), OMADAC));
  assert.doesNotThrow(() => assertWriteAllowed('POST', url('v1', SITE, '/acls/modifyIndex'), OMADAC));
  assert.doesNotThrow(() => assertWriteAllowed('PATCH', url('v2', SITE, '/lan-networks/n1'), OMADAC));

  // Wrong verb for an allowed path.
  assert.throws(() => assertWriteAllowed('DELETE', url('v1', SITE, '/acls/osg-acls/abc'), OMADAC), /not an allowlisted/);
  assert.throws(() => assertWriteAllowed('PUT', url('v1', SITE, '/acls/abc'), OMADAC), /not an allowlisted/);
  // Wrong version for a version-specific op.
  assert.throws(() => assertWriteAllowed('PATCH', url('v1', SITE, '/lan-networks/n1'), OMADAC), /not an allowlisted/);
  assert.throws(() => assertWriteAllowed('POST', url('v2', SITE, '/acls/osg-acls'), OMADAC), /not an allowlisted/);
  // Reads are not this function's concern (handled by assertReadOnly).
  assert.doesNotThrow(() => assertWriteAllowed('GET', url('v1', SITE, '/acls/osg-acls'), OMADAC));
});

test('assertWriteAllowed rejects paths outside the bound controller', () => {
  const other = `/openapi/v1/other-controller/sites/${SITE}/acls/osg-acls`;
  assert.throws(() => assertWriteAllowed('POST', other, OMADAC), /does not match this controller/);
  assert.throws(
    () => assertWriteAllowed('POST', `/openapi/v1/${OMADAC}/../../etc/passwd`, OMADAC),
    /unsafe write path|does not match/,
  );
  // A path claiming another origin (no '//' so it reaches the controller check).
  assert.throws(
    () => assertWriteAllowed('POST', `evil.example/openapi/v1/${OMADAC}/sites/${SITE}/acls/osg-acls`, OMADAC),
    /does not match this controller/,
  );
});

test('assertWriteAllowed blocks endpoints not in the whitelist', () => {
  const base = `/openapi/v1/${OMADAC}/sites/${SITE}`;
  for (const [method, path] of [
    ['POST', '/cmd/gateways/x/reboot'],
    ['DELETE', '/lan-networks/n1'], // v1 delete exists in API but is NOT allowlisted
    ['POST', '/setting/service/dhcp/aa/export'],
    ['PUT', '/acls/modifyIndex'],
    ['POST', '/internet'],
    ['DELETE', '/clients/aa'],
  ]) {
    assert.throws(
      () => assertWriteAllowed(method, `${base}${path}`, OMADAC),
      /not an allowlisted/,
      `should block ${method} ${path}`,
    );
  }
});
