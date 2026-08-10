// A calibration splits a stage into a before and an after. These tests pin the
// two log lines that make that seam readable without arithmetic.
//
// The question that motivated them — "which shot was the calibration applied
// at?" — was only answerable by taking each logged coordinate, reading the raw
// frame off the end of the same line, and solving for the offset that connects
// them. That works, but it is a reconstruction, and it stops working the moment
// a line is truncated or a shot is quoted on its own.
//
// So: TargetsService names the seam when it moves, and SensorService restates
// the offset on every located shot.

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildHitFrame, decodeFrame } from '@/transport/protocol/frame.codec';
import { SequenceTracker } from '@/transport/protocol/sequence.tracker';
import { SensorService } from '@/sensor/sensor.service';
import type { InBoundFrame } from '@/transport/target-transport.interface';

import { TargetsService } from './targets.service';

const SRC = '192.168.4.1';

/** Every line the service handed to Nest's logger this test. */
let logged: string[];

beforeEach(() => {
  logged = [];
  vi.spyOn(Logger.prototype, 'log').mockImplementation((msg: unknown) => {
    logged.push(String(msg));
  });
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

// ── SensorService: the per-shot line ────────────────────────────────────────

function sensorHarness(offset: { x: number; y: number }) {
  const target = {
    id: 't1',
    label: '25M',
    laneId: 1,
    ipAddress: SRC,
    offsetXmm: offset.x,
    offsetYmm: offset.y,
  };
  const rows = new Map<number, any>();
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
      findFirst: vi.fn(async () => ({ ...stage, _count: { shots: rows.size } })),
      findUnique: vi.fn(async () => ({ ...stage, _count: { shots: rows.size } })),
    },
    shot: {
      create: vi.fn(async ({ data }: any) => (rows.set(data.shotNumber, data), data)),
      upsert: vi.fn(async ({ where, create }: any) => {
        const n = where.sessionStageId_shotNumber.shotNumber;
        rows.set(n, { ...create });
        return rows.get(n);
      }),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => rows.size),
    },
  };

  const service = new SensorService(
    prisma as any,
    { frames$: { subscribe: vi.fn() } } as any,
    { resend: vi.fn() } as any,
    new SequenceTracker(),
    { resolve: vi.fn(async () => target) } as any,
    { events$: { subscribe: vi.fn() }, advance: vi.fn() } as any,
    { setHeld: vi.fn() } as any,
    { get: (_k: string, fallback?: string) => fallback } as any,
  );
  return service;
}

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

describe('the per-shot line shows raw, offset and result', () => {
  it('prints the whole sum on a located hit', async () => {
    // Shot #12 off the live 25M string: raw (0xffad, 706) under offset
    // (-66, +93) scored as (-149, 299).
    const service = sensorHarness({ x: -66, y: 93 });
    await feed(service, hit(1, 65453, 706));

    const line = logged.find((l) => l.includes('25M #1:'))!;
    // The reader must be able to check the arithmetic without decoding the
    // frame: -83 + -66 = -149, and 206 + 93 = 299.
    expect(line).toContain('raw(-83, 206) + cal(-66, +93)mm = (-149, 299)');
  });

  it('reports raw already sign-corrected and Y-biased', async () => {
    // 65453 is a negative int16 on the wire, and 706 is measured from the
    // board's bottom edge. Printing either one un-normalised would make the
    // sum on the line fail to add up.
    const service = sensorHarness({ x: 0, y: 0 });
    await feed(service, hit(1, 65453, 706));

    const line = logged.find((l) => l.includes('25M #1:'))!;
    expect(line).toContain('raw(-83, 206)');
  });

  it('says cal(none) rather than dropping the field on an uncalibrated board', async () => {
    const service = sensorHarness({ x: 0, y: 0 });
    await feed(service, hit(1, 66, 407));

    const line = logged.find((l) => l.includes('25M #1:'))!;
    // Keeping the field present — rather than omitting it — is what lets a
    // calibrated and an uncalibrated shot be read, and grepped, the same way.
    expect(line).toContain('raw(66, -93) + cal(none) = (66, -93)');
  });

  it('says nothing on a no-detection miss', async () => {
    const service = sensorHarness({ x: -66, y: 93 });
    await feed(service, hit(1, 0, 0));

    const line = logged.find((l) => l.includes('25M #1:'))!;
    expect(line).toContain('MISS (no detection)');
    // There are no coordinates on this row for an offset to have produced.
    expect(line).not.toContain('cal(');
    expect(line).not.toContain('raw(');
  });
});

// ── TargetsService: the boundary line ───────────────────────────────────────

function targetsHarness() {
  const target = {
    id: 't1',
    label: '25M',
    laneId: 1,
    ipAddress: SRC,
    offsetXmm: 0,
    offsetYmm: 0,
  };
  const stage = { id: 's1', targetId: 't1', status: 'ACTIVE', profileType: 'FIGURE' as const };
  // Seven rows: shots #1-#7, matching the live string where #7 was the only
  // located hit and became the reference.
  const shots = Array.from({ length: 7 }, (_, i) => ({
    id: `sh${i + 1}`,
    sessionStageId: 's1',
    shotNumber: i + 1,
    x: i === 6 ? 66 : 0,
    y: i === 6 ? -93 : 0,
    score: i === 6 ? 3 : 0,
    isMiss: i !== 6,
  }));

  const db = {
    target: {
      findUnique: vi.fn(async () => ({ ...target })),
      update: vi.fn(async ({ data }: any) => (Object.assign(target, data), { ...target })),
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
        Object.assign(shots.find((s) => s.id === where.id)!, data);
      }),
    },
    $transaction: vi.fn(async (cb: any) => cb(db)),
  };

  const service = new TargetsService(
    db as any,
    { invalidate: vi.fn() } as any,
    {} as any,
    {} as any,
  );
  return { service, target, db };
}

describe('the one-bullet pick is spendable once per session', () => {
  /** The data passed to the session row's update, across all calls. */
  const sessionWrites = (db: any) =>
    db.session.update.mock.calls.map((c: any[]) => c[0].data);

  it('marks the pick used when the calibration came from a shot', async () => {
    const { service, db } = targetsHarness();
    await service.calibrateFromShot('t1', { stageId: 's1', shotNumber: 7 }, 0, 0);

    expect(sessionWrites(db)).toEqual([
      { calibrationCount: { increment: 1 }, pickCalibrationUsed: true },
    ]);
  });

  it('does NOT mark it used for a plain offset write', async () => {
    // A bulk group drag and a hand-typed offset both land here. Neither is the
    // pick, and neither may consume it.
    const { service, db } = targetsHarness();
    await service.setOffset('t1', -66, 93);

    expect(sessionWrites(db)).toEqual([{ calibrationCount: { increment: 1 } }]);
  });

  it('does NOT hand the pick back when the offset is reset to zero', async () => {
    // The reported bug: resetting mid-session put the single-shot calibration
    // back on offer. Nothing here may write pickCalibrationUsed: false — the
    // flag is one-way for the life of the session.
    const { service, db } = targetsHarness();
    await service.calibrateFromShot('t1', { stageId: 's1', shotNumber: 7 }, 0, 0);
    await service.setOffset('t1', 0, 0);

    const writes = sessionWrites(db);
    expect(writes).toHaveLength(2);
    expect(writes[1]).not.toHaveProperty('pickCalibrationUsed');
    expect(
      writes.some((w: any) => w.pickCalibrationUsed === false),
    ).toBe(false);
  });
});

describe('the boundary line names the seam', () => {
  it('states the before, the after, the delta and the first shot affected', async () => {
    const { service } = targetsHarness();

    // The live calibration: shot #7 scored (66, -93), dragged to dead centre.
    await service.calibrateFromShot('t1', { stageId: 's1', shotNumber: 7 }, 0, 0);

    const line = logged.find((l) => l.startsWith('CALIBRATED'))!;
    // Zero takes no sign — "+0" reads as a direction, and there isn't one.
    expect(line).toContain('(0, 0) -> (-66, +93)mm');
    expect(line).toContain('[delta -66, +93]');
    // Seven rows on the stage, so the next bullet is #8 — the same allocation
    // the ingest path uses. This is the number the original question was after.
    expect(line).toContain('in force from shot #8');
  });

  it('records which shot the operator pointed at, and where', async () => {
    const { service } = targetsHarness();
    await service.calibrateFromShot('t1', { stageId: 's1', shotNumber: 7 }, 0, 0);

    const line = logged.find((l) => l.startsWith('CALIBRATE FROM SHOT'))!;
    expect(line).toContain('shot #7');
    expect(line).toContain('scored at (66, -93)');
    expect(line).toContain('true position (0, 0)mm');
  });

  it('prints each re-scored shot before and after, not just a count', async () => {
    const { service } = targetsHarness();

    await service.calibrateFromShot('t1', { stageId: 's1', shotNumber: 7 }, 0, 0);

    // #7 is the only located shot on the stage; the six misses are left alone.
    const lines = logged.filter((l) => l.startsWith('RE-SCORED'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('25M #7: (66, -93) = 3 -> (0, 0) = 5');
  });

  it('does not claim a shot number when no stage is running', async () => {
    const { service } = targetsHarness();
    // Between stages: nothing to re-score, and #1 would be a guess about a
    // stage that has not been created yet.
    (service as any).prisma.sessionStage.findFirst = vi.fn(async () => null);

    await service.setOffset('t1', -66, 93);

    const line = logged.find((l) => l.startsWith('CALIBRATED'))!;
    expect(line).toContain('no active stage');
    expect(line).not.toMatch(/shot #\d/);
  });
});
