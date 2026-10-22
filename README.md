# omada-mcp

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for
[TP-Link Omada](https://www.omadanetworks.com/) controllers (SDN / Omada Controller 5.x–6.x).

It lets an MCP client (OpenCode, Claude, Cursor, etc.) inspect an Omada network — sites, devices,
clients, VLANs, gateway ACLs, NAT, mDNS, QoS, DNS and more — **without any ability to change
configuration**.

## Why read-only?

Most Omada MCP servers can write. That's powerful, but risky: a model can delete an ACL, disable a
VLAN, or reboot a gateway. This server is deliberately write-incapable at three independent layers:

1. **No write methods.** The Omada client exposes only read operations. There is no `create`,
   `update`, `delete`, or generic escape hatch.
2. **A method guard.** Every outbound request passes `assertReadOnly()`, which permits only `GET`
   plus the single OAuth token endpoint. This runs before any socket is opened.
3. **Fixed paths.** Request paths come from a compile-time registry of known datasets, never from
   tool input; `siteId` values are percent-encoded so they can't traverse a path.

If you want write access, use a tool that was built and reviewed for it — not this one.

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

| Tool | Purpose |
| --- | --- |
| `getConnectionStatus` | Local config readiness; no login, no network call |
| `listSites` | Sites accessible to the credential |
| `listDevices` | Adopted devices for a site |
| `listClients` | Active clients for a site |
| `getLanNetworks` | VLAN/subnet/DHCP settings (no SSID passwords) |
| `readSiteConfiguration` | Read one fixed dataset from a fixed registry |

`readSiteConfiguration` accepts one of a fixed set of dataset names — no arbitrary paths or HTTP
methods are reachable:

`dhcpReservations`, `groups`, `gatewayAcls`, `gatewayAclMode`, `customGatewayAcls`, `portForwards`,
`mdns`, `bonjourServices`, `siteSpecification`, `internet`, `bandwidthControl`, `bandwidthRules`,
`gatewayBandwidthRules`, `qosWans`, `qosClasses`, `dnsProxy`, `dnsCache`, `firewall`, `idsIps`,
`remoteLogging`, `igmp`, `clients`, `lanNetworks`.

Endpoint paths were checked against the Omada Open API reference. Endpoints can vary by controller
version: an unsupported or unauthorized endpoint returns a visible error, never an empty list.

## Configuration reference

| Variable | Required | Description |
| --- | --- | --- |
| `OMADA_BASE_URL` | one of* | Controller base URL |
| `OMADA_OMADAC_ID` | one of* | Controller ID from `/api/info` |
| `OMADA_CERT_SHA256` | one of* | SHA-256 of the controller's leaf certificate |
| `OMADA_ACCESS_TOKEN` | one of | Pre-fetched OAuth access token |
| `OMADA_CLIENT_ID` / `OMADA_CLIENT_SECRET` | one of | Open API Client-mode application |
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

Covers: the method guard, absence of write methods on the client, the Omada `AccessToken` header
format, secret redaction, pagination completeness/failure behaviour, path construction safety, and
certificate pinning (including refusal of a mismatched fingerprint).

## Not affiliated

Unofficial. TP-Link and Omada are trademarks of TP-Link Technologies Co., Ltd.

## License

MIT
