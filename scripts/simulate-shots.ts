/**
 * Bench simulator — pretends to be a target board.
 *
 * Sends real 9-byte HIT frames over UDP to the running server, so the whole
 * ingestion path (decode -> resolve -> sequence -> score -> persist -> emit)
 * runs exactly as it will with hardware. Nothing here is mocked or stubbed.
 *
 * Run:
 *   npx tsx scripts/simulate-shots.ts            # 5 shots, 1s apart
 *   npx tsx scripts/simulate-shots.ts 10 300     # 10 shots, 300ms apart
 *
 * IMPORTANT — attribution is by SOURCE IP. Frames sent from this machine
 * arrive at the server as 127.0.0.1, so a target row must exist with
 * ipAddress "127.0.0.1", and a session stage against that target must be
 * ACTIVE, or the shot is correctly logged as unassigned and dropped.
 *
 *   1. POST /api/targets   with "ipAddress": "127.0.0.1"
 *   2. POST /api/sessions  with a stage against that target
 *   3. POST /api/sessions/:id/start
 *   4. run this script
 *
 * Throwaway test tooling. Not imported by the app.
 */

import dgram from 'node:dgram';

import { buildHitFrame } from '../src/transport/protocol/frame.codec';
import { SENSOR_Y_FLOOR_BIAS_MM } from '../src/sensor/scoring';

const HOST = process.env.SIM_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SENSOR_UDP_LISTEN_PORT ?? 14555);

const count = Number(process.argv[2] ?? 5);
const intervalMs = Number(process.argv[3] ?? 1000);

/** Random coordinate in millimetres, roughly on the face. */
function randomCoord(): number {
  return Math.round((Math.random() - 0.5) * 300);
}

/** The wire carries uint16 big-endian; negatives go as two's complement. */
function toWire(mm: number): number {
  return mm < 0 ? mm + 65536 : mm;
}

/**
 * Where the bullet counter starts.
 *
 * Randomised by default, and this matters: SequenceTracker dedups on the
 * unwrapped counter and keeps a 128-wide window per target, IN MEMORY for the
 * life of the server process. Running this script twice with a fixed start of
 * 0 means the second run's bullets are all duplicates of the first run's and
 * are silently — and correctly — discarded. You get no rows and no error, and
 * it looks exactly like a broken pipeline.
 *
 * Set explicitly to exercise the 256-byte rollover, which is the case that
 * broke the original system:
 *   SIM_START=250 npx tsx scripts/simulate-shots.ts 10 200
 */
const start =
  process.env.SIM_START !== undefined
    ? Number(process.env.SIM_START)
    : Math.floor(Math.random() * 256);

const socket = dgram.createSocket('udp4');

let sent = 0;

function sendOne(): void {
  // Every 5th shot is a sentinel miss, so the miss path gets exercised too.
  const isMiss = sent > 0 && sent % 5 === 4;

  const x = isMiss ? 65535 : toWire(randomCoord());
  // The real sensor measures Y from the board's bottom edge, so centre is raw
  // 500, not 0. Encoding the bias here is what keeps a simulated "centre" shot
  // and a real one landing in the same place once the server decodes it.
  const y = isMiss ? 65535 : toWire(randomCoord() + SENSOR_Y_FLOOR_BIAS_MM);

  const bullet = (start + sent) & 0xff;

  const frame = buildHitFrame(x, y, bullet);

  socket.send(frame, PORT, HOST, (err) => {
    if (err) {
      console.error('send failed:', err.message);
      return;
    }
    console.log(
      `sent bullet ${bullet}  ${isMiss ? '(MISS sentinel)' : `x=${x} y=${y}`}`,
    );
  });

  sent += 1;
  if (sent < count) {
    setTimeout(sendOne, intervalMs);
  } else {
    setTimeout(() => socket.close(), 200);
  }
}

console.log(`simulating ${count} shots -> ${HOST}:${PORT} every ${intervalMs}ms`);
sendOne();
