import { describe, expect, it } from 'vitest';

import {
  buildGetWiperFrame,
  buildSelfTestFrame,
  buildWriteWiperFrame,
  CMD_GET_WIPER,
  CMD_SELF_TEST,
  decodeDatagram,
  decodeFrame,
  decodeSelfTest,
  decodeWiperPage,
} from './frame.codec';

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex.split(/\s+/).map((b) => parseInt(b, 16)));
}

describe('frame.codec — wiper/self-test opcodes', () => {
  // Every byte sequence below was captured against real hardware over Packet
  // Sender this session, not derived from the vendor doc — see the header
  // comments on CMD_GET_WIPER/CMD_WRITE_WIPER in frame.codec.ts for why the
  // doc's own 'W' example is known to be wrong.

  it('builds the exact GET_WIPER page A frame that was sent to the board', () => {
    expect(buildGetWiperFrame('A')).toEqual(
      hexToBuffer('24 47 41 00 00 00 00 AC 23'),
    );
  });

  it('builds the exact GET_WIPER page B frame that was sent to the board', () => {
    expect(buildGetWiperFrame('B')).toEqual(
      hexToBuffer('24 47 42 00 00 00 00 AD 23'),
    );
  });

  it('builds the exact WRITE_WIPER frame that produced a confirmed write', () => {
    // W, page A, wiper 2, value 30 — the board's page A wiper 2 moved from 20
    // to 30 in response to exactly this frame.
    expect(buildWriteWiperFrame('A', 2, 30)).toEqual(
      hexToBuffer('24 57 41 02 1E 00 00 DC 23'),
    );
  });

  it('decodes the captured GET_WIPER reply into the right page contents', () => {
    // Rx 24 47 0A 1E 0A 0A 0B B2 23 — the G-shaped reply to the write above,
    // proving page A is now [10, 30, 10, 10, 11].
    const result = decodeFrame(hexToBuffer('24 47 0A 1E 0A 0A 0B B2 23'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.command).toBe(CMD_GET_WIPER);
    expect(decodeWiperPage(result.frame.payload)).toEqual([10, 30, 10, 10, 11]);
  });

  it('builds the self-test frame', () => {
    expect(buildSelfTestFrame()).toEqual(hexToBuffer('24 54 00 00 00 00 00 78 23'));
  });

  it('decodeSelfTest reads NOT_ARMED from an unarmed board (0xFF)', () => {
    expect(decodeSelfTest([0xff, 0, 0, 0, 0]).outcome).toBe('NOT_ARMED');
  });

  it('decodeSelfTest reads FAILED from an armed-but-broken board (0x00)', () => {
    expect(decodeSelfTest([0x00, 0, 0, 0, 0]).outcome).toBe('FAILED');
  });

  it('decodeSelfTest reads PASSED with the documented stimulus position (~-150, ~600)', () => {
    // x = -150 => 0xFF6A big-endian; y = 600 => 0x0258 big-endian.
    const reply = decodeSelfTest([0x01, 0xff, 0x6a, 0x02, 0x58]);
    expect(reply.outcome).toBe('PASSED');
    expect(reply.xMm).toBe(-150);
    expect(reply.yMm).toBe(600);
  });

  it('decodeFrame accepts CMD_SELF_TEST inbound (it used to be UNKNOWN_COMMAND)', () => {
    const result = decodeFrame(hexToBuffer('24 54 01 FF 6A 02 58 3C 23'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.command).toBe(CMD_SELF_TEST);
  });

  it('still rejects a genuinely unknown command byte', () => {
    // 0x99 is not any recognised opcode. The CRC byte is irrelevant here —
    // decodeFrame checks the command whitelist BEFORE the checksum, so an
    // unknown command is rejected on its own terms rather than as a CRC
    // failure with a misleading reason.
    const result = decodeFrame(hexToBuffer('24 99 00 00 00 00 00 00 23'));
    expect(result).toEqual({ ok: false, reason: 'UNKNOWN_COMMAND' });
  });
});

describe('frame.codec — payload aliasing regression', () => {
  // The whole reason DecodedFrame.payload is built with Array.from rather
  // than a Buffer subarray: decodeDatagram hands decodeFrame a VIEW over a
  // shared datagram buffer, and one datagram can carry several frames back
  // to back. A view-based payload would let mutating (or reusing) the source
  // buffer silently corrupt an already-"decoded" result.

  it('two frames in one datagram decode to independent, non-aliased payloads', () => {
    const datagram = Buffer.concat([
      hexToBuffer('24 47 41 00 00 00 00 AC 23'), // GET_WIPER A request-shaped
      hexToBuffer('24 47 0A 1E 0A 0A 0B B2 23'), // GET_WIPER reply, page A = 10,30,10,10,11
    ]);

    const results = [...decodeDatagram(datagram)];
    expect(results).toHaveLength(2);
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(true);
    if (!results[0]!.ok || !results[1]!.ok) return;

    expect(results[0]!.frame.payload).toEqual([0x41, 0, 0, 0, 0]);
    expect(results[1]!.frame.payload).toEqual([0x0a, 0x1e, 0x0a, 0x0a, 0x0b]);

    // Mutate the SOURCE datagram after decoding. If payload were a view over
    // it, both results would now read back the poisoned bytes.
    datagram.fill(0xee);

    expect(results[0]!.frame.payload).toEqual([0x41, 0, 0, 0, 0]);
    expect(results[1]!.frame.payload).toEqual([0x0a, 0x1e, 0x0a, 0x0a, 0x0b]);
  });
});
