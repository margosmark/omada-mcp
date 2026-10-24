/**
 * Site log helpers (alerts + events).
 *
 * The Omada Open API exposes the site alert and event logs at
 * `/openapi/v1/{omadacId}/sites/{siteId}/logs/alerts` and
 * `/openapi/v1/{omadacId}/sites/{siteId}/logs/events`.
 *
 * Verified live against an Omada 6.3.0.111 controller (Omada API v3):
 *
 *   - Both endpoints REQUIRE `filters.timeStart` + `filters.timeEnd` (epoch
 *     milliseconds), `page` (>= 1) and `pageSize` (1..1000). Omitting any of
 *     them is an HTTP 400 or error -1001, which the client surfaces as a
 *     visible error — never as an empty list.
 *   - Rows come back strictly newest-first, and the ordering continues across
 *     pages, so reading from page 1 upwards yields the newest records.
 *   - `filters.module` (System|Device|Client) is honoured by both endpoints.
 *   - `filters.level` (Warning|Error|Information|Critical, CASE SENSITIVE) is
 *     honoured by the alerts endpoint. `filters.resolved` (true|false) is
 *     honoured by the alerts endpoint only; the events endpoint ignores it.
 *   - An unknown filter VALUE is accepted by the controller and simply matches
 *     nothing (`level=warning` and `level=NotALevel` both return 0 rows, no
 *     error). The tools therefore validate these against a closed list before
 *     sending them, so a typo is an error instead of a silent empty result.
 *   - A log row carries exactly: `id`, `key`, `module`, `content`, `time`
 *     (epoch ms) and — for alerts — `level` (severity). There are NO separate
 *     first/last-seen timestamps, NO device/client id fields and NO per-row
 *     resolved flag.
 *
 * The related device/client is named inside the message text
 * (`[ap:28-87-BA-A2-73-62]`, `[gateway:5C-62-8B-31-36-11]`, `[switch:…]`,
 * `[client:BC-24-11-05-17-94 ]`, or the bare `client[98-4e-…]` form), so the
 * MACs are parsed out of `content` and normalised to the same uppercase-dashed
 * form the device/client inventories use.
 */

/** Default look-back window when the caller gives no `since`: the last 7 days. */
export const DEFAULT_LOG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Default number of records returned when the caller gives no `limit`. */
export const DEFAULT_LOG_LIMIT = 50;

/** Hard ceiling on records returned by one log read. */
export const MAX_LOG_LIMIT = 200;

/**
 * Severity vocabulary the controller uses for alert `level` values.
 * Case sensitive: the controller matches `Warning`, not `warning`.
 */
export const ALERT_LEVELS = ['Information', 'Warning', 'Error', 'Critical'];

/** Alert/event category vocabulary the controller uses for `module` values. */
export const LOG_MODULES = ['System', 'Device', 'Client'];

/**
 * Parse an ISO-8601 timestamp into epoch milliseconds.
 *
 * A bare date (`2026-10-23`) is read as UTC midnight, and a timestamp without
 * an offset (`2026-10-23T12:00:00`) is read as UTC, so the result never
 * depends on the machine's local timezone.
 */
export function toEpochMs(value) {
  if (typeof value === 'number') return epochMs(value);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ISO-8601 timestamp: ${value}`);
  }
  const text = value.trim();
  // Bare date -> UTC midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(`${text}T00:00:00Z`);
  // No timezone designator -> interpret as UTC rather than local time.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) {
    return Date.parse(`${text.replace(' ', 'T')}Z`);
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ISO-8601 timestamp: ${value}`);
  return parsed;
}

/**
 * Clamp a caller-supplied limit into [1, MAX_LOG_LIMIT].
 * Oversized requests are clamped rather than rejected; the effective limit is
 * reported back in the result envelope so the caller can see it.
 */
export function clampLogLimit(limit) {
  const requested = Number(limit);
  if (!Number.isFinite(requested)) return DEFAULT_LOG_LIMIT;
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_LOG_LIMIT);
}

/**
 * Coerce a controller timestamp into epoch milliseconds.
 * The API returns epoch ms, but seconds are accepted defensively (a value
 * below 1e11 is a 1973-or-later date in seconds, not milliseconds).
 */
export function epochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Render epoch milliseconds as an ISO-8601 UTC string. */
export function isoOrNull(ms) {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString();
}

/** Severity label, kept verbatim from the controller. */
function severityOf(record) {
  const raw = record.level ?? record.severity ?? null;
  if (raw === null || raw === undefined) return null;
  return typeof raw === 'string' ? raw : String(raw);
}

const MAC_PATTERN = /\b[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}\b/g;

/** Normalise a MAC to the uppercase-dashed form the inventories use. */
export function normalizeMac(value) {
  return String(value).replaceAll(':', '-').toUpperCase();
}

/**
 * Extract the device and client MACs named inside a log message.
 *
 * The controller names the related hardware in the message text, e.g.
 *   "[ap:28-87-BA-A2-73-62] reported monitor link down …"
 *   "[gateway:5C-62-8B-31-36-11] client[98-4e-8a-93-80-2a] used conflicted ip"
 *   "DHCP Server allocated IP address 10.10.11.108 for the [client:BC-24-11-13-8B-FA ]."
 *
 * Returns { deviceMacs, clientMacs } — each de-duplicated, in message order.
 */
export function extractMacs(message) {
  const text = typeof message === 'string' ? message : '';
  const deviceMacs = [];
  const clientMacs = [];
  const seen = new Set();
  for (const match of text.matchAll(MAC_PATTERN)) {
    const mac = normalizeMac(match[0]);
    if (seen.has(mac)) continue;
    seen.add(mac);
    const before = text.slice(Math.max(0, match.index - 32), match.index);
    if (/\bclient\s*[:\[]?\s*$/i.test(before)) clientMacs.push(mac);
    else if (/\b(?:ap|gateway|switch|device|omada)\s*[:\[]?\s*$/i.test(before)) deviceMacs.push(mac);
  }
  return { deviceMacs, clientMacs };
}

/**
 * Normalise one site alert row into the shape getAlerts returns.
 *
 * severity  <- level           (controller's severity label)
 * category  <- module          (System|Device|Client)
 * message   <- content
 * time      <- time            (epoch ms -> ISO-8601)
 * firstSeen/lastSeen           the controller stores ONE occurrence timestamp
 *                               per row, so both mirror `time`
 * deviceMacs/clientMacs        parsed from the message text — the API has no
 *                               separate device/client id field
 */
export function normalizeAlert(record) {
  const time = epochMs(record.time);
  const first = epochMs(record.firstSeen ?? record.firstTime ?? record.time);
  const last = epochMs(record.lastSeen ?? record.lastTime ?? record.time);
  const { deviceMacs, clientMacs } = extractMacs(record.content ?? record.message ?? '');
  return {
    id: record.id ?? null,
    key: record.key ?? null,
    severity: severityOf(record),
    category: record.module ?? record.category ?? null,
    message: record.content ?? record.message ?? null,
    time: isoOrNull(time),
    firstSeen: isoOrNull(first),
    lastSeen: isoOrNull(last),
    deviceMacs,
    clientMacs,
  };
}

/**
 * Normalise one site event row into the shape getEvents returns.
 * Event rows carry no severity and no resolved state; `module` is the category
 * and `content` is the message.
 */
export function normalizeEvent(record) {
  const time = epochMs(record.time);
  const { deviceMacs, clientMacs } = extractMacs(record.content ?? record.message ?? '');
  return {
    id: record.id ?? null,
    key: record.key ?? null,
    category: record.module ?? record.category ?? null,
    message: record.content ?? record.message ?? null,
    time: isoOrNull(time),
    deviceMacs,
    clientMacs,
  };
}

/**
 * Order newest-first. Ties keep their original relative order (stable sort),
 * so equal timestamps stay in the controller's order.
 */
export function sortNewestFirst(records) {
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const ta = epochMs(a.record.time) ?? -Infinity;
      const tb = epochMs(b.record.time) ?? -Infinity;
      if (ta !== tb) return tb - ta;
      return a.index - b.index;
    })
    .map((entry) => entry.record);
}

/**
 * Drop records outside the requested window. The controller already honours
 * `filters.timeStart`/`filters.timeEnd`, but applying the bound again locally
 * guarantees the documented filter even if a controller ignores it.
 */
export function filterWindow(records, sinceMs, untilMs) {
  return records.filter((record) => {
    const time = epochMs(record.time);
    if (time === null) return true; // unknown timestamp: keep rather than hide
    if (sinceMs !== null && sinceMs !== undefined && time < sinceMs) return false;
    if (untilMs !== null && untilMs !== undefined && time > untilMs) return false;
    return true;
  });
}

/**
 * Build the query parameters for a bounded site-log read.
 *
 * `since`/`until` are ISO-8601 strings (epoch milliseconds are also accepted)
 * and are optional; without them the read covers the default look-back window
 * ending now.
 *
 * `definition` is a LOG_DATASETS entry: `filters` lists the server-side
 * filters that endpoint actually honours and `kind` names it. Only those
 * filters are emitted — the controller silently ignores an unknown filter
 * NAME, so sending one would look like a working filter while quietly
 * returning unfiltered rows.
 *
 * A filter the endpoint does not support is an error, not a silent no-op:
 * dropping it would return a full log that the caller believes is filtered.
 */
export function buildLogParams(options = {}, definition = {}) {
  const { kind = 'log', filters: supported = [] } = definition;
  const endMs = options.until === undefined || options.until === null ? Date.now() : toEpochMs(options.until);
  const startMs =
    options.since === undefined || options.since === null ? endMs - DEFAULT_LOG_WINDOW_MS : toEpochMs(options.since);
  if (startMs > endMs) {
    throw new Error('`since` must not be later than `until`.');
  }
  const params = {
    'filters.timeStart': startMs,
    'filters.timeEnd': endMs,
  };

  if (options.category !== undefined && options.category !== null) {
    if (!supported.includes('module')) {
      throw new Error(`The ${kind} log does not support category filtering.`);
    }
    if (!LOG_MODULES.includes(options.category)) {
      throw new Error(`Unknown category "${options.category}". Expected one of: ${LOG_MODULES.join(', ')}.`);
    }
    params['filters.module'] = options.category;
  }

  if (options.severity !== undefined && options.severity !== null) {
    if (!supported.includes('level')) {
      throw new Error(`The ${kind} log does not support severity filtering.`);
    }
    if (!ALERT_LEVELS.includes(options.severity)) {
      throw new Error(`Unknown severity "${options.severity}". Expected one of: ${ALERT_LEVELS.join(', ')}.`);
    }
    params['filters.level'] = options.severity;
  }

  if (options.resolved !== undefined && options.resolved !== null) {
    if (!supported.includes('resolved')) {
      throw new Error(`The ${kind} log does not support resolved filtering.`);
    }
    params['filters.resolved'] = options.resolved;
  }

  return { params, startMs, endMs };
}
