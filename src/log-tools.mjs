/**
 * Site log tools (getAlerts / getEvents).
 *
 * The handler logic lives here, separated from the MCP registration in
 * src/index.mjs, so it can be exercised without a live controller: the caller
 * injects a `read` function and the tool logic is exercised against it.
 *
 * Four properties are enforced here:
 *
 *  1. No silent emptiness. Every read goes through the client's
 *     readLogDataset() -> read()/collectPages() path, which refuses malformed,
 *     truncated or repeated responses. A failure throws and the tool wrapper
 *     turns it into a visible error; it is never reported as "0 results".
 *     The envelope also reports the controller's own `totalRows` for the
 *     query, so a caller can tell "nothing matched" from "the window was
 *     truncated at the limit".
 *
 *  2. Bounded reads. The limit is clamped to MAX_LOG_LIMIT, and the effective
 *     limit is reported back so a caller that asked for more can see it.
 *
 *  3. Closed filter vocabulary. The controller accepts an unknown filter VALUE
 *     and simply matches nothing, and it accepts a filter NAME it does not
 *     implement on the wrong endpoint without complaint (e.g. `filters.level`
 *     on the event log returns 0 rows even though event rows carry no level
 *     at all). Both would look like a working filter that found nothing, so
 *     the values are validated here against a closed list and a filter the
 *     endpoint does not implement is a visible error.
 *
 *  4. No secrets in output. The result is redacted with the configured
 *     secrets before it leaves this module (the MCP tool wrapper redacts a
 *     second time).
 */
import { z } from 'zod';

import { redact } from './core.mjs';
import {
  ALERT_LEVELS,
  DEFAULT_LOG_LIMIT,
  LOG_MODULES,
  MAX_LOG_LIMIT,
  clampLogLimit,
  filterWindow,
  normalizeAlert,
  normalizeEvent,
  sortNewestFirst,
  toEpochMs,
} from './logs.mjs';

/**
 * A log timestamp argument.
 *
 * The controller accepts any ISO-8601 form, but a timestamp without a
 * timezone is ambiguous, so it is rejected rather than guessed. A bare date is
 * read as UTC midnight.
 */
export const timestampSchema = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .describe('ISO-8601 timestamp (e.g. 2026-10-23T08:00:00Z) or date (2026-10-23).');

/** Shared shape of both log tools. */
export const logSchema = z
  .object({
    siteId: z.string().min(1),
    limit: z.number().int().min(1).max(MAX_LOG_LIMIT).default(DEFAULT_LOG_LIMIT),
    since: timestampSchema.optional().describe('Return records at or after this timestamp.'),
    until: timestampSchema.optional().describe('Return records at or before this timestamp.'),
    category: z
      .enum(LOG_MODULES)
      .optional()
      .describe('Filter by category/module: System, Device or Client.'),
  })
  .strict();

/** getAlerts adds the alert-only filters. */
export const alertSchema = logSchema
  .extend({
    severity: z
      .enum(ALERT_LEVELS)
      .optional()
      .describe('Filter by severity (case sensitive): Information, Warning, Error or Critical.'),
    resolved: z.boolean().optional().describe('Filter by resolved status; omit for all alerts.'),
  })
  .strict();

export const ALERTS_DESCRIPTION =
  'Read recent site alert logs for a site, newest first. Returns an envelope ' +
  '{kind, siteId, window, limit, returned, totalRows, limited, records}; each record is ' +
  '{id, key, severity, category, message, time, firstSeen, lastSeen, deviceMacs, clientMacs}. ' +
  'severity is the controller severity (Information|Warning|Error|Critical, case sensitive) ' +
  'and category is System|Device|Client. The controller stores ONE occurrence timestamp per ' +
  'alert, so firstSeen and lastSeen both equal time; it exposes no per-alert device/client id ' +
  'field, so deviceMacs/clientMacs are parsed from the message text. Defaults to the last 7 ' +
  `days and 50 records; limit is 1-${MAX_LOG_LIMIT}.`;

export const EVENTS_DESCRIPTION =
  'Read the site event log for a site, newest first. Returns an envelope ' +
  '{kind, siteId, window, limit, returned, totalRows, limited, records}; each record is ' +
  '{id, key, category, message, time, deviceMacs, clientMacs}. Event rows carry no severity ' +
  'and no resolved state, so those filters are rejected rather than silently ignored; the ' +
  'controller exposes no per-event device/client id field, so deviceMacs/clientMacs are parsed ' +
  'from the message text. Defaults to the last 7 days and 50 records; ' +
  `limit is 1-${MAX_LOG_LIMIT}.`;

/** Clamp and validate the window arguments shared by both tools. */
function windowOf({ since, until }) {
  const sinceMs = since === undefined || since === null ? null : toEpochMs(since);
  const untilMs = until === undefined || until === null ? null : toEpochMs(until);
  if (sinceMs !== null && untilMs !== null && sinceMs > untilMs) {
    throw new Error('`since` must not be later than `until`.');
  }
  return { sinceMs, untilMs };
}

/**
 * Read one site log and return the tool envelope.
 *
 * `read` is the injected reader: (options) -> the client's readLogDataset()
 * result. `normalize` maps one raw controller row to a tool record.
 */
async function readLog({ read, siteId, limit, since, until, filters, normalize, secrets }) {
  const effectiveLimit = clampLogLimit(limit);
  const { sinceMs, untilMs } = windowOf({ since, until });
  const result = await read({ limit: effectiveLimit, since, until, ...filters });

  let records = result.records.map(normalize);
  // Defence in depth: the controller honours the time window and the
  // category/severity filters, but re-applying them locally means a
  // controller that ignored a filter can never hand back rows that do not
  // match what was asked for.
  records = filterWindow(records, sinceMs, untilMs);
  if (filters.category !== undefined && filters.category !== null) {
    records = records.filter((record) => record.category === filters.category);
  }
  if (filters.severity !== undefined && filters.severity !== null) {
    records = records.filter((record) => record.severity === filters.severity);
  }
  records = sortNewestFirst(records);
  if (records.length > effectiveLimit) records = records.slice(0, effectiveLimit);

  const totalRows = typeof result.totalRows === 'number' ? result.totalRows : null;
  return redact(
    {
      kind: result.kind,
      siteId,
      window: {
        since: result.window?.since ?? (sinceMs === null ? null : new Date(sinceMs).toISOString()),
        until: result.window?.until ?? (untilMs === null ? null : new Date(untilMs).toISOString()),
      },
      limit: effectiveLimit,
      returned: records.length,
      totalRows,
      // True when the controller holds more rows for this query than were
      // returned — the read was bounded, not empty.
      limited: result.limited === true || (totalRows !== null && totalRows > records.length),
      records,
    },
    secrets,
  );
}

/**
 * getAlerts handler.
 *
 * `category` maps to the controller's `filters.module` (System|Device|Client),
 * `severity` to `filters.level` (Information|Warning|Error|Critical, case
 * sensitive) and `resolved` to `filters.resolved` (true|false).
 *
 * `resolved` is applied server-side only: an alert row carries no per-row
 * resolved flag, so there is nothing to re-check locally.
 */
export function alertsHandler({
  read,
  siteId,
  limit,
  since,
  until,
  category,
  severity,
  resolved,
  secrets = [],
}) {
  return readLog({
    read,
    siteId,
    limit,
    since,
    until,
    filters: { category, severity, resolved },
    normalize: normalizeAlert,
    secrets,
  });
}

/**
 * getEvents handler.
 *
 * The controller's event log has no severity and no resolved state, so only
 * `category` maps to a server-side filter. Asking for a severity or resolved
 * filter on events is rejected rather than silently ignored.
 */
export function eventsHandler({ read, siteId, limit, since, until, category, secrets = [] }) {
  return readLog({
    read,
    siteId,
    limit,
    since,
    until,
    filters: { category },
    normalize: normalizeEvent,
    secrets,
  });
}

/**
 * Build the tool specifications for the two site log tools.
 *
 * `getClient` is invoked lazily inside each handler so the server can start
 * and report a helpful config error per call, rather than crashing at module
 * load — the same pattern the write tools use.
 *
 * The caller registers each spec through the shared `tool()` helper, so the
 * log tools get the same redaction and visible-error handling as every other
 * read tool.
 */
export function logToolSpecs({ getClient, secrets = () => [] }) {
  /** Reject a site the credential cannot see, before any log read. */
  async function requireSite(c, siteId) {
    const sites = await c.listSites();
    if (!sites.some((site) => site.siteId === siteId)) {
      throw new Error('siteId is not in the accessible site list.');
    }
  }

  return [
    {
      name: 'getAlerts',
      description: ALERTS_DESCRIPTION,
      schema: alertSchema,
      handler: async ({ siteId, limit, since, until, category, severity, resolved }) => {
        const c = getClient();
        await requireSite(c, siteId);
        return alertsHandler({
          read: (options) => c.readLogDataset(siteId, 'alerts', options),
          siteId,
          limit,
          since,
          until,
          category,
          severity,
          resolved,
          secrets: secrets(),
        });
      },
    },
    {
      name: 'getEvents',
      description: EVENTS_DESCRIPTION,
      schema: logSchema,
      handler: async ({ siteId, limit, since, until, category }) => {
        const c = getClient();
        await requireSite(c, siteId);
        return eventsHandler({
          read: (options) => c.readLogDataset(siteId, 'events', options),
          siteId,
          limit,
          since,
          until,
          category,
          secrets: secrets(),
        });
      },
    },
  ];
}
