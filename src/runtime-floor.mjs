/**
 * Runtime floor guard.
 *
 * omada-mcp must not run on a Node.js runtime that is vulnerable to
 * CVE-2026-111497 (Brotli RCE). The floor is declared in-repo in three
 * places that must agree:
 *
 *   - package.json  "engines": { "node": ">=22.23.4" }
 *   - .nvmrc        22.23.4
 *   - .node-version 22.23.4
 *
 * This module is the enforcement point: it fails closed (throws) on an
 * unsupported runtime. There is deliberately no bypass flag and no
 * warn-and-continue path — running an unfixed runtime has to be a
 * deliberate, visible configuration change, never a silent one.
 *
 * Supported lines (patch floors are the first patched releases):
 *   22.x  ->  >= 22.23.4
 *   26.x  ->  >= 26.12.1
 *
 * Majors between those two lines are NOT supported: a bare ">=22.23.4"
 * comparison would numerically admit 23.x/24.x/25.x, which are not
 * patched lines. Unknown future majors are rejected too (fail closed)
 * until their patch floor is added here explicitly.
 */

/** Supported release lines, each with the first patched version. */
export const FLOORS = Object.freeze([
  Object.freeze({ major: 22, minor: 23, patch: 4 }),
  Object.freeze({ major: 26, minor: 12, patch: 1 }),
]);

/** Human-readable requirement, used in error messages and by tests. */
export const REQUIRED_FLOOR = '>=22.23.4 (or >=26.12.1 on the 26.x line)';

/** The advisory this guard exists for. */
export const CVE = 'CVE-2026-111497';

/**
 * Parse a node version string into { major, minor, patch }.
 * Returns null when the string is not a recognisable semver-ish version.
 */
export function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Compare two { major, minor, patch } triples. Returns -1, 0 or 1. */
export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] > b[key]) return 1;
    if (a[key] < b[key]) return -1;
  }
  return 0;
}

/**
 * True when the given version string is on a supported line AND at or above
 * that line's patch floor. Pure: no process state is read or mutated.
 */
export function meetsFloor(version) {
  const parsed = typeof version === 'object' && version !== null ? version : parseVersion(version);
  if (!parsed) return false;
  for (const floor of FLOORS) {
    if (parsed.major !== floor.major) continue;
    return compareVersions(parsed, floor) >= 0;
  }
  return false;
}

/**
 * Assert the running Node.js runtime is at or above a patched floor.
 * Throws on an unsupported runtime; returns silently otherwise.
 *
 * @param {string|{major:number,minor:number,patch:number}} [version]
 *   Version to check. Defaults to process.versions.node.
 * @param {{log?: {error?: Function}}} [options]
 *   Optional logger. It is only ever used to surface the failure; it can
 *   never turn a failure into a pass.
 */
export function assertRuntimeFloor(version = process.versions.node, options = {}) {
  const raw = typeof version === 'string' ? version.trim() : version;
  const parsed = typeof raw === 'object' && raw !== null ? raw : parseVersion(raw);

  if (parsed && meetsFloor(parsed)) return;

  const detected = parsed
    ? `${parsed.major}.${parsed.minor}.${parsed.patch}`
    : String(raw ?? 'unknown');

  const message =
    `Unsupported Node.js runtime ${detected}. omada-mcp requires Node.js ${REQUIRED_FLOOR} ` +
    `to remediate ${CVE} (Brotli RCE). Upgrade Node.js (see .nvmrc / .node-version) and restart.`;

  const logger = options && options.log;
  if (logger && typeof logger.error === 'function') logger.error(message);

  throw new Error(message);
}
