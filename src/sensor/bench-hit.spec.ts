// A bullet fired at a target that no session owns.
//
// Commissioning arms a board directly — PLAY with no stage behind it — so the
// hits it pushes back belong to nothing. persistHit has always refused to file
// them, and that refusal is the contract: a bench bullet must never reach the
// shot log, a session total or a report, because the numbers there are what a
// range officer signs off.
//
// What it used to do beyond refusing was nothing at all, which is why the
// calibration panel could only see a bullet by asking for it back by number.
// These tests pin both halves: still nothing written, and now something said.

import { describe, expect, it, vi } from 'vitest';

import {
  buildHitFrame,
  decodeFrame,
} from '@/transport/protocol/frame.codec';
import { SequenceTracker } from '@/transport/protocol/sequence.tracker';
import type { InBoundFrame } from '@/transport/target-transport.interface';

import { SensorService } from './sensor.service';
import { scoreShot } from './scoring';
import type { BenchHitEvent, ShotEvent } from './sensor.events';

const SRC = '192.168.4.1';

/** The board's "I saw nothing" marker — NOT the coordinates (0, 0). */
const NO_DETECTION = [0, 0] as const;

/**
 * The same wiring the other sensor specs use, with the one difference under
 * test: every stage lookup comes back empty, which is what a commissioning
 * target looks like from persistHit's side.
 */
function harness(offset = { offsetXmm: 0, offsetYmm: 0 }) {
  const benchHits: BenchHitEvent[] = [];
  const shots: ShotEvent[] = [];

  const target = {
    id: 't1',
    label: '25M',
    laneId: 1,
    ipAddress: SRC,
    profileType: 'FIGURE',
    ...offset,
  } as any;

  const prisma = {
    target: { update: vi.fn() },
    sessionStage: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
    },
    shot: {
      create: vi.fn(),
      upsert: vi.fn(),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
  };

  const config = {
    get: (key: string, fallback?: string) =>
      ({
        SENSOR_RESEND_ENABLED: 'false',
        NO_DETECT_REREAD: 'false',
        BOARD_READ_LATENCY_MS: '0',
      })[key] ?? fallback,
  };

  const service = new SensorService(
    prisma as any,
    { frames$: { subscribe: vi.fn() } } as any,
    { readShotRequest: vi.fn() } as any,
    new SequenceTracker(),
    { resolve: vi.fn(async () => target) } as any,
    {
      events$: { subscribe: vi.fn() },
      advance: vi.fn(),
      getArmedStageId: vi.fn(() => undefined),
    } as any,
    { setHeld: vi.fn() } as any,
    config as any,
  );

  service.benchHits$.subscribe((e) => benchHits.push(e));
  service.shots$.subscribe((e) => shots.push(e));

  return { service, prisma, benchHits, shots, target };
}

/** A real 9-byte hit frame, encoded then decoded like one off the wire. */
function hit(counter: number, rawX: number, rawY: number): InBoundFrame {
  const decoded = decodeFrame(buildHitFrame(rawX, rawY, counter));
  if (!decoded.ok) throw new Error(`bad fixture: ${decoded.reason}`);
  return {
    ...decoded.frame,
    sourceKey: SRC,
    transport: 'WIFI',
    receivedAt: new Date(),
  };
}

async function feed(service: SensorService, frame: InBoundFrame) {
  await (service as any).onHit(frame);
  await new Promise((r) => setTimeout(r, 0));
}

describe('a hit with no session behind it', () => {
  it('is announced as a bench hit and written nowhere', async () => {
    const { service, prisma, benchHits, shots } = harness();

    await feed(service, hit(1, 120, 400));

    expect(benchHits).toHaveLength(1);
    expect(benchHits[0].targetId).toBe('t1');
    expect(benchHits[0].laneId).toBe(1);
    expect(benchHits[0].shot).toBe(1);
    expect(benchHits[0].isMiss).toBe(false);

    // The contract that predates this event and must outlive it.
    expect(prisma.shot.create).not.toHaveBeenCalled();
    expect(prisma.shot.upsert).not.toHaveBeenCalled();
    expect(shots).toHaveLength(0);
  });

  it('carries the millimetres a read of the same bullet would return', async () => {
    // Not a hardcoded pair: the panel plots this event and can later re-read
    // the same bullet over HTTP, and the two must land on the same spot. Both
    // sides go through scoreShot, so the test asserts they agree rather than
    // asserting a number that could drift away from one of them.
    const offset = { offsetXmm: -269, offsetYmm: -438 };
    const { service, benchHits } = harness(offset);

    const frame = hit(2, 120, 400);
    await feed(service, frame);

    const expected = scoreShot({
      rawX: frame.rawX,
      rawY: frame.rawY,
      offsetXmm: offset.offsetXmm,
      offsetYmm: offset.offsetYmm,
      profile: 'FIGURE',
    });

    expect(benchHits).toHaveLength(1);
    expect(benchHits[0].xMm).toBe(expected.x);
    expect(benchHits[0].yMm).toBe(expected.y);
    expect(benchHits[0].score).toBe(expected.score);
  });

  it('flags a no-detection rather than reporting a bullet at dead centre', async () => {
    // (0, 0) is the board saying it triangulated nothing, not a bullseye. A
    // client that plotted it would draw a shot nobody fired at the exact point
    // the operator is about to mark against.
    const { service, benchHits, shots } = harness();

    await feed(service, hit(1, ...NO_DETECTION));

    expect(benchHits).toHaveLength(1);
    expect(benchHits[0].isMiss).toBe(true);
    expect(shots).toHaveLength(0);
  });
});
