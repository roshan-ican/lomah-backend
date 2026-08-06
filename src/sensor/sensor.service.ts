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

import { scoreShot, isSentinel } from './scoring';
import type { ShotEvent } from './sensor.events';
import { TargetResolver } from './target-resolver.service';
import { SensorGateService } from './sensor-gate.service';

/**
 * Ingestion: frame -> target -> lane -> active stage -> Shot row.
 */
@Injectable()
export class SensorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SensorService.name);

  private sub?: Subscription;
  private sessionsSub?: Subscription;

  /**
   * Shots as they are persisted. The realtime gateway subscribes to this.
   *
   * The dependency points THIS way on purpose: SensorService knows nothing
   * about sockets, rooms, or connected clients — it just announces what
   * happened. RealtimeModule imports SensorModule, never the reverse. Same
   * shape as TransportRegistry.frames$ one layer down, and it keeps the two
   * modules independently testable (and avoids a circular import, which is
   * what you'd get the moment ingestion tried to call the gateway directly).
   */
  private readonly shots = new Subject<ShotEvent>();
  readonly shots$: Observable<ShotEvent> = this.shots.asObservable();

  /**
   * Per-target serialisation. `frames$` is a stream and the handler is async,
   * so without this two bullets arriving inside the same tick both read
   * "shots so far = N" and both write N+1 — overrunning the bullet limit and
   * colliding on shotNumber. The original backend carried the same queue for
   * the same reason (`laneQueues` in services/shot.ingestion.ts).
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  /**
   * Whether to ask a board to re-send a bullet we never received, or one we
   * received as a (0,0) no-detection frame.
   *
   * Defaults OFF: the deployed firmware does not implement RESEND ('R'), so
   * every request was a frame the board silently discarded — noise on the wire
   * and a misleading "resend requested" in the log implying recovery was under
   * way when nothing was coming. Gap DETECTION and MISS DETECTION are
   * unaffected and still logged; only the outbound request is suppressed. Set
   * SENSOR_RESEND_ENABLED=true if a firmware build that supports it is ever
   * deployed.
   */
  private readonly resendEnabled: boolean;

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
  }

  onModuleInit(): void {
    this.sub = this.registry.frames$.subscribe((frame) => {
      // Never await inside the subscribe callback: RxJS will not wait for it,
      // and an unhandled rejection here kills the subscription for every lane.
      void this.handle(frame);
    });

    // Range-wide admin hold auto-releases the moment live firing resumes —
    // matches the old backend's sessionStarted/sessionResumed listeners.
    // Lives here, not in SessionsService, to avoid a module import cycle: see
    // the comment on SensorGateService in sensor.module.ts.
    this.sessionsSub = this.sessions.events$.subscribe((event) => {
      if (event.type === 'session:started' || event.type === 'session:resumed') {
        this.gate.setHeld(false);
      }
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    this.sessionsSub?.unsubscribe();
    this.shots.complete();
    this.queues.clear();
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

  // ── Telemetry ──────────────────────────────────────────────────────────────

  /**
   * Heartbeat. Only proves the board is powered and associated — which is
   * exactly what the (still to be built) pre-flight check before arming a stage
   * will read.
   *
   * `rssi` is deliberately NOT written yet: the deployed firmware's telemetry
   * payload layout is unconfirmed (the original backend discarded these frames
   * outright, so there is no precedent to port). Guessing a byte offset here
   * would fill the column with plausible-looking garbage, which is worse than
   * leaving it null. Confirm against the board, then map it here.
   */
  private async onTelemetry(frame: InBoundFrame): Promise<void> {
    const target = await this.resolver.resolve(frame.sourceKey);
    if (!target) return;

    await this.prisma.target.update({
      where: { id: target.id },
      data: { lastSeenAt: frame.receivedAt },
    });
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

    // Best-effort, deliberately not awaited: a resend request must not delay
    // persisting the bullet already in hand.
    if (this.resendEnabled) {
      for (const gap of gaps) {
        void this.targetCommand
          .resend(this.targetRef(target), gap & 0xff)
          .catch((err: Error) =>
            this.logger.warn(
              `Resend ${gap} -> ${target.label} failed: ${err.message}`,
            ),
          );
      }
    }
    if (gaps.length > 0) {
      this.logger.warn(
        `${target.label}: missing bullet(s) ${gaps.join(', ')} before #${absolute}` +
          (this.resendEnabled
            ? ' — resend requested.'
            : ' — dropped (resend disabled).'),
      );
    }

    // An 'L' frame carrying a no-detection sentinel — (0,0) or (65535,65535),
    // see scoring.ts — means not all the sensors detected the bullet: the board
    // resolved no location (sensor-values.md). Ask it to re-send so a real
    // coordinate can come back, same machinery as the gap resend above. The
    // shot is still scored as a miss regardless, so a board that never recovers
    // does not lose the round.
    if (isSentinel(frame.rawX, frame.rawY)) {
      this.logger.warn(
        `${target.label}: shot #${absolute} reported no detection (${frame.rawX}, ${frame.rawY}).` +
          (this.resendEnabled
            ? ' Requesting resend.'
            : ' Resend disabled — counted as a miss.'),
      );
      if (this.resendEnabled) {
        void this.targetCommand
          .resend(this.targetRef(target), frame.bulletCounter)
          .catch((err: Error) =>
            this.logger.warn(
              `Resend ${absolute} -> ${target.label} failed: ${err.message}`,
            ),
          );
      }
    }

    this.serialize(target.id, () => this.persistHit(target, frame));
  }

  /**
   * Debug/bench-test injection — ports the old backend's
   * POST /api/debug/simulate-shot (backend/http/controllers/debug.controller.ts
   * in the pre-NestJS project). Scores and persists a shot directly against
   * whatever target is currently armed on `laneId`, identified by the lane
   * alone. Deliberately skips onHit's IP resolution and sequence-counter
   * dedup entirely — this is not "pretend to be the sensor board over UDP",
   * it is "pretend the ingestion pipeline already resolved a target", which
   * is what lets it work with no target IP configuration at all, exactly
   * like the old endpoint did.
   *
   * `x`/`y` are raw wire-format sensor values (see frame.codec.ts) — the same
   * shape frontend/src/types/shared/coordinates.ts's clickToSensorCoords
   * already produces, so a click and this debug path score identically.
   */
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
      this.serialize(target.id, async () => {
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

  private async persistHit(target: Target, frame: InBoundFrame): Promise<ShotEvent | null> {
    // Re-read inside the serialised block. A previous bullet in this same queue
    // may have just completed the stage, and it must not admit another shot.
    const stage = await this.prisma.sessionStage.findFirst({
      where: { targetId: target.id, status: 'ACTIVE' },
      include: { _count: { select: { shots: true } } },
    });


    if (!stage) {
      // The target fired with nothing armed against it — a dry run, a bump, or
      // a board still firing after a stage ended. Real, but not attributable.
      this.logger.warn(
        `Unassigned shot from ${target.label}: no active stage on this target.`,
      );
      return null;
    }

    const shotNumber = stage._count.shots + 1;

    if (stage.bulletLimit > 0 && shotNumber > stage.bulletLimit) {
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
      // The STAGE's profile snapshot, not target.profileType — re-facing a
      // target later must not rescore a stage that already happened.
      profile: stage.profileType,
    });

    await this.prisma.shot.create({
      data: {
        sessionStageId: stage.id,
        shotNumber,
        x: scored.x,
        y: scored.y,
        score: scored.score,
        isMiss: scored.isMiss,
        firedAt: frame.receivedAt,
      },
    });

    // Announce only AFTER the row is committed. Emitting first would show a
    // shot on the tablet that a failed write then makes disappear on refresh.
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
      firedAt: frame.receivedAt,
      stageShotCount: shotNumber,
    };
    this.shots.next(event);

    // Reaching the bullet limit ENDS the stage — the previous version only
    // rejected shot N+1, leaving the stage ACTIVE forever and the target still
    // armed after the shooter had fired their allotted rounds.
    //
    // Not awaited: advance() sends a UDP command and waits on an ack, and this
    // runs inside the per-target ingest queue. Blocking the queue on a network
    // handshake would stall every subsequent bullet behind it.
    if (stage.bulletLimit > 0 && shotNumber >= stage.bulletLimit) {
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

    this.logger.log(
      `${target.label} #${shotNumber}: ${
        scored.isMiss ? 'MISS (no detection)' : `(${scored.x}, ${scored.y}) = ${scored.score}`
      }`,
    );

    return event;
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  /**
   * Chain work per target so two bullets can never interleave. The catch is
   * load-bearing: one unhandled rejection without it poisons the chain and that
   * target stops ingesting for the rest of the relay.
   *
   * Typed to accept any return value, not just Promise<void> — simulateHit's
   * work settles its own outer promise from inside the callback rather than
   * through this one's resolution.
   */
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
    };
  }
}
