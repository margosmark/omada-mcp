#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { certificateAgent, redact } from './core.mjs';
import { OmadaClient } from './omada-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Config/PEM live at the package root (one level above src/), matching setup.mjs.
const root = dirname(here);
const CONFIG_PATH = process.env.OMADA_CONFIG ?? join(root, 'controller.json');
const PEM_PATH = process.env.OMADA_PEM ?? join(root, 'controller.pem');

/** Fixed dataset registry: known read paths, version, and pagination behaviour. */
const DATASETS = {
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

function readSecretFile(path) {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || (stats.mode & 0o077) || stats.uid !== process.getuid()) {
      throw new Error(`Credential file must be owned by you with mode 600: ${path}`);
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function config() {
  let parsed = {};
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read controller config at ${CONFIG_PATH}.`);
  }
  const baseUrl = process.env.OMADA_BASE_URL ?? parsed.baseUrl;
  const omadacId = process.env.OMADA_OMADAC_ID ?? parsed.controllerId;
  const certificateSha256 = process.env.OMADA_CERT_SHA256 ?? parsed.certificateSha256;
  if (!baseUrl) throw new Error(`Missing baseUrl. Run: node setup.mjs <controller-url> (config: ${CONFIG_PATH}).`);
  if (!omadacId) throw new Error('Missing omadacId. Run: node setup.mjs <controller-url>');
  if (!certificateSha256) throw new Error('Missing certificateSha256. Run: node setup.mjs <controller-url>');

  const fromEnv = {
    accessToken: process.env.OMADA_ACCESS_TOKEN,
    clientId: process.env.OMADA_CLIENT_ID,
    clientSecret: process.env.OMADA_CLIENT_SECRET,
  };
  const fromFile = readSecretFile(process.env.OMADA_CREDENTIALS ?? join(root, '.secrets/credentials.json'));
  const accessToken = fromEnv.accessToken ?? fromFile.accessToken;
  const clientId = fromEnv.clientId ?? fromFile.clientId;
  const clientSecret = fromEnv.clientSecret ?? fromFile.clientSecret;

  return { baseUrl, omadacId, certificateSha256, accessToken, clientId, clientSecret, pemPath: PEM_PATH };
}

let client;
function get() {
  if (client) return client;
  const c = config();
  let pem;
  try {
    pem = readFileSync(c.pemPath, 'utf8');
  } catch {
    throw new Error(`Missing pinned certificate at ${c.pemPath}. Run: node setup.mjs <controller-url>`);
  }
  const agent = certificateAgent(pem, c.certificateSha256);
  if (!c.accessToken && !c.clientId) {
    throw new Error('No credentials. Set OMADA_ACCESS_TOKEN or OMADA_CLIENT_ID + OMADA_CLIENT_SECRET.');
  }
  client = new OmadaClient({
    baseUrl: c.baseUrl,
    omadacId: c.omadacId,
    agent,
    accessToken: c.accessToken,
    clientId: c.clientId,
    clientSecret: c.clientSecret,
  });
  return client;
}

/** Redact any configured secrets before returning a tool result. */
function secretsInUse() {
  try {
    const c = config();
    return [c.accessToken, c.clientSecret].filter(Boolean);
  } catch {
    return [];
  }
}

function sanitize(value) {
  return redact(value, secretsInUse());
}

const server = new McpServer(
  { name: 'omada-mcp', version: '1.0.0' },
  {
    instructions:
      'Read-only Omada inventory over the Open API. No configuration writes, generic HTTP tools, reboots, or deletes are exposed. ' +
      'API errors and incomplete pagination are surfaced as errors, never as empty datasets.',
  },
);

const siteSchema = z.object({ siteId: z.string().min(1) }).strict();
const datasetSchema = z
  .object({ siteId: z.string().min(1).optional(), dataset: z.enum(Object.keys(DATASETS)) })
  .strict();

function tool(name, description, schema, handler) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await handler(args);
        return { content: [{ type: 'text', text: JSON.stringify(sanitize(result), null, 2) }] };
      } catch (error) {
        // Never serialise an Axios/error object: it can carry request headers.
        return { isError: true, content: [{ type: 'text', text: sanitize(error.message || 'Read failed.') }] };
      }
    },
  );
}

tool(
  'getConnectionStatus',
  'Report configured connection state without logging in or making a network call.',
  z.object({}).strict(),
  async () => {
    // Tolerant read: reports missing pieces instead of throwing, so this tool
    // works before `node setup.mjs` has been run.
    let parsed = {};
    try {
      parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      /* not set up yet */
    }
    const baseUrl = process.env.OMADA_BASE_URL ?? parsed.baseUrl;
    const omadacId = process.env.OMADA_OMADAC_ID ?? parsed.controllerId;
    const certificateSha256 = process.env.OMADA_CERT_SHA256 ?? parsed.certificateSha256;
    const fromEnv = {
      accessToken: process.env.OMADA_ACCESS_TOKEN,
      clientId: process.env.OMADA_CLIENT_ID,
      clientSecret: process.env.OMADA_CLIENT_SECRET,
    };
    const fromFile = readSecretFile(process.env.OMADA_CREDENTIALS ?? join(root, '.secrets/credentials.json'));
    const accessToken = fromEnv.accessToken ?? fromFile.accessToken;
    const clientId = fromEnv.clientId ?? fromFile.clientId;
    let pemPresent = false;
    try {
      statSync(process.env.OMADA_PEM ?? PEM_PATH);
      pemPresent = true;
    } catch {
      /* pem not generated yet */
    }

    const missing = [];
    if (!baseUrl) missing.push('baseUrl');
    if (!omadacId) missing.push('omadacId');
    if (!certificateSha256) missing.push('certificateSha256');
    if (!pemPresent) missing.push('controller.pem');

    return {
      mode: 'read-only',
      baseUrl: baseUrl ?? null,
      omadacId: omadacId ?? null,
      certificatePinned: Boolean(certificateSha256 && pemPresent),
      authMode: accessToken ? 'access-token' : clientId ? 'client-credentials' : 'missing',
      configured: missing.length === 0,
      missing,
      configPath: CONFIG_PATH,
      datasets: Object.keys(DATASETS).length,
      authenticated: 'not tested by this tool',
      setupHint: missing.length ? 'run: node setup.mjs https://<controller-url>' : undefined,
      credentialHint:
        accessToken || clientId
          ? undefined
          : 'set OMADA_ACCESS_TOKEN, or OMADA_CLIENT_ID + OMADA_CLIENT_SECRET',
    };
  },
);

tool(
  'listSites',
  'List sites available to the configured credential.',
  z.object({}).strict(),
  async () => (await get()).listSites(),
);

tool('listDevices', 'List adopted devices for the selected site.', siteSchema, async ({ siteId }) => {
  const c = get();
  const sites = await c.listSites();
  if (!sites.some((s) => s.siteId === siteId)) throw new Error('siteId is not in the accessible site list.');
  return c.listDevices(siteId);
});

tool(
  'listClients',
  'List active clients for the selected site.',
  siteSchema,
  async ({ siteId }) => {
    const c = get();
    const sites = await c.listSites();
    if (!sites.some((s) => s.siteId === siteId)) throw new Error('siteId is not in the accessible site list.');
    return c.listClients(siteId);
  },
);

tool(
  'getLanNetworks',
  'Read VLAN/subnet/DHCP settings for the selected site. Contains no SSID passwords.',
  siteSchema,
  async ({ siteId }) => (await get()).getLanNetworks(siteId),
);

tool(
  'readSiteConfiguration',
  'Read one fixed configuration dataset. No arbitrary paths or methods; unknown datasets are rejected.',
  datasetSchema,
  async ({ siteId, dataset }) => {
    const c = get();
    const sites = await c.listSites();
    if (!sites.some((s) => s.siteId === siteId)) throw new Error('siteId is not in the accessible site list.');
    return c.readDataset(siteId, DATASETS[dataset]);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
