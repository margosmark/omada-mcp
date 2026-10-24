# omada-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[TP-Link Omada](https://www.omadanetworks.com/) controllers (SDN / Omada Controller 5.x–6.x).

It lets an MCP client (OpenCode, Claude, Cursor, etc.) inspect an Omada network — sites, devices,
clients, VLANs, gateway ACLs, NAT, mDNS, QoS, DNS and more.

**Read-only by default.** Set `OMADA_ENABLE_WRITES=true` to additionally register 17 write tools
(Gateway ACL, DHCP reservation, group, port-forward, mDNS, LAN network create/update/delete plus
ACL reorder). See [Write mode](#write-mode) — even when enabled, every write is dry-run until you
pass `confirm:true`, and only a fixed whitelist of endpoints is reachable.

## Why read-only by default?

Most Omada MCP servers can write unconditionally. That's powerful, but risky: a model can delete an
ACL, disable a VLAN, or reboot a gateway from a mistyped prompt. Here, write capability is an
explicit opt-in rather than an assumption, and it stays constrained even when on:

1. **Flag-gated registration.** Without `OMADA_ENABLE_WRITES=true`, write tools are never
   registered — they don't appear in the tool list at all.
2. **Dry-run default.** When registered, every write tool validates and returns the request
   **without sending it** unless you pass `confirm: true`. Two independent gates.
3. **No arbitrary writers.** There is no generic `create`/`update`/`delete`/`request` escape hatch.
   Writes go through one `write(operation, …)` entry point bound to a fixed operation whitelist.
4. **Method + path guard.** Every mutating request is re-checked against the whitelist's exact
   verb, path pattern, API version, and controller ID before any socket opens.
5. **Strict identifiers.** Dynamic path segments must match `[A-Za-z0-9_-]+`, so an identifier
   cannot traverse out of its path segment (`..`, `/`, `//` are all rejected).
6. **Schema validation.** Write bodies require the fields Omada's own Open API marks required;
   unknown top-level fields are rejected by a strict input schema.
7. **Read-back.** Each write returns Omada's acknowledgement (`errorCode 0` = accepted); verify
   with the read tools before and after.

Write access *is* available here — it's just opt-in and bounded. Turn it on only when you intend to
change configuration; leave it off for routine inspection. See [Write mode](#write-mode).

## Safety properties

- **TLS stays verified.** The controller's leaf certificate is pinned by SHA-256. A changed
  certificate fails closed rather than falling back to "ignore errors".
- **No secrets in output.** Tool results are recursively redacted before they're returned
  (tokens, secrets, cookies, passwords, keys).
- **No empty-on-error.** Paginated reads refuse malformed, truncated or repeated responses and
  surface an error instead of reporting "0 results".
- **No network calls on setup.** `getConnectionStatus` reports what's configured without logging in.

## Install

```sh
git clone <this-repo>
cd omada-mcp
npm install
```

## Quick start

**1. Discover your controller and pin its certificate:**

```sh
node setup.mjs https://<controller-host>:8043
```

This reads the public `/api/info` endpoint, writes `controller.json` + `controller.pem`, and prints
the certificate's SHA-256. **Verify that fingerprint** against the controller UI or browser padlock
before entering credentials — it's trust-on-first-observation on your own LAN, not PKI.

**2. Provide credentials.** Either set environment variables (recommended) or store them locally:

```sh
# Option A — pre-fetched access token (no API app needed)
export OMADA_ACCESS_TOKEN="<token>"

# Option B — Open API application in Client mode
export OMADA_CLIENT_ID="<client-id>"
export OMADA_CLIENT_SECRET="<client-secret>"
```

Or store them in an owner-only `.secrets/credentials.json` (never committed):

```sh
python3 configure.py          # Client ID + Secret
python3 configure.py --token  # or a pre-fetched access token
```

Create the application under **Omada → Settings → Platform Integration → Open API**, in **Client**
mode, with the narrowest role your read-only needs allow. Don't reuse your admin password.

**3. Run:**

```sh
npm start
```

## Add to OpenCode

```sh
opencode mcp add omada --global -- /usr/bin/node /path/to/omada-mcp/src/index.mjs
```

Or with credentials in the MCP config:

```jsonc
{
  "mcp": {
    "servers": {
      "omada": {
        "type": "local",
        "command": ["node", "/path/to/omada-mcp/src/index.mjs"],
        "environment": {
          "OMADA_BASE_URL": "https://<controller-host>:8043",
          "OMADA_OMADAC_ID": "<omadacId>",
          "OMADA_CERT_SHA256": "<sha256>",
          "OMADA_ACCESS_TOKEN": "{env:OMADA_ACCESS_TOKEN}"
        }
      }
    }
  }
}
```

`setup.mjs` already writes `baseUrl`, `controllerId` and `certificateSha256` into `controller.json`,
so if you're running next to the repo you only need to supply credentials.

## Tools

Read tools (always available):

| Tool | Purpose |
| --- | --- |
| `getConnectionStatus` | Local config readiness; no login, no network call |
| `listSites` | Sites accessible to the credential |
| `listDevices` | Adopted devices for a site |
| `listClients` | Active clients for a site |
| `getLanNetworks` | VLAN/subnet/DHCP settings (no SSID passwords) |
| `readSiteConfiguration` | Read one fixed dataset from a fixed registry |
| `getAlerts` | Recent site alerts (severity, category, message, timestamp) |
| `getEvents` | Paginated site event log, newest first |
| `getDevice` | One device by MAC: model, status, uptime, counts, type-specific detail |
| `getSwitchPorts` | Switch port status: link, speed, PoE, errors, and the client on each port |

`readSiteConfiguration` accepts one of a fixed set of dataset names — no arbitrary paths or HTTP
methods are reachable:

`dhcpReservations`, `groups`, `gatewayAcls`, `gatewayAclMode`, `customGatewayAcls`, `portForwards`,
`mdns`, `bonjourServices`, `siteSpecification`, `internet`, `bandwidthControl`, `bandwidthRules`,
`gatewayBandwidthRules`, `qosWans`, `qosClasses`, `dnsProxy`, `dnsCache`, `firewall`, `idsIps`,
`remoteLogging`, `igmp`, `clients`, `lanNetworks`.

Endpoint paths were checked against the Omada Open API reference. Endpoints can vary by controller
version: an unsupported or unauthorized endpoint returns a visible error, never an empty list.

### Site logs

`getAlerts` and `getEvents` read the two site log endpoints. Both take a `siteId`, an optional
`since`/`until` window (ISO-8601 timestamp or date), and a `limit` (default 50, max 200). Records
come back newest first.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `getAlerts` | `siteId`, `limit`, `since`, `until`, `category`, `severity`, `resolved` | `{id, key, severity, category, message, time, firstSeen, lastSeen, deviceMacs, clientMacs}` |
| `getEvents` | `siteId`, `limit`, `since`, `until`, `category` | `{id, key, category, message, time, deviceMacs, clientMacs}` |

- `category` is `System`, `Device` or `Client` (the controller's `filters.module`).
- `severity` is `Information`, `Warning`, `Error` or `Critical` — **case sensitive**. The
  controller matches `Warning`, not `warning`.
- `resolved` is `true` or `false` and applies to alerts only.
- The event log has no severity and no resolved state, so those filters are **rejected** there
  rather than silently ignored — the controller accepts a filter it does not implement and
  returns an unfiltered log that looks filtered.
- Filter values are validated against a closed list. The controller accepts an unknown value
  (`warning`, `NotALevel`) and matches nothing, which is indistinguishable from "no such alerts" —
  so a typo is an error instead of a silent empty result.

Both tools return an envelope: `{kind, siteId, window, limit, returned, totalRows, limited, records}`.
`totalRows` is the controller's own count for the query and `limited` says whether the read was
bounded — so "nothing matched" is never confused with "there was more than the limit".

What the controller does **not** expose, and the tools therefore do not claim:

- There is no separate first/last-seen timestamp. The controller stores one occurrence time per
  row, so `firstSeen` and `lastSeen` both mirror `time`.
- There is no per-row device or client id. The related hardware is named inside the message
  (`[ap:28-87-BA-A2-73-62]`, `[client:B4-22-00-0B-23-77 ]`), so `deviceMacs` and `clientMacs` are
  parsed out of the message text and normalised to the same uppercase-dashed MAC form the
  device and client inventories use.
- Event rows carry no severity field at all.

The default window is the last 7 days. The log endpoints require a time window and bounded
pagination server-side, so the reads are always windowed and paginated — a malformed, truncated
or repeated response is a visible error, never "0 results".

### Device and switch-port status

`getDevice` and `getSwitchPorts` read one device and one switch's ports. Both take a `siteId` and
an optional `deviceId` — a MAC address as `listDevices` reports it. The id is uppercased for
comparison and is otherwise the controller's own value, so `28-87-BA-C0-4E-4A`,
`28-87-ba-c0-4e-4a` and `2887BAC04E4A` all resolve to the same device. The id must be one of
`[A-Za-z0-9_-]` and is rejected **before** any controller call.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `getDevice` | `siteId`, `deviceId` | `{siteId, device}` |
| `getSwitchPorts` | `siteId`, `deviceId` (optional) | `{siteId, deviceId, portCount, switchCount, switches, ports}` |

`deviceId` is **required** on `getDevice` and **optional** on `getSwitchPorts`: with it, only that
switch's ports come back; without it, every switch in the site is read.

`getDevice` resolves the id against the site's **real device list** before issuing a detail
request, so an unknown id is an error naming the id — and listing a few valid ones — rather than a
404 or an empty body. An unsupported device type is likewise an error that names the type.

**There is no generic device-detail endpoint.** The controller has no `/devices/{mac}` route —
it answers 404. Each device type has its own detail route, so `getDevice` reads
`switches/{mac}`, `aps/{mac}` or `gateways/{mac}` depending on what the id actually is.

`device` is `{deviceId, name, type, model, modelName, modelVersion, hardwareVersion, ip,
firmwareVersion, firmwareVersionShort, status, statusCode, statusCategory, statusDetail,
statusDetailCode, uptimeSeconds, uptime, cpuUtil, memUtil, temperature, sn, lastSeen,
portCount}`:

- `status` is `online`/`offline`/`unknown`, derived from the device's own code in the controller's
  own space and not reinterpreted. `statusDetail` and `statusDetailCode` keep the detail route's
  separate status space intact — the list route and the detail route do not share one.
  `statusCategory` is the detail route's own coarser category, reported as the raw code.
- The Open API does not report last-seen for a device, so `lastSeen` mirrors `uptime` when the
  device is connected and is `null` when it is not.
- An unadopted device has no uptime or firmware in the list row. Those fields are `null`, never
  `0` — an uptime of 0 seconds and no uptime at all are different facts, and a controller that
  omits a field is not being reported as "just now".
- `cpuUtil`/`memUtil` are null on an AP, `temperature`/`portCount` are gateway/switch-only. The
  tools never guess a value the controller does not expose for that device type.
- A device id is **not** validated against the write path parameters. `getDevice` proves the id
  exists in the site's device list, which is the read-only question; it never touches
  `deviceParamPath`.

`getSwitchPorts` joins three read-only endpoints in parallel — `switches/ports/counters` (link
state, errors and byte counters), `switches/ports/poe-info` (PoE) and `clients` (what is plugged
in) — narrowed server-side by `filters.switchMac` when a `deviceId` was given, and paginated until
every row is in hand. `switches` gives the per-switch tally `{mac, name, ports, linksUp,
clients}`, so a filtered read of one switch is distinguishable from a whole-site read without
recounting.

Each port is `{switchMac, switchName, port, portName, linkUp, linkSpeedCode, linkSpeedMbps,
linkSpeed, duplex, duplexCode, poeSupported, poeMode, poeActive, poePowerW, poeVoltage,
poeCurrent, poeClass, txBytes, rxBytes, txErrors, rxErrors, stp, clientConnected, clients,
clientMac, clientName, clientIp, clientType}`:

- `clientConnected` is the **port's** link flag, not a count of end devices. An uplink carrying
  another switch is `clientConnected: true, clients: 0`, and its `clientMac`/`clientName`/
  `clientIp`/`clientType` are null.
- `linkSpeedMbps` and `linkSpeed` come from a code map. Codes `1`/`2`/`3` (10M/100M/1G) are
  corroborated by the controller's own data; any other code keeps `linkSpeedCode` and reports the
  two derived fields as null rather than guessing a rate. See `LINK_SPEEDS` in `src/devices.mjs`
  for why code 5 is deliberately left unmapped.
- PoE is reported in two separate pieces, deliberately. `poeSupported` (this port is a PoE port)
  and `poeMode` (PoE enabled on this port) come from the counters row's own flags, so they are
  present even where the controller exposes no live telemetry. The `poe-info` join supplies only
  the live figures, so a port with no telemetry row gets null `poePowerW`/`poeVoltage`/
  `poeCurrent`/`poeClass` rather than a fabricated 0 W — a switch with no PoE ports still
  reports its ports, each correctly marked unsupported.
- `poeClass` is null when the controller reports `'--'`, its sentinel for a PoE port with no
  powered device attached. That is "nothing is drawing power", not class 0.
- Port names come from the counters rows themselves; the tools read no port configuration.
- Only the `switches/{mac}` detail route used by `getDevice` returns a port list at all, and that
  is configuration — profile, PoE mode, enabled flag — not link status. `getSwitchPorts` does not
  merge it in.

## Write mode

Off by default. To enable:

```sh
OMADA_ENABLE_WRITES=true npm start
```

This registers 17 additional tools:

| Group | Tools |
| --- | --- |
| Gateway ACL | `createGatewayAcl`, `updateGatewayAcl`, `deleteGatewayAcl`, `reorderGatewayAcls` |
| DHCP reservation | `createDhcpReservation`, `updateDhcpReservation`, `deleteDhcpReservation` |
| Group profile | `createGroupProfile`, `updateGroupProfile`, `deleteGroupProfile` |
| Port forwarding | `createPortForward`, `updatePortForward`, `deletePortForward` |
| mDNS | `createMdnsRule`, `updateMdnsRule`, `deleteMdnsRule` |
| LAN network | `updateLanNetwork` |

### The two gates

1. **`OMADA_ENABLE_WRITES=true`** — registers the tools. Without it they don't exist.
2. **`confirm: true`** on each call — actually dispatches. Omit it (or set `false`) and the call
   is a **dry-run**: it validates the body, builds the exact path, and returns what *would* be
   sent, without touching the network.

So a cautious workflow is: call normally to preview → inspect path and body → re-send with
`confirm: true`.

```text
Preview  → { "dryRun": true, "sent": false, "path": "/sites/<id>/acls/osg-acls", ... }
Apply    → { "sent": true, "controllerAck": { ... } }
```

### What write mode cannot do

Even with the flag on, these remain blocked:

- **Anything not on the whitelist.** Only the verbs/paths in the table above. ACL delete is at
  `/acls/{id}` while update is at `/acls/osg-acls/{id}` — both allowlisted precisely; a delete to
  the update path is rejected, as is `PUT /acls/modifyIndex`.
- **Wrong API version.** `updateLanNetwork` is v2 only; using it at v1 is rejected.
- **A different controller.** Paths are checked against the configured `omadacId`.
- **Path traversal.** Identifiers must match `[A-Za-z0-9_-]+`.
- **Schema-invalid bodies.** Required fields enforced; unknown top-level keys rejected.
- **Reboots, firmware upgrades, client blocking, arbitrary HTTP.** Not in the whitelist.

### Recommendation

Keep write mode **off** for routine/agent-driven inspection. Turn it on only when you intend to
change configuration, and preview first. Give the Omada credential the narrowest role that still
permits the operations you need.

## Configuration reference

| Variable | Required | Description |
| --- | --- | --- |
| `OMADA_BASE_URL` | one of* | Controller base URL |
| `OMADA_OMADAC_ID` | one of* | Controller ID from `/api/info` |
| `OMADA_CERT_SHA256` | one of* | SHA-256 of the controller's leaf certificate |
| `OMADA_ACCESS_TOKEN` | one of | Pre-fetched OAuth access token |
| `OMADA_CLIENT_ID` / `OMADA_CLIENT_SECRET` | one of | Open API Client-mode application |
| `OMADA_ENABLE_WRITES` | no | `true` registers the write tools; omitted/false = read-only (default) |
| `OMADA_CONFIG` | no | Path to `controller.json` |
| `OMADA_PEM` | no | Path to the pinned `controller.pem` |
| `OMADA_CREDENTIALS` | no | Path to a credentials JSON file |

\* `OMADA_BASE_URL`, `OMADA_OMADAC_ID` and `OMADA_CERT_SHA256` can instead come from
`controller.json`, which `setup.mjs` generates.

`OMADA_ACCESS_TOKEN` takes precedence over Client ID/Secret when both are set.

## Access token vs Client ID/Secret

- **Access token** — simplest, if you already have a short-lived OAuth token. Set
  `OMADA_ACCESS_TOKEN`. Note tokens expire; refresh requires the credentials flow or a new token.
- **Client ID/Secret** — the server obtains and refreshes its own token automatically. Best for
  long-running sessions.

## Tests

```sh
npm test
```

Covers: the read-only method guard, absence of bypass writers on the client, the Omada
`AccessToken` header format, secret redaction, pagination completeness/failure, path construction
safety, certificate pinning (including refusal of a mismatched fingerprint), the write flag
defaulting off, the operation whitelist's exact verb/path/version matching, path-traversal
rejection in identifiers, write-tool registration only when enabled, and dry-run by default with
`confirm:true` required to dispatch.

## Not affiliated

Unofficial. TP-Link and Omada are trademarks of TP-Link Technologies Co., Ltd.

## License

MIT
