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
import { SequenceTracker } from '@/transport/protocol/sequence.tracker';
import { scoreAt } from "@/sensor/scoring";


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

  /**
   * targetId -> the stage it's currently armed for, known the instant PLAY is
   * acked in arm() — before any network round trip for a shot could even
   * begin, and well before the DB transaction that flips that stage's status
   * to ACTIVE actually commits.
   *
   * persistHit() (SensorService) reads this to find the right stage by id
   * instead of querying `status: 'ACTIVE'`, which raced that transaction: a
   * board can report a shot as soon as it echoes PLAY, but its stage's status
   * column doesn't flip until a separate, later write. Looking the row up by
   * id sidesteps that entirely — the row has existed since the stage was
   * created, long before this arm.
   */
  private readonly armedStageByTarget = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly targetCommand: TargetCommandService,
    private readonly sequenceTracker: SequenceTracker,
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

    // ── ONE OPEN SESSION PER LANE ────────────────────────────────────────────
    //
    // Nothing enforced this before, and the whole rest of the system assumes
    // it: findActiveByLane is a findFirst, the admin console's lane grid does
    // `sessions.find(s => s.laneId === n)`, and every command in the console
    // addresses the ONE session id held in that lane's channel state.
    //
    // So a second open session on a lane is not a harmless duplicate — it is
    // an orphan. It can never be started, stopped or ended by any UI, it keeps
    // coming back from GET /sessions forever, and which of the two the grid
    // shows after a reload is decided by createdAt ordering rather than by
    // anything the operator did. That is exactly how an edit could report
    // success and then reappear as the pre-edit plan on the next refresh.
    //
    // "Edit Config" is the legitimate reason to want a replacement, and it
    // says so explicitly via replaceExisting. Everything else is a bug in the
    // caller and gets told what is in the way, by id and status, instead of a
    // generic 400.
    const open = await this.prisma.session.findFirst({
      where: {
        laneId: dto.laneId,
        status: { in: ['CREATED', 'ACTIVE', 'PAUSED'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (open && !dto.replaceExisting) {
      throw new BadRequestException(
        `Lane ${dto.laneId} already has an open session (${open.id}, ${open.status}). ` +
        `End or discard it before configuring a new one.`,
      );
    }

    // A relay that has already gone downrange is not something an edit may
    // quietly throw away — there are shots recorded against its stages and a
    // target armed against its id. Refuse, and name the status so the console
    // can tell the operator what to do about it.
    if (open && open.status !== 'CREATED') {
      // The remedy differs by status, and telling a range officer to "pause"
      // a session that is already paused is the kind of not-quite-true message
      // that costs more time than saying nothing.
      const remedy =
        open.status === 'ACTIVE'
          ? 'Pause it first, then end or discard it'
          : 'End it or discard it';
      throw new BadRequestException(
        `Session ${open.id} on lane ${dto.laneId} is ${open.status} and cannot be edited. ` +
        `${remedy} before changing the plan.`,
      );
    }

    // Replace and create in ONE transaction. Cancelling the old session and
    // then failing to write the new one would leave the lane empty and the
    // operator's plan gone — the failure mode this whole change exists to
    // remove. Either the lane ends up with exactly the new plan, or it is left
    // untouched with the old one still intact.
    const endedAt = new Date();
    const session = await this.prisma.$transaction(async (tx) => {
      if (open) {
        await tx.session.update({
          where: { id: open.id },
          data: { status: 'CANCELLED', endedAt },
        });
      }

      return tx.session.create({
        data: {
          laneId: dto.laneId,
          shooterId: dto.shooterId,
          shooterName: dto.shooterName,
          notes: dto.notes,
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
    });

    // Announce the replacement BEFORE the creation, and announce it at all.
    //
    // The console used to do this itself by calling POST /:id/stop before
    // POST /sessions, which is what broadcast the cancel to every other admin
    // screen. Now that the swap happens here, the event has to happen here
    // too, or a second console watching this lane keeps showing the old plan
    // until something unrelated forces a resync — the exact "it looked saved
    // on one screen and not the other" symptom.
    //
    // Order matters: the client's handler for this event ignores a completion
    // that names a session the lane has already moved on from, so cancel-then-
    // create repaints correctly while create-then-cancel could blank the new
    // session on a slow client.
    if (open) {
      this.logger.log(
        `Lane ${dto.laneId}: session ${open.id} replaced by ${session.id} (edit).`,
      );
      this.events.next({
        type: 'session:completed',
        laneId: dto.laneId,
        sessionId: open.id,
        status: 'CANCELLED',
        endedAt,
      });
    }
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
    await this.arm(session.laneId, first.targetId, first.id);

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
      await this.arm(session.laneId, next.targetId, next.id);
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
      targetId: next?.targetId,
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
      await this.arm(session.laneId, current.targetId, current.id);
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
      targetId: current?.targetId,
    });

    return this.findOne(id);
  }


  /** Already over — ending one again is a no-op, not an error. See end(). */
  private static readonly TERMINAL_STATUSES = [
    'COMPLETED',
    'CANCELLED',
    'SUPERSEDED',
  ] as const;

  async end(id: string) {
    const session = await this.findOne(id);

    // Ending a session that is already finished is idempotent.
    //
    // The case that forced this: a server restart marks every interrupted
    // session SUPERSEDED (see SessionRecoveryService), but an admin console
    // that was open across the restart still has the session on its lane and
    // still offers End. Pressing it returned 400 "is SUPERSEDED and cannot be
    // ended" — an error the operator can neither act on nor clear, on a lane
    // the server had already released.
    //
    // Re-emitting session:completed is the point of doing this rather than
    // just returning: it is what tells every connected client to vacate the
    // lane, so the dead session actually leaves the grid instead of sitting
    // there until the next refresh.
    if (
      (SessionsService.TERMINAL_STATUSES as readonly string[]).includes(
        session.status,
      )
    ) {
      this.logger.warn(
        `End requested for ${session.status} session ${id} (lane ${session.laneId}) — ` +
          `already closed, re-announcing so stale clients release the lane.`,
      );
      this.events.next({
        type: 'session:completed',
        laneId: session.laneId,
        sessionId: id,
        // The real status is carried through rather than flattened to
        // COMPLETED: a session the server superseded did not finish the way an
        // operator-ended one did, and a client — or a later reader of this
        // event — should be able to tell the two apart.
        status: session.status,
        endedAt: session.endedAt ?? new Date(),
      });
      return session;
    }

    // CREATED is NOT terminal: the session was assigned but never started, and
    // "end" is the wrong verb for it — cancel() is. Still an error.
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
    const score = scoreAt(x, y, stage.profileType);

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
      sensorXmm: updated.sensorXmm ?? undefined,
      sensorYmm: updated.sensorYmm ?? undefined,
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

  /** Which stage `targetId` is currently armed for, if any. See
   *  armedStageByTarget above for why persistHit() should trust this over a
   *  `status: 'ACTIVE'` query. */
  getArmedStageId(targetId: string): string | undefined {
    return this.armedStageByTarget.get(targetId);
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
  private async arm(laneId: number, targetId: string, stageId: string): Promise<void> {
    const target = await this.targetRef(laneId, targetId);
    const acked = await this.targetCommand.play(target);

    if (acked) {
      this.sequenceTracker.reset(targetId);
      this.armedStageByTarget.set(targetId, stageId);
      return;
    }

    if (!this.requireAck) {
      this.sequenceTracker.reset(targetId);
      this.armedStageByTarget.set(targetId, stageId);
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
    // Cleared here rather than only on the next arm(): advance()'s final
    // stage has no "next" to overwrite this entry, so a session that ends
    // outright would otherwise leave a stale target -> stage mapping behind.
    this.armedStageByTarget.delete(targetId);
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
    return {
      id: target.id,
      laneId: String(laneId),
      label: target.label,
      transport: 'WIFI' as const,
      ipAddress: target.ipAddress,
      commandHost: target.commandHost,
      commandPort: target.commandPort,
    };
  }

  onModuleDestroy(): void {
    this.events.complete();
  }
}
