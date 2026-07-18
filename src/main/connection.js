'use strict';

/*
 * Connection — a single MU* TCP session.
 *
 * Wraps a net.Socket and owns the byte pipeline for one server connection:
 *   socket 'data'
 *     -> emit 'raw' (original chunk, for the capture log)
 *     -> telnet filter (strip/refuse all IAC, write any refusal reply back)
 *     -> accumulate filtered bytes, split into complete lines at the BYTE level
 *     -> decode each complete line with iconv-lite and emit 'line'
 *
 * Line splitting happens on raw bytes BEFORE decoding so a multibyte character
 * is never chopped across a chunk boundary: we only ever hand iconv-lite whole
 * lines. Any trailing partial line is retained in the accumulator for the next
 * chunk.
 *
 * The main process owns the network; renderers are display-only. This module
 * emits decoded lines and lets the caller (router/window-manager) fan them out.
 */

const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');
const iconv = require('iconv-lite');

const { createTelnetFilter } = require('./telnet-negotiation');
const { createLineSplitter } = require('./line-splitter');

const CR = 0x0d; // \r
const IAC = 0xff; // Interpret As Command

// Double every literal 0xFF byte in outgoing data so the server's telnet
// parser can't mistake it for an IAC introducer (e.g. the character U+00FF
// encodes to a lone 0xFF under latin1). Zero-copy when no 0xFF is present.
function escapeIac(buffer) {
  let count = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === IAC) count++;
  }
  if (count === 0) return buffer;

  const out = Buffer.alloc(buffer.length + count);
  let j = 0;
  for (let i = 0; i < buffer.length; i++) {
    out[j++] = buffer[i];
    if (buffer[i] === IAC) out[j++] = IAC;
  }
  return out;
}

/**
 * @param {{ host: string, port: number, charset?: string, tls?: boolean,
 *           tlsAllowInsecure?: boolean }} opts `tls` connects via implicit
 *   TLS (a dedicated secure port — NOT telnet STARTTLS, which this client
 *   does not implement). `tlsAllowInsecure` skips certificate verification
 *   (self-signed certs), which defeats TLS's protection against a
 *   man-in-the-middle and is opt-in only, never the default.
 * @returns {EventEmitter} emits 'connect' | 'raw' | 'line' | 'close' | 'error'
 */
function createConnection({ host, port, charset, tls: useTls, tlsAllowInsecure }) {
  const emitter = new EventEmitter();
  const enc = (typeof charset === 'string' && charset && iconv.encodingExists(charset)) ? charset : 'latin1';

  let socket = null;
  let filter = null;
  let splitter = null; // stateful byte-level line splitter for pending filtered bytes

  function decodeLine(bytes) {
    // Strip a trailing CR (servers send CRLF); split already removed the LF.
    let end = bytes.length;
    if (end > 0 && bytes[end - 1] === CR) end -= 1;
    const slice = end === bytes.length ? bytes : bytes.subarray(0, end);
    return iconv.decode(slice, enc);
  }

  function handleFiltered(data) {
    if (!data || data.length === 0) return;
    for (const lineBytes of splitter.push(data)) {
      emitter.emit('line', decodeLine(lineBytes));
    }
  }

  function onData(chunk) {
    // 1. Raw first, exactly as received, before any stripping.
    emitter.emit('raw', chunk);

    // 2. Telnet filter: strip IAC sequences, send refusal replies.
    const { data, reply } = filter.process(chunk);
    if (reply.length && socket && !socket.destroyed) {
      try {
        socket.write(reply);
      } catch (err) {
        emitter.emit('error', err);
      }
    }

    // 3. Line-split on bytes, decode, emit.
    handleFiltered(data);
  }

  function connect() {
    if (socket) return; // already connecting/connected
    filter = createTelnetFilter();
    splitter = createLineSplitter();

    // TLSSocket extends net.Socket (same data/write/end/destroy surface), so
    // everything below this point — telnet filtering, line splitting, send(),
    // disconnect() — is identical regardless of which path created it. The
    // only difference is which event marks "actually ready to send data":
    // a plaintext socket is ready on the raw TCP 'connect', a TLS one only
    // after the handshake finishes ('secureConnect') — writing earlier would
    // still work (Node buffers it) but 'connect' firing on TLSSocket doesn't
    // by itself mean the cert was validated yet, so we wait for the real
    // "ready" signal before telling the caller we're connected.
    if (useTls) {
      socket = tls.connect({ host, port, rejectUnauthorized: !tlsAllowInsecure });
      socket.on('secureConnect', () => emitter.emit('connect'));
    } else {
      socket = net.createConnection({ host, port });
      socket.on('connect', () => emitter.emit('connect'));
    }
    socket.on('data', onData);
    socket.on('error', (err) => emitter.emit('error', err));
    socket.on('close', () => {
      socket = null;
      emitter.emit('close');
    });
  }

  function send(text) {
    if (!socket || socket.destroyed) return; // no-op if not connected
    const payload = escapeIac(iconv.encode((text == null ? '' : String(text)) + '\r\n', enc));
    try {
      socket.write(payload);
    } catch (err) {
      emitter.emit('error', err);
    }
  }

  function disconnect() {
    if (!socket) return;
    const s = socket;
    try {
      s.end();
      const t = setTimeout(() => {
        if (s && !s.destroyed) s.destroy();
      }, 2000);
      if (typeof t.unref === 'function') t.unref();
    } catch (err) {
      emitter.emit('error', err);
    }
  }

  emitter.connect = connect;
  emitter.send = send;
  emitter.disconnect = disconnect;
  return emitter;
}

module.exports = { createConnection, escapeIac };
