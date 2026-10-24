import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertRuntimeFloor, compareVersions, meetsFloor, parseVersion, CVE } from '../src/runtime-floor.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const ACCEPTED = ['22.23.4', '26.12.1'];
const REJECTED = [
  '22.23.3', // Hermes' bundled node before the spawn-binary swap
  '22.22.0',
  '20.19.0', // proves the old ">=20" engines floor was too low
  '26.12.0',
  '26.7.0', // the other bundled node we are avoiding
  '24.5.0', // major between the two supported lines must not pass
  '23.1.0',
];

test('meetsFloor accepts the patched floors', () => {
  for (const version of ACCEPTED) {
    assert.equal(meetsFloor(version), true, `${version} should be accepted`);
  }
});

test('meetsFloor rejects unpatched and unsupported runtimes', () => {
  for (const version of REJECTED) {
    assert.equal(meetsFloor(version), false, `${version} should be rejected`);
  }
});

test('meetsFloor does not accept a bare major as a floor', () => {
  // "any 22+" and "any 26+" are the bug being fixed: 22.0.0 and 26.0.0 are
  // numerically above 22.23.4's minor but not patched.
  assert.equal(meetsFloor('22.0.0'), false);
  assert.equal(meetsFloor('26.0.0'), false);
});

test('parseVersion reads major/minor/patch and rejects garbage', () => {
  assert.deepEqual(parseVersion('22.23.4'), { major: 22, minor: 23, patch: 4 });
  assert.deepEqual(parseVersion('v26.12.1'), { major: 26, minor: 12, patch: 1 });
  assert.equal(parseVersion('not-a-version'), null);
  assert.equal(parseVersion(undefined), null);
});

test('compareVersions orders versions', () => {
  assert.equal(compareVersions({ major: 22, minor: 23, patch: 4 }, { major: 22, minor: 23, patch: 4 }), 0);
  assert.equal(compareVersions({ major: 26, minor: 12, patch: 1 }, { major: 22, minor: 23, patch: 4 }), 1);
  assert.equal(compareVersions({ major: 22, minor: 23, patch: 3 }, { major: 22, minor: 23, patch: 4 }), -1);
});

test('assertRuntimeFloor returns silently on a supported runtime', () => {
  for (const version of ACCEPTED) {
    assert.doesNotThrow(() => assertRuntimeFloor(version));
  }
});

test('assertRuntimeFloor throws on an unsupported runtime', () => {
  for (const version of REJECTED) {
    assert.throws(() => assertRuntimeFloor(version), /Unsupported Node\.js runtime/);
  }
});

test('the thrown error names the CVE and the detected version', () => {
  assert.throws(
    () => assertRuntimeFloor('22.23.3'),
    (error) => {
      assert.match(error.message, /CVE-2026-111497/);
      assert.match(error.message, /22\.23\.3/);
      assert.match(error.message, />=22\.23\.4/);
      assert.match(error.message, /26\.12\.1/);
      return true;
    },
  );
});

test('assertRuntimeFloor fails closed on the live process runtime', () => {
  // No bypass flag exists: the guard either passes or throws.
  assert.doesNotThrow(() => assertRuntimeFloor());
  assert.equal(typeof process.versions.node, 'string');
});

test('package.json declares the node floor as >=22.23.4', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.engines?.node, '>=22.23.4');
});

test('.nvmrc and .node-version exist, agree, and satisfy the floor', () => {
  const nvmrc = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  const nodeVersion = readFileSync(join(root, '.node-version'), 'utf8').trim();

  assert.notEqual(nvmrc, '');
  assert.notEqual(nodeVersion, '');
  assert.equal(nvmrc, nodeVersion, '.nvmrc and .node-version must pin the same version');
  assert.equal(meetsFloor(nvmrc), true, `${nvmrc} must satisfy the runtime floor`);
});

test('src/index.mjs imports and calls assertRuntimeFloor', () => {
  const source = readFileSync(join(root, 'src', 'index.mjs'), 'utf8');
  assert.match(source, /import\s*\{[^}]*assertRuntimeFloor[^}]*\}\s*from\s*'\.\/runtime-floor\.mjs'/);
  assert.match(source, /assertRuntimeFloor\s*\(/);
});

test('the guard module names the advisory it enforces', () => {
  assert.equal(CVE, 'CVE-2026-111497');
});
