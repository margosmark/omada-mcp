#!/usr/bin/env node
// Fetch the controller's public identity + leaf certificate, then pin it.
// Prints the SHA-256 so you can verify it against the controller/browser
// BEFORE entering any credentials. Nothing is transmitted beyond these reads.
import { X509Certificate } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:tls';
import { request } from 'node:https';

const here = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base || !/^https?:\/\//.test(base)) {
  console.error('Usage: node setup.mjs https://<controller-host>:8043');
  process.exit(1);
}
const url = new URL(base.replace(/\/$/, ''));
const port = Number(url.port) || 443;

function getInfo() {
  return new Promise((resolve, reject) => {
    const req = request(
      { method: 'GET', hostname: url.hostname, port, path: '/api/info', rejectUnauthorized: false },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            if (body.errorCode !== 0) reject(new Error(`api/info returned ${body.errorCode}`));
            else resolve(body.result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function getLeaf() {
  return new Promise((resolve, reject) => {
    const sock = connect(
      { host: url.hostname, port, servername: url.hostname, rejectUnauthorized: false },
      () => {
        const raw = Buffer.from(sock.getPeerCertificate(false).raw);
        sock.end();
        resolve(raw);
      },
    );
    sock.on('error', reject);
  });
}

async function main() {
  const info = await getInfo();
  const der = await getLeaf();
  const x509 = new X509Certificate(der);
  const fingerprint = x509.fingerprint256.replaceAll(':', '').toLowerCase();
  const pem = x509.toString();

  writeFileSync(
    join(here, 'controller.json'),
    JSON.stringify(
      {
        baseUrl: url.toString().replace(/\/$/, ''),
        controllerId: info.omadacId,
        controllerVersion: info.controllerVer,
        certificateSha256: fingerprint,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  writeFileSync(join(here, 'controller.pem'), pem, { mode: 0o600 });

  console.log(`Controller:  ${url.toString().replace(/\/$/, '')}`);
  console.log(`  Version:   ${info.controllerVer}`);
  console.log(`  omadacId:  ${info.omadacId}`);
  console.log(`  Cert SHA:  ${fingerprint}`);
  console.log('');
  console.log('Wrote controller.json and controller.pem.');
  console.log('VERIFY this SHA-256 against your controller/browser BEFORE entering credentials.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
