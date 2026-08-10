import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Target } from '@prisma/client';
import { Subject, type Observable, type Subscription } from 'rxjs';

import { PrismaService } from '@/common/prisma/prisma.service';
import {
  CMD_HIT,
  CMD_TELEMETRY,
} from '@/transport/protocol/frame.codec';
import { SequenceTracker } from '@/transport/protocol/sequence.tracker';
import { TargetCommandService } from '@/transport/target-command.service';
import type { InBoundFrame, TargetRef } from '@/transport/target-transport.interface';
import { TransportRegistry } from '@/transport/transport.registry';

import { SessionsService } from '@/sessions/sessions.service';

import {
  scoreShot,
  isSentinel,
  signedMm,
  toSigned16,
  SENSOR_Y_FLOOR_BIAS_MM,
} from './scoring';
import type { ShotEvent } from './sensor.events';
import { TargetResolver } from './target-resolver.service';
import { SensorGateService } from './sensor-gate.service';

/**
 * How many consecutive holes we are willing to call "lost bullets" and write
 * placeholder rows for.
 *
 * A shooter can plausibly lose a handful of datagrams to a weak link. They
 * cannot plausibly lose thirty in a row and keep firing — that pattern means
 * the sequence anchor is desynced (a board reboot, a counter reset, a target
 * swapped underneath us), and fabricating a row per hole would bury the real
 * shots under invented ones. Past this many, log and leave the numbering alone.
 */
const MAX_PLACEHOLDER_BURST = 8;

/** Where a reserved-but-unfilled bullet is parked, pending resend. */
interface ReservedSlot {
  stageId: string;
  shotNumber: number;
}

function slotKey(targetId: string, absolute: number): string {
  return `${targetId}:${absolute}`;
}

@Injectable()
export class SensorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SensorService.name);

  private sub?: Subscription;
  private sessionsSub?: Subscription;

  private readonly shots = new Subject<ShotEvent>();
  readonly shots$: Observable<ShotEvent> = this.shots.asObservable();

  private readonly queues = new Map<string, Promise<unknown>>();

  private readonly resendEnabled: boolean;

  private readonly resendGraceMs: number;

  private readonly maxResendAttempts: number;


  private readonly pendingGaps = new Map<
    string,
    Map<number, { timer: NodeJS.Timeout; lostTimer: NodeJS.Timeout; attempts: number }>
  >();

  /**
   * Placeholder rows written for holes we are still chasing, keyed
   * `${targetId}:${absolute}`.
   *
   * Exists because shotNumber is stage-relative ("rows so far + 1") while the
   * sequence tracker counts board-lifetime bullets, so there is no arithmetic
   * that maps one onto the other. The slot is recorded at reserve time and
   * looked up again if the bullet lands late, which is what lets a resend fill
   * its own row rather than take a fresh number at the end of the list.
   */
  private readonly reservedSlots = new Map<string, ReservedSlot>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: TransportRegistry,
    private readonly targetCommand: TargetCommandService,
    private readonly sequence: SequenceTracker,
    private readonly resolver: TargetResolver,
    private readonly sessions: SessionsService,
    private readonly gate: SensorGateService,
    config: ConfigService,
  ) {
    this.resendEnabled = config.get<string>('SENSOR_RESEND_ENABLED', 'false') === 'true';
    this.resendGraceMs = Number(config.get<string>('RESEND_GRACE_MS', '150'));
   this.maxResendAttempts = Number(
  config.get('MAX_RESEND_ATTEMPTS', '0'),
);
  }

  onModuleInit(): void {
    // The one step in raw -> scored that is not visible on a shot line. The
    // per-shot log prints raw() already biased, so without this the constant
    // that produced it is invisible to anyone reading the log later.
    this.logger.log(
      `Shot geometry: raw = signed16(wire) with Y floor bias ` +
        `${SENSOR_Y_FLOOR_BIAS_MM}mm subtracted; scored = raw + per-target cal.`,
    );

    this.sub = this.registry.frames$.subscribe((frame) => {

      void this.handle(frame);
    });

    this.sessionsSub = this.sessions.events$.subscribe((event) => {
      if (event.type === 'session:started' || event.type === 'session:resumed') {
        this.gate.setHeld(false);
      }

      // Anything that arms a board starts a new relay on it, so whatever this
      // service was still chasing for that target belongs to the previous one.
      // SessionsService resets the SequenceTracker at the same moments; this is
      // the other half, and it cannot live there — SensorModule imports
      // SessionsModule, so the dependency only runs this way round.
      if (
        event.type === 'session:started' ||
        event.type === 'session:resumed' ||
        event.type === 'session:advanced'
      ) {
        if (event.targetId) this.resetTarget(event.targetId);
      }
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    this.sessionsSub?.unsubscribe();
    this.shots.complete();
    this.queues.clear();
    this.clearAllGaps();
  }

  private async handle(frame: InBoundFrame): Promise<void> {
    try {
      switch (frame.command) {
        case CMD_TELEMETRY:
          await this.onTelemetry(frame);
          return;
        case CMD_HIT:
          await this.onHit(frame);
          return;
        default:
          // CMD_PLAY echoes are acks — TargetCommandService already consumes
          // those off the same stream. Anything else is not ours.
          return;
      }
    } catch (err) {
      this.logger.error(
        `Frame from ${frame.sourceKey} failed: ${(err as Error).message}`,
      );
    }
  }

  private async onTelemetry(frame: InBoundFrame): Promise<void> {
    const target = await this.resolver.resolve(frame.sourceKey);
    if (!target) return;

    await this.prisma.target.update({
      where: { id: target.id },
      data: { lastSeenAt: frame.receivedAt },
    });
  }


private scheduleGapResend(target: Target, absolute: number): void {
  const pending = this.pendingGaps.get(target.id) ?? new Map();
  this.pendingGaps.set(target.id, pending);

  if (pending.has(absolute)) return;

  const MAX_RETRY_DELAY_MS = 5000;
  const LOST_TIMEOUT_MS = 60000; // after 60s, mark as lost

  let lostTimer: NodeJS.Timeout;

  const attempt = (attemptsSoFar: number): void => {
    // Bullet arrived while waiting
    if (this.sequence.hasSeen(target.id, absolute)) {
      clearTimeout(lostTimer);
      this.clearGap(target.id, absolute);
      return;
    }

    if (this.maxResendAttempts > 0 && attemptsSoFar >= this.maxResendAttempts) {
      this.logger.warn(
        `${target.label}: max resend attempts reached for bullet #${absolute}`,
      );
      this.clearGap(target.id, absolute);
      void this.serializeAndWait(target.id, () => this.publishLost(target, absolute));
      return;
    }

    this.logger.warn(
      `${target.label}: requesting missing bullet #${absolute} ` +
      `(attempt ${attemptsSoFar + 1})`,
    );

    void this.targetCommand
      .resend(this.targetRef(target), absolute & 0xff)
      .catch((err: Error) =>
        this.logger.warn(
          `Resend #${absolute} -> ${target.label} failed: ${err.message}`,
        ),
      );

    const entry = pending.get(absolute);

    if (!entry) return;

    entry.attempts = attemptsSoFar + 1;

    // Exponential backoff:
    // 150ms -> 300ms -> 600ms -> 1200ms -> 2400ms -> 4800ms...
    const delay = Math.min(
      this.resendGraceMs * Math.pow(2, attemptsSoFar),
      MAX_RETRY_DELAY_MS,
    );

    entry.timer = setTimeout(
      () => attempt(attemptsSoFar + 1),
      delay,
    );

    entry.timer.unref?.();
  };


  // Safety timeout:
  // If the board truly lost the shot forever, eventually close it.
  lostTimer = setTimeout(() => {
    if (this.sequence.hasSeen(target.id, absolute)) {
      this.clearGap(target.id, absolute);
      return;
    }

    this.logger.warn(
      `${target.label}: bullet #${absolute} missing after ${LOST_TIMEOUT_MS}ms — marking lost.`,
    );

    this.clearGap(target.id, absolute);

    void this.serializeAndWait(target.id, () =>
      this.publishLost(target, absolute),
    );

  }, LOST_TIMEOUT_MS);

  lostTimer.unref?.();


  const timer = setTimeout(
    () => attempt(0),
    this.resendGraceMs,
  );

  timer.unref?.();

  pending.set(absolute, {
    timer,
    lostTimer,
    attempts: 0,
  });
}
private serializeAndWait<T>(
  targetId: string,
  work: () => Promise<T>,
): Promise<T> {
  const tail = this.queues.get(targetId) ?? Promise.resolve();

  const next = tail.then(work);

  this.queues.set(
    targetId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );

  return next;
}
  /** The bullet turned up. Stop chasing it. */
  private gapArrived(targetId: string, absolute: number): void {
    const pending = this.pendingGaps.get(targetId);
    if (!pending?.has(absolute)) return;
    this.logger.log(
      `Bullet #${absolute} arrived late on its own — resend cancelled.`,
    );
    this.clearGap(targetId, absolute);
  }

private clearGap(targetId: string, absolute: number): void {
  const pending = this.pendingGaps.get(targetId);
  const entry = pending?.get(absolute);

  if (!entry) return;

  clearTimeout(entry.timer);
  clearTimeout(entry.lostTimer);

  pending!.delete(absolute);

  if (pending!.size === 0) {
    this.pendingGaps.delete(targetId);
  }
}
  /**
   * Drop everything this service is still chasing for one target.
   *
   * Called when a board is (re)armed for a new relay. The timers are the point:
   * a gap chase runs for up to LOST_TIMEOUT_MS (60s) and keeps asking the board
   * to resend bullet numbers from the PREVIOUS session, which is how a
   * five-shot relay ended up logging "requesting missing bullet #21". The
   * reserved slots go with them — they name rows in a stage that is over, so a
   * late frame must not be allowed to fill one.
   */
  resetTarget(targetId: string): void {
    const pending = this.pendingGaps.get(targetId);
    if (pending) {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        clearTimeout(entry.lostTimer);
      }
      this.pendingGaps.delete(targetId);
    }

    const prefix = `${targetId}:`;
    for (const key of this.reservedSlots.keys()) {
      if (key.startsWith(prefix)) this.reservedSlots.delete(key);
    }

    if (pending?.size) {
      this.logger.log(
        `Dropped ${pending.size} outstanding bullet chase(s) for ${targetId} — new relay armed.`,
      );
    }
  }

  /** Drop every outstanding chase (shutdown). */
private clearAllGaps(): void {
  for (const pending of this.pendingGaps.values()) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      clearTimeout(entry.lostTimer);
    }
  }

  this.pendingGaps.clear();
  this.reservedSlots.clear();
}

  // ── Lost bullets ───────────────────────────────────────────────────────────

  /**
   * Write an empty row to hold a missing bullet's place in the stage.
   *
   * Deliberately silent: no shot event is emitted here. During the resend grace
   * window we do not yet know whether this bullet is lost or merely late, and
   * announcing it would flash a LOST row on every tablet that then has to be
   * retracted 150ms later. The row exists so the NEXT shot gets the right
   * number; publishLost announces it only once giving up is final.
   */
  private async reserveLostSlot(
    target: Target,
    absolute: number,
    firedAt: Date,
  ): Promise<void> {
    const key = slotKey(target.id, absolute);
    if (this.reservedSlots.has(key)) return;

    const stage = await this.prisma.sessionStage?.findFirst({
      where: { targetId: target.id, status: 'ACTIVE' },
      include: { _count: { select: { shots: true } } },
    });
    if (!stage) return;

    const shotNumber = stage._count.shots + 1;
    // A bullet that would have exceeded the stage's allowance is not recorded,
    // matching what persistHit does with a real one that overruns.
    if (stage.bulletLimit > 0 && shotNumber > stage.bulletLimit) return;

    await this.prisma.shot?.create({
      data: {
        sessionStageId: stage.id,
        shotNumber,
        x: 0,
        y: 0,
        score: 0,
        isMiss: true,
        isLost: true,
        firedAt,
      },
    });

    this.reservedSlots.set(key, { stageId: stage.id, shotNumber });

    this.logger.warn(
      `${target.label}: reserved shot #${shotNumber} for missing bullet ` +
        `#${absolute} — placeholder written so later shots keep their numbers.`,
    );
  }

  /** Giving up is final: announce the placeholder to connected clients. */
  private async publishLost(target: Target, absolute: number): Promise<void> {
    const key = slotKey(target.id, absolute);
    const slot = this.reservedSlots.get(key);
    if (!slot) return;
    this.reservedSlots.delete(key);

    const row = await this.prisma.shot?.findUnique({
      where: {
        sessionStageId_shotNumber: {
          sessionStageId: slot.stageId,
          shotNumber: slot.shotNumber,
        },
      },
    });
    // Cleared isLost means the bullet landed after all and persistHit already
    // announced the real thing; a missing row means the stage was torn down.
    if (!row?.isLost) return;

    const stage = await this.prisma.sessionStage?.findUnique({
      where: { id: slot.stageId },
      include: { _count: { select: { shots: true } } },
    });
    if (!stage) return;

    if (stage.bulletLimit > 0 && slot.shotNumber >= stage.bulletLimit) {
      this.logger.log(
        `${target.label}: bullet limit ${stage.bulletLimit} reached on a lost ` +
          `bullet — advancing stage.`,
      );
      void this.sessions
        .advance(stage.sessionId)
        .catch((err: Error) =>
          this.logger.error(
            `Auto-advance after bullet limit failed for session ${stage.sessionId}: ${err.message}`,
          ),
        );
    }

    this.shots.next({
      laneId: target.laneId,
      targetId: target.id,
      targetLabel: target.label,
      sessionId: stage.sessionId,
      sessionStageId: stage.id,
      stageOrder: stage.order,
      shotNumber: slot.shotNumber,
      x: 0,
      y: 0,
      score: 0,
      isMiss: true,
      isLost: true,
      firedAt: row.firedAt,
      stageShotCount: stage._count.shots,
    });
  }

  private formatFrame(frame: InBoundFrame): string {
    if (!frame.bytes.length) {
      return `frame=<synthetic, no wire bytes> cmd=0x${frame.command
        .toString(16)
        .padStart(2, '0')} n=${frame.bulletCounter} x=${frame.rawX} y=${frame.rawY}`;
    }

    const hex = frame.bytes
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');

    return (
      `frame=[${hex}] ` +
      `cmd=0x${frame.command.toString(16).padStart(2, '0')}` +
      `(${String.fromCharCode(frame.command)}) ` +
      `n=${frame.bulletCounter} ` +
      `x=${frame.rawX}(0x${frame.rawX.toString(16).padStart(4, '0')}) ` +
      `y=${frame.rawY}(0x${frame.rawY.toString(16).padStart(4, '0')}) ` +
      `from=${frame.sourceKey}`
    );
  }

  // ── Hits ───────────────────────────────────────────────────────────────────

  private async onHit(frame: InBoundFrame): Promise<void> {
    const target = await this.resolver.resolve(frame.sourceKey);
    if (!target) return;

    const { absolute, duplicate, gaps } = this.sequence.observe(
      target.id,
      frame.bulletCounter,
    );
    if (duplicate) return;

    if (this.sequence.hasSeen(target.id, absolute)) {
      this.gapArrived(target.id, absolute);
    }


    if (gaps.length > 0) {
      this.logger.warn(
        `${target.label}: sequence broke — missing #${gaps.join(', #')} before #${absolute}` +
          (this.resendEnabled
            ? ` — waiting ${this.resendGraceMs}ms for late arrival.`
            : ' — dropped (resend disabled).') +
          ` ${this.formatFrame(frame)}`,
      );

      if (gaps.length > MAX_PLACEHOLDER_BURST) {
        // Not a lossy link — a desynced anchor. See MAX_PLACEHOLDER_BURST.
        this.logger.error(
          `${target.label}: ${gaps.length} consecutive missing bullets before ` +
            `#${absolute} — too many to be packet loss, so no placeholders were ` +
            `written and shot numbering will shift. Check whether the board rebooted ` +
            `or its bullet counter was reset mid-stage.`,
        );
      } else {
        for (const gap of gaps) {
          await this.serializeAndWait(target.id, () =>
            this.reserveLostSlot(target, gap, frame.receivedAt),
          );

          if (this.resendEnabled) {
            this.scheduleGapResend(target, gap);
          } else {
            await this.serializeAndWait(target.id, () => this.publishLost(target, gap));
          }
        }
      }
    }

    if (isSentinel(frame.rawX, frame.rawY)) {
      this.logger.warn(
        `${target.label}: shot #${absolute} reported no detection (${frame.rawX}, ${frame.rawY}) — ` +
          `frame arrived intact and in sequence, so this is a board-side ` +
          `detection failure, not packet loss. Scored as a miss. ` +
          `${this.formatFrame(frame)}`,
      );
    }

    this.serialize(target.id, () => this.persistHit(target, frame, absolute));
  }


  async simulateHit(laneId: number, rawX: number, rawY: number): Promise<ShotEvent> {
    const target = await this.prisma.target.findFirst({
      where: { laneId, stages: { some: { status: 'ACTIVE' } } },
    });
    if (!target) {
      throw new BadRequestException(
        `No active session on lane ${laneId} — start one before simulating a shot.`,
      );
    }

    const frame: InBoundFrame = {
      sourceKey: 'debug',
      transport: 'WIFI',
      command: CMD_HIT,
      bulletCounter: 0,
      rawX,
      rawY,
      payload: [],
      bytes: [],
      receivedAt: new Date(),
    };

    return new Promise<ShotEvent>((resolve, reject) => {
      void this.serializeAndWait(target.id, async () => {
        try {
          const event = await this.persistHit(target, frame);
          if (!event) {
            reject(
              new BadRequestException(
                `Shot rejected — no active stage or bullet limit already reached on lane ${laneId}.`,
              ),
            );
            return;
          }
          resolve(event);
        } catch (err) {
          reject(err as Error);
        }
      });
    });
  }

  private async persistHit(
    target: Target,
    frame: InBoundFrame,
    absolute?: number,
  ): Promise<ShotEvent | null> {
    const stage = await this.prisma.sessionStage.findFirst({
      where: { targetId: target.id, status: 'ACTIVE' },
      include: { _count: { select: { shots: true } } },
    });


    if (!stage) {
      this.logger.warn(
        `Unassigned shot from ${target.label}: no active stage on this target.`,
      );
      return null;
    }

    const reservationKey =
      absolute != null ? slotKey(target.id, absolute) : null;
    const reservation = reservationKey
      ? this.reservedSlots.get(reservationKey)
      : undefined;
    const filledReservation =
      reservation?.stageId === stage.id ? reservation : undefined;

    const shotNumber = filledReservation
      ? filledReservation.shotNumber
      : stage._count.shots + 1;

    if (!filledReservation && stage.bulletLimit > 0 && shotNumber > stage.bulletLimit) {
      this.logger.warn(
        `${target.label}: shot #${shotNumber} exceeds stage bullet limit ${stage.bulletLimit} — rejected.`,
      );
      return null;
    }

    const scored = scoreShot({
      rawX: frame.rawX,
      rawY: frame.rawY,
      offsetXmm: target.offsetXmm,
      offsetYmm: target.offsetYmm,
      profile: stage.profileType,
    });

    await this.prisma.shot.upsert({
      where: {
        sessionStageId_shotNumber: {
          sessionStageId: stage.id,
          shotNumber,
        },
      },
      create: {
        sessionStageId: stage.id,
        shotNumber,
        x: scored.x,
        y: scored.y,
        score: scored.score,
        isMiss: scored.isMiss,
        isLost: false,
        firedAt: frame.receivedAt,
      },
      update: {
        x: scored.x,
        y: scored.y,
        score: scored.score,
        isMiss: scored.isMiss,
        isLost: false,
        firedAt: frame.receivedAt,
      },
    });

    if (reservationKey) this.reservedSlots.delete(reservationKey);

    const stageShotCount = filledReservation
      ? await this.prisma.shot.count({ where: { sessionStageId: stage.id } })
      : shotNumber;

    const event: ShotEvent = {
      laneId: target.laneId,
      targetId: target.id,
      targetLabel: target.label,
      sessionId: stage.sessionId,
      sessionStageId: stage.id,
      stageOrder: stage.order,
      shotNumber,
      x: scored.x,
      y: scored.y,
      score: scored.score,
      isMiss: scored.isMiss,
      isLost: false,
      firedAt: frame.receivedAt,
      stageShotCount,
    };
    this.shots.next(event);


    if (
      !filledReservation &&
      stage.bulletLimit > 0 &&
      stageShotCount >= stage.bulletLimit
    ) {
      this.logger.log(
        `${target.label}: bullet limit ${stage.bulletLimit} reached — advancing stage.`,
      );
      void this.sessions
        .advance(stage.sessionId)
        .catch((err: Error) =>
          this.logger.error(
            `Auto-advance after bullet limit failed for session ${stage.sessionId}: ${err.message}`,
          ),
        );
    }

    // The whole arithmetic is printed on every located shot, not just the
    // result and not just on the line where the calibration changed. Reading a
    // scored coordinate back to its raw frame otherwise means sign-correcting
    // the wire bytes by hand, remembering the Y floor bias, and finding the
    // last CALIBRATED line — which may be in an earlier session, or in a log
    // that has already rolled. A shot whose offset cannot be reconstructed
    // cannot be argued with afterwards, so the line shows what the sensor
    // gave, what was added to it, and what that produced:
    //
    //   25M #2: raw(-269, 309) + cal(+278, -750)mm = (9, -441) = 0
    //
    // raw() is post-sign-correction and post-Y-floor-bias — i.e. millimetres
    // from centre as the sensor saw them, the exact quantity the offset is
    // added to. cal(none) is printed rather than omitted so that calibrated
    // and uncalibrated shots line up column-wise and grep the same way.
    // Omitted entirely on a miss: there are no coordinates for it to explain.
    const geometry = scored.isMiss
      ? 'MISS (no detection)'
      : `raw(${toSigned16(frame.rawX)}, ${
          toSigned16(frame.rawY) - SENSOR_Y_FLOOR_BIAS_MM
        }) + ${
          target.offsetXmm === 0 && target.offsetYmm === 0
            ? 'cal(none)'
            : `cal(${signedMm(target.offsetXmm)}, ${signedMm(target.offsetYmm)})mm`
        } = (${scored.x}, ${scored.y}) = ${scored.score}`;

    this.logger.log(
      `${target.label} #${shotNumber}: ${geometry} | ${this.formatFrame(frame)}`,
    );

    return event;
  }

  private serialize(targetId: string, work: () => Promise<unknown>): void {
    const tail = this.queues.get(targetId) ?? Promise.resolve();
    const next = tail
      .then(work)
      .catch((err: Error) =>
        this.logger.error(`Ingest failed for ${targetId}: ${err.message}`),
      );
    this.queues.set(targetId, next);
  }

  /** Adapt a persisted Target to the shape the transport layer speaks. */
  private targetRef(target: Target): TargetRef {
    return {
      id: target.id,
      laneId: String(target.laneId),
      label: target.label,
      transport: 'WIFI',
      ipAddress: target.ipAddress,
      commandHost: target.commandHost,
      commandPort: target.commandPort,
    };
  }
}
