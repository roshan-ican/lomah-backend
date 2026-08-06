import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { PrismaService } from '@/common/prisma/prisma.service';

import { SessionsService } from './sessions.service';

/** How often expiry is checked. One second is well inside human tolerance for
 *  "the stage should have ended by now" and costs one indexed query. */
const TICK_MS = 1000;

/**
 * Ends stages that have run out of time.
 *
 * Only stages that were GIVEN a time. A stage with `durationSeconds <= 0` is
 * open-ended and this service ignores it entirely — it ends when the range
 * officer advances it, or when its bullet limit is reached (see
 * SensorService). That is the common case for a relay run at the officer's
 * pace: "fire until I say advance".
 *
 * `SessionStage.durationSeconds` was stored and never read, so a stage stayed
 * ACTIVE indefinitely until an operator called /advance by hand — meaning a
 * shot fired ten minutes after a 60-second stage was supposed to end still
 * scored. The old backend checked expiry on every incoming shot
 * (`completeSessionIfTimeExpired`), which has a hole in it: if the shooter
 * stops firing, nothing triggers the check and the stage never closes.
 *
 * Polling on a timer closes that hole — a stage ends when its time is up
 * whether or not anyone is still shooting.
 */
@Injectable()
export class StageMonitorService {
  private readonly logger = new Logger(StageMonitorService.name);

  /** Stages already being advanced, so a slow advance() cannot be started twice
   *  by the next tick. */
  private readonly advancing = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  @Interval(TICK_MS)
  async tick(): Promise<void> {
    try {
      await this.expireDueStages();
    } catch (err) {
      // A throw here would be an unhandled rejection inside a timer, which in
      // some Node versions takes the process down. The range must not die
      // because one tick failed.
      this.logger.error(`Stage monitor tick failed: ${(err as Error).message}`);
    }
  }

  private async expireDueStages(): Promise<void> {
    const active = await this.prisma.sessionStage.findMany({
      where: {
        status: 'ACTIVE',
        startedAt: { not: null },
        session: { status: 'ACTIVE' },
        // `durationSeconds <= 0` means "no clock": the stage runs until the
        // range officer advances it, or until its bullet limit is reached.
        // Filtered in the QUERY, not below, because the elapsed check is
        // `elapsed >= duration * 1000` — with a duration of 0 that is true on
        // the very first tick, so an untimed stage would be advanced roughly
        // one second after it started.
        durationSeconds: { gt: 0 },
      },
      select: {
        id: true,
        sessionId: true,
        startedAt: true,
        durationSeconds: true,
        session: { select: { totalPausedMs: true } },
      },
    });

    const now = Date.now();

    for (const stage of active) {
      if (!stage.startedAt) continue;
      if (this.advancing.has(stage.id)) continue;

      // Time spent paused does not count against the stage clock. The query
      // above only returns stages whose session is ACTIVE, so a currently
      // paused session is excluded entirely; totalPausedMs covers the pauses
      // it has already come back from.
      const elapsedMs =
        now - stage.startedAt.getTime() - stage.session.totalPausedMs;
      if (elapsedMs < stage.durationSeconds * 1000) continue;

      this.advancing.add(stage.id);
      this.logger.log(
        `Stage ${stage.id} hit its ${stage.durationSeconds}s limit — advancing.`,
      );

      try {
        // Reuse advance() rather than closing the stage directly: it is what
        // knows to arm the next stage, disarm the hardware, release the lane
        // and complete the session on the last stage. Duplicating any of that
        // here would guarantee the two paths drift apart.
        await this.sessions.advance(stage.sessionId);
      } catch (err) {
        this.logger.error(
          `Auto-advance of session ${stage.sessionId} failed: ${(err as Error).message}`,
        );
      } finally {
        this.advancing.delete(stage.id);
      }
    }
  }

}
