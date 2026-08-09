// What the shooter's shot list is allowed to look like after a bad string.
//
// The rule, stated once: every round that left the barrel gets a row, and the
// row keeps the number the shooter counted. Three things can happen to a round
// and all three must be distinguishable afterwards:
//
//   located hit      -> coordinates, a score
//   no detection     -> row exists, isMiss, no coordinates (the frame ARRIVED,
//                       the board just could not triangulate)
//   never arrived    -> row exists, isLost, written as a placeholder so the
//                       rounds fired after it do not slide down a number
//
// The third case is the one that used to be invisible. shotNumber is allocated
// as "rows so far + 1", so a dropped datagram left no hole — it silently
// renumbered everything after it, and the bullet the board called #8 was filed
// as #7 for the rest of the stage.
//
// The fixture below is a real 25M string off the range: thirteen rounds fired,
// eight no-detections, and bullet #7 lost to the link entirely.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildHitFrame,
  decodeFrame,
} from '@/transport/protocol/frame.codec';
import { SequenceTracker } from '@/transport/protocol/sequence.tracker';
import type { InBoundFrame } from '@/transport/target-transport.interface';

import { SensorService } from './sensor.service';
import type { ShotEvent } from './sensor.events';

const GRACE_MS = 20;
const MAX_ATTEMPTS = 2;
const SRC = '192.168.4.1';

interface Row {
  shotNumber: number;
  x: number;
  y: number;
  score: number;
  isMiss: boolean;
  isLost: boolean;
  firedAt: Date;
}

function harness({ resend = true }: { resend?: boolean } = {}) {
  const rows = new Map<number, Row>();
  const emitted: ShotEvent[] = [];
  const resent: number[] = [];

  const target = {
    id: 't1',
    label: '25M',
    laneId: 1,
    ipAddress: SRC,
    offsetXmm: 0,
    offsetYmm: 0,
  } as any;

  const stage = {
    id: 's1',
    sessionId: 'sess1',
    order: 0,
    profileType: 'FIGURE',
    bulletLimit: 0,
    status: 'ACTIVE',
  };

  const prisma = {
    target: { update: vi.fn() },
    sessionStage: {
      findFirst: vi.fn(async () => ({
        ...stage,
        _count: { shots: rows.size },
      })),
      findUnique: vi.fn(async () => ({
        ...stage,
        _count: { shots: rows.size },
      })),
    },
    shot: {
      create: vi.fn(async ({ data }: any) => {
        rows.set(data.shotNumber, { ...data });
        return data;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const n = where.sessionStageId_shotNumber.shotNumber;
        const existing = rows.get(n);
        rows.set(n, existing ? { ...existing, ...update } : { ...create });
        return rows.get(n);
      }),
      findUnique: vi.fn(async ({ where }: any) =>
        rows.get(where.sessionStageId_shotNumber.shotNumber) ?? null,
      ),
      count: vi.fn(async () => rows.size),
    },
  };

  const config = {
    get: (key: string, fallback?: string) =>
      ({
        SENSOR_RESEND_ENABLED: String(resend),
        RESEND_GRACE_MS: String(GRACE_MS),
        MAX_RESEND_ATTEMPTS: String(MAX_ATTEMPTS),
      })[key] ?? fallback,
  };

  const service = new SensorService(
    prisma as any,
    { frames$: { subscribe: vi.fn() } } as any,
    {
      resend: vi.fn(async (_t: unknown, b: number) => void resent.push(b)),
    } as any,
    new SequenceTracker(),
    { resolve: vi.fn(async () => target) } as any,
    { events$: { subscribe: vi.fn() }, advance: vi.fn() } as any,
    { setHeld: vi.fn() } as any,
    config as any,
  );

  service.shots$.subscribe((e) => emitted.push(e));

  return { service, rows, emitted, resent };
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

/** The board's "I saw nothing" marker — NOT the coordinates (0, 0). */
const NO_DETECTION = [0, 0] as const;

/** Let the per-target serialize queue drain. */
async function settle(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function feed(service: SensorService, frame: InBoundFrame) {
  await (service as any).onHit(frame);
  await settle();
}

function sorted(rows: Map<number, Row>): Row[] {
  return [...rows.values()].sort((a, b) => a.shotNumber - b.shotNumber);
}

describe('lost-bullet placeholders', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('numbers a real 13-round string so nothing is skipped or shifted', async () => {
    const { service, rows, emitted } = harness();

    // The string as the board sent it. Bullet 7 is absent because it never
    // reached the server — that is the whole point of the fixture.
    await feed(service, hit(1, ...NO_DETECTION));
    await feed(service, hit(2, ...NO_DETECTION));
    await feed(service, hit(3, ...NO_DETECTION));
    await feed(service, hit(4, 34, 470));
    await feed(service, hit(5, 8, 783));
    await feed(service, hit(6, ...NO_DETECTION));
    await feed(service, hit(8, 64473, 3069));
    await feed(service, hit(9, ...NO_DETECTION));
    await feed(service, hit(10, ...NO_DETECTION));
    await feed(service, hit(11, ...NO_DETECTION));
    await feed(service, hit(12, ...NO_DETECTION));
    await feed(service, hit(13, ...NO_DETECTION));
    await feed(service, hit(14, 269, 246));

    // Two resend attempts a grace apart, then the service gives up.
    await settle(GRACE_MS * (MAX_ATTEMPTS + 2));

    const all = sorted(rows);

    // Fourteen rounds left the barrel; fourteen rows exist, numbered 1..14
    // with no hole and no duplicate.
    expect(all.map((r) => r.shotNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);

    // Bullet 7 is the one that never arrived.
    const seven = rows.get(7)!;
    expect(seven.isLost).toBe(true);
    expect(seven.isMiss).toBe(true);

    // And critically, #8 is the bullet the BOARD called 8 — not slid down into
    // 7's slot. (34, 470) raw is the hit that scored, so its neighbours are
    // what pins the alignment.
    expect(rows.get(4)!.score).toBe(5);
    expect(rows.get(4)!.isMiss).toBe(false);
    expect(rows.get(5)!.isMiss).toBe(false);
    expect(rows.get(8)!.isMiss).toBe(false);
    expect(rows.get(8)!.isLost).toBe(false);
    expect(rows.get(14)!.isMiss).toBe(false);

    // The no-detections: frames that arrived, carrying nothing.
    for (const n of [1, 2, 3, 6, 9, 10, 11, 12, 13]) {
      expect(rows.get(n)!.isMiss, `#${n} should be a miss`).toBe(true);
      expect(rows.get(n)!.isLost, `#${n} arrived, so not lost`).toBe(false);
    }

    // A miss carries no position. Zeroes here are absence, not a centre hit,
    // and the UI relies on isMiss rather than on x/y to know that.
    expect(rows.get(1)!.x).toBe(0);
    expect(rows.get(1)!.y).toBe(0);
    expect(rows.get(1)!.score).toBe(0);

    // Every row is announced exactly once, including the lost one.
    const announced = emitted.map((e) => e.shotNumber).sort((a, b) => a - b);
    expect(announced).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(emitted.find((e) => e.shotNumber === 7)!.isLost).toBe(true);
    expect(emitted.find((e) => e.shotNumber === 8)!.isLost).toBe(false);
  });

  it('lets a resent bullet fill its own placeholder rather than take a new number', async () => {
    const { service, rows, emitted } = harness();

    await feed(service, hit(1, 34, 470));
    await feed(service, hit(3, 8, 783));
    // #2 is now reserved and being chased.
    expect(rows.get(2)!.isLost).toBe(true);

    // It turns up inside the grace window.
    await feed(service, hit(2, 34, 470));
    await settle(GRACE_MS * (MAX_ATTEMPTS + 2));

    expect(sorted(rows).map((r) => r.shotNumber)).toEqual([1, 2, 3]);
    // Filled in place: same row, no longer lost, and NOT appended as #4.
    expect(rows.get(2)!.isLost).toBe(false);
    expect(rows.get(2)!.isMiss).toBe(false);
    expect(rows.get(2)!.score).toBe(5);
    expect(rows.has(4)).toBe(false);

    // The late bullet is announced as a real shot, never as lost.
    const two = emitted.filter((e) => e.shotNumber === 2);
    expect(two).toHaveLength(1);
    expect(two[0].isLost).toBe(false);
  });

  it('does not fabricate rows when the sequence anchor is desynced', async () => {
    const { service, rows } = harness();

    await feed(service, hit(1, 34, 470));
    // A jump this large is a board reboot or a counter reset, not thirty
    // consecutive dropped datagrams — see MAX_PLACEHOLDER_BURST.
    await feed(service, hit(40, 34, 470));
    await settle(GRACE_MS * (MAX_ATTEMPTS + 2));

    // Two real shots, two rows. No invented bullets in between.
    expect(sorted(rows).map((r) => r.shotNumber)).toEqual([1, 2]);
    expect([...rows.values()].every((r) => !r.isLost)).toBe(true);
  });
});
