'use strict';

/*
 * Telnet negotiation — REFUSE-EVERYTHING policy.
 *
 * This client speaks to PennMUSH/TinyMUSH-family servers over a plain telnet
 * stream that we hand-roll on top of Node's `net`. We deliberately negotiate
 * NOTHING: no MCCP, no NAWS, no terminal-type, no charset, no EOR — nothing.
 * The servers we target work perfectly with zero options enabled, so the
 * simplest correct behaviour is to politely decline every option the server
 * offers or requests and to strip all in-band telnet command sequences out of
 * the application data stream before it is decoded and displayed.
 *
 * Concretely:
 *   IAC DO   x  -> we reply IAC WONT x  (we will not do option x)
 *   IAC WILL x  -> we reply IAC DONT x  (please don't do option x)
 *   IAC DONT x  -> no reply (we already weren't doing it)
 *   IAC WONT x  -> no reply (fine, we didn't want it either)
 *   IAC SB..SE  -> whole subnegotiation is dropped, no reply
 *   IAC IAC     -> a single literal 0xFF byte in the data (escaped 255)
 *   IAC <cmd>   -> other single-byte commands (GA, NOP, ...) are dropped
 *
 * The filter is STATEFUL: TCP does not respect message boundaries, so any of
 * the sequences above can be split across chunk boundaries (a lone trailing
 * IAC, an IAC DO whose option byte arrives next chunk, or an SB that has not
 * yet seen its terminating IAC SE). We keep the partial-parse state in the
 * closure and resume on the next process() call. We never throw on a split
 * sequence — we buffer and wait.
 */

// Telnet protocol constants.
const IAC = 255; // Interpret As Command
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250; // Subnegotiation Begin
const SE = 240; // Subnegotiation End
const GA = 249; // Go Ahead
const NOP = 241; // No Operation

// Sanity cap on subnegotiation length. This client refuses ALL options per
// its REFUSE-EVERYTHING policy, so no legitimate SB payload we'd ever
// meaningfully act on can approach this size — it exists purely to bound how
// long we stay stuck waiting for a terminating IAC SE that a malformed or
// malicious server might never send (see S_SB / S_SB_IAC below).
const MAX_SB_LEN = 4096;

// Internal parser states.
const S_DATA = 0; // normal application bytes
const S_IAC = 1; // saw IAC, waiting for the command byte
const S_OPT = 2; // saw IAC + (DO|DONT|WILL|WONT), waiting for the option byte
const S_SB = 3; // inside a subnegotiation, consuming until IAC SE
const S_SB_IAC = 4; // inside a subnegotiation, saw an IAC, waiting for SE (or escaped IAC)

/**
 * Create a stateful telnet filter.
 *
 * @returns {{ process: (chunk: Buffer) => { data: Buffer, reply: Buffer } }}
 */
function createTelnetFilter() {
  // Parser state persists across process() calls so split sequences resume.
  let state = S_DATA;
  // When in S_OPT, remembers which of DO/DONT/WILL/WONT we saw.
  let negotiation = 0;
  // Counts bytes consumed since entering S_SB, so an unterminated
  // subnegotiation can be abandoned instead of hanging forever. Persists
  // across process() calls like `state`, since a subnegotiation can span
  // chunk boundaries.
  let sbLen = 0;

  function process(chunk) {
    if (!chunk || chunk.length === 0) {
      return { data: Buffer.alloc(0), reply: Buffer.alloc(0) };
    }

    // Collect output bytes into plain arrays, then materialise Buffers once.
    const out = [];
    const rep = [];

    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];

      switch (state) {
        case S_DATA:
          if (b === IAC) {
            state = S_IAC;
          } else {
            out.push(b);
          }
          break;

        case S_IAC:
          if (b === IAC) {
            // Escaped 255: emit a single literal 0xFF into the data.
            out.push(IAC);
            state = S_DATA;
          } else if (b === DO || b === DONT || b === WILL || b === WONT) {
            negotiation = b;
            state = S_OPT;
          } else if (b === SB) {
            state = S_SB;
            sbLen = 0;
          } else {
            // Any other single-byte command (GA, NOP, SE seen loose, etc.):
            // consume it silently, no reply.
            state = S_DATA;
          }
          break;

        case S_OPT: {
          // b is the option byte. Refuse per policy.
          if (negotiation === DO) {
            rep.push(IAC, WONT, b);
          } else if (negotiation === WILL) {
            rep.push(IAC, DONT, b);
          }
          // DONT / WONT: no reply.
          negotiation = 0;
          state = S_DATA;
          break;
        }

        case S_SB:
          sbLen++;
          if (sbLen > MAX_SB_LEN) {
            // Unterminated subnegotiation exceeded the sanity cap: abandon it
            // and recover to S_DATA so real application data starts flowing
            // again. We drop this triggering byte and resume interpretation
            // from the NEXT byte (rather than reprocessing this one as a
            // fresh S_DATA byte) — we have no way to know whether this byte
            // is mid-sequence garbage or the start of real data, and treating
            // it as still-abandoned garbage is the simpler, safer default.
            state = S_DATA;
            sbLen = 0;
            break;
          }
          if (b === IAC) {
            state = S_SB_IAC;
          }
          // else: subnegotiation payload byte, dropped.
          break;

        case S_SB_IAC:
          sbLen++;
          if (sbLen > MAX_SB_LEN) {
            // Same abandon-and-recover logic as S_SB above.
            state = S_DATA;
            sbLen = 0;
            break;
          }
          if (b === SE) {
            // End of subnegotiation.
            state = S_DATA;
            sbLen = 0;
          } else if (b === IAC) {
            // Escaped IAC inside SB payload — stay in SB, still dropping.
            state = S_SB;
          } else {
            // Some other IAC <cmd> embedded in SB; ignore and keep scanning.
            state = S_SB;
          }
          break;

        default:
          // Should be unreachable; recover defensively.
          state = S_DATA;
          out.push(b);
          break;
      }
    }

    return {
      data: out.length ? Buffer.from(out) : Buffer.alloc(0),
      reply: rep.length ? Buffer.from(rep) : Buffer.alloc(0),
    };
  }

  return { process };
}

module.exports = {
  IAC,
  DONT,
  DO,
  WONT,
  WILL,
  SB,
  SE,
  GA,
  NOP,
  createTelnetFilter,
};
