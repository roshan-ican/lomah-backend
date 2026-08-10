// A mid-stage calibration has to move the bullets that already landed AND the
// bullets that have not been fired yet. The second half is the one that broke.
//
// Ingestion does not read Target from the database per frame — that lookup is
// on the hot path, so TargetResolver caches the whole row by source IP. The
// cached row carries offsetXmm/offsetYmm, and scoreShot() reads them off it.
// setOffset() used to update the row and re-score the stage without touching
// that cache, so the shot list rewrote itself correctly while every subsequent
// bullet kept being scored against the pre-calibration mounting error — one
// stage split across two coordinate frames, silently, until the board's IP
// changed or Nest restarted.
//
// The fixture is the 25M string this was found on: offsets (186, -457) at
// arming, shot #3 dragged onto its true position mid-stage, shot #4 fired
// after. Real raw frames, real numbers.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { scoreShot } from '@/sensor/scoring';
import { TargetResolver } from '@/sensor/target-resolver.service';

import { TargetsService } from './targets.service';

const IP = '192.168.4.1';
const TARGET_ID = 't-25m';
const STAGE_ID = 'stage-1';

/** Raw frames off the board, exactly as they were logged. */
const RAW = {
  shot3: { x: 269, y: 0 },
  shot4: { x: 12, y: 515 },
};

interface ShotRow {
  id: string;
  sessionStageId: number | string;
  shotNumber: number;
  x: number;
  y: number;
  score: number;
  isMiss: boolean;
}

function harness() {
  const target = {
    id: TARGET_ID,
    label: '25M',
    laneId: 1,
    ipAddress: IP,
    offsetXmm: 186,
    offsetYmm: -457,
  };

  const stage = {
    id: STAGE_ID,
    sessionId: 'sess1',
    targetId: TARGET_ID,
    status: 'ACTIVE',
    profileType: 'FIGURE' as const,
  };

  // Shots #1-#3, already scored with the arming offsets.
  const shots: ShotRow[] = [
    { id: 'sh1', sessionStageId: STAGE_ID, shotNumber: 1, x: 158, y: -475, score: 0, isMiss: false },
    { id: 'sh2', sessionStageId: STAGE_ID, shotNumber: 2, x: -84, y: -21118, score: 0, isMiss: false },
    { id: 'sh3', sessionStageId: STAGE_ID, shotNumber: 3, x: 455, y: -957, score: 0, isMiss: false },
  ];

  const db = {
    target: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return where.id === target.id ? { ...target } : null;
        if (where.ipAddress) return where.ipAddress === target.ipAddress ? { ...target } : null;
        return null;
      }),
      update: vi.fn(async ({ data }: any) => {
        Object.assign(target, data);
        return { ...target };
      }),
    },
    sessionStage: {
      findFirst: vi.fn(async () => ({ ...stage, shots: shots.map((s) => ({ ...s })) })),
    },
    // setOffset counts calibrations on the session so the one-bullet "pick"
    // can be offered exactly once per session.
    session: {
      update: vi.fn(async () => ({ calibrationCount: 1 })),
      findUnique: vi.fn(async () => ({
        calibrationCount: 1,
        pickCalibrationUsed: true,
      })),
    },
    shot: {
      findUnique: vi.fn(async ({ where }: any) => {
        const n = where.sessionStageId_shotNumber?.shotNumber;
        const row = shots.find((s) => s.shotNumber === n);
        return row ? { ...row, stage: { ...stage } } : null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = shots.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      }),
    },
    $transaction: vi.fn(async (cb: any) => cb(db)),
  };

  // A REAL resolver, not a spy: the point of the test is that the cache it
  // keeps actually re-reads after a calibration.
  const resolver = new TargetResolver(db as any);
  const service = new TargetsService(
    db as any,
    resolver,
    { } as any, // TargetCommandService — unused by the calibration path
    { } as any, // SequenceTracker — likewise
  );

  return { db, resolver, service, shots, target };
}

/** What ingestion does per frame: resolve by IP, then score with that row. */
async function scoreIncoming(
  resolver: TargetResolver,
  raw: { x: number; y: number },
) {
  const target = (await resolver.resolve(IP))!;
  return scoreShot({
    rawX: raw.x,
    rawY: raw.y,
    offsetXmm: target.offsetXmm,
    offsetYmm: target.offsetYmm,
    profile: 'FIGURE',
  });
}

describe('mid-stage calibration vs the resolver cache', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it('scores bullets fired AFTER the calibration with the new offset', async () => {
    // Shot #3 arrives and warms the cache with the arming offsets.
    const before = await scoreIncoming(h.resolver, RAW.shot3);
    expect(before).toMatchObject({ x: 455, y: -957 });

    // The range officer drags shot #3 onto where it truly landed.
    await h.service.calibrateFromShot(
      TARGET_ID,
      { stageId: STAGE_ID, shotNumber: 3 },
      289,
      -472,
    );

    // Shot #4, same board, next frame. This is the assertion that failed
    // before the invalidate: it scored (198, -442), still 166mm/485mm out.
    const after = await scoreIncoming(h.resolver, RAW.shot4);
    expect(after).toMatchObject({ x: 32, y: 43 });
  });

  it('derives the offset from the stored shot and writes it to the target', async () => {
    await h.service.calibrateFromShot(
      TARGET_ID,
      { stageId: STAGE_ID, shotNumber: 3 },
      289,
      -472,
    );
    expect(h.target).toMatchObject({ offsetXmm: 20, offsetYmm: 28 });
  });

  it('moves the shots already on the board by the same delta', async () => {
    await h.service.calibrateFromShot(
      TARGET_ID,
      { stageId: STAGE_ID, shotNumber: 3 },
      289,
      -472,
    );
    // delta = (-166, +485), applied to every non-miss row.
    expect(h.shots.map((s) => [s.x, s.y])).toEqual([
      [-8, 10],
      [-250, -20633],
      [289, -472],
    ]);
  });

  it('invalidates on a direct offset write too, not only on calibrate-from-shot', async () => {
    await scoreIncoming(h.resolver, RAW.shot3); // warm the cache

    await h.service.setOffset(TARGET_ID, 0, 0);

    const after = await scoreIncoming(h.resolver, RAW.shot4);
    expect(after).toMatchObject({ x: 12, y: 15 });
  });

  it('re-reads the target row rather than patching the cached copy in place', async () => {
    await scoreIncoming(h.resolver, RAW.shot3);
    const reads = h.db.target.findUnique.mock.calls.filter(
      (c: any[]) => c[0]?.where?.ipAddress,
    ).length;

    await h.service.setOffset(TARGET_ID, 20, 28);
    await scoreIncoming(h.resolver, RAW.shot4);

    // A second IP lookup proves the entry was dropped, not mutated — mutating
    // the cached object would pass the coordinate assertions above while
    // leaving the next board swap resolving to a stale row.
    expect(
      h.db.target.findUnique.mock.calls.filter(
        (c: any[]) => c[0]?.where?.ipAddress,
      ).length,
    ).toBe(reads + 1);
  });
});
