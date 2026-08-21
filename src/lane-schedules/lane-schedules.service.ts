import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ScheduleIdentitySource, type Prisma } from '@prisma/client';
import { Subject, type Observable } from 'rxjs';

import { PrismaService } from '@/common/prisma/prisma.service';
import {
  CreateLaneScheduleDto,
  type LaneScheduleAttendeeDto,
} from './dto/create-lane-schedule.dto';
import { LaneScheduleRangeDto } from './dto/lane-schedule-range.dto';
import { UpdateLaneScheduleDto } from './dto/update-lane-schedule.dto';
import type { LaneScheduleChangedEvent } from './lane-schedule.events';

interface NormalizedAttendee {
  shooterId?: string;
  displayName: string;
  identitySource: ScheduleIdentitySource;
  externalProvider?: string;
  externalId?: string;
}

const OWNER_INCLUDE = {
  lane: { select: { id: true, name: true } },
  attendees: { orderBy: { createdAt: 'asc' as const } },
} as const;

type ScheduleWithDetails = Prisma.LaneScheduleGetPayload<{
  include: typeof OWNER_INCLUDE;
}>;

@Injectable()
export class LaneSchedulesService {
  private readonly changes = new Subject<LaneScheduleChangedEvent>();
  readonly changes$: Observable<LaneScheduleChangedEvent> =
    this.changes.asObservable();

  constructor(private readonly prisma: PrismaService) {}

  async create(ownerAdminId: string, dto: CreateLaneScheduleDto) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    this.assertTimeRange(startsAt, endsAt);
    await this.assertLane(dto.laneId);
    await this.assertNoOverlap(dto.laneId, startsAt, endsAt);
    const attendees = await this.normalizeAttendees(dto.attendees);

    const schedule = await this.prisma.laneSchedule.create({
      data: {
        ownerAdminId,
        laneId: dto.laneId,
        startsAt,
        endsAt,
        attendees: { create: attendees },
      },
      include: this.ownerInclude,
    });
    this.announce(schedule.laneId, schedule.startsAt, schedule.endsAt);
    return this.asOwnerView(schedule);
  }

  async findRange(ownerAdminId: string, query: LaneScheduleRangeDto) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (from >= to) {
      throw new BadRequestException('Schedule range must end after it starts');
    }

    const schedules = await this.prisma.laneSchedule.findMany({
      where: {
        cancelledAt: null,
        startsAt: { lt: to },
        endsAt: { gt: from },
      },
      orderBy: [{ laneId: 'asc' }, { startsAt: 'asc' }],
      include: this.ownerInclude,
    });

    return schedules.map((schedule) =>
      schedule.ownerAdminId === ownerAdminId
        ? this.asOwnerView(schedule)
        : this.asBusyView(schedule),
    );
  }

  async update(
    id: string,
    ownerAdminId: string,
    dto: UpdateLaneScheduleDto,
  ) {
    const existing = await this.findOwned(id, ownerAdminId);
    this.assertNotFinished(existing.endsAt);
    const laneId = dto.laneId ?? existing.laneId;
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : existing.startsAt;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : existing.endsAt;
    this.assertTimeRange(startsAt, endsAt);
    if (laneId !== existing.laneId) await this.assertLane(laneId);
    await this.assertNoOverlap(laneId, startsAt, endsAt, id);
    const attendees = dto.attendees
      ? await this.normalizeAttendees(dto.attendees)
      : undefined;

    const schedule = await this.prisma.laneSchedule.update({
      where: { id },
      data: {
        laneId,
        startsAt,
        endsAt,
        ...(attendees
          ? { attendees: { deleteMany: {}, create: attendees } }
          : {}),
      },
      include: this.ownerInclude,
    });
    this.announce(existing.laneId, existing.startsAt, existing.endsAt);
    this.announce(schedule.laneId, schedule.startsAt, schedule.endsAt);
    return this.asOwnerView(schedule);
  }

  async cancel(id: string, ownerAdminId: string) {
    const existing = await this.findOwned(id, ownerAdminId);
    this.assertNotFinished(existing.endsAt);
    const schedule = await this.prisma.laneSchedule.update({
      where: { id },
      data: { cancelledAt: new Date() },
      include: this.ownerInclude,
    });
    this.announce(existing.laneId, existing.startsAt, existing.endsAt);
    return this.asOwnerView(schedule);
  }

  /**
   * Protects immediate session creation during an active reservation.
   * Outside a reservation the existing manual flow remains unrestricted; in
   * an owned reservation the shooter must come from its informational roster.
   */
  async assertSessionAllowedForAdmin(
    laneId: number,
    adminId: string,
    shooter: { shooterId?: string; shooterName?: string },
    at = new Date(),
  ): Promise<void> {
    const blocking = await this.prisma.laneSchedule.findFirst({
      where: {
        laneId,
        cancelledAt: null,
        startsAt: { lte: at },
        endsAt: { gt: at },
      },
      select: {
        ownerAdminId: true,
        attendees: { select: { shooterId: true, displayName: true } },
      },
    });
    if (blocking && blocking.ownerAdminId !== adminId) {
      throw new ConflictException('This lane is reserved and currently busy');
    }
    if (!blocking) return;

    const normalizedName = shooter.shooterName?.trim().toLowerCase();
    const isScheduled = blocking.attendees.some(
      (attendee) =>
        (!!shooter.shooterId && attendee.shooterId === shooter.shooterId) ||
        (!!normalizedName &&
          attendee.displayName.trim().toLowerCase() === normalizedName),
    );
    if (!isScheduled) {
      throw new BadRequestException(
        'Select a shooter from the active lane schedule',
      );
    }
  }

  private async findOwned(id: string, ownerAdminId: string) {
    const schedule = await this.prisma.laneSchedule.findFirst({
      where: { id, ownerAdminId, cancelledAt: null },
      include: this.ownerInclude,
    });
    if (!schedule) throw new NotFoundException('Lane schedule not found');
    return schedule;
  }

  private async assertLane(laneId: number): Promise<void> {
    const lane = await this.prisma.lane.findUnique({
      where: { id: laneId },
      select: { id: true },
    });
    if (!lane) throw new BadRequestException(`Lane ${laneId} not found`);
  }

  private assertTimeRange(startsAt: Date, endsAt: Date): void {
    if (startsAt >= endsAt) {
      throw new BadRequestException('Schedule end time must be after start time');
    }
    if (endsAt <= new Date()) {
      throw new BadRequestException('Schedule must end in the future');
    }
  }

  private assertNotFinished(endsAt: Date): void {
    if (endsAt <= new Date()) {
      throw new BadRequestException('A finished schedule cannot be changed');
    }
  }

  private async assertNoOverlap(
    laneId: number,
    startsAt: Date,
    endsAt: Date,
    ignoreId?: string,
  ): Promise<void> {
    const overlap = await this.prisma.laneSchedule.findFirst({
      where: {
        laneId,
        cancelledAt: null,
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
        ...(ignoreId ? { id: { not: ignoreId } } : {}),
      },
      select: { id: true },
    });
    if (overlap) {
      throw new ConflictException('This lane is busy during the selected time');
    }
  }

  private async normalizeAttendees(
    input: LaneScheduleAttendeeDto[],
  ): Promise<NormalizedAttendee[]> {
    if (input.length === 0) {
      throw new BadRequestException('At least one attendee is required');
    }

    const localIds = input
      .filter((row) => row.identitySource === ScheduleIdentitySource.LOCAL)
      .map((row) => row.shooterId?.trim())
      .filter((id): id is string => Boolean(id));
    const shooters = localIds.length
      ? await this.prisma.shooter.findMany({
          where: { id: { in: localIds } },
          select: { id: true, name: true },
        })
      : [];
    const shooterById = new Map(shooters.map((row) => [row.id, row]));

    const normalized = input.map((row): NormalizedAttendee => {
      if (row.identitySource === ScheduleIdentitySource.LOCAL) {
        const shooter = row.shooterId
          ? shooterById.get(row.shooterId.trim())
          : undefined;
        if (!shooter) {
          throw new BadRequestException('Every local attendee must be a registered shooter');
        }
        return {
          shooterId: shooter.id,
          displayName: shooter.name,
          identitySource: ScheduleIdentitySource.LOCAL,
        };
      }

      const displayName = row.displayName?.trim();
      if (!displayName) {
        throw new BadRequestException('Every manual or external attendee needs a name');
      }
      if (
        row.identitySource === ScheduleIdentitySource.EXTERNAL &&
        (!row.externalProvider?.trim() || !row.externalId?.trim())
      ) {
        throw new BadRequestException('External attendees need a provider and external ID');
      }
      return {
        displayName,
        identitySource: row.identitySource,
        externalProvider: row.externalProvider?.trim() || undefined,
        externalId: row.externalId?.trim() || undefined,
      };
    });

    const keys = normalized.map((row) =>
      row.shooterId
        ? `local:${row.shooterId}`
        : `${row.identitySource}:${row.displayName.toLocaleLowerCase()}`,
    );
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException('The same attendee cannot be added twice');
    }
    return normalized;
  }

  private readonly ownerInclude = OWNER_INCLUDE;

  private asOwnerView(schedule: ScheduleWithDetails) {
    return {
      access: 'OWNER' as const,
      id: schedule.id,
      laneId: schedule.laneId,
      laneName: schedule.lane.name,
      startsAt: schedule.startsAt,
      endsAt: schedule.endsAt,
      cancelledAt: schedule.cancelledAt,
      attendees: schedule.attendees.map((row) => ({
        id: row.id,
        shooterId: row.shooterId,
        displayName: row.displayName,
        identitySource: row.identitySource,
        externalProvider: row.externalProvider,
        externalId: row.externalId,
      })),
    };
  }

  private asBusyView(schedule: ScheduleWithDetails) {
    return {
      access: 'BUSY' as const,
      id: schedule.id,
      laneId: schedule.laneId,
      laneName: schedule.lane.name,
      startsAt: schedule.startsAt,
      endsAt: schedule.endsAt,
    };
  }

  private announce(laneId: number, startsAt: Date, endsAt: Date): void {
    this.changes.next({
      type: 'lane-schedule:changed',
      laneId,
      startsAt,
      endsAt,
    });
  }
}
