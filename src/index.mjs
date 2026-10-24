#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { certificateAgent, redact } from './core.mjs';
import { CONFIG_DATASETS, CONFIG_DATASET_NAMES, LOG_DATASETS } from './datasets.mjs';
import { logToolSpecs } from './log-tools.mjs';
import { OmadaClient } from './omada-client.mjs';
import { createToolRegistrar } from './tool.mjs';
import { registerWriteTools } from './write-tools.mjs';
import { writesEnabled as writeFlag } from './write-guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Config/PEM live at the package root (one level above src/), matching setup.mjs.
const root = dirname(here);
const CONFIG_PATH = process.env.OMADA_CONFIG ?? join(root, 'controller.json');
const PEM_PATH = process.env.OMADA_PEM ?? join(root, 'controller.pem');

// Read the write-mode flag once, up front. It decides both which tools are
// registered and what the server reports. Default is read-only.
const ENABLE_WRITES = writeFlag();

/** Fixed dataset registry: known read paths, version, and pagination behaviour. */
const DATASETS = CONFIG_DATASETS;

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
    enableWrites: writeFlag(),
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
      'Omada inventory over the Open API. Read tools are always available. ' +
      (ENABLE_WRITES
        ? 'WRITE tools are REGISTERED (OMADA_ENABLE_WRITES=true): each is dry-run by default and only sends when you pass confirm:true. Verify reads before and after writes.'
        : 'This server is READ-ONLY: no write tools are registered, and every outbound request is restricted to GET plus the OAuth token endpoint.'),
  },
);

const siteSchema = z.object({ siteId: z.string().min(1) }).strict();
const datasetSchema = z
  .object({ siteId: z.string().min(1).optional(), dataset: z.enum(CONFIG_DATASET_NAMES) })
  .strict();

// Every read tool is registered through this one helper, so they all share
// the same redaction and visible-error handling. See src/tool.mjs.
const tool = createToolRegistrar(server, sanitize);

// Write tool names, filled in below when (and only when) writes are enabled.
// Declared here so getConnectionStatus can report the real tool surface.
const writeToolNames = [];

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
      mode: ENABLE_WRITES ? 'write-enabled' : 'read-only',
      writesEnabled: ENABLE_WRITES,
      baseUrl: baseUrl ?? null,
      omadacId: omadacId ?? null,
      certificatePinned: Boolean(certificateSha256 && pemPresent),
      authMode: accessToken ? 'access-token' : clientId ? 'client-credentials' : 'missing',
      configured: missing.length === 0,
      missing,
      configPath: CONFIG_PATH,
      // Datasets readable through readSiteConfiguration, and the site log
      // endpoints behind getAlerts/getEvents.
      datasets: Object.keys(DATASETS).length,
      logDatasets: Object.keys(LOG_DATASETS).length,
      // The number of tools this server actually registered, so the report
      // cannot drift from the real tool surface. Write tools are only
      // registered when OMADA_ENABLE_WRITES=true, so the count reflects that.
      tools: tool.names.length + writeToolNames.length,
      authenticated: 'not tested by this tool',
      setupHint: missing.length ? 'run: node setup.mjs https://<controller-url>' : undefined,
      writeHint: ENABLE_WRITES
        ? 'Write tools are registered; each is dry-run until confirm:true.'
        : undefined,
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

// Site log tools (getAlerts / getEvents). The specs live in src/log-tools.mjs
// so the same registration path can be exercised in the tests; they are
// registered through the shared `tool()` helper like every other read tool.
for (const spec of logToolSpecs({ getClient: () => get(), secrets: secretsInUse })) {
  tool(spec.name, spec.description, spec.schema, spec.handler);
}

if (Object.keys(LOG_DATASETS).join(',') !== 'alerts,events') {
  throw new Error('Unexpected site log dataset registry.');
}

// Write tools exist only when the operator has explicitly opted in via
// OMADA_ENABLE_WRITES=true. A read-only server never registers them at all.
// get is passed as a lazy thunk so a missing config yields a per-call error
// instead of crashing the server at startup.
if (ENABLE_WRITES) {
  writeToolNames.push(...registerWriteTools(server, () => get()));
}

const transport = new StdioServerTransport();
await server.connect(transport);
