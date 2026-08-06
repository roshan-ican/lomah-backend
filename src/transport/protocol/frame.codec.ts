/**
 * LOMAH wire protocol — 9-byte frame codec.
 *
 * PORTED VERBATIM (in behaviour) from the original
 * `backend/services/lomah-sensor-command.ts`. Do not "clean up" the constants
 * or the CRC: they are dictated by firmware that is already deployed, and the
 * only authority on them is the hardware.
 *
 * Deliberately pure — no sockets, no Nest decorators, no I/O. That is what lets
 * the whole decode path be unit-tested without a target, a router, or a radio,
 * which matters a great deal now that some targets sit 200m downrange.
 *
 *   byte 0   header    0x24
 *   byte 1   command
 *   byte 2   bullet counter (single byte — WRAPS every 256 shots)
 *   byte 3   X high
 *   byte 4   X low
 *   byte 5   Y high
 *   byte 6   Y low
 *   byte 7   CRC
 *   byte 8   trailer   0x23
 *
 * The frame is FULL. There is no spare field for a lane or device id, which is
 * why a target's identity has to be resolved from how the frame arrived (source
 * IP for WiFi, node id for LoRa) rather than from the frame itself.
 */

export const FRAME_SIZE = 9;

export const HEADER = 0x24;
export const TRAILER = 0x23;

export const CMD_PLAY = 0x50;
export const CMD_STOP = 0x53;
export const CMD_HIT = 0x4c;
export const CMD_RESEND = 0x52;
export const CMD_TELEMETRY = 0x3a;

// Commissioning/diagnostic commands, verified against real hardware over
// Packet Sender (see lomah-nest/sensor-values.md for the vendor spec — treat
// its WORKED EXAMPLES as more trustworthy than its prose; the 'W' example
// below is wrong, and the capture is not).
/** Get Wiper Position — ask a page's five sensitivity trimmers. */
export const CMD_GET_WIPER = 0x47;
/** Write Wiper Position — set one trimmer on one page.
 *
 *  CONFIRMED BY CAPTURE: the device does NOT echo the write. It replies with a
 *  CMD_GET_WIPER-shaped frame carrying the whole updated page. The vendor
 *  doc's example (`Tx: W A 2 20 ... / Rx: W A 2 20 ...`) shows a literal echo
 *  and is simply wrong — trust the capture instead:
 *   Tx 24 57 41 02 1E 00 00 DC 23  (W, page A, wiper 2, value 30)
 *   Rx 24 47 0A 1E 0A 0A 0B B2 23  (G-shaped: page A is now 10,30,10,10,11)
 */
export const CMD_WRITE_WIPER = 0x57;
/** Self Test — the device's own timing-circuit check. Reports whether it is
 *  armed, whether the test passed, and the test stimulus's (x, y). */
export const CMD_SELF_TEST = 0x54;
/** Heartbeat — the board sends one at startup and echoes one when asked. */
export const CMD_HEARTBEAT = 0x48;
/** Developer options / per-shot diagnostic — request which sensors detected a
 *  given shot. Reply byte[2] is a bitmask L4 L3 L2 L1 R4 R3 R2 R1. */
export const CMD_DEV_DATA = 0x44;

export const WIPER_PAGE_A = 0x41; // ASCII 'A'
export const WIPER_PAGE_B = 0x42; // ASCII 'B'
/** How many trimmers exist on one page. A CMD_GET_WIPER reply carries exactly
 *  this many values — see decodeWiperPage. */
export const WIPERS_PER_PAGE = 5;

/** Seed for the XOR-style checksum. Fixed by firmware. */
const CRC_CONST = 0x24;

/**
 * Reinterpret a big-endian uint16 off the wire as a signed int16.
 *
 * Deliberately duplicated from `sensor/scoring.ts`'s `toSigned16`, not
 * imported: `sensor` already depends on `transport` (SensorModule imports
 * TransportModule), so the reverse import here would be a layering cycle at
 * the module-graph level. This file stays dependency-free by design — see the
 * header comment — and the function is two lines, cheap to keep in sync.
 */
function toSigned16(raw: number): number {
  const v = raw & 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
}

export type FrameCommand =
  | typeof CMD_PLAY
  | typeof CMD_STOP
  | typeof CMD_HIT
  | typeof CMD_RESEND
  | typeof CMD_TELEMETRY
  | typeof CMD_GET_WIPER
  | typeof CMD_WRITE_WIPER
  | typeof CMD_SELF_TEST
  | typeof CMD_HEARTBEAT
  | typeof CMD_DEV_DATA;

export interface DecodedFrame {
  command: number;
  /** Raw single-byte bullet counter, NOT yet unwrapped. See SequenceTracker.
   *  Meaningless outside CMD_HIT — for every other command this is simply
   *  payload[0], kept only because HIT is the hot path this shape predates. */
  bulletCounter: number;
  /** Raw big-endian uint16, before sign correction. Same caveat as above. */
  rawX: number;
  rawY: number;
  /** Bytes 2..6 verbatim, copied (never a Buffer view — see decodeFrame).
   *  bulletCounter/rawX/rawY are this same data reinterpreted as a HIT;
   *  anything shaped differently (wiper pages, self-test) reads this instead. */
  payload: readonly number[];
  /** All nine bytes verbatim, copied (never a Buffer view). What the admin
   *  console displays as the real wire frame. */
  bytes: readonly number[];
}

export type DecodeFailure =
  | 'BAD_HEADER'
  | 'BAD_TRAILER'
  | 'CRC_MISMATCH'
  | 'UNKNOWN_COMMAND';

export type DecodeResult =
  | { ok: true; frame: DecodedFrame }
  | { ok: false; reason: DecodeFailure; expectedCrc?: number; actualCrc?: number };

/**
 * Checksum over the command plus the five data bytes.
 *
 * Named CRC by the firmware; it is really a truncated additive checksum. Kept
 * bug-for-bug compatible with the deployed boards.
 */
export function calculateCrc(command: number, dataBytes: number[] = [0, 0, 0, 0, 0]): number {
  let crc = CRC_CONST + command;
  for (const byte of dataBytes) {
    crc += byte;
  }
  return crc & 0xff;
}

/** Build an outbound frame (PLAY / STOP / RESEND / simulated HIT). */
export function buildFrame(command: number, dataBytes: number[] = [0, 0, 0, 0, 0]): Buffer {
  const buf = Buffer.alloc(FRAME_SIZE);
  buf[0] = HEADER;
  buf[1] = command;
  buf[2] = dataBytes[0] ?? 0;
  buf[3] = dataBytes[1] ?? 0;
  buf[4] = dataBytes[2] ?? 0;
  buf[5] = dataBytes[3] ?? 0;
  buf[6] = dataBytes[4] ?? 0;
  buf[7] = calculateCrc(command, dataBytes);
  buf[8] = TRAILER;
  return buf;
}

export const buildPlayFrame = (): Buffer => buildFrame(CMD_PLAY);
export const buildStopFrame = (): Buffer => buildFrame(CMD_STOP);
export const buildResendFrame = (bullet: number): Buffer =>
  buildFrame(CMD_RESEND, [bullet & 0xff, 0, 0, 0, 0]);

/** Build a simulated HIT — used by the range simulators and bench tests. */
export function buildHitFrame(x: number, y: number, bulletCounter: number): Buffer {
  return buildFrame(CMD_HIT, [
    bulletCounter & 0xff,
    (x >> 8) & 0xff,
    x & 0xff,
    (y >> 8) & 0xff,
    y & 0xff,
  ]);
}

export type WiperPage = 'A' | 'B';
const wiperPageByte = (page: WiperPage): number =>
  page === 'A' ? WIPER_PAGE_A : WIPER_PAGE_B;

export const buildGetWiperFrame = (page: WiperPage): Buffer =>
  buildFrame(CMD_GET_WIPER, [wiperPageByte(page), 0, 0, 0, 0]);

/** `wiper` is 1-based (1..5), matching the firmware's own indexing. */
export const buildWriteWiperFrame = (
  page: WiperPage,
  wiper: number,
  value: number,
): Buffer =>
  buildFrame(CMD_WRITE_WIPER, [
    wiperPageByte(page),
    wiper & 0xff,
    value & 0xff,
    0,
    0,
  ]);

export const buildSelfTestFrame = (): Buffer => buildFrame(CMD_SELF_TEST);

export const buildHeartbeatFrame = (): Buffer => buildFrame(CMD_HEARTBEAT);

/** 'D' — request the developer's per-shot sensor diagnostic. `shot` is the
 *  1-based shot number (1..100) to ask about; the board answers with a bitmask
 *  of which of its 8 sensors detected it. */
export const buildDevDataFrame = (shot: number): Buffer =>
  buildFrame(CMD_DEV_DATA, [shot & 0xff, 0, 0, 0, 0]);

/** A 'D' reply's byte[2] — bitmask L4 L3 L2 L1 R4 R3 R2 R1 (bit 0 = R1). */
export function decodeDevData(payload: readonly number[]): number {
  return payload[0] ?? 0;
}

/**
 * The five wiper values carried in a CMD_GET_WIPER (or CMD_WRITE_WIPER's
 * G-shaped) reply. The reply does NOT say which page it is — the caller
 * already knows, because it is the one who asked.
 */
export function decodeWiperPage(payload: readonly number[]): number[] {
  return payload.slice(0, WIPERS_PER_PAGE);
}

export type SelfTestOutcome = 'PASSED' | 'FAILED' | 'NOT_ARMED';

export interface SelfTestReply {
  outcome: SelfTestOutcome;
  /** Signed millimetres of the test stimulus. ~-150 on a real pass. */
  xMm: number;
  /** Signed millimetres of the test stimulus. ~600 on a real pass. */
  yMm: number;
}

/**
 * payload[0]: 0xFF = device is in STOP mode (not armed — the test did not
 * run), 0x00 = armed but the test FAILED, 0x01 = armed and PASSED.
 * payload[1..2] / [3..4]: big-endian signed int16 (x, y) of the test
 * stimulus, meaningful only when armed.
 */
export function decodeSelfTest(payload: readonly number[]): SelfTestReply {
  const flag = payload[0] ?? 0;
  const outcome: SelfTestOutcome =
    flag === 0xff ? 'NOT_ARMED' : flag === 0x01 ? 'PASSED' : 'FAILED';
  return {
    outcome,
    xMm: toSigned16(((payload[1] ?? 0) << 8) | (payload[2] ?? 0)),
    yMm: toSigned16(((payload[3] ?? 0) << 8) | (payload[4] ?? 0)),
  };
}

/**
 * Commands this side of the link is willing to decode inbound. A Set, not a
 * chain of `!==`, so adding the next opcode is one line here rather than a
 * repeated-condition edit. CMD_RESEND is deliberately absent — the firmware
 * never sends it, only the server does, so an inbound RESEND has no meaning
 * and stays dropped as UNKNOWN_COMMAND, unchanged from before this file added
 * the wiper/self-test opcodes.
 */
const DECODABLE_COMMANDS = new Set<number>([
  CMD_PLAY,
  CMD_STOP,
  CMD_HIT,
  CMD_TELEMETRY,
  CMD_GET_WIPER,
  CMD_WRITE_WIPER,
  CMD_SELF_TEST,
  CMD_HEARTBEAT,
  CMD_DEV_DATA,
]);

/** Decode exactly one 9-byte frame. Callers slice; this never scans. */
export function decodeFrame(pkt: Buffer): DecodeResult {
  if (pkt.length < FRAME_SIZE || pkt[0] !== HEADER) {
    return { ok: false, reason: 'BAD_HEADER' };
  }
  if (pkt[8] !== TRAILER) {
    return { ok: false, reason: 'BAD_TRAILER' };
  }

  const command = pkt[1]!;
  if (!DECODABLE_COMMANDS.has(command)) {
    return { ok: false, reason: 'UNKNOWN_COMMAND' };
  }

  const actualCrc = pkt[7]!;
  const expectedCrc = calculateCrc(command, [
    pkt[2] ?? 0,
    pkt[3] ?? 0,
    pkt[4] ?? 0,
    pkt[5] ?? 0,
    pkt[6] ?? 0,
  ]);
  if (actualCrc !== expectedCrc) {
    return { ok: false, reason: 'CRC_MISMATCH', expectedCrc, actualCrc };
  }

  // Array.from COPIES — pkt is a subarray VIEW over a datagram that may carry
  // several concatenated frames (see decodeDatagram below). Retaining a
  // subarray here instead would alias that shared buffer: mutate or reuse it
  // for the next frame and every previously "decoded" payload would silently
  // change underneath its holder.
  const payload = Array.from(pkt.subarray(2, 7));

  return {
    ok: true,
    frame: {
      command,
      bulletCounter: pkt[2]!,
      rawX: ((pkt[3] ?? 0) << 8) | (pkt[4] ?? 0),
      rawY: ((pkt[5] ?? 0) << 8) | (pkt[6] ?? 0),
      payload,
      bytes: Array.from(pkt),
    },
  };
}

/**
 * A datagram may carry several frames back to back — the original code relied
 * on this, stepping 9 bytes at a time. Anything that is not a clean frame at a
 * 9-byte boundary is skipped rather than resynchronised, matching the deployed
 * behaviour.
 */
export function* decodeDatagram(msg: Buffer): Generator<DecodeResult> {
  for (let offset = 0; offset + FRAME_SIZE <= msg.length; offset += FRAME_SIZE) {
    yield decodeFrame(msg.subarray(offset, offset + FRAME_SIZE));
  }
}

/** Hex helper for trace logging. */
export function hex(b: number | undefined): string {
  return b === undefined ? '??' : (b & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

export function formatFrame(pkt: Buffer): string {
  return Array.from(pkt, (b) => hex(b)).join(' ');
}
