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
  ECHO_WINDOW_MS,
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

// ECHO_WINDOW_MS — how soon an identical (0,0) frame for the bullet we just
// asked about counts as our own request bouncing back rather than an answer —
// now lives in frame.codec.ts beside buildReadShotFrame. TargetsService.readShot
// has to make the same judgement on the commissioning route, and while this
// constant was local the two surfaces disagreed: the route compared bytes only,
// so every honest "no position for that shot" reply was reported as
// "read not implemented".

/**
 * Most no-detection shots chased at once per target.
 *
 * A no-detection storm produces one candidate per shot, on the hot receive path
 * during sustained fire — the exact regression gap-resend.spec.ts was written
 * to prevent. Past this many in flight, later misses are painted immediately
 * and not chased.
 */
const MAX_CONCURRENT_NODETECT_READS = 4;

/**
 * Longest a board has been measured taking to answer a read-shot request.
 *
 * The dev board answers in 700–820ms over the direct AP link (timed off field
 * logs: request at 26.768 answered at 27.489, request at 31.483 answered at
 * 32.302). Reading a stored shot costs it a lookup; this is not link latency,
 * and no amount of asking harder shortens it.
 *
 * It is a floor on two settings, enforced below, because both were configured
 * shorter than it and both failed silently as a result:
 *
 *   RESEND_GRACE_MS   — was 250ms, so a chase fired four requests before the
 *                       first answer could physically arrive. The board serviced
 *                       one and dropped the rest, which read as "the board is
 *                       ignoring us" when it was simply being asked 3x too fast.
 *   NO_DETECT_HOLD_MS — was 800ms, so the UI gave up and painted a MISS a
 *                       moment before the answer landed, which is the exact
 *                       flicker the hold exists to prevent.
 */
const BOARD_READ_LATENCY_MS = 900;

/** How many bullets back a target's slot mapping is retained. Mirrors
 *  SEEN_WINDOW in sequence.tracker.ts — past it, the tracker calls a late
 *  bullet a fresh one anyway, so its row mapping is dead weight. */
const SLOT_WINDOW = 128;

/** Which row in which stage a given bullet number owns. */
interface ShotSlot {
  stageId: string;
  shotNumber: number;
  /** Set once publishLost has announced this row, so giving up twice on the
   *  same bullet cannot emit it twice. Used to be implicit in deleting the
   *  entry, which is no longer safe — the mapping has to outlive the giving up
   *  so a very late bullet still fills its own row. */
  announcedLost?: boolean;
}

/** Whether we are chasing a bullet that never arrived, or one that arrived
 *  carrying nothing. The two differ in how giving up is reported. */
type ReadKind = 'gap' | 'nodetect';

interface PendingRead {
  kind: ReadKind;
  timer: NodeJS.Timeout;
  /** 'gap' only — the 60s backstop that finalises a bullet as lost. */
  lostTimer: NodeJS.Timeout | null;
  /** 'nodetect' only — when the UI stops waiting and paints the miss. */
  holdTimer: NodeJS.Timeout | null;
  attempts: number;
  /** Epoch ms of the last request we put on the wire, for ECHO_WINDOW_MS. */
  lastSentAt: number;
}

/** A shot persisted but not yet announced, waiting on a read-shot reply. */
interface HeldShot {
  event: ShotEvent;
  /** Session to advance when this event is finally released, if this shot
   *  completed the stage. Deferred with the event — a stage must not advance
   *  on a shot the shooter has not been shown. */
  advanceSessionId: string | null;
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

  private readonly noDetectReread: boolean;

  private readonly noDetectHoldMs: number;

  /** targetId -> absolute -> the chase currently running for that bullet. */
  private readonly pendingReads = new Map<string, Map<number, PendingRead>>();

  /**
   * Which row each bullet number owns, keyed `${targetId}:${absolute}`.
   *
   * Exists because shotNumber is stage-relative ("rows so far + 1") while the
   * sequence tracker counts board-lifetime bullets, so there is no arithmetic
   * that maps one onto the other. The entry is recorded when the row is written
   * — reserved placeholder or real shot alike — and looked up again whenever
   * that bullet number turns up later, which is what lets both a late bullet
   * and a re-read correction land in their own row rather than take a fresh
   * number at the end of the list.
   */
  private readonly slots = new Map<string, ShotSlot>();

  /** Shots written to the database but deliberately not announced yet, keyed
   *  the same way. See beginNoDetectHold. */
  private readonly heldShots = new Map<string, HeldShot>();
  private readonly armedStageByTarget = new Map<string, string>()

  getArmedStageId(targetId: string): string | undefined {
    return this.armedStageByTarget.get(targetId)
  }

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
    this.maxResendAttempts = Number(config.get('MAX_RESEND_ATTEMPTS', '4'));
    this.noDetectReread = config.get<string>('NO_DETECT_REREAD', 'false') === 'true';

    // Clamped rather than trusted. Both of these are millisecond knobs whose
    // wrong values produce no error and no obviously broken behaviour — just a
    // board that appears not to answer and shots that flicker from miss to hit.
    // See BOARD_READ_LATENCY_MS; anything below it is a misconfiguration, so it
    // is corrected loudly at startup instead of being honoured quietly.
    //
    // The floor is itself configurable, and set to 0 by the specs: they drive
    // whole chases through fake timers on a 60ms grace, so a hard-coded 900ms
    // floor would stretch every timeline in the suite by 15x for no gain. It is
    // a guard against a mistyped .env, not an invariant of the algorithm.
    const floorMs = Number(
      config.get<string>('BOARD_READ_LATENCY_MS', String(BOARD_READ_LATENCY_MS)),
    );

    this.resendGraceMs = this.atLeast(
      Number(config.get<string>('RESEND_GRACE_MS', '1000')),
      floorMs,
      'RESEND_GRACE_MS',
    );
    this.noDetectHoldMs = this.atLeast(
      Number(config.get<string>('NO_DETECT_HOLD_MS', '2000')),
      floorMs,
      'NO_DETECT_HOLD_MS',
    );
  }

  private atLeast(value: number, floorMs: number, name: string): number {
    if (!Number.isFinite(floorMs) || floorMs <= 0) return value;
    if (Number.isFinite(value) && value >= floorMs) return value;
    this.logger.warn(
      `${name}=${value}ms is below the ${floorMs}ms a board needs to answer a ` +
      `read — raising it to ${floorMs}ms. Below this, requests go out faster ` +
      `than they can be answered, the board drops the ones it cannot service, ` +
      `and it looks unresponsive when it is not.`,
    );
    return floorMs;
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
    this.clearAllReads();
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


  /**
   * Start asking the board for one bullet, over 'L'.
   *
   * Two callers, distinguished by `kind`:
   *   'gap'      — the bullet's datagram never arrived. Give up by announcing the
   *                placeholder row as LOST.
   *   'nodetect' — the bullet arrived as (0,0). Its row is already written and
   *                held back from the UI; give up by painting it as a MISS.
   */
  private scheduleRead(target: Target, absolute: number, kind: ReadKind): void {
    const pending = this.pendingReads.get(target.id) ?? new Map<number, PendingRead>();
    this.pendingReads.set(target.id, pending);

    if (pending.has(absolute)) return;

    if (kind === 'nodetect') {
      let inFlight = 0;
      for (const entry of pending.values()) if (entry.kind === 'nodetect') inFlight++;
      if (inFlight >= MAX_CONCURRENT_NODETECT_READS) {
        this.logger.warn(
          `${target.label}: ${inFlight} no-detection re-reads already in flight — ` +
          `shot #${absolute} scored as a miss without asking. The board is failing ` +
          `to triangulate faster than it can answer; check sensitivity, not the link.`,
        );
        this.releaseHeld(target.id, absolute);
        return;
      }
    }

    const MAX_RETRY_DELAY_MS = 5000;
    const LOST_TIMEOUT_MS = 60000; // after 60s, mark as lost

    const giveUp = (why: string): void => {
      this.logger.warn(`${target.label}: ${why} for bullet #${absolute}`);
      this.clearRead(target.id, absolute);
      if (kind === 'gap') {
        void this.serializeAndWait(target.id, () => this.publishLost(target, absolute));
      } else {
        this.releaseHeld(target.id, absolute);
      }
    };

    const attempt = (attemptsSoFar: number): void => {
      // A 'gap' bullet that turned up on its own needs no more asking. A
      // 'nodetect' one cannot be settled this way — the tracker recorded its
      // counter when the (0,0) arrived, so hasSeen was already true before the
      // chase started. Its exit is onReadReply or the give-up below.
      if (kind === 'gap' && this.sequence.hasSeen(target.id, absolute)) {
        this.clearRead(target.id, absolute);
        return;
      }

      if (this.maxResendAttempts > 0 && attemptsSoFar >= this.maxResendAttempts) {
        giveUp('max read attempts reached');
        return;
      }

      const entry = pending.get(absolute);
      if (!entry) return;

      this.logger.warn(
        `${target.label}: requesting ${kind === 'gap' ? 'missing' : 'no-detection'} ` +
        `bullet #${absolute} (attempt ${attemptsSoFar + 1})`,
      );

      entry.attempts = attemptsSoFar + 1;
      // Stamped before the await, not after: the echo we are guarding against can
      // be back inside a millisecond on a direct AP link.
      entry.lastSentAt = Date.now();

      void this.targetCommand
        .readShotRequest(this.targetRef(target), absolute & 0xff)
        .catch((err: Error) =>
          this.logger.warn(
            `Read shot #${absolute} -> ${target.label} failed: ${err.message}`,
          ),
        );

      // Exponential backoff:
      // 250ms -> 500ms -> 1000ms -> 2000ms -> 4000ms -> 5000ms...
      const delay = Math.min(
        this.resendGraceMs * Math.pow(2, attemptsSoFar),
        MAX_RETRY_DELAY_MS,
      );

      entry.timer = setTimeout(() => attempt(attemptsSoFar + 1), delay);
      entry.timer.unref?.();
    };

    // Safety timeout: if the board truly lost the shot forever, eventually close
    // it. Only meaningful for a gap — a no-detection row already exists and is
    // closed by its hold timer instead.
    let lostTimer: NodeJS.Timeout | null = null;
    if (kind === 'gap') {
      lostTimer = setTimeout(() => {
        if (this.sequence.hasSeen(target.id, absolute)) {
          this.clearRead(target.id, absolute);
          return;
        }
        giveUp(`missing after ${LOST_TIMEOUT_MS}ms — marking lost`);
      }, LOST_TIMEOUT_MS);
      lostTimer.unref?.();
    }

    // The UI's patience, which is deliberately shorter than the chase. If the
    // board answers late the correction still lands — persistHit upserts the same
    // row and re-announces it, and the client replaces the miss in place.
    let holdTimer: NodeJS.Timeout | null = null;
    if (kind === 'nodetect') {
      holdTimer = setTimeout(() => {
        this.releaseHeld(target.id, absolute);
      }, this.noDetectHoldMs);
      holdTimer.unref?.();
    }

    const timer = setTimeout(() => attempt(0), this.resendGraceMs);
    timer.unref?.();

    pending.set(absolute, {
      kind,
      timer,
      lostTimer,
      holdTimer,
      attempts: 0,
      lastSentAt: 0,
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
  /**
   * The bullet turned up. Stop chasing it.
   *
   * The log line used to say "arrived late on its own" unconditionally, which
   * was actively misleading during commissioning: a 'gap' answer carries a
   * counter the tracker has never seen, so the board dutifully answering our
   * read looked identical to the bullet wandering in by itself. Two of those
   * lines in a field log — bullets #5 and #7, each landing ~750ms after a read
   * went out — were read as "the board stopped answering us" when the board had
   * in fact answered every single request.
   */
  private readArrived(
    targetId: string,
    absolute: number,
    kind: ReadKind,
  ): void {
    const pending = this.pendingReads.get(targetId);
    if (!pending?.has(absolute)) return;
    this.logger.log(
      `Bullet #${absolute} arrived in answer to our ${kind} read request — ` +
      `chase cancelled.`,
    );
    this.clearRead(targetId, absolute);
  }

  private clearRead(targetId: string, absolute: number): void {
    const pending = this.pendingReads.get(targetId);
    const entry = pending?.get(absolute);

    if (!entry) return;

    clearTimeout(entry.timer);
    if (entry.lostTimer) clearTimeout(entry.lostTimer);
    if (entry.holdTimer) clearTimeout(entry.holdTimer);

    pending!.delete(absolute);

    if (pending!.size === 0) {
      this.pendingReads.delete(targetId);
    }
  }

  /**
   * Announce a shot that was written but held back, and run the stage advance
   * that was deferred with it. Idempotent — the hold timer, a give-up and the
   * concurrency cap can all reach for the same held shot.
   */
  private releaseHeld(targetId: string, absolute: number): void {
    const key = slotKey(targetId, absolute);
    const held = this.heldShots.get(key);
    if (!held) return;
    this.heldShots.delete(key);

    this.shots.next(held.event);
    this.logger.log(
      `${held.event.targetLabel} #${held.event.shotNumber}: MISS (no detection) — ` +
      `board did not answer the re-read of bullet #${absolute}.`,
    );

    if (held.advanceSessionId) this.advanceSession(held.advanceSessionId);
  }

  /** The one place a bullet-limit auto-advance is kicked off. */
  private advanceSession(sessionId: string): void {
    void this.sessions
      .advance(sessionId)
      .catch((err: Error) =>
        this.logger.error(
          `Auto-advance after bullet limit failed for session ${sessionId}: ${err.message}`,
        ),
      );
  }

  /** Forget row mappings for bullets too old for a late arrival to matter. */
  private pruneSlots(targetId: string, absolute: number): void {
    const floor = absolute - SLOT_WINDOW;
    if (floor <= 0) return;
    const prefix = `${targetId}:`;
    for (const key of this.slots.keys()) {
      if (!key.startsWith(prefix)) continue;
      if (Number(key.slice(prefix.length)) < floor) this.slots.delete(key);
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
    const pending = this.pendingReads.get(targetId);
    if (pending) {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        if (entry.lostTimer) clearTimeout(entry.lostTimer);
        if (entry.holdTimer) clearTimeout(entry.holdTimer);
      }
      this.pendingReads.delete(targetId);
    }

    // Held shots go unannounced rather than being flushed: they name rows in a
    // stage that is over, and the client has already cleared its list for the
    // new one.
    const prefix = `${targetId}:`;
    for (const key of this.slots.keys()) {
      if (key.startsWith(prefix)) this.slots.delete(key);
    }
    for (const key of this.heldShots.keys()) {
      if (key.startsWith(prefix)) this.heldShots.delete(key);
    }

    if (pending?.size) {
      this.logger.log(
        `Dropped ${pending.size} outstanding bullet chase(s) for ${targetId} — new relay armed.`,
      );
    }
  }

  /** Drop every outstanding chase (shutdown). */
  private clearAllReads(): void {
    for (const pending of this.pendingReads.values()) {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        if (entry.lostTimer) clearTimeout(entry.lostTimer);
        if (entry.holdTimer) clearTimeout(entry.holdTimer);
      }
    }

    this.pendingReads.clear();
    this.slots.clear();
    this.heldShots.clear();
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
    if (this.slots.has(key)) return;

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

    this.slots.set(key, { stageId: stage.id, shotNumber });

    this.logger.warn(
      `${target.label}: reserved shot #${shotNumber} for missing bullet ` +
      `#${absolute} — placeholder written so later shots keep their numbers.`,
    );
  }

  /** Giving up is final: announce the placeholder to connected clients. */
  private async publishLost(target: Target, absolute: number): Promise<void> {
    const key = slotKey(target.id, absolute);
    const slot = this.slots.get(key);
    if (!slot || slot.announcedLost) return;
    // The mapping is kept, not deleted — a bullet can still arrive after we
    // have written it off, and when it does it must fill this row rather than
    // be appended with a fresh number. `announcedLost` is what stops the giving
    // up itself from happening twice.
    slot.announcedLost = true;

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
      this.advanceSession(stage.sessionId);
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

    // Before the sequence tracker sees it, because the tracker cannot be told
    // to forget: recording an echo as bullet n makes hasSeen(n) true, which
    // ends the very chase that produced it. For a gap that is the worse case —
    // a bullet we never received would be written off as a no-detection on the
    // strength of our own request coming back.
    if (this.isOwnEcho(target.id, frame)) {
      this.logger.debug(
        `${target.label}: ignored echo of our own read request for bullet ` +
        `#${frame.bulletCounter}. ${this.formatFrame(frame)}`,
      );
      return;
    }

    const { absolute, duplicate, gaps } = this.sequence.observe(
      target.id,
      frame.bulletCounter,
    );

    // A counter we have already recorded. Normally that is a stray retransmit
    // and is dropped — but if we asked for this exact bullet back, it is the
    // answer, and dropping it here is what made every re-read pointless.
    if (duplicate) {
      await this.onReadReply(target, frame, absolute);
      return;
    }

    // Were we already asking the board for this exact bullet?
    //
    // This has to be read BEFORE readArrived clears the entry, and the guard it
    // replaces (`if (this.sequence.hasSeen(absolute))`) was dead code: observe()
    // records the number a line earlier, so hasSeen was unconditionally true and
    // the branch said nothing about whether a chase was running.
    //
    // The distinction is load-bearing for a 'gap' chase. A gap bullet is one we
    // never received, so when the board answers our read the counter is NEW to
    // the tracker — duplicate is false and the frame falls through to the
    // fresh-shot path below. Left that way, a (0,0) answer to "resend bullet 5"
    // was treated as bullet 5 arriving late of its own accord, which started a
    // SECOND chase for the same bullet, whose answer started a third. That is
    // the feedback loop that turned five missing bullets into twenty datagrams
    // in two seconds.
    const answering = this.pendingReads.get(target.id)?.get(absolute)?.kind ?? null;
    if (answering) this.readArrived(target.id, absolute, answering);

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
            this.scheduleRead(target, gap, 'gap');
          } else {
            await this.serializeAndWait(target.id, () => this.publishLost(target, gap));
          }
        }
      }
    }

    if (isSentinel(frame.rawX, frame.rawY)) {
      // Never chase a bullet whose answer we are already holding. If this frame
      // came back because we asked for it, the board has just told us it has no
      // position for it — asking the same question again cannot change that, and
      // doing so is what produced the request storms in the field logs.
      const chasing =
        this.resendEnabled && this.noDetectReread && answering === null;
      this.logger.warn(
        `${target.label}: shot #${absolute} reported no detection (${frame.rawX}, ${frame.rawY}) — ` +
        (answering
          ? `this is the board ANSWERING our ${answering} re-read, and the answer ` +
          `is that it has nothing stored for that bullet. Scored as a miss.`
          : `frame arrived intact and in sequence, so this is a board-side ` +
          `detection failure, not packet loss. ` +
          (chasing
            ? `Holding it for up to ${this.noDetectHoldMs}ms while the board is asked to re-read it.`
            : `Scored as a miss.`)) +
        ` ${this.formatFrame(frame)}`,
      );

      if (chasing) {
        this.serialize(target.id, () =>
          this.beginNoDetectHold(target, frame, absolute),
        );
        return;
      }
    }

    this.serialize(target.id, () => this.persistHit(target, frame, absolute));
  }

  /**
   * Is this frame the read request we just sent, coming straight back?
   *
   * A request is `24 4C n 00 00 00 00 crc 23` — the same nine bytes as a
   * no-detection hit for bullet n. Nothing in the frame distinguishes the two,
   * so arrival time is the only evidence: an echo returns at link latency, a
   * real answer costs the board a lookup. Matched on the wire counter rather
   * than the unwrapped absolute, because that is the byte we actually sent and
   * the only one an echo can carry back.
   */
  private isOwnEcho(targetId: string, frame: InBoundFrame): boolean {
    if (!isSentinel(frame.rawX, frame.rawY)) return false;

    const pending = this.pendingReads.get(targetId);
    if (!pending) return false;

    const now = Date.now();
    for (const [absolute, entry] of pending) {
      if ((absolute & 0xff) !== frame.bulletCounter) continue;
      if (entry.lastSentAt > 0 && now - entry.lastSentAt <= ECHO_WINDOW_MS) {
        return true;
      }
    }
    return false;
  }

  /**
   * A frame whose bullet counter we have already recorded.
   *
   * The only reason to look twice at one is that we asked for it. Everything
   * else — a stray retransmit, a board repeating itself — is noise and is
   * dropped, exactly as it was before there was a read command.
   */
  private async onReadReply(
    target: Target,
    frame: InBoundFrame,
    absolute: number,
  ): Promise<void> {
    const pending = this.pendingReads.get(target.id)?.get(absolute);
    if (!pending) return;

    if (isSentinel(frame.rawX, frame.rawY)) {
      // Echoes were already filtered upstream by isOwnEcho, so this is the
      // board genuinely answering that it has nothing. Let the backoff run —
      // the next attempt may still find it.
      this.logger.warn(
        `${target.label}: re-read of bullet #${absolute} came back (0,0) again — ` +
        `the board has no position stored for it. ${this.formatFrame(frame)}`,
      );
      return;
    }

    this.logger.log(
      `${target.label}: bullet #${absolute} recovered by re-read — ` +
      `the board answered with a position. ${this.formatFrame(frame)}`,
    );

    this.clearRead(target.id, absolute);
    await this.serializeAndWait(target.id, () =>
      this.persistHit(target, frame, absolute),
    );
  }

  /**
   * A no-detection shot, written but not shown.
   *
   * The row goes in immediately so the shot keeps its number and the database
   * is never behind the board. The socket event does not, because the board may
   * still be able to produce a position for it: announcing a MISS now and a
   * score 800ms later means every operator watching sees a hole appear where a
   * miss was, on a screen they are using to call the shoot. releaseHeld is the
   * single exit — hold timer, give-up, or the concurrency cap.
   */
  private async beginNoDetectHold(
    target: Target,
    frame: InBoundFrame,
    absolute: number,
  ): Promise<void> {
    const event = await this.persistHit(target, frame, absolute, {
      deferEmit: true,
    });
    // No active stage, or over the bullet limit — nothing was written, so there
    // is nothing to hold and nothing to chase.
    if (!event) return;

    this.scheduleRead(target, absolute, 'nodetect');
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
    opts?: { deferEmit?: boolean },
  ): Promise<ShotEvent | null> {
    // Prefer the stage SessionsService says this target is armed for — known
    // since the moment PLAY was acked, not since the (later, separate)
    // transaction that flips this row's status to ACTIVE actually commits.
    // Falls back to the status query for anything with no session driving it
    // at all (commissioning's manual Play, self-test, bench work).
    const expectedStageId = this.sessions.getArmedStageId(target.id);
    const stage = expectedStageId
      ? await this.prisma.sessionStage.findUnique({
          where: { id: expectedStageId },
          include: { _count: { select: { shots: true } } },
        })
      : await this.prisma.sessionStage.findFirst({
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
      ? this.slots.get(reservationKey)
      : undefined;
    const filledReservation =
      reservation?.stageId === stage.id ? reservation : undefined;

    // A held shot being corrected: it never reached a client, so the advance it
    // was carrying never ran. Take it over rather than letting it vanish with
    // the held record — a stage that ends on a recovered no-detection must
    // still end.
    const held = reservationKey ? this.heldShots.get(reservationKey) : undefined;
    if (held && reservationKey) this.heldShots.delete(reservationKey);

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

    // Recorded, not deleted: this is the mapping that lets a later re-read
    // correction — or a bullet that turns up long after we wrote it off — land
    // in this row instead of being appended with a fresh number.
    if (reservationKey) {
      this.slots.set(reservationKey, {
        stageId: stage.id,
        shotNumber,
        announcedLost: false,
      });
      if (absolute != null) this.pruneSlots(target.id, absolute);
    }

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
    const completesStage =
      !filledReservation &&
      stage.bulletLimit > 0 &&
      stageShotCount >= stage.bulletLimit;

    if (opts?.deferEmit && reservationKey) {
      this.heldShots.set(reservationKey, {
        event,
        advanceSessionId: completesStage ? stage.sessionId : null,
      });
    } else {
      this.shots.next(event);
      if (completesStage || held?.advanceSessionId) {
        this.logger.log(
          `${target.label}: bullet limit ${stage.bulletLimit} reached — advancing stage.`,
        );
        this.advanceSession(held?.advanceSessionId ?? stage.sessionId);
      }
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
      ? opts?.deferEmit
        ? 'MISS (no detection) — row written, held pending re-read'
        : 'MISS (no detection)'
      : `raw(${toSigned16(frame.rawX)}, ${toSigned16(frame.rawY) - SENSOR_Y_FLOOR_BIAS_MM
      }) + ${target.offsetXmm === 0 && target.offsetYmm === 0
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
