/**
 * Adopted-device status tools (getDevice / getSwitchPorts).
 *
 * The handler logic lives here, separated from the MCP registration in
 * src/index.mjs, so it can be exercised against fixture rows without a live
 * controller — the same pattern the site log tools use.
 *
 * Five properties are enforced here:
 *
 *  1. Fixed paths only. A device detail read goes through the DEVICE_DATASETS
 *     registry and the client's SAFE_ID-validated path builder; a switch-port
 *     read goes through the same registry and is narrowed only by the
 *     controller's own `filters.switchMac`. There is no way for an argument to
 *     become an arbitrary path or filter.
 *
 *  2. No silent emptiness. Every read goes through the client's #read() ->
 *     collectPages() path, which refuses malformed, truncated or repeated
 *     responses, and every failure the tools can detect themselves (unknown
 *     device id, an id that is not a switch, an unadopted device type) throws
 *     a visible error. Neither tool can answer "nothing here" by accident.
 *
 *  3. Device ids are resolved, not trusted. getSwitchPorts looks an id up in
 *     the site's own device list before using it: an id that is not a switch
 *     in this site is an error, and the MAC actually sent to the controller is
 *     the one the controller itself returned — never the caller's spelling.
 *
 *  4. Optional fields stay null. Omada omits keys rather than sending null (an
 *     offline AP reports no uptime or CPU/memory, a non-PoE port reports no
 *     power). src/devices.mjs preserves that distinction so a caller can tell
 *     "not exposed" from "zero".
 *
 *  5. No secrets in output. The result is redacted with the configured
 *     secrets before it leaves this module (the MCP tool wrapper redacts a
 *     second time).
 */
import { z } from 'zod';

import { redact } from './core.mjs';
import { DEVICE_DATASETS, DEVICE_TYPE_DATASETS } from './datasets.mjs';
import {
  DEVICE_ID_PATTERN,
  indexBySwitchPort,
  indexClientsBySwitchPort,
  normalizeDevice,
  normalizeSwitchPort,
  normalizeDeviceId,
  portsEnvelope,
} from './devices.mjs';

export const GET_DEVICE_DESCRIPTION =
  'Read one adopted device (switch, gateway or AP) by its MAC, for one site. Returns ' +
  '{siteId, device} where device is {deviceId, name, type, model, modelName, modelVersion, ' +
  'hardwareVersion, ip, firmwareVersion, firmwareVersionShort, status, statusCode, ' +
  'statusCategory, statusDetail, statusDetailCode, uptimeSeconds, uptime, cpuUtil, memUtil, ' +
  'temperature, sn, lastSeen, portCount}. status is online|offline|unknown; uptime is the ' +
  "controller's own string with uptimeSeconds parsed from it; cpuUtil/memUtil are percentages; " +
  'temperature and portCount are gateway/switch-only and null elsewhere. Fields the controller ' +
  "does not expose for that device (e.g. CPU/memory on an AP) are null, never guessed. An id " +
  'that is not an adopted device in this site, or an invalid id, is a visible error.';

export const GET_SWITCH_PORTS_DESCRIPTION =
  'Read switch port status for a site: link state, negotiated speed, duplex, PoE draw, error ' +
  'and traffic counters, and the clients connected to each port. Optionally restrict to one ' +
  "switch by deviceId (its MAC); an id that is not a switch in this site is a visible error. " +
  'Returns an envelope {siteId, deviceId, portCount, switchCount, switches, ports}; each port is ' +
  '{switchMac, switchName, port, portName, linkUp, linkSpeedCode, linkSpeedMbps, linkSpeed, ' +
  'duplex, duplexCode, poeSupported, poeMode, poeActive, poePowerW, poeVoltage, poeCurrent, ' +
  'poeClass, txBytes, rxBytes, txErrors, rxErrors, stp, clientConnected, clients, clientMac, ' +
  'clientName, clientIp, clientType}. clientConnected is the port link flag and can be true on ' +
  'an uplink carrying another switch, where `clients` (the wired clients on the port) is 0 and ' +
  'the client fields are null. A port whose link-speed code this build cannot corroborate keeps ' +
  'linkSpeedCode and reports linkSpeed/linkSpeedMbps as null rather than guessing a rate. ' +
  'PoE voltage/current/class are only reported for ports the ' +
  'controller exposes PoE telemetry for; elsewhere they are null.';

/** Shared shape of both device tools. */
export const deviceSchema = z
  .object({
    siteId: z.string().min(1),
    deviceId: z
      .string()
      .regex(DEVICE_ID_PATTERN, "Device MAC, e.g. '20-23-51-5E-4A-BA' (alphanumeric, '_' or '-' only).")
      .optional(),
  })
  .strict();

/**
 * Build the tool specifications for the two device tools.
 *
 * `getClient` is invoked lazily inside each handler so the server can start
 * and report a helpful config error per call rather than crashing at module
 * load — the same pattern the log and write tools use.
 */
export function deviceToolSpecs({ getClient, secrets = () => [] }) {
  /** Reject a site the credential cannot see, before any device read. */
  async function requireSite(c, siteId) {
    const sites = await c.listSites();
    if (!sites.some((site) => site.siteId === siteId)) {
      throw new Error('siteId is not in the accessible site list.');
    }
  }

  /**
   * Resolve a device id against the site's own device list.
   *
   * Matching is case-insensitive and the controller's own spelling of the MAC
   * is what is returned, so the value later sent back to the controller is one
   * the controller itself produced. An unknown id produces an error naming a
   * few valid ids, so a typo is diagnosable without a second tool call.
   */
  async function findDevice(c, siteId, deviceId) {
    const normalized = normalizeDeviceId(deviceId);
    const devices = await c.listDevices(siteId);
    const match = devices.find((device) => String(device.mac ?? '').toUpperCase() === normalized);
    if (match) return match;

    const sample = devices.slice(0, 5).map((device) => device.mac).join(', ');
    throw new Error(
      `Unknown deviceId '${deviceId}': no adopted device with that MAC in this site. ` +
        `Adopted devices: ${sample || 'none'}.`,
    );
  }

  return [
    {
      name: 'getDevice',
      description: GET_DEVICE_DESCRIPTION,
      schema: deviceSchema,
      handler: async ({ siteId, deviceId }) => {
        if (!deviceId) {
          throw new Error('getDevice requires deviceId (the device MAC, e.g. 20-23-51-5E-4A-BA).');
        }
        // Validate the identifier before any controller call: a malformed id
        // is a caller error, and diagnosing it must not cost a round trip.
        const normalized = normalizeDeviceId(deviceId);
        const c = getClient();
        await requireSite(c, siteId);
        const row = await findDevice(c, siteId, normalized);

        const kind = DEVICE_TYPE_DATASETS[row.type];
        if (!kind) {
          throw new Error(
            `Device '${row.mac}' has unsupported type '${row.type}'; ` +
              `only ${Object.keys(DEVICE_TYPE_DATASETS).join(', ')} have a detail endpoint.`,
          );
        }

        const detail = await c.readDeviceDetail(siteId, kind, row.mac);
        return redact({ siteId, device: normalizeDevice({ row, detail: detail.result ?? {} }) }, secrets());
      },
    },
    {
      name: 'getSwitchPorts',
      description: GET_SWITCH_PORTS_DESCRIPTION,
      schema: deviceSchema,
      handler: async ({ siteId, deviceId }) => {
        // Validate the identifier before any controller call, then check the
        // site, then resolve the id against the site's own device list: a
        // malformed id is a caller error and must not cost a round trip, while
        // a well-formed but unknown one is diagnosed against the real list.
        const normalized = deviceId === undefined || deviceId === null ? null : normalizeDeviceId(deviceId);
        const c = getClient();
        await requireSite(c, siteId);

        // Narrow server-side only after the id has been resolved against the
        // site's own device list: a switch MAC the controller returned is the
        // only value that ever reaches the `filters.switchMac` query.
        let switchMac;
        if (normalized !== null) {
          const row = await findDevice(c, siteId, normalized);
          if (row.type !== 'switch') {
            throw new Error(
              `Device '${row.mac}' is a ${row.type}, not a switch; getSwitchPorts only reads switch ports.`,
            );
          }
          switchMac = row.mac;
        }

        const [counters, poe, clients] = await Promise.all([
          c.readSwitchPortDataset(siteId, 'switchPorts', { switchMac }),
          c.readSwitchPortDataset(siteId, 'switchPortPoe', { switchMac }),
          c.listClients(siteId),
        ]);

        const poeByKey = indexBySwitchPort(poe.records);
        const clientsByKey = indexClientsBySwitchPort(clients.filter((client) => client.wireless === false));

        const ports = counters.records.map((row) =>
          normalizeSwitchPort({
            countersRow: row,
            poeRow: poeByKey.get(`${row.switchMac}#${row.port}`) ?? null,
            clientRows: clientsByKey.get(`${row.switchMac}#${row.port}`) ?? [],
          }),
        );

        return redact(
          portsEnvelope({ siteId, deviceId: switchMac ?? null, ports }),
          secrets(),
        );
      },
    },
  ];
}
