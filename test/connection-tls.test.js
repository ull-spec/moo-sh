'use strict';

/*
 * Integration test for src/main/connection.js's TLS support (implicit TLS
 * only, i.e. a dedicated secure port — not telnet STARTTLS).
 *
 * Spins up a real tls.createServer() with a throwaway self-signed cert
 * (generated via `openssl req`, since Node core has no built-in X.509 issuer)
 * and exercises both directions of the one security-relevant behavior:
 *
 *   - tlsAllowInsecure: true  -> connects and round-trips data through a
 *     self-signed cert (proves the TLS wiring actually works end-to-end).
 *   - tlsAllowInsecure: false (the default) -> the SAME self-signed cert is
 *     REJECTED and 'connect' never fires. This is the important regression
 *     guard: it proves cert validation is genuinely on by default, not
 *     silently bypassed.
 *
 * Skips (does not fail) if `openssl` isn't on PATH, since it's a test-fixture
 * dependency, not a runtime one — this module never shells out itself.
 *
 * Plain Node, no framework. Exits non-zero on any failure (skips exit 0).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { execFileSync } = require('child_process');
const { createConnection } = require('../src/main/connection');

let pass = 0;
let fail = 0;
function check(desc, cond) {
  if (cond) {
    pass += 1;
    console.log('PASS: ' + desc);
  } else {
    fail += 1;
    console.log('FAIL: ' + desc);
  }
}

function haveOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

// Self-signed cert/key for 127.0.0.1, valid 1 day, no passphrase.
function makeSelfSignedCert(dir) {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
  ], { stdio: 'ignore' });
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function makeEchoTlsServer(certKey) {
  const server = tls.createServer(certKey, (sock) => {
    sock.on('data', (chunk) => sock.write(chunk));
  });
  return server;
}

async function testInsecureAllowedConnectsAndRoundTrips(certKey) {
  const server = makeEchoTlsServer(certKey);
  await listen(server);
  const port = server.address().port;

  const conn = createConnection({
    host: '127.0.0.1', port, charset: 'utf8', tls: true, tlsAllowInsecure: true,
  });

  const received = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for echoed line')), 5000);
    conn.on('line', (line) => { clearTimeout(timer); resolve(line); });
    conn.on('error', (err) => { clearTimeout(timer); reject(err); });
    conn.on('connect', () => conn.send('hello over tls'));
    conn.connect();
  });

  check('tlsAllowInsecure:true — connects through a self-signed cert and round-trips data',
    received === 'hello over tls');

  conn.disconnect();
  await close(server);
}

async function testStrictRejectsSelfSignedByDefault(certKey) {
  const server = makeEchoTlsServer(certKey);
  await listen(server);
  const port = server.address().port;

  // No tlsAllowInsecure passed at all — must default to strict validation.
  const conn = createConnection({ host: '127.0.0.1', port, charset: 'utf8', tls: true });

  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 5000);
    conn.on('connect', () => { clearTimeout(timer); resolve('connected'); });
    conn.on('error', () => { clearTimeout(timer); resolve('error'); });
    conn.connect();
  });

  check('tlsAllowInsecure defaults to strict — a self-signed cert is REJECTED, not silently accepted',
    outcome === 'error');

  conn.disconnect();
  await close(server);
}

async function runAsyncTests() {
  if (!haveOpenssl()) {
    console.log('SKIP: openssl not found on PATH — skipping TLS integration tests');
    console.log('');
    console.log(`${pass} passed, ${fail} failed (skipped)`);
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mush-tls-'));
  try {
    const certKey = makeSelfSignedCert(dir);
    await testInsecureAllowedConnectsAndRoundTrips(certKey);
    await testStrictRejectsSelfSignedByDefault(certKey);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('ALL TESTS PASSED');
}

runAsyncTests().catch((err) => {
  console.log('FAIL: async TLS tests threw: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
