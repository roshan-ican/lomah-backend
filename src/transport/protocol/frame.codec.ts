export const FRAME_SIZE = 9;
export const HEADER = 0x24;
export const TRAILER = 0x23;

export const CMD_PLAY = 0x50;
export const CMD_STOP = 0x53;
export const CMD_HIT = 0x4c;
export const CMD_RESEND = 0x52;
export const CMD_TELEMETRY = 0x3a;


export const CMD_GET_WIPER = 0x47;

export const CMD_WRITE_WIPER = 0x57;

export const CMD_SELF_TEST = 0x54;
export const CMD_HEARTBEAT = 0x48;

export const CMD_DEV_DATA = 0x44;

export const WIPER_PAGE_A = 0x41; // ASCII 'A'
export const WIPER_PAGE_B = 0x42; // ASCII 'B'

export const WIPERS_PER_PAGE = 5;

const CRC_CONST = 0x24;


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
  bulletCounter: number;
  rawX: number;
  rawY: number;
  payload: readonly number[];
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


export const buildDevDataFrame = (shot: number): Buffer =>
  buildFrame(CMD_DEV_DATA, [shot & 0xff, 0, 0, 0, 0]);

/** A 'D' reply's byte[2] — bitmask L4 L3 L2 L1 R4 R3 R2 R1 (bit 0 = R1). */
export function decodeDevData(payload: readonly number[]): number {
  return payload[0] ?? 0;
}


export function decodeWiperPage(payload: readonly number[]): number[] {
  return payload.slice(0, WIPERS_PER_PAGE);
}

export type SelfTestOutcome = 'PASSED' | 'FAILED' | 'NOT_ARMED';

export interface SelfTestReply {
  outcome: SelfTestOutcome;
  xMm: number;
  yMm: number;
}

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


export function* decodeDatagram(msg: Buffer): Generator<DecodeResult> {
  for (let offset = 0; offset + FRAME_SIZE <= msg.length; offset += FRAME_SIZE) {
    yield decodeFrame(msg.subarray(offset, offset + FRAME_SIZE));
  }
}

export function hex(b: number | undefined): string {
  return b === undefined ? '??' : (b & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

export function formatFrame(pkt: Buffer): string {
  return Array.from(pkt, (b) => hex(b)).join(' ');
}
