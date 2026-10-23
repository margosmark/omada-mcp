/**
 * Write-operation allowlist and path safety.
 *
 * Two independent gates control writes:
 *   1. OMADA_ENABLE_WRITES=true — without this the MCP never registers write tools.
 *   2. confirm:true on each call — without it a call is a dry-run preview only.
 *
 * Even when both gates are open, only the operations listed in WRITE_OPS are
 * reachable, and every dynamic path segment is validated against a strict
 * character class so an identifier can never traverse out of its path segment.
 */

/** Path identifiers: hex IDs, MAC-style values, numeric group types. No '.', '/', or '..'. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Every write Omada exposes in the reviewed scope.
 * `template` is site-relative: everything after /sites/{siteId}/.
 * Verbs/paths verified against the Open API reference (e.g. ACL delete is at
 * /acls/{aclId}, not /acls/osg-acls/{aclId}).
 */
export const WRITE_OPS = {
  createGatewayAcl: { method: 'POST', template: '/acls/osg-acls', version: 'v1' },
  // {aclId} (not {id}) so the tool input name and template agree.
  updateGatewayAcl: { method: 'PUT', template: '/acls/osg-acls/{aclId}', version: 'v1' },
  deleteGatewayAcl: { method: 'DELETE', template: '/acls/{aclId}', version: 'v1' },
  reorderGatewayAcls: { method: 'POST', template: '/acls/modifyIndex', version: 'v1' },
  createDhcpReservation: { method: 'POST', template: '/setting/service/dhcp', version: 'v1' },
  updateDhcpReservation: { method: 'PATCH', template: '/setting/service/dhcp/{mac}', version: 'v1' },
  deleteDhcpReservation: { method: 'DELETE', template: '/setting/service/dhcp/{mac}', version: 'v1' },
  createGroupProfile: { method: 'POST', template: '/profiles/groups', version: 'v1' },
  updateGroupProfile: { method: 'PATCH', template: '/profiles/groups/{type}/{id}', version: 'v1' },
  deleteGroupProfile: { method: 'DELETE', template: '/profiles/groups/{type}/{id}', version: 'v1' },
  createPortForward: { method: 'POST', template: '/nat/port-forwardings', version: 'v1' },
  updatePortForward: { method: 'PUT', template: '/nat/port-forwardings/{id}', version: 'v1' },
  deletePortForward: { method: 'DELETE', template: '/nat/port-forwardings/{id}', version: 'v1' },
  createMdnsRule: { method: 'POST', template: '/setting/service/mdns', version: 'v1' },
  updateMdnsRule: { method: 'PATCH', template: '/setting/service/mdns/{id}', version: 'v1' },
  deleteMdnsRule: { method: 'DELETE', template: '/setting/service/mdns/{id}', version: 'v1' },
  // v2 required for LAN updates; v1 PATCH exists but v2 matches current controllers.
  updateLanNetwork: { method: 'PATCH', template: '/lan-networks/{id}', version: 'v2' },
};

/** True when this HTTP method can mutate configuration. */
export function isWriteMethod(method) {
  const m = String(method).toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

/** Reads are always permitted; writes only when the operator opted in. */
export function writesEnabled(env = process.env) {
  return String(env.OMADA_ENABLE_WRITES ?? '').trim().toLowerCase() === 'true';
}

function assertSafeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error(`Invalid ${name}: must be alphanumeric, '_' or '-' only (got ${JSON.stringify(value)}).`);
  }
  return value;
}

const regexCache = new Map();
function templateRegex(template) {
  let cached = regexCache.get(template);
  if (cached) return cached;
  const parts = template.split(/(\{\w+\})/g);
  let source = '^';
  for (const part of parts) {
    if (/^\{\w+\}$/.test(part)) source += '[A-Za-z0-9_-]+';
    else source += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  cached = new RegExp(`${source}$`);
  regexCache.set(template, cached);
  return cached;
}

/** Substitute a site-relative template, validating every dynamic segment. */
export function buildSitePath(template, params = {}) {
  const resolved = template.replace(/\{(\w+)\}/g, (_, key) => assertSafeId(params[key], `path parameter '${key}'`));
  if (/\{|\}/.test(resolved)) throw new Error(`Unresolved path template: ${template}`);
  if (resolved.includes('//') || /(^|\/)\.\.(\/|$)/.test(resolved)) {
    throw new Error(`Refusing unsafe path: ${resolved}`);
  }
  return resolved;
}

/** Build a full write path for an allowlisted operation. */
export function buildWritePath(opName, siteId, params = {}) {
  const op = WRITE_OPS[opName];
  if (!op) throw new Error(`Unknown write operation: ${opName}`);
  assertSafeId(siteId, 'siteId');
  return `/sites/${siteId}${buildSitePath(op.template, params)}`;
}

/**
 * Defence in depth: verify a fully-built write request corresponds to exactly one
 * allowlisted operation. Called by the client on every mutating request, so a
 * direct client.request('DELETE', ...) cannot reach an unexpected endpoint.
 *
 * @param {string} method  HTTP method
 * @param {string} fullPath path including /openapi/{version}/{omadacId}
 * @param {string} omadacId controller id the client is bound to
 */
export function assertWriteAllowed(method, fullPath, omadacId) {
  const m = String(method).toUpperCase();
  if (!isWriteMethod(m)) return; // reads handled elsewhere

  if (fullPath.includes('//') || /(^|\/)\.\.(\/|$)/.test(fullPath)) {
    throw new Error(`Refusing unsafe write path: ${fullPath}`);
  }
  const prefix = new RegExp(`^/openapi/(v[12])/${escapeRegex(omadacId)}(/sites/[^/]+)(/.*)$`);
  const match = prefix.exec(fullPath);
  if (!match) {
    throw new Error(`Write path does not match this controller: ${fullPath}`);
  }
  const [, version, , opPath] = match;
  for (const op of Object.values(WRITE_OPS)) {
    if (op.method === m && op.version === version && templateRegex(op.template).test(opPath)) return;
  }
  throw new Error(`Blocked: ${m} ${opPath} (${version}) is not an allowlisted write operation.`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
