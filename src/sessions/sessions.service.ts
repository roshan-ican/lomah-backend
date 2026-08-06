import { Subject, type Observable } from "rxjs"
import type { SessionEvent } from "./session.events"

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreateSessionDto } from './dto/create-session.dto';
import { Prisma } from '@prisma/client';

import { PrismaService } from '@/common/prisma/prisma.service';
import { TargetCommandService } from '@/transport/target-command.service';
import { scoreForRadius } from "@/sensor/scoring";


type PrismaTx = Prisma.TransactionClient;

/**
 * What a stage exposes about the target it engages: enough to label it
 * ("200m · Silhouette") without a second request, and nothing more.
 *
 * Explicitly a `select`, not `include: true`. Reachability — `ipAddress`,
 * `deviceId` — is commissioning data with no place on a scorecard, and it
 * would otherwise ride along on every lane-grid poll to every admin client.
 */
const STAGE_TARGET_SELECT = {
  select: {
    id: true,
    label: true,
    distanceM: true,
    positionIndex: true,
    profileType: true,
    // The board's current mounting offset. Not reachability data — it is the
    // calibration the shots on this stage were scored against, and the admin
    // console's offset panel is the one place it has to be readable from.
    // Without it that panel had no server-side value to render at all, so a
    // saved offset reported success and then reappeared as (0, 0) on reload.
    offsetXmm: true,
    offsetYmm: true,
  },
} as const;

@Injectable()
export class SessionsService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionsService.name);

  private readonly events = new Subject<SessionEvent>()
  readonly events$: Observable<SessionEvent> = this.events.asObservable()

  /** Whether a target must acknowledge PLAY before a stage may go live.
   *  Off only for bench work with no hardware attached. */
  private readonly requireAck: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly targetCommand: TargetCommandService,
    config: ConfigService,
  ) {
    this.requireAck =
      config.get<string>('SENSOR_REQUIRE_ACK', 'true') !== 'false';
  }

  async create(dto: CreateSessionDto) {
    if (dto.stages.length === 0) {
      throw new BadRequestException('At least one stage plan is required');
    }

    const lane = await this.prisma.lane.findUnique({
      where: { id: dto.laneId },
    });
    if (!lane) {
      throw new BadRequestException(`Lane ${dto.laneId} not found`);
    }

    const targetIds = dto.stages.map((s) => s.targetId);
    const targets = await this.prisma.target.findMany({
      where: { id: { in: targetIds } },
    });

    const foundIds = new Set(targets.map((t) => t.id));
    const missing = targetIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Target(s) not found: ${missing.join(', ')}`,
      );
    }

    const wrongLane = targets.filter((t) => t.laneId !== dto.laneId);
    if (wrongLane.length > 0) {
      throw new BadRequestException(
        wrongLane
          .map(
            (t) =>
              `Target ${t.id} ("${t.label}") belongs to lane ${t.laneId}, not lane ${dto.laneId}.`,
          )
          .join(' '),
      );
    }

    const session = await this.prisma.session.create({
      data: {
        laneId: dto.laneId,
        shooterId: dto.shooterId,
        shooterName: dto.shooterName,
        stages: {
          create: dto.stages.map((stage, index) => ({
            target: { connect: { id: stage.targetId } },
            order: index,
            bulletLimit: stage.bulletLimit,
            durationSeconds: stage.durationSeconds,
          })),
        },
      },
      include: {
        stages: true,
      },
    });
    this.events.next({
      type: 'session:created',
      laneId: session.laneId,
      sessionId: session.id,
      shooterName: session.shooterName
    })
    return session
  }

  /**
   * Sessions that are still LIVE — the lane grid's data source.
   *
   * Deliberately excludes COMPLETED / CANCELLED / SUPERSEDED. A lane holds at
   * most one open session, so filtering here is what lets a caller do
   * `sessions.find(s => s.laneId === n)` and get the right answer. Returning
   * every session ever recorded made that find() hit whichever finished
   * session happened to be first, so lanes displayed a dead session's status
   * and their controls disappeared.
   *
   * Finished sessions are history and belong to /reports/sessions.
   * Pass `includeAll` to bypass the filter.
   */
  findAll(includeAll = false) {
    return this.prisma.session.findMany({
      where: includeAll
        ? undefined
        : { status: { in: ['CREATED', 'ACTIVE', 'PAUSED'] } },
      orderBy: { createdAt: 'desc' },
      include: {
        stages: {
          orderBy: { order: 'asc' },
          include: {
            shots: { orderBy: { shotNumber: 'asc' } },
            target: STAGE_TARGET_SELECT,
          },
        },
      },
    });
  }

  async findOne(id: string) {
    const session = await this.prisma.session.findUnique({
      where: { id },
      include: {
        stages: {
          orderBy: { order: 'asc' },
          include: { shots: true, target: STAGE_TARGET_SELECT },
        },
      },
    });
    if (!session) {
      throw new NotFoundException(`Session ${id} not found`);
    }
    return session;
  }


  /**
   * Public, lane-scoped read for the shooter terminal (see
   * SessionsController.findActiveForLane) — the same live-session filter as
   * findAll, narrowed to one lane. Lets a freshly (re)connected
   * StationTerminal discover an already-active session on its own lane
   * instead of only ever finding out via a socket event, which — being a
   * live broadcast, not a queue — it may have missed entirely if the session
   * was already started before this tablet connected.
   */
  findActiveByLane(laneId: number) {
    return this.prisma.session.findFirst({
      where: { laneId, status: { in: ['CREATED', 'ACTIVE', 'PAUSED'] } },
      orderBy: { createdAt: 'desc' },
      include: {
        stages: {
          orderBy: { order: 'asc' },
          include: { shots: true, target: STAGE_TARGET_SELECT },
        },
      },
    });
  }

  async start(id: string) {
    const session = await this.findOne(id);

    if (session.status !== 'CREATED') {
      throw new BadRequestException(
        `Session ${id} is ${session.status} and cannot be started.`,
      );
    }

    const first = session.stages[0];
    if (!first) {
      throw new BadRequestException(`Session ${id} has no stages`);
    }

    // HANDSHAKE FIRST, then commit.
    //
    // The target must acknowledge PLAY before the session is allowed to go
    // ACTIVE. If the board is unpowered, unplugged or on the wrong address,
    // starting anyway produces a session that looks live on every screen while
    // no hardware is listening — the shooter fires and nothing is ever
    // recorded. Refusing to start is the honest failure, and it is what the
    // original backend did (session.manager.ts: `if (!playOk) throw`).
    //
    // Deliberately OUTSIDE and BEFORE the transaction: play() waits on a UDP
    // ack and retries, which is seconds of network I/O. Holding a write
    // transaction (and, on SQLite, a write lock) open for that would stall
    // every other lane. Nothing is written until the target answers.
    await this.arm(session.laneId, first.targetId);

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.session.update({
        where: { id },
        data: { status: 'ACTIVE', startedAt: now },
      });
      await this.armStageWrites(tx, session.laneId, first, now);
    });

    this.events.next({
      type: 'session:started',
      laneId: session.laneId,
      sessionId: id,
      stageId: first.id,
      stageOrder: first.order,
      targetId: first.targetId,
      startedAt: now,
    });

    return this.findOne(id);
  }

  async advance(id: string) {
    const session = await this.findOne(id);
    const current = session.stages.find((s) => s.status === 'ACTIVE');
    if (!current) throw new BadRequestException('No active stage to advance from.');

    const next = session.stages.find((s) => s.order === current.order + 1);
    const now = new Date();

    // Arm the NEXT target before committing, same rule as start(): a stage
    // must not be marked ACTIVE unless its board answered.
    //
    // The previous stage is stopped first so two targets on the same lane are
    // never armed simultaneously — if the next one then fails to answer, the
    // lane is left quiet rather than still scoring against the old target.
    await this.disarm(session.laneId, current.targetId);
    if (next) {
      await this.arm(session.laneId, next.targetId);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.sessionStage.update({
        where: { id: current.id },
        data: { status: 'COMPLETED', endedAt: now },
      });

      if (next) {
        await this.armStageWrites(tx, session.laneId, next, now);
        return;
      }

      await tx.session.update({
        where: { id },
        data: { status: 'COMPLETED', endedAt: now },
      });

      await tx.lane.update({
        where: { id: session.laneId },
        data: { activeTargetId: null },
      });
    });
    this.events.next({
      type: 'session:advanced',
      laneId: session.laneId,
      sessionId: id,
      fromStageId: current.id,
      toStageId: next?.id,
      toStageOrder: next?.order,
    });
    if (!next) {
      this.events.next({
        type: 'session:completed',
        laneId: session.laneId,
        sessionId: id,
        status: 'COMPLETED',
        endedAt: now,
      });
    }

    return this.findOne(id);
  }

  async stop(id: string) {
    const session = await this.findOne(id);
    const current = session.stages.find((s) => s.status === 'ACTIVE');
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      if (current) {
        await tx.sessionStage.update({
          where: { id: current.id },
          data: { status: 'COMPLETED', endedAt: now },
        });
      }
      await tx.session.update({
        where: { id },
        data: { status: 'CANCELLED', endedAt: now },
      });
      await tx.lane.update({
        where: { id: session.laneId },
        data: { activeTargetId: null },
      });
    });

    if (current) {
      await this.disarm(session.laneId, current.targetId);
    }
    this.events.next({
      type: 'session:completed',
      laneId: session.laneId,
      sessionId: id,
      status: 'CANCELLED',
      endedAt: now,
    });

    return this.findOne(id);
  }


  async pause(id: string) {
    const session = await this.findOne(id);
    if (session.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Session ${id} is ${session.status} and cannot be paused.`,
      );
    }

    const current = session.stages.find((s) => s.status === 'ACTIVE');
    const now = new Date();

    await this.prisma.session.update({
      where: { id },
      data: { status: 'PAUSED', pausedAt: now },
    });

    if (current) {
      await this.disarm(session.laneId, current.targetId);
    }
    this.events.next({
      type: 'session:paused',
      laneId: session.laneId,
      sessionId: id,
      pausedAt: now,
    });

    return this.findOne(id);
  }

  async resume(id: string) {
    const session = await this.findOne(id);
    if (session.status !== 'PAUSED') {
      throw new BadRequestException(
        `Session ${id} is ${session.status} and cannot be resumed.`,
      );
    }

    const current = session.stages.find((s) => s.status === 'ACTIVE');
    const now = new Date();

    const pausedMs = session.pausedAt
      ? now.getTime() - session.pausedAt.getTime()
      : 0;

    // Re-arm BEFORE clearing PAUSED, same rule as start(). A resume that the
    // board never acknowledged would otherwise leave the session reading
    // ACTIVE with a disarmed target — the shooter fires into a dead lane.
    // The original backend threw here too (session.manager.ts resume path).
    if (current) {
      await this.arm(session.laneId, current.targetId);
    }

    await this.prisma.session.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        pausedAt: null,
        totalPausedMs: session.totalPausedMs + Math.max(0, pausedMs),
      },
    });

    this.events.next({
      type: 'session:resumed',
      laneId: session.laneId,
      sessionId: id,
      totalPausedMs: session.totalPausedMs + Math.max(0, pausedMs),
    });

    return this.findOne(id);
  }


  async end(id: string) {
    const session = await this.findOne(id);
    if (session.status !== 'ACTIVE' && session.status !== 'PAUSED') {
      throw new BadRequestException(
        `Session ${id} is ${session.status} and cannot be ended.`,
      );
    }

    const current = session.stages.find((s) => s.status === 'ACTIVE');
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      if (current) {
        await tx.sessionStage.update({
          where: { id: current.id },
          data: { status: 'COMPLETED', endedAt: now },
        });
      }
      await tx.session.update({
        where: { id },
        data: { status: 'COMPLETED', endedAt: now },
      });
      await tx.lane.update({
        where: { id: session.laneId },
        data: { activeTargetId: null },
      });
    });

    if (current) {
      await this.disarm(session.laneId, current.targetId);
    }
    this.events.next({
      type: 'session:completed',
      laneId: session.laneId,
      sessionId: id,
      status: 'COMPLETED',
      endedAt: now,
    });

    return this.findOne(id);
  }


  async addFeedback(id: string, feedback: string, notes?: string) {
    const session = await this.findOne(id);
    await this.prisma.session.update({
      where: { id },
      data: { feedback, notes, reviewedAt: new Date() },
    });
    this.events.next({
      type: 'session:reviewed',
      laneId: session.laneId,
      sessionId: id,
      feedback,
    });
    return this.findOne(id);
  }


  async resetStageShots(id: string, stageId: string) {
    const session = await this.findOne(id);
    if (session.status !== 'ACTIVE' && session.status !== 'PAUSED') {
      throw new BadRequestException(
        `Session ${id} is ${session.status}; its shots can no longer be reset.`,
      );
    }

    const stage = session.stages.find((s) => s.id === stageId);
    if (!stage) {
      throw new NotFoundException(
        `Stage ${stageId} does not belong to session ${id}.`,
      );
    }

    const { count } = await this.prisma.shot.deleteMany({
      where: { sessionStageId: stageId },
    });

    this.logger.log(`Reset ${count} shot(s) on stage ${stageId}.`);

    this.events.next({
      type: 'session:shots_reset',
      laneId: session.laneId,
      sessionId: id,
      stageId,
    });
    return this.findOne(id);
  }
  
  async calibrateShot(
    sessionId: string,
    stageId: string,
    shotNumber: number,
    x: number,
    y: number,
  ) {
    const session = await this.findOne(sessionId);
    const stage = session.stages.find((s) => s.id === stageId);
    if (!stage) {
      throw new NotFoundException(
        `Stage ${stageId} does not belong to session ${sessionId}.`,
      );
    }

    const shot = await this.prisma.shot.findUnique({
      where: { sessionStageId_shotNumber: { sessionStageId: stageId, shotNumber } },
    });
    if (!shot) {
      throw new NotFoundException(
        `Shot #${shotNumber} not found on stage ${stageId}.`,
      );
    }

    // The stage's profile snapshot, same rule as SensorService.persistHit — not
    // target.profileType, which may have changed since this stage was fired.
    const score = scoreForRadius(Math.hypot(x, y), stage.profileType);

    // A manual drag repositions a shot that WAS detected. Whatever the sensor
    // originally reported, it is no longer "no detection" after this.
    const updated = await this.prisma.shot.update({
      where: { id: shot.id },
      data: { x, y, score, isMiss: false },
    });

    this.events.next({
      type: 'shot:calibrated',
      laneId: session.laneId,
      sessionId,
      sessionStageId: stageId,
      shotId: updated.id,
      shotNumber: updated.shotNumber,
      x: updated.x,
      y: updated.y,
      score: updated.score,
    });

    return updated;
  }

  private async armStageWrites(
    tx: PrismaTx,
    laneId: number,
    stage: { id: string; targetId: string },
    now: Date,
  ): Promise<void> {
    await tx.lane.update({
      where: { id: laneId },
      data: { activeTargetId: stage.targetId },
    });
    await tx.sessionStage.update({
      where: { id: stage.id },
      data: { status: 'ACTIVE', startedAt: now },
    });
  }

  /**
   * The HARDWARE half: tell the board to start scoring, and REFUSE TO PROCEED
   * if it does not answer.
   *
   * play() already retries (PLAY_MAX_ATTEMPTS, default 3) before giving up, so
   * reaching the throw means the target stayed silent through every attempt —
   * unpowered, not associated to the AP, or on a different address than the
   * one commissioned for it.
   *
   * Set SENSOR_REQUIRE_ACK=false to bypass this on a bench with no hardware
   * attached. It defaults to ON: silently arming a lane nothing is listening
   * to is the failure mode that loses a shooter's whole relay.
   */
  private async arm(laneId: number, targetId: string): Promise<void> {
    const target = await this.targetRef(laneId, targetId);
    const acked = await this.targetCommand.play(target);
    if (acked) return;

    if (!this.requireAck) {
      this.logger.warn(
        `${target.label} never acknowledged PLAY — continuing anyway ` +
          `(SENSOR_REQUIRE_ACK=false).`,
      );
      return;
    }

    throw new ServiceUnavailableException(
      `Target "${target.label}" (${target.ipAddress}) did not respond. ` +
        `Check that it is powered and connected, then try again.`,
    );
  }

  private async disarm(laneId: number, targetId: string): Promise<void> {
    try {
      await this.targetCommand.stop(await this.targetRef(laneId, targetId));
    } catch (err) {
      // An unreachable board must not prevent a session from being closed out.
      this.logger.warn(
        `STOP to target ${targetId} failed: ${(err as Error).message}`,
      );
    }
  }

  private async targetRef(laneId: number, targetId: string) {
    const target = await this.prisma.target.findUniqueOrThrow({ where: { id: targetId } });
    return { id: target.id, laneId: String(laneId), label: target.label, transport: 'WIFI' as const, ipAddress: target.ipAddress };
  }

  onModuleDestroy(): void {
    this.events.complete();
  }
}
