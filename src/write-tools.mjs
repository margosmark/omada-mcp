import { z } from 'zod';

import { WRITE_OPS, buildWritePath } from './write-guard.mjs';

/**
 * Write tool registration.
 *
 * Every write tool defaults to a dry-run: it validates and returns the exact
 * request without sending it. The call is only dispatched when the caller passes
 * confirm:true. Combined with OMADA_ENABLE_WRITES=true gating registration, that
 * gives two independent gates before any mutation reaches the controller.
 *
 * Body schemas require the fields Omada's own Open API marks required, and are
 * loose beyond that so Omada remains the final validator of optional fields.
 */

const bool = z.boolean();
const int = z.number().int();
const id = z.string().min(1);
const strList = z.array(z.string().min(1));
const intList = z.array(int);

const directionSchema = z
  .object({
    lanToLan: bool.optional(),
    lanToWan: bool.optional(),
    wanInIds: strList.optional(),
    vpnInIds: strList.optional(),
  })
  .loose();

// Required fields mirror the Open API request schemas.
const aclBody = z
  .object({
    description: z.string().min(1),
    status: bool,
    policy: int,
    protocols: intList,
    sourceType: int,
    sourceIds: strList,
    destinationType: int,
    destinationIds: strList.optional(),
    direction: directionSchema,
    stateMode: int,
    syslog: bool,
  })
  .loose();

const dhcpBody = z
  .object({
    mac: z.string().min(1),
    netId: id,
    status: bool,
  })
  .loose();

const groupBody = z
  .object({
    name: z.string().min(1),
    type: int,
  })
  .loose();

const portForwardBody = z
  .object({
    name: z.string().min(1),
    status: bool,
    from: int,
    dMZ: bool,
    forwardIp: z.string().min(1),
  })
  .loose();

const mdnsBody = z
  .object({
    name: z.string().min(1),
    status: bool,
    profileIds: strList,
  })
  .loose();

const reorderBody = z
  .object({
    type: z.string().min(1),
    indexes: z.record(z.string(), int),
  })
  .loose();

const lanNetworkBody = z
  .object({
    name: z.string().min(1),
    purpose: int,
    igmpSnoopEnable: bool,
  })
  .loose();

/**
 * One entry per write operation.
 * `params` are path segments (e.g. aclId); `body` is the Omada payload.
 */
const SPECS = [
  { op: 'createGatewayAcl', params: {}, body: aclBody,
    description: 'Create a Gateway ACL rule. Requires Omada-side valid IDs for source/destination.' },
  { op: 'updateGatewayAcl', params: { aclId: id }, body: aclBody,
    description: 'Update an existing Gateway ACL rule by ID.' },
  { op: 'deleteGatewayAcl', params: { aclId: id }, body: null,
    description: 'Delete a Gateway ACL rule by ID.' },
  { op: 'reorderGatewayAcls', params: {}, body: reorderBody,
    description: 'Reorder Gateway ACL rules. indexes maps ruleId -> new 0-based index; type is usually "gateway".' },
  { op: 'createDhcpReservation', params: {}, body: dhcpBody,
    description: 'Create a DHCP reservation (needs netId from getLanNetworks).' },
  { op: 'updateDhcpReservation', params: { mac: id }, body: dhcpBody,
    description: 'Update an existing DHCP reservation by MAC.' },
  { op: 'deleteDhcpReservation', params: { mac: id }, body: null,
    description: 'Delete a DHCP reservation by MAC.' },
  { op: 'createGroupProfile', params: {}, body: groupBody,
    description: 'Create an IP / IP-Port / IPv6 / MAC group profile.' },
  { op: 'updateGroupProfile', params: { type: id, id }, body: groupBody,
    description: 'Update a group profile. Params: type (group type number) and id (groupId).' },
  { op: 'deleteGroupProfile', params: { type: id, id }, body: null,
    description: 'Delete a group profile. Params: type (group type number) and id (groupId).' },
  { op: 'createPortForward', params: {}, body: portForwardBody,
    description: 'Create a port-forwarding (virtual server) rule.' },
  { op: 'updatePortForward', params: { id }, body: portForwardBody,
    description: 'Update an existing port-forwarding rule by ID.' },
  { op: 'deletePortForward', params: { id }, body: null,
    description: 'Delete a port-forwarding rule by ID.' },
  { op: 'createMdnsRule', params: {}, body: mdnsBody,
    description: 'Create an mDNS/Bonjour repeater rule.' },
  { op: 'updateMdnsRule', params: { id }, body: mdnsBody,
    description: 'Update an existing mDNS rule by ID.' },
  { op: 'deleteMdnsRule', params: { id }, body: null,
    description: 'Delete an mDNS rule by ID.' },
  { op: 'updateLanNetwork', params: { id }, body: lanNetworkBody,
    description: 'Update a LAN/VLAN network (v2). Send the full desired object; Omada validates optional fields.' },
];

const confirmSchema = z.boolean().optional().describe(
  'false/omitted = dry-run: validates and returns the request without sending. true = actually send it.',
);

function toolSchema(spec) {
  const shape = { siteId: id, confirm: confirmSchema };
  for (const [key, value] of Object.entries(spec.params)) shape[key] = value;
  if (spec.body) shape.body = spec.body;
  return z.object(shape).strict();
}

/**
 * Register write tools on the server. Only call this when writes are enabled —
 * the caller decides registration, so a read-only server never exposes them.
 *
 * `getClient` is invoked lazily inside each handler so the server can start and
 * report a helpful config error per call, rather than crashing at module load.
 *
 * Returns the names of the tools that were registered, so the caller can
 * report the real tool surface.
 */
export function registerWriteTools(server, getClient) {
  const registered = [];
  for (const spec of SPECS) {
    const method = WRITE_OPS[spec.op].method;
    registered.push(spec.op);
    server.registerTool(
      spec.op,
      {
        description: `[WRITE — dry-run by default; pass confirm:true to send] ${spec.description}`,
        inputSchema: toolSchema(spec),
        annotations: { readOnlyHint: false, destructiveHint: spec.body === null, idempotentHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          const { siteId, confirm = false, body, ...params } = args;
          const path = buildWritePath(spec.op, siteId, params);
          if (!confirm) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  dryRun: true,
                  sent: false,
                  operation: spec.op,
                  method,
                  path,
                  body: body ?? null,
                  note: 'Nothing was sent. Re-send with confirm:true to apply.',
                }, null, 2),
              }],
            };
          }
          const client = getClient();
          const result = await client.write(spec.op, { siteId, params, body });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                sent: true,
                operation: spec.op,
                method,
                path,
                controllerAck: result,
                note: 'controllerAck is the Omada response (errorCode 0 = accepted). Verify with the read tools.',
              }, null, 2),
            }],
          };
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: error.message || 'Write failed.' }] };
        }
      },
    );
  }
  return registered;
}
