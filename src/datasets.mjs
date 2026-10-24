/**
 * Fixed dataset registry.
 *
 * Every read path the server can reach is listed here as a compile-time
 * constant. There is no way for a caller to supply an arbitrary path or HTTP
 * method: a tool either names a dataset in this registry, or calls one of the
 * named client methods in src/omada-client.mjs.
 *
 * CONFIG_DATASETS entries are readable through the generic readSiteConfiguration
 * tool: `path` is relative to `/sites/{siteId}`, `version` selects the Open API
 * version, `paginated` selects the full-inventory read (collectPages) versus a
 * single response.
 *
 * LOG_DATASETS entries are the site log endpoints. They are separate because
 * they are read with an explicit time window and a bounded page count rather
 * than as a whole-dataset inventory, so they get their own tools
 * (getAlerts / getEvents) instead of being folded into readSiteConfiguration.
 */
export const CONFIG_DATASETS = {
  dhcpReservations: { path: '/setting/service/dhcp', paginated: true, version: 'v1' },
  groups: { path: '/profiles/groups', paginated: false, version: 'v1' },
  gatewayAcls: { path: '/acls/osg-acls', paginated: true, version: 'v1' },
  gatewayAclMode: { path: '/acls/osg-config-mode', paginated: false, version: 'v1' },
  customGatewayAcls: { path: '/acls/osg-custom-acls', paginated: true, version: 'v1' },
  portForwards: { path: '/nat/port-forwardings', paginated: true, version: 'v1' },
  mdns: { path: '/setting/service/mdns', paginated: true, version: 'v1' },
  bonjourServices: { path: '/profiles/bonjour-service', paginated: false, version: 'v1' },
  siteSpecification: { path: '/specification', paginated: false, version: 'v1' },
  internet: { path: '/internet', paginated: false, version: 'v1' },
  bandwidthControl: { path: '/bandwidth-control', paginated: false, version: 'v1' },
  bandwidthRules: { path: '/bandwidth-control/rules', paginated: true, version: 'v1' },
  gatewayBandwidthRules: { path: '/qos/gateway/bwcs', paginated: true, version: 'v1' },
  qosWans: { path: '/qos/gateway/wans', paginated: false, version: 'v1' },
  qosClasses: { path: '/qos/gateway/class-rules', paginated: true, version: 'v1' },
  dnsProxy: { path: '/setting/service/dns-proxy', paginated: false, version: 'v1' },
  dnsCache: { path: '/setting/service/dns-cache', paginated: false, version: 'v1' },
  firewall: { path: '/firewall', paginated: false, version: 'v1' },
  idsIps: { path: '/network-security/ips', paginated: false, version: 'v1' },
  remoteLogging: { path: '/remote-logging', paginated: false, version: 'v1' },
  igmp: { path: '/setting/service/igmp', paginated: false, version: 'v1' },
  clients: { path: '/clients', paginated: true, version: 'v1' },
  lanNetworks: { path: '/lan-networks', paginated: true, version: 'v2' },
};

/**
 * Site log endpoints.
 *
 * Verified live against an Omada 6.3.0.111 controller (Omada API v3):
 *   GET /openapi/v1/{omadacId}/sites/{siteId}/logs/alerts
 *   GET /openapi/v1/{omadacId}/sites/{siteId}/logs/events
 *
 * Both endpoints REQUIRE `filters.timeStart` + `filters.timeEnd` (epoch
 * milliseconds) plus `page` (>= 1) and `pageSize` (1..1000); omitting any of
 * them is an HTTP 400, which the client surfaces as an error rather than an
 * empty list.
 *
 * `filters` lists the optional server-side filters each endpoint honours.
 * Anything not listed here is never sent — the controller silently ignores
 * unknown filters, so sending one would look like a filter that works.
 *   alerts: module (System|Device|Client), level (Warning|Error|Information|
 *           Critical — case sensitive), resolved (true|false)
 *   events: module (System|Device|Client)
 */
export const LOG_DATASETS = {
  alerts: {
    path: '/logs/alerts',
    version: 'v1',
    kind: 'alerts',
    filters: ['module', 'level', 'resolved'],
    maxPageSize: 1000,
  },
  events: {
    path: '/logs/events',
    version: 'v1',
    kind: 'events',
    filters: ['module'],
    maxPageSize: 1000,
  },
};

/** Names accepted by the readSiteConfiguration dataset enum. */
export const CONFIG_DATASET_NAMES = Object.keys(CONFIG_DATASETS);
