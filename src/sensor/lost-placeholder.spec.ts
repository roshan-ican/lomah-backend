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

function harness({
  resend = true,
  noDetect = false,
  holdMs = 60,
  bulletLimit = 0,
}: {
  resend?: boolean;
  noDetect?: boolean;
  holdMs?: number;
  bulletLimit?: number;
} = {}) {
  const rows = new Map<number, Row>();
  const emitted: ShotEvent[] = [];
  const resent: number[] = [];
  const advanced: string[] = [];

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
    bulletLimit,
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
        NO_DETECT_REREAD: String(noDetect),
        NO_DETECT_HOLD_MS: String(holdMs),
        // See gap-resend.spec.ts — the production floor on grace/hold is off
        // here so these tests can run on a compressed timeline.
        BOARD_READ_LATENCY_MS: '0',
      })[key] ?? fallback,
  };

  const service = new SensorService(
    prisma as any,
    { frames$: { subscribe: vi.fn() } } as any,
    {
      readShotRequest: vi.fn(
        async (_t: unknown, b: number) => void resent.push(b),
      ),
    } as any,
    new SequenceTracker(),
    { resolve: vi.fn(async () => target) } as any,
    {
      events$: { subscribe: vi.fn() },
      advance: vi.fn(async (id: string) => void advanced.push(id)),
    } as any,
    { setHeld: vi.fn() } as any,
    config as any,
  );

  service.shots$.subscribe((e) => emitted.push(e));

  return { service, rows, emitted, resent, advanced };
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
    // what pins the alignment. It lands 34mm right and 30mm low of centre,
    // outside the Figure-11 centre box (half-width 22.5mm) and inside the
    // middle one — a 4, not the 5 this asserted while the boxes were wider.
    expect(rows.get(4)!.score).toBe(4);
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
    expect(rows.get(2)!.score).toBe(4);
    expect(rows.has(4)).toBe(false);

    // The late bullet is announced as a real shot, never as lost.
    const two = emitted.filter((e) => e.shotNumber === 2);
    expect(two).toHaveLength(1);
    expect(two[0].isLost).toBe(false);
  });

  it('lets a bullet that arrives AFTER we gave up still fill its own row', async () => {
    const { service, rows, emitted } = harness();

    await feed(service, hit(1, 34, 470));
    await feed(service, hit(3, 8, 783));

    // Chase, give up, announce #2 as lost.
    await settle(GRACE_MS * 10);
    expect(rows.get(2)!.isLost).toBe(true);
    expect(emitted.find((e) => e.shotNumber === 2)!.isLost).toBe(true);

    // Now it turns up — a slow board, or an answer to the last request that
    // outran our patience. The row mapping has to have survived the write-off,
    // or this lands as a brand-new #4 and the stage gains a round that was
    // never fired.
    await feed(service, hit(2, 34, 470));
    await settle(GRACE_MS * 2);

    expect(sorted(rows).map((r) => r.shotNumber)).toEqual([1, 2, 3]);
    expect(rows.get(2)!.isLost).toBe(false);
    expect(rows.get(2)!.score).toBe(4);

    // Announced twice, and the second one is the correction. The client keeps
    // the later, located version — see isDowngrade in shotCoordinates.ts.
    const two = emitted.filter((e) => e.shotNumber === 2);
    expect(two).toHaveLength(2);
    expect(two[1].isLost).toBe(false);
    expect(two[1].isMiss).toBe(false);
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

// What the shooter is shown while a no-detection shot is being chased.
//
// The rule: a round appears on the target once, and the first thing shown about
// it is the truth. A MISS that becomes a 9 half a second later is worse than a
// pause — the operator is calling the shoot off that screen.
describe('holding a no-detection shot while the board is re-read', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  const HOLD_MS = 60;

  it('writes the row immediately but announces nothing yet', async () => {
    const { service, rows, emitted } = harness({ noDetect: true, holdMs: HOLD_MS });

    await feed(service, hit(1, 34, 470));
    await feed(service, hit(2, ...NO_DETECTION));

    // The database is never behind the board: the row exists the moment the
    // frame lands, which is what keeps the NEXT shot's number right.
    expect(rows.get(2)).toBeDefined();
    expect(rows.get(2)!.isMiss).toBe(true);

    // But the shooter has not been told anything about it.
    expect(emitted.map((e) => e.shotNumber)).toEqual([1]);
  });

  it('paints it as a real bullet when the board answers, never as a miss', async () => {
    const { service, rows, emitted } = harness({ noDetect: true, holdMs: HOLD_MS });

    await feed(service, hit(1, 34, 470));
    await feed(service, hit(2, ...NO_DETECTION));
    await settle(GRACE_MS + 5); // the request goes out

    // The board answers with a position for a counter it already sent.
    await feed(service, hit(2, 34, 470));
    await settle(HOLD_MS * 3);

    expect(rows.get(2)!.isMiss).toBe(false);
    expect(rows.get(2)!.score).toBe(4);

    // Announced exactly once, and as a hit. The held miss never reached anyone.
    const two = emitted.filter((e) => e.shotNumber === 2);
    expect(two).toHaveLength(1);
    expect(two[0].isMiss).toBe(false);
  });

  it('falls back to a MISS once the hold expires with no answer', async () => {
    const { service, rows, emitted } = harness({ noDetect: true, holdMs: HOLD_MS });

    await feed(service, hit(1, 34, 470));
    await feed(service, hit(2, ...NO_DETECTION));
    await settle(HOLD_MS * 4);

    expect(rows.get(2)!.isMiss).toBe(true);
    const two = emitted.filter((e) => e.shotNumber === 2);
    expect(two).toHaveLength(1);
    expect(two[0].isMiss).toBe(true);
    // A miss, not a lost bullet: the frame did arrive.
    expect(two[0].isLost).toBe(false);
  });

  it('does not let a recovered shot swallow the stage advance it was carrying', async () => {
    // A no-detection as the LAST round of a limited stage. The advance rides
    // along with the held event; if the re-read then succeeds and the held
    // record is simply discarded, the advance goes with it and the stage never
    // ends — the shooter is left on a finished stage waiting for a round they
    // already fired.
    const { service, advanced } = harness({
      noDetect: true,
      holdMs: HOLD_MS,
      bulletLimit: 2,
    });

    await feed(service, hit(1, 34, 470));
    await feed(service, hit(2, ...NO_DETECTION));
    await settle(GRACE_MS + 5);

    expect(advanced).toEqual([]); // still held, so the stage must not have moved

    await feed(service, hit(2, 8, 783)); // the board answers
    await settle(HOLD_MS * 3);

    expect(advanced).toEqual(['sess1']);
  });

  it('advances the stage on a held miss too, once the hold expires', async () => {
    const { service, advanced, emitted } = harness({
      noDetect: true,
      holdMs: HOLD_MS,
      bulletLimit: 2,
    });

    await feed(service, hit(1, 34, 470));
    await feed(service, hit(2, ...NO_DETECTION));
    expect(advanced).toEqual([]);

    await settle(HOLD_MS * 4);

    expect(emitted.filter((e) => e.shotNumber === 2)).toHaveLength(1);
    expect(advanced).toEqual(['sess1']);
  });
});
