/**
 * Pure normalizers for the adopted-device tools (getDevice / getSwitchPorts).
 *
 * Everything here is a function of controller rows alone — no client, no
 * network — so the mapping from Omada's wire shape to the tool's output can be
 * tested against the exact JSON the controller returns.
 *
 * Two rules hold throughout:
 *
 *  1. A missing optional field becomes null, never a guessed default. Omada
 *     omits keys rather than sending null (an offline AP has no uptime, a
 *     non-PoE port has no power reading), and a caller must be able to tell
 *     "not exposed" from "zero".
 *
 *  2. Numeric controller enums keep their raw code next to any label, and a
 *     label is only emitted for codes observed live against this controller.
 */

/**
 * Device identifiers accepted by both tools.
 *
 * Omada identifies devices by MAC, which the controller renders uppercase and
 * dashed (`20-23-51-5E-4A-BA`) — dashes and alphanumerics only, so the
 * SAFE_ID character class used by the write paths covers it exactly. Callers
 * may send any case; matching is case-insensitive and the controller's own
 * spelling is what is echoed back.
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validate a device identifier and return it in the controller's spelling.
 *
 * `name` is only used in the error message. The character class is exactly the
 * SAFE_ID rule src/write-guard.mjs applies to path parameters, so the same
 * value is safe whether it lands in a path segment (the detail read) or in a
 * query filter (the switch-port read); test/device-tools.test.mjs asserts the
 * two rules agree.
 */
export function assertDeviceId(value, name = 'deviceId') {
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${name}: expected a device MAC such as '20-23-51-5E-4A-BA' ` +
        `(alphanumeric, '_' or '-' only), got ${JSON.stringify(value)}.`,
    );
  }
  return value.toUpperCase();
}

/** Normalize a caller-supplied device id to the controller's spelling. */
export function normalizeDeviceId(value) {
  return assertDeviceId(value, 'deviceId');
}

/**
 * Port link-speed code -> Mbps, as reported in `portStatus.linkSpeed`.
 *
 * Only the codes corroborated on the live controller are mapped:
 *
 *   0  Auto       — seen only on down ports, never a negotiated rate
 *   1  10 Mbps    — idle gigabit ports
 *   2  100 Mbps   — a client that negotiated 100M
 *   3  1 Gbps     — gigabit links on every switch model present
 *
 * Code 5 is deliberately left unmapped. It is reported on the SG3428X's
 * uplink-class ports, and the controller's own data does not settle what it
 * means: port 28's LLDP neighbour is the gateway's 10G SFP+ port (whose
 * `portConfigs` carry the raw figure 10000 Mbps), which would make 5 = 10G,
 * but port 27's neighbour is an SG2008 — a 1G-only switch — and that switch
 * reports the very same link as code 3. Two ends of one link disagreeing is a
 * reason to withhold the claim, not to pick the flattering one. Such a port
 * keeps its raw `linkSpeedCode` and gets null `linkSpeedMbps`/`linkSpeed`.
 * Widen this map only with evidence from a controller that reports
 * consistently at both ends.
 */
export const LINK_SPEEDS = { 1: 10, 2: 100, 3: 1000 };

/** Human label for a link speed in Mbps. */
export function linkSpeedLabel(mbps) {
  if (mbps === null || mbps === undefined) return null;
  return mbps >= 1000 ? `${mbps / 1000} Gbps` : `${mbps} Mbps`;
}

/** Duplex code -> label. 2 = full, 0 = unset (seen only on down ports). */
export function duplexLabel(code) {
  if (code === 2) return 'full';
  if (code === 1) return 'half';
  return null;
}

/**
 * Detail-status code -> label.
 *
 * Observed live: 14 (Connected) on every online device and 0 (Disconnected) on
 * an offline AP. No other code has been seen, so anything else keeps its raw
 * code and gets a null label.
 */
export const DETAIL_STATUS = { 0: 'Disconnected', 14: 'Connected' };

/**
 * Parse Omada's uptime strings into seconds.
 *
 * Three shapes appear across the API:
 *   device list row:  "51day(s) 7h 28m 26s"
 *   switch detail:    "20 days 07:05:17"
 *   gateway detail:   "2 days 10:15:42"
 * plus `uptimeLong` (plain seconds) on an online AP's detail row. Returns null
 * when nothing can be parsed, so "no uptime reported" stays distinguishable
 * from a parsed zero.
 */
export function parseUptimeSeconds(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // "51day(s) 7h 28m 26s" — days/hours/minutes/seconds with unit suffixes.
  const compact = /^(\d+)\s*day\(s\)\s+(\d+)h\s+(\d+)m\s+(\d+)s$/i.exec(trimmed);
  if (compact) {
    const [, d, h, m, s] = compact.map(Number);
    return d * 86400 + h * 3600 + m * 60 + s;
  }

  // "2 days 10:15:42" — optional days prefix plus an HH:MM:SS clock.
  const clock = /^(?:(\d+)\s+days?\s+)?(\d{1,2}):(\d{1,2}):(\d{1,2})$/i.exec(trimmed);
  if (clock) {
    const days = Number(clock[1] ?? 0);
    return days * 86400 + Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4]);
  }

  return null;
}

/** Epoch milliseconds -> ISO string; non-numeric input stays null. */
function toIso(value) {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

/** First non-undefined, non-null value among the candidates. */
function coalesce(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

/**
 * Normalize one adopted device into the getDevice record.
 *
 * `row` is the /devices list row (identity, IP, uptime string, CPU/mem) and
 * `detail` the type-specific detail row (/switches/{mac}, /aps/{mac} or
 * /gateways/{mac}). The detail row is preferred where both carry a field: it
 * is the authoritative record for that device type. Fields neither row
 * carries — CPU/memory on an AP detail read, uptime on an offline device —
 * come back as null.
 */
export function normalizeDevice({ row = {}, detail = {} }) {
  const statusCode = typeof row.status === 'number' ? row.status : null;
  const statusCategory = typeof detail.statusCategory === 'number' ? detail.statusCategory : null;
  const statusDetailCode = coalesce(detail.status, row.detailStatus);
  const status = statusFromCodes({ statusCode, statusCategory });
  const uptimeSeconds = coalesce(
    typeof detail.uptimeLong === 'number' ? detail.uptimeLong : undefined,
    parseUptimeSeconds(detail.uptime),
    parseUptimeSeconds(row.uptime),
  );

  return {
    deviceId: coalesce(row.mac, detail.mac),
    name: coalesce(detail.name, row.name),
    type: coalesce(detail.type, row.type),
    model: coalesce(detail.model, detail.showModel, row.model, row.modelName),
    modelName: coalesce(row.modelName, detail.showModel, detail.model),
    modelVersion: coalesce(row.modelVersion, detail.hwVersion),
    hardwareVersion: coalesce(detail.hwVersion, row.modelVersion),
    ip: coalesce(detail.ip, row.ip),
    firmwareVersion: coalesce(detail.firmwareVersion, row.firmwareVersion),
    firmwareVersionShort: coalesce(detail.version),
    status,
    statusCode,
    statusCategory: typeof statusCategory === 'number' ? statusCategory : null,
    statusDetail: DETAIL_STATUS[statusDetailCode] ?? null,
    statusDetailCode: typeof statusDetailCode === 'number' ? statusDetailCode : null,
    uptimeSeconds,
    uptime: coalesce(detail.uptime, row.uptime),
    cpuUtil: coalesce(detail.cpuUtil, row.cpuUtil),
    memUtil: coalesce(detail.memUtil, row.memUtil),
    temperature: coalesce(detail.temp),
    sn: coalesce(detail.sn, row.sn),
    lastSeen: coalesce(toIso(detail.lastSeen), toIso(row.lastSeen)),
    portCount: Array.isArray(detail.portList) ? detail.portList.length : null,
  };
}

/**
 * Resolve online/offline from the two code spaces the controller uses.
 *
 * A /devices list row carries `status` as 1 (online) / 0 (offline). A detail
 * row instead carries the detail-status code in `status` (14 = Connected,
 * 0 = Disconnected) plus `statusCategory` (1 = online, 0 = offline). Some
 * detail reads expose neither `status` nor a category at all, so the fall
 * through is explicit and an unresolvable device is 'unknown' rather than a
 * guess.
 */
function statusFromCodes({ statusCode, statusCategory }) {
  if (statusCode === 1) return 'online';
  if (statusCode === 0) return 'offline';
  if (statusCategory === 1) return 'online';
  if (statusCategory === 0) return 'offline';
  return 'unknown';
}

/** Index a port's PoE-info row by `switchMac#port`. */
export function indexBySwitchPort(rows) {
  const index = new Map();
  for (const row of rows ?? []) {
    if (row?.switchMac === undefined || row?.port === undefined) continue;
    index.set(`${row.switchMac}#${row.port}`, row);
  }
  return index;
}

/** Index wired client rows by `switchMac#port`. */
export function indexClientsBySwitchPort(rows) {
  const index = new Map();
  for (const row of rows ?? []) {
    if (row?.switchMac === undefined || row?.port === undefined) continue;
    const key = `${row.switchMac}#${row.port}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(row);
    else index.set(key, [row]);
  }
  return index;
}

/**
 * Normalize one switch-port counter row into a getSwitchPorts record.
 *
 * `countersRow` is a /switches/ports/counters row: link state, PoE mode, error
 * and traffic counters. `poeRow` is the matching /switches/ports/poe-info row
 * when the controller reports PoE telemetry for that port (absent on non-PoE
 * ports). `clientRows` are the wired clients currently on the port.
 *
 * PoE draw is only reported where the controller exposes it: a port with no
 * poe-info row gets null voltage/current/draw rather than a fabricated 0.
 */
export function normalizeSwitchPort({ countersRow, poeRow = null, clientRows = [] }) {
  const status = countersRow.portStatus ?? {};
  const linkUp = status.linkStatus === 1;
  const speedCode = typeof status.linkSpeed === 'number' ? status.linkSpeed : null;
  // A down port's speed code is not a negotiated speed (the controller
  // reports 1 on idle ports), so the code is kept raw but no rate is claimed.
  const speedMbps = linkUp ? (LINK_SPEEDS[speedCode] ?? null) : null;
  const supported = countersRow.supportPoe === true;
  const exposed = poeRow !== null && (poeRow.power !== undefined || poeRow.voltage !== undefined);
  const first = clientRows[0];

  return {
    switchMac: countersRow.switchMac,
    switchName: countersRow.switchName,
    port: countersRow.port,
    portName: countersRow.portName,
    linkUp,
    linkSpeedCode: speedCode,
    linkSpeedMbps: speedMbps,
    linkSpeed: linkSpeedLabel(speedMbps),
    duplex: duplexLabel(status.duplex),
    duplexCode: typeof status.duplex === 'number' ? status.duplex : null,
    poeSupported: supported,
    // The port's configured PoE mode code (1 = PoE enabled on this port);
    // distinct from poeActive, which is whether it is drawing power now.
    poeMode: typeof countersRow.poe === 'number' ? countersRow.poe : null,
    poeActive: status.poe === true,
    poePowerW: exposed ? coalesce(poeRow.power, status.poePower) : supported ? coalesce(status.poePower) : null,
    poeVoltage: exposed ? coalesce(poeRow.voltage) : null,
    poeCurrent: exposed ? coalesce(poeRow.current) : null,
    // The controller reports '--' for a PoE port with no powered device.
    poeClass: exposed && poeRow.pdClass !== '--' ? coalesce(poeRow.pdClass) : null,
    txBytes: coalesce(countersRow.txBytes),
    rxBytes: coalesce(countersRow.rxBytes),
    txErrors: coalesce(countersRow.txErrors),
    rxErrors: coalesce(countersRow.rxErrors),
    stp: coalesce(status.stp),
    clientConnected: countersRow.connectedStatus === 1,
    clients: clientRows.length,
    clientMac: first?.mac ?? null,
    clientName: first?.name ?? null,
    clientIp: first?.ip ?? null,
    clientType: first?.deviceType ?? null,
  };
}

/**
 * Build the getSwitchPorts envelope.
 *
 * Ports stay in the controller's own order (switch, then port number), and
 * the per-switch tallies are reported next to them so a caller can tell a
 * filtered read of one switch from a whole-site read without recounting.
 */
export function portsEnvelope({ siteId, deviceId, ports }) {
  const switches = [];
  const bySwitch = new Map();
  for (const port of ports) {
    let entry = bySwitch.get(port.switchMac);
    if (!entry) {
      entry = { mac: port.switchMac, name: port.switchName, ports: 0, linksUp: 0, clients: 0 };
      bySwitch.set(port.switchMac, entry);
      switches.push(entry);
    }
    entry.ports += 1;
    if (port.linkUp) entry.linksUp += 1;
    entry.clients += port.clients;
  }

  return {
    siteId,
    deviceId,
    portCount: ports.length,
    switchCount: switches.length,
    switches,
    ports,
  };
}
