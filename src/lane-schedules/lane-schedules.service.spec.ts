import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ScheduleIdentitySource } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LaneSchedulesService } from './lane-schedules.service';

const startsAt = '2030-01-02T07:00:00.000Z';
const endsAt = '2030-01-02T08:00:00.000Z';

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'schedule-1',
    ownerAdminId: 'admin-1',
    laneId: 1,
    lane: { id: 1, name: 'Lane 1' },
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    cancelledAt: null,
    attendees: [
      {
        id: 'attendee-1',
        shooterId: 'shooter-1',
        displayName: 'Ahmed',
        identitySource: ScheduleIdentitySource.LOCAL,
        externalProvider: null,
        externalId: null,
        createdAt: new Date(),
      },
    ],
    ...overrides,
  };
}

function makeService() {
  const prisma = {
    lane: { findUnique: vi.fn().mockResolvedValue({ id: 1 }) },
    shooter: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: 'shooter-1', name: 'Ahmed' }]),
    },
    laneSchedule: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(schedule()),
      update: vi.fn().mockResolvedValue(schedule()),
    },
  };
  return {
    prisma,
    service: new LaneSchedulesService(prisma as any),
  };
}

const createDto = () => ({
  laneId: 1,
  startsAt,
  endsAt,
  attendees: [
    {
      identitySource: ScheduleIdentitySource.LOCAL,
      shooterId: 'shooter-1',
    },
    {
      identitySource: ScheduleIdentitySource.MANUAL,
      displayName: 'Bilal',
    },
  ],
});

describe('LaneSchedulesService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a private schedule with local and manual attendee snapshots', async () => {
    const { service, prisma } = makeService();

    await service.create('admin-1', createDto());

    expect(prisma.laneSchedule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerAdminId: 'admin-1',
          laneId: 1,
          attendees: {
            create: [
              expect.objectContaining({
                shooterId: 'shooter-1',
                displayName: 'Ahmed',
              }),
              expect.objectContaining({
                displayName: 'Bilal',
                identitySource: ScheduleIdentitySource.MANUAL,
              }),
            ],
          },
        }),
      }),
    );
  });

  it('uses strict interval overlap so adjacent schedules remain valid', async () => {
    const { service, prisma } = makeService();

    await service.create('admin-1', createDto());

    expect(prisma.laneSchedule.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        startsAt: { lt: new Date(endsAt) },
        endsAt: { gt: new Date(startsAt) },
      }),
      select: { id: true },
    });
  });

  it('rejects an overlapping reservation', async () => {
    const { service, prisma } = makeService();
    prisma.laneSchedule.findFirst.mockResolvedValueOnce({ id: 'blocking' });

    await expect(service.create('admin-1', createDto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.laneSchedule.create).not.toHaveBeenCalled();
  });

  it('returns full owned details but redacts another admin schedule to Busy', async () => {
    const { service, prisma } = makeService();
    prisma.laneSchedule.findMany.mockResolvedValue([
      schedule(),
      schedule({ id: 'schedule-2', ownerAdminId: 'admin-2' }),
    ]);

    const result = await service.findRange('admin-1', {
      from: '2030-01-02T00:00:00.000Z',
      to: '2030-01-03T00:00:00.000Z',
    });

    expect(result[0]).toMatchObject({ access: 'OWNER', attendees: [{ displayName: 'Ahmed' }] });
    expect(result[1]).toMatchObject({ access: 'BUSY', laneId: 1 });
    expect(result[1]).not.toHaveProperty('attendees');
    expect(result[1]).not.toHaveProperty('ownerAdminId');
  });

  it('hides another admin schedule from edit and cancel operations', async () => {
    const { service } = makeService();

    await expect(
      service.update('schedule-2', 'admin-1', { laneId: 2 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.cancel('schedule-2', 'admin-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('edits only the owned schedule and replaces its attendee list', async () => {
    const { service, prisma } = makeService();
    prisma.laneSchedule.findFirst
      .mockResolvedValueOnce(schedule())
      .mockResolvedValueOnce(null);

    await service.update('schedule-1', 'admin-1', {
      attendees: [
        {
          identitySource: ScheduleIdentitySource.MANUAL,
          displayName: 'Bilal',
        },
      ],
    });

    expect(prisma.laneSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'schedule-1' },
        data: expect.objectContaining({
          attendees: {
            deleteMany: {},
            create: [expect.objectContaining({ displayName: 'Bilal' })],
          },
        }),
      }),
    );
  });

  it('cancels an owned schedule without deleting its audit record', async () => {
    const { service, prisma } = makeService();
    prisma.laneSchedule.findFirst.mockResolvedValueOnce(schedule());

    await service.cancel('schedule-1', 'admin-1');

    expect(prisma.laneSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'schedule-1' },
        data: { cancelledAt: expect.any(Date) },
      }),
    );
  });

  it('blocks another admin during the active window', async () => {
    const { service, prisma } = makeService();
    prisma.laneSchedule.findFirst.mockResolvedValue({
      ownerAdminId: 'admin-2',
      attendees: [{ shooterId: null, displayName: 'Roshan' }],
    });

    await expect(
      service.assertSessionAllowedForAdmin(
        1,
        'admin-1',
        { shooterName: 'Roshan' },
        new Date(startsAt),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows only a scheduled attendee for the owning admin', async () => {
    const { service, prisma } = makeService();
    prisma.laneSchedule.findFirst.mockResolvedValue({
      ownerAdminId: 'admin-1',
      attendees: [
        { shooterId: 'shooter-1', displayName: 'Roshan' },
        { shooterId: null, displayName: 'Bilal' },
      ],
    });

    await expect(
      service.assertSessionAllowedForAdmin(
        1,
        'admin-1',
        { shooterName: ' roshan ' },
        new Date(startsAt),
      ),
    ).resolves.toBeUndefined();
    await expect(
      service.assertSessionAllowedForAdmin(
        1,
        'admin-1',
        { shooterName: 'Someone else' },
        new Date(startsAt),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('preserves the manual shooter fallback when no schedule is active', async () => {
    const { service, prisma } = makeService();
    prisma.laneSchedule.findFirst.mockResolvedValue(null);

    await expect(
      service.assertSessionAllowedForAdmin(
        1,
        'admin-1',
        { shooterName: 'Walk-in shooter' },
        new Date(startsAt),
      ),
    ).resolves.toBeUndefined();
  });
});
