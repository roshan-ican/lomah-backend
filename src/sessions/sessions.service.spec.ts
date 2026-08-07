// Regression cover for SessionsService.create's lane-occupancy guard and the
// notes column.
//
// The bug these pin down: "Edit Config" reported success and then showed the
// pre-edit plan again after a reload. Two independent causes —
//
//   1. Nothing stopped a lane accumulating a SECOND open session. The console
//      swapped plans with an unsequenced stop-then-create, and when the stop
//      did not happen (any status other than CREATED) or did not land, the
//      lane ended up with two live sessions. Only one is reachable by any UI,
//      and which one the grid picks up after a refresh is decided by createdAt
//      ordering rather than by the operator.
//
//   2. `notes` was never written. The column has always existed; no code path
//      populated it at create time, so the text lived in one browser's memory
//      and was gone on reload and absent on every other console.
//
// Prisma is stubbed rather than hit for real: these assertions are about the
// decisions create() makes, and a real SQLite file would make them depend on
// migration state.

import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionsService } from './sessions.service';

const LANE_ID = 1;
const TARGET_ID = 'tgt-1';

function makePrisma(openSession: Record<string, unknown> | null) {
  const created = {
    id: 'new-session',
    laneId: LANE_ID,
    shooterName: 'Roshan',
    notes: null as string | null,
    stages: [{ id: 'stage-1', order: 0 }],
  };

  const tx = {
    session: {
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockImplementation(({ data }: any) => {
        created.notes = data.notes ?? null;
        return Promise.resolve({ ...created, notes: data.notes ?? null });
      }),
    },
  };

  return {
    tx,
    prisma: {
      lane: { findUnique: vi.fn().mockResolvedValue({ id: LANE_ID }) },
      target: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: TARGET_ID, laneId: LANE_ID, label: 'T1' }]),
      },
      session: { findFirst: vi.fn().mockResolvedValue(openSession) },
      $transaction: vi.fn((cb: any) => cb(tx)),
    },
  };
}

function makeService(openSession: Record<string, unknown> | null) {
  const { prisma, tx } = makePrisma(openSession);
  const service = new SessionsService(
    prisma as any,
    { play: vi.fn() } as any,
    { get: () => 'false' } as any,
  );
  return { service, prisma, tx };
}

const dto = (extra: Record<string, unknown> = {}) => ({
  laneId: LANE_ID,
  shooterName: 'Roshan',
  stages: [{ targetId: TARGET_ID, bulletLimit: 5, durationSeconds: 60 }],
  ...extra,
});

describe('SessionsService.create — lane occupancy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists notes instead of dropping them', async () => {
    const { service, tx } = makeService(null);

    const session = await service.create(dto({ notes: 'Wind 5kt L-to-R' }) as any);

    expect(tx.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notes: 'Wind 5kt L-to-R' }),
      }),
    );
    expect(session.notes).toBe('Wind 5kt L-to-R');
  });

  it('refuses a second open session when the caller did not ask to replace', async () => {
    const { service, tx } = makeService({
      id: 'existing',
      status: 'CREATED',
    });

    await expect(service.create(dto() as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Crucially: nothing was written. A refused create must not have cancelled
    // the session that was already there.
    expect(tx.session.create).not.toHaveBeenCalled();
    expect(tx.session.update).not.toHaveBeenCalled();
  });

  it('names the blocking session and its status in the rejection', async () => {
    const { service } = makeService({ id: 'existing', status: 'ACTIVE' });

    await expect(service.create(dto() as any)).rejects.toThrow(
      /existing.*ACTIVE/,
    );
  });

  it('replaces a CREATED session in one transaction when asked', async () => {
    const { service, tx } = makeService({ id: 'existing', status: 'CREATED' });

    await service.create(dto({ replaceExisting: true }) as any);

    expect(tx.session.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'existing' },
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
    expect(tx.session.create).toHaveBeenCalledTimes(1);
  });

  it('refuses to replace a session that has already started', async () => {
    // The case the old client-side swap got wrong: it only stopped a CREATED
    // session, so editing a running relay forked the lane instead of failing.
    for (const status of ['ACTIVE', 'PAUSED']) {
      const { service, tx } = makeService({ id: 'live', status });

      await expect(
        service.create(dto({ replaceExisting: true }) as any),
      ).rejects.toThrow(new RegExp(`is ${status} and cannot be edited`));
      expect(tx.session.create).not.toHaveBeenCalled();
    }
  });

  it('creates normally on a genuinely free lane', async () => {
    const { service, tx } = makeService(null);

    await service.create(dto() as any);

    expect(tx.session.update).not.toHaveBeenCalled();
    expect(tx.session.create).toHaveBeenCalledTimes(1);
  });
});
