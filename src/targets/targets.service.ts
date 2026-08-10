import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Subject, type Observable } from 'rxjs';
import { CreateTargetDto } from './dto/create-target.dto';
import { UpdateTargetDto } from './dto/update-target.dto';
import { PrismaService } from '@/common/prisma/prisma.service';
import { TargetResolver } from '@/sensor/target-resolver.service';
import { TargetCommandService } from '@/transport/target-command.service';
import { SequenceTracker } from '@/transport/protocol/sequence.tracker';
import { ECHO_WINDOW_MS } from '@/transport/protocol/frame.codec';
import type { WiperPage } from '@/transport/protocol/frame.codec';
import {
  isSentinel,
  scoreAt,
  signedMm,
  toSigned16,
  SENSOR_Y_FLOOR_BIAS_MM,
} from '@/sensor/scoring';
import type { TargetCalibratedEvent } from './target.events';

/** Prisma's code for "a unique constraint was violated". */
const UNIQUE_VIOLATION = 'P2002';

/** How a caller points at the shot a calibration is derived from. */
type ReferenceShotRef = {
  shotId?: string;
  stageId?: string;
  shotNumber?: number;
};

@Injectable()
export class TargetsService implements OnModuleDestroy {
  private readonly logger = new Logger(TargetsService.name);

  private readonly calibrations = new Subject<TargetCalibratedEvent>();
  readonly calibrations$: Observable<TargetCalibratedEvent> =
    this.calibrations.asObservable();

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: TargetResolver,
    private readonly command: TargetCommandService,
    private readonly sequenceTracker: SequenceTracker,
  ) { }

  onModuleDestroy(): void {
    this.calibrations.complete();
  }

  async create(dto: CreateTargetDto) {
    try {
      return await this.prisma.target.create({ data: dto });
    } catch (err) {
      throw this.translateUniqueViolation(err, dto.ipAddress);
    }
  }

  findAll() {
    return this.prisma.target.findMany();
  }

  // id is a string everywhere — Target.id is a UUID in the schema, not a
  // numeric autoincrement column. Converting it to a number (as this used to
  // do) doesn't just fail to compile: `Number("a3f5-...")` is NaN, so even if
  // TypeScript let it through, the lookup would never match a real row.
  async findOne(id: string) {
    const target = await this.prisma.target.findUnique({ where: { id } });
    if (!target) {
      // NotFoundException maps to a 404 response. A plain `throw new Error`
      // is unhandled and surfaces as a 500, which tells the caller "the
      // server broke" instead of "that id doesn't exist" — a real difference
      // once something else is calling this API.
      throw new NotFoundException(`Target ${id} not found`);
    }
    return target;
  }

  async update(id: string, dto: UpdateTargetDto) {
    const before = await this.findOne(id); // throws 404 before writing, if missing
    let updated;
    try {
      updated = await this.prisma.target.update({
        where: { id },
        data: dto,
      });
    } catch (err) {
      throw this.translateUniqueViolation(err, dto.ipAddress);
    }

    // SensorService resolves inbound frames to targets by source IP, cached in
    // memory. Leaving a stale entry after an IP change means shots keep being
    // attributed to whatever row used to own that address — silent, and
    // unrecoverable once the relay is over. Invalidate BOTH addresses: the old
    // key is what's actually sitting in the cache.
    this.resolver.invalidate(before.ipAddress);
    this.resolver.invalidate(updated.ipAddress);

    return updated;
  }

  /**
   * Turn Prisma's unique-constraint error into a 409 that names the actual
   * problem. `Target` has two independent unique constraints — `ipAddress`
   * and `[laneId, positionIndex]` — and left unhandled, either one surfaces
   * as a bare 500 ("Internal server error"), which reads as "the server is
   * broken" instead of "that IP is already assigned to another target".
   * Mirrors the same translate() pattern in ShootersService.
   */
  private translateUniqueViolation(err: unknown, ipAddress?: string): Error {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === UNIQUE_VIOLATION
    ) {
      const fields = (err.meta?.target as string[] | undefined) ?? [];
      if (fields.includes('ipAddress')) {
        return new ConflictException(
          `IP address "${ipAddress}" is already assigned to another target. ` +
            `Each board needs a unique address — move or remove the other target first.`,
        );
      }
      if (fields.includes('laneId') || fields.includes('positionIndex')) {
        return new ConflictException(
          'That lane slot is already occupied by another target.',
        );
      }
      return new ConflictException('That target conflicts with an existing one.');
    }
    return err as Error;
  }

  async remove(id: string) {
    const target = await this.findOne(id);
    const deleted = await this.prisma.target.delete({ where: { id } });
    this.resolver.invalidate(target.ipAddress);
    return deleted;
  }

  /**
   * Refuse to touch a target that is mid-relay. Shared by every command on
   * this service that puts a frame on the wire: arming/disarming for a
   * self-test, or changing sensitivity, under a live stage either drops
   * rounds on the floor or silently changes scoring behaviour mid-string.
   */
  private async assertNotMidRelay(id: string, label: string, what: string): Promise<void> {
    const liveStage = await this.prisma.sessionStage.findFirst({
      where: {
        targetId: id,
        status: 'ACTIVE',
        session: { status: { in: ['ACTIVE', 'PAUSED'] } },
      },
      select: { sessionId: true },
    });
    if (liveStage) {
      throw new ConflictException(
        `Target "${label}" is mid-relay on session ${liveStage.sessionId}. ` +
          `${what} it now would interfere with that stage.`,
      );
    }
  }

  private refOf(target: {
    id: string;
    laneId: number;
    label: string;
    ipAddress: string;
    commandHost?: string | null;
    commandPort?: number | null;
  }) {
    return {
      id: target.id,
      laneId: String(target.laneId),
      label: target.label,
      transport: 'WIFI' as const,
      ipAddress: target.ipAddress,
      commandHost: target.commandHost ?? null,
      commandPort: target.commandPort ?? null,
    };
  }

  /**
   * Run the device's OWN self test ('T') — arm it, ask it to check its timing
   * circuit, disarm it. This supersedes the earlier version of this method,
   * which only sent PLAY and checked for an echo: that proves the board is
   * reachable, not that the sensor actually works. 'T' is a strictly stronger
   * claim — see decodeSelfTest in frame.codec.ts for what each outcome means.
   *
   * Three things this MUST get right, in order of how easy they are to miss:
   *
   * 1. PLAY arms the board — it starts scoring, and 'T' additionally moves an
   *    internal test stimulus while armed. Leaving it armed after a test means
   *    the next stray impact is recorded against whatever stage runs next, so
   *    STOP is sent unconditionally in a finally, including when nothing ever
   *    answered.
   * 2. The self-test stimulus may itself look like a HIT to SequenceTracker —
   *    unconfirmed against real firmware, but cheap to guard against
   *    regardless. The tracker is reset for this target right after STOP so a
   *    stray bullet number from testing can never poison gap-detection on the
   *    NEXT real relay this target runs.
   * 3. It refuses to touch a target that is mid-relay (assertNotMidRelay).
   */
  async selfTest(id: string) {
    const target = await this.findOne(id);
    await this.assertNotMidRelay(id, target.label, 'Testing');

    const ref = this.refOf(target);
    const testedAt = new Date();

    let outcome: 'PASSED' | 'FAILED' | 'NOT_ARMED' | 'NO_ANSWER' = 'NO_ANSWER';
    let xMm: number | null = null;
    let yMm: number | null = null;
    let sawBoard = false;
    let txHex: string | null = null;
    let rxHex: string | null = null;

    try {
      const armed = await this.command.play(ref);
      if (armed) {
        sawBoard = true;
        const { reply, exchange } = await this.command.selfTestExchange(ref);
        txHex = exchange.txHex;
        rxHex = exchange.rxHex;
        if (reply) {
          outcome = reply.outcome;
          xMm = reply.xMm;
          yMm = reply.yMm;
        }
        // else: armed but the 'T' round-trip itself never answered — stays NO_ANSWER.
      }
      // else: never even acknowledged PLAY — stays NO_ANSWER, sawBoard stays false.
    } finally {
      try {
        await this.command.stop(ref);
      } catch (err) {
        // An unreachable board cannot be left armed by definition — but a
        // transport error here must not turn "did not answer" into a 500,
        // which would read as "the server broke" rather than "the board is
        // down".
        this.logger.warn(
          `STOP after self-test of ${target.label} failed: ${(err as Error).message}`,
        );
      }
      // See point 2 above — cheap insurance, run whether or not the test itself
      // ever produced a reply.
      this.sequenceTracker.reset(id);
    }

    if (sawBoard) {
      // A board that answered at all proves it is reachable — including a
      // FAILED (armed-but-broken) result, which is not the same claim as
      // PASSED but is still "the board is up", which is what lastSeenAt tracks.
      await this.prisma.target.update({
        where: { id },
        data: { lastSeenAt: testedAt },
      });
    }

    const message =
      outcome === 'PASSED'
        ? `${target.label} passed self-test on ${target.ipAddress} (stimulus at ${xMm}, ${yMm}mm).`
        : outcome === 'FAILED'
          ? `${target.label} (${target.ipAddress}) is armed but FAILED its self-test — ` +
            `the timing circuit is not working correctly.`
          : outcome === 'NOT_ARMED'
            ? `${target.label} (${target.ipAddress}) reported it was not armed. ` +
              `Retest — this should not happen right after a successful PLAY.`
            : `${target.label} (${target.ipAddress}) did not answer. Check that it is ` +
              `powered, associated to the range router, and reserved at this address.`;

    return {
      targetId: target.id,
      label: target.label,
      ipAddress: target.ipAddress,
      command: 'T',
      ok: outcome === 'PASSED',
      outcome,
      xMm,
      yMm,
      testedAt: testedAt.toISOString(),
      // The 'T' round trip as it actually went out/came back — null when the
      // board never acknowledged PLAY, so the test frame was never sent.
      txHex,
      rxHex,
      message,
    };
  }

  /**
   * Commissioning PLAY — arm the board and wait for its echo. The console
   * keeps the returned hex so the packet log shows the real round trip.
   */
  async play(id: string) {
    const target = await this.findOne(id);
    await this.assertNotMidRelay(id, target.label, 'Arming');

    this.logger.log(`PLAY → ${target.label} (${target.ipAddress})`);
    const exchange = await this.command.playTarget(this.refOf(target));
    this.logger.log(`PLAY response: ok=${exchange.ok}, txHex=${exchange.txHex}, rxHex=${exchange.rxHex}`);
    if (exchange.ok) {
      await this.prisma.target.update({
        where: { id },
        data: { lastSeenAt: new Date() },
      });
    }
    return {
      targetId: target.id,
      label: target.label,
      ipAddress: target.ipAddress,
      armed: exchange.ok,
      command: 'P',
      txHex: exchange.txHex,
      rxHex: exchange.rxHex,
      message: exchange.message,
    };
  }

  /**
   * Commissioning STOP — disarm the board and wait for its echo (the board
   * confirms receipt, per the protocol). Unlike the session path's fire-and-
   * forget stop, this surfaces whether the board actually answered.
   */
  async stop(id: string) {
    const target = await this.findOne(id);
    await this.assertNotMidRelay(id, target.label, 'Disarming');

    const exchange = await this.command.stopTarget(this.refOf(target));
    // A disarm is a natural reset point for the gap tracker — the same reason
    // selfTest() resets it after STOP, so a stale bullet number from a bench
    // session can never poison the next real relay.
    this.sequenceTracker.reset(id);
    return {
      targetId: target.id,
      label: target.label,
      ipAddress: target.ipAddress,
      disarmed: true,
      command: 'S',
      txHex: exchange.txHex,
      rxHex: exchange.rxHex,
      message: exchange.message,
    };
  }

  /** Ping the board ('H') and report whether it echoed. */
  async heartbeat(id: string) {
    const target = await this.findOne(id);
    const exchange = await this.command.heartbeat(this.refOf(target));
    if (exchange.ok) {
      await this.prisma.target.update({
        where: { id },
        data: { lastSeenAt: new Date() },
      });
    }
    return {
      targetId: target.id,
      label: target.label,
      ipAddress: target.ipAddress,
      command: 'H',
      ok: exchange.ok,
      txHex: exchange.txHex,
      rxHex: exchange.rxHex,
      message: exchange.message,
    };
  }

  /** 'D' — which of the board's 8 sensors detected a given shot. */
  async devData(id: string, shot: number) {
    const target = await this.findOne(id);
    const { sensors, exchange } = await this.command.devData(
      this.refOf(target),
      shot,
    );
    return {
      targetId: target.id,
      label: target.label,
      ipAddress: target.ipAddress,
      command: 'D',
      ok: exchange.ok,
      txHex: exchange.txHex,
      rxHex: exchange.rxHex,
      sensors,
      message: exchange.ok
        ? `${target.label} shot #${shot} — sensors 0x${sensors?.toString(16).toUpperCase().padStart(2, '0') ?? '??'}`
        : exchange.message,
    };
  }

  /**
   * 'L' — ask the board to send one specific shot again, and report exactly
   * what came back.
   *
   * The point of this route is to answer a question the server logs cannot: does
   * this firmware implement the read at all? A gap resend is fire-and-forget, so
   * "no bullet recovered" is indistinguishable from "the board ignored us". Here
   * the round trip is explicit and the raw bytes are returned either way.
   *
   * Refuses mid-relay, unlike the 'D' read. This is the one command whose reply
   * shares an opcode AND a counter with a live hit, so during a string the
   * waiter would settle on the shooter's next shot and report it as an answer.
   *
   * `echoed` is the other trap, and the reason this route used to report a
   * working board as a broken one. A request carries a zero payload, so the nine
   * bytes we send are IDENTICAL to a no-detection answer for the same shot:
   * `24 4C n 00 00 00 00 crc 23` either way. Comparing rxHex to txHex therefore
   * cannot tell "the board has no position for shot n" from "the board just
   * echoes commands" — and since the first case is the common one (that is
   * precisely why anyone re-reads a shot), the old byte comparison declared
   * "read not implemented" every time the read was working perfectly.
   *
   * Round-trip time is the only thing that separates them: an echo returns at
   * link latency, an answer costs the board a stored-shot lookup. So an
   * identical frame is only called an echo when it comes back inside
   * ECHO_WINDOW_MS; slower than that it is the board saying it has nothing.
   * This is the same rule SensorService.isOwnEcho applies on the live path.
   */
  async readShot(id: string, shot: number) {
    const target = await this.findOne(id);
    await this.assertNotMidRelay(id, target.label, 'Re-reading a shot from');

    const { rawX, rawY, exchange } = await this.command.readShot(
      this.refOf(target),
      shot,
    );

    const identical = exchange.ok && exchange.rxHex === exchange.txHex;
    const withinEchoWindow =
      exchange.elapsedMs !== null && exchange.elapsedMs <= ECHO_WINDOW_MS;
    const echoed = identical && withinEchoWindow;
    const noDetection = exchange.ok && !echoed && isSentinel(rawX ?? 0, rawY ?? 0);

    const rtt = exchange.elapsedMs === null ? '' : ` (${exchange.elapsedMs}ms)`;

    let message: string;
    if (!exchange.ok) {
      message =
        `${target.label} did not answer a read of shot #${shot}. Either the ` +
        `firmware does not implement 'L' reads, or the board is unreachable — ` +
        `run a heartbeat to tell those apart.`;
    } else if (echoed) {
      message =
        `${target.label} bounced the request straight back${rtt} — too fast to ` +
        `be a lookup, so treat this as "read not implemented" rather than a miss.`;
    } else if (noDetection) {
      message =
        `${target.label} answered${rtt} that it has no stored position for shot ` +
        `#${shot} (0, 0) — the read works, the board simply never triangulated ` +
        `that shot. Run the 'D' read on the same shot to see which sensors fired.`;
    } else {
      message =
        `${target.label} shot #${shot}${rtt} — raw (${toSigned16(rawX ?? 0)}, ` +
        `${toSigned16(rawY ?? 0) - SENSOR_Y_FLOOR_BIAS_MM})mm from centre, ` +
        `before this target's calibration offset.`;
    }

    return {
      targetId: target.id,
      label: target.label,
      ipAddress: target.ipAddress,
      command: 'L',
      shot,
      ok: exchange.ok && !echoed,
      echoed,
      noDetection,
      txHex: exchange.txHex,
      rxHex: exchange.rxHex,
      elapsedMs: exchange.elapsedMs,
      rawX,
      rawY,
      message,
    };
  }

  /**
   * Read one page's five sensitivity trimmers, live off the board. Never
   * persisted — the board is the only source of truth for these values, so
   * every read is a fresh UDP round-trip. Does not arm the board: 'G' is a
   * configuration read, confirmed working against real hardware without a
   * preceding PLAY.
   */
  async readWipers(id: string, page: WiperPage) {
    const target = await this.findOne(id);
    await this.assertNotMidRelay(id, target.label, 'Reading sensitivity for');

    const read = await this.command.getWiperPage(this.refOf(target), page);
    if (!read) {
      throw new ServiceUnavailableException(
        `${target.label} (${target.ipAddress}) did not answer a wiper read. ` +
          `Check that it is powered and reachable.`,
      );
    }

    return {
      targetId: id,
      page,
      values: read.values,
      readAt: new Date().toISOString(),
      txHex: read.exchange.txHex,
      rxHex: read.exchange.rxHex,
    };
  }

  /**
   * Write one trimmer, live. Also does not arm the board — same reasoning as
   * readWipers. Returns the device's own reply, the whole updated page, NOT
   * the value that was sent: confirmed by capture, a write's reply is
   * G-shaped and carries every wiper on that page, so trusting the request
   * body instead of this return would show a value that was never confirmed.
   */
  async writeWiper(id: string, page: WiperPage, wiper: number, value: number) {
    const target = await this.findOne(id);
    await this.assertNotMidRelay(id, target.label, 'Changing sensitivity for');

    const read = await this.command.writeWiper(
      this.refOf(target),
      page,
      wiper,
      value,
    );
    if (!read) {
      throw new ServiceUnavailableException(
        `${target.label} (${target.ipAddress}) did not answer a wiper write. ` +
          `Check that it is powered and reachable, and re-read before trusting the last value shown.`,
      );
    }

    this.logger.log(
      `WIPER → ${target.label} (${target.ipAddress}): ${page}${wiper} set to ${value}`,
    );

    return {
      targetId: id,
      page,
      values: read.values,
      readAt: new Date().toISOString(),
      txHex: read.exchange.txHex,
      rxHex: read.exchange.rxHex,
    };
  }

  /**
   * @param marksPickUsed true only when this write came from
   *   calibrateFromShot — the one-bullet pick. Every other route into here (a
   *   bulk group drag, a hand-typed offset, a reset to zero) leaves the pick
   *   flag alone: see Session.pickCalibrationUsed for why it is not inferred
   *   from the calibration count.
   */
  async setOffset(
    id: string,
    offsetXmm: number,
    offsetYmm: number,
    marksPickUsed = false,
  ) {
    const target = await this.findOne(id);
    const deltaX = offsetXmm - target.offsetXmm;
    const deltaY = offsetYmm - target.offsetYmm;

    const activeStage = await this.prisma.sessionStage.findFirst({
      where: { targetId: id, status: 'ACTIVE' },
      include: { shots: true },
    });

    // Every stage of the SAME SESSION, not just the live one.
    //
    // A calibration corrects a mounting error that was wrong for the whole
    // relay, so applying it to only the active stage leaves the earlier stages
    // of that session scored against an offset the operator has just declared
    // incorrect — and the session total then disagrees with the sum of the
    // shots it is made of. Scoped to the session on purpose: widening it to
    // every stage this target ever ran would retroactively rewrite sessions
    // that are already completed and reviewed.
    const stagesToRescore = activeStage
      ? await this.prisma.sessionStage.findMany({
          where: { sessionId: activeStage.sessionId, targetId: id },
          include: { shots: true },
        })
      : [];

    // Collected inside the transaction, logged after it commits — a re-score
    // that rolled back must not leave a log line claiming it happened.
    const rescored: string[] = [];

    await this.prisma.$transaction(async (tx) => {
      await tx.target.update({
        where: { id },
        data: { offsetXmm, offsetYmm },
      });

      if (!activeStage) return;

      // Recorded here, in the same transaction as the offset itself, so
      // neither fact can disagree with whether the calibration actually
      // landed. The flag is one-way: `true` is never written back to false
      // within a session, so resetting the offset cannot hand the pick back.
      await tx.session.update({
        where: { id: activeStage.sessionId },
        data: {
          calibrationCount: { increment: 1 },
          ...(marksPickUsed ? { pickCalibrationUsed: true } : {}),
        },
      });

      for (const stage of stagesToRescore) {
        for (const shot of stage.shots) {
          if (shot.isMiss) continue;

          const x = shot.x + deltaX;
          const y = shot.y + deltaY;
          // Each stage's OWN profile snapshot — a session can mix faces, and a
          // stage must never be re-scored against a face it was not shot on.
          const score = scoreAt(x, y, stage.profileType);
          await tx.shot.update({ where: { id: shot.id }, data: { x, y, score } });
          rescored.push(
            `stage ${stage.order} #${shot.shotNumber}: ` +
              `(${shot.x}, ${shot.y}) = ${shot.score} -> ` +
              `(${x}, ${y}) = ${score}`,
          );
        }
      }
    });

    const shotsUpdated = rescored.length;

    for (const line of rescored) {
      this.logger.log(`RE-SCORED ${target.label} ${line}`);
    }

    this.resolver.invalidate(target.ipAddress);

    const appliesFrom = activeStage
      ? `in force from shot #${activeStage.shots.length + 1}`
      : 'no active stage — in force from the next stage';
    this.logger.log(
      `CALIBRATED ${target.label}: offset ` +
        `(${signedMm(target.offsetXmm)}, ${signedMm(target.offsetYmm)}) -> ` +
        `(${signedMm(offsetXmm)}, ${signedMm(offsetYmm)})mm ` +
        `[delta ${signedMm(deltaX)}, ${signedMm(deltaY)}] — ` +
        `${shotsUpdated} shot(s) re-scored, ${appliesFrom}.`,
    );

    const session = activeStage
      ? await this.prisma.session.findUnique({
          where: { id: activeStage.sessionId },
          select: { calibrationCount: true, pickCalibrationUsed: true },
        })
      : null;

    this.calibrations.next({
      laneId: target.laneId,
      targetId: id,
      offsetXmm,
      offsetYmm,
      shotsUpdated,
      sessionCalibrationCount: session?.calibrationCount ?? null,
      sessionPickUsed: session?.pickCalibrationUsed ?? null,
    });

    return this.findOne(id);
  }

  async calibrateFromShot(
    id: string,
    ref: ReferenceShotRef,
    trueX: number,
    trueY: number,
  ) {
    const target = await this.findOne(id);
    const shot = await this.resolveReferenceShot(id, ref);

    const offsetXmm = target.offsetXmm + (trueX - shot.x);
    const offsetYmm = target.offsetYmm + (trueY - shot.y);

    this.logger.log(
      `CALIBRATE FROM SHOT: ${target.label} shot #${shot.shotNumber} ` +
        `scored at (${shot.x}, ${shot.y}) -> operator marked true position ` +
        `(${trueX}, ${trueY})mm.`,
    );

    // The only caller that spends the session's one-bullet pick.
    return this.setOffset(id, offsetXmm, offsetYmm, true);
  }

  /**
   * The reference shot, addressed either by row id or — the way the admin board
   * actually holds it — by stage plus 1-based shot number. See
   * CalibrateFromShotDto for why both forms exist.
   *
   * Either way the shot is re-read here rather than trusted from the request
   * body: the caller sends only where the shot BELONGS, never where it already
   * is, so a stale copy on the console cannot skew the derived offset.
   */
  private async resolveReferenceShot(targetId: string, ref: ReferenceShotRef) {
    if (ref.shotId) {
      const shot = await this.prisma.shot.findUnique({
        where: { id: ref.shotId },
        include: { stage: true },
      });
      if (!shot || shot.stage.targetId !== targetId) {
        throw new NotFoundException(
          `Shot ${ref.shotId} does not belong to target ${targetId}.`,
        );
      }
      return shot;
    }

    if (ref.stageId && ref.shotNumber != null) {
      const shot = await this.prisma.shot.findUnique({
        where: {
          sessionStageId_shotNumber: {
            sessionStageId: ref.stageId,
            shotNumber: ref.shotNumber,
          },
        },
        include: { stage: true },
      });
      if (!shot || shot.stage.targetId !== targetId) {
        throw new NotFoundException(
          `Shot #${ref.shotNumber} on stage ${ref.stageId} does not belong to ` +
            `target ${targetId}.`,
        );
      }
      return shot;
    }

    throw new BadRequestException(
      'Identify the reference shot by `shotId`, or by `stageId` and `shotNumber`.',
    );
  }
}
