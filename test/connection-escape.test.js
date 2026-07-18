'use strict';

/*
 * Regression test for outgoing IAC escaping in src/main/connection.js.
 *
 * A literal 0xFF byte in outgoing data (e.g. iconv-encoded U+00FF under the
 * default latin1 charset) must be doubled before hitting the socket, or the
 * server's telnet parser reads it as a lone IAC command introducer. Covers
 * escapeIac() directly rather than a live socket, since it's a pure
 * byte-transform with no telnet/net dependency.
 *
 * Also covers two connection.js safety fixes via a real loopback TCP server:
 *   - an invalid/unknown `charset` must not crash construction or the first
 *     decode/encode call; it silently falls back to latin1.
 *   - a valid, non-default charset (utf8) must still work exactly as before
 *     (no regression from the charset-validation fallback logic).
 *   - disconnect() must still result in a normal 'close' event (graceful
 *     end(), not an immediate destroy()).
 *
 * Plain Node, no framework. Exits non-zero on any failure.
 */

const net = require('net');
const { escapeIac, createConnection } = require('../src/main/connection');

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

// --- no 0xFF present: fast path returns the same buffer reference ----------
{
  const input = Buffer.from([1, 2, 3]);
  const output = escapeIac(input);
  check('no-FF: returns identical buffer reference (zero-copy)', output === input);
}

// --- empty buffer -----------------------------------------------------------
{
  const input = Buffer.alloc(0);
  const output = escapeIac(input);
  check('empty buffer: returns identical reference', output === input);
}

// --- single 0xFF is doubled ---------------------------------------------------
{
  const input = Buffer.from([1, 2, 0xff, 3]);
  const output = escapeIac(input);
  check('single FF: output is [1,2,FF,FF,3]', Buffer.compare(output, Buffer.from([1, 2, 0xff, 0xff, 3])) === 0);
  check('single FF: output length grew by 1', output.length === input.length + 1);
}

// --- multiple 0xFF bytes, including adjacent and leading/trailing -----------
{
  const input = Buffer.from([0xff, 0xff, 1, 0xff]);
  const output = escapeIac(input);
  check('multi FF: output is [FF,FF,FF,FF,1,FF,FF]',
    Buffer.compare(output, Buffer.from([0xff, 0xff, 0xff, 0xff, 1, 0xff, 0xff])) === 0);
}

// --- all-0xFF buffer ----------------------------------------------------------
{
  const input = Buffer.from([0xff, 0xff, 0xff]);
  const output = escapeIac(input);
  check('all-FF: doubles every byte', Buffer.compare(output, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])) === 0);
}

// --- realistic case: latin1-encoded U+00FF ("\xFF") from iconv-lite --------
{
  const iconv = require('iconv-lite');
  const encoded = iconv.encode('hÿi\r\n', 'latin1'); // -> 68 FF 69 0D 0A
  const output = escapeIac(encoded);
  check('latin1 U+00FF: original single 0xFF is doubled',
    Buffer.compare(output, Buffer.from([0x68, 0xff, 0xff, 0x69, 0x0d, 0x0a])) === 0);
}

// --- helpers for the async loopback-server tests below ---------------------

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// A plain echo server: whatever bytes it receives, it writes straight back.
// Default allowHalfOpen:false means a FIN from the client auto-ends the
// server's writable side too, so a client end() results in a full graceful
// close without needing the client's destroy() fallback to fire.
function makeEchoServer() {
  const server = net.createServer((sock) => {
    sock.on('data', (chunk) => sock.write(chunk));
  });
  return server;
}

function waitForLine(conn, textToSend) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for echoed line')), 3000);
    conn.on('line', (line) => {
      clearTimeout(timer);
      resolve(line);
    });
    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    conn.on('connect', () => conn.send(textToSend));
    conn.connect();
  });
}

// --- M1: invalid charset must not crash, and falls back to latin1 ----------
async function testBogusCharsetDoesNotCrash() {
  const server = makeEchoServer();
  await listen(server);
  const port = server.address().port;

  let threw = false;
  let conn;
  try {
    conn = createConnection({ host: '127.0.0.1', port, charset: 'this-is-not-a-real-charset' });
  } catch (err) {
    threw = true;
  }
  check('bogus charset: createConnection does not throw at construction', !threw);

  const received = await waitForLine(conn, 'hello world');
  check(
    'bogus charset: ASCII round-trips correctly (fell back to latin1, pipeline still works)',
    received === 'hello world'
  );

  conn.disconnect();
  await close(server);
}

// --- regression: a valid, non-default charset still works as before -------
async function testValidUtf8CharsetUnaffected() {
  const server = makeEchoServer();
  await listen(server);
  const port = server.address().port;

  const conn = createConnection({ host: '127.0.0.1', port, charset: 'utf8' });
  const received = await waitForLine(conn, 'café');
  check('utf8 charset: accented character round-trips correctly (no regression)', received === 'café');

  conn.disconnect();
  await close(server);
}

// --- nitpick: disconnect() still closes gracefully (end(), not destroy()) --
async function testGracefulDisconnectStillCloses() {
  const server = makeEchoServer();
  await listen(server);
  const port = server.address().port;

  const conn = createConnection({ host: '127.0.0.1', port, charset: 'utf8' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for connect')), 3000);
    conn.on('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    conn.connect();
  });

  let threw = false;
  const closed = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    conn.on('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
    try {
      conn.disconnect();
    } catch (err) {
      threw = true;
    }
  });

  check('disconnect: does not throw', !threw);
  check('disconnect: close event still fires (graceful end(), not stuck)', closed);

  await close(server);
}

async function runAsyncTests() {
  await testBogusCharsetDoesNotCrash();
  await testValidUtf8CharsetUnaffected();
  await testGracefulDisconnectStillCloses();
}

runAsyncTests()
  .catch((err) => {
    fail += 1;
    console.log('FAIL: async connection tests threw: ' + (err && err.stack ? err.stack : err));
  })
  .then(() => {
    console.log('');
    console.log(`${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
    console.log('ALL TESTS PASSED');
  });
