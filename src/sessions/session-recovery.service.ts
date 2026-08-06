import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { PrismaService } from '@/common/prisma/prisma.service';

/**
 * Reconciles state left behind by a previous process.
 *
 * A session is ACTIVE in the database, but "armed" is a property of a physical
 * board that was told to PLAY over UDP. That command does not survive a server
 * restart, and neither does the board's notion of being armed once it stops
 * hearing from us. So after a crash or a restart the database claims a relay is
 * in progress while nothing downrange is actually scoring.
 *
 * The old backend had `restoreOpenSessionsFromDb()` for the same reason. This
 * takes the opposite and safer position: rather than trying to resume a relay
 * whose real-world state we cannot know, mark it interrupted and make an
 * operator restart it deliberately. Shots fired into a gap we did not record
 * are not recoverable, and pretending otherwise would silently produce a
 * scorecard with holes in it.
 */
@Injectable()
export class SessionRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(SessionRecoveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.reconcile();
  }

  async reconcile(): Promise<{ sessions: number; stages: number; lanes: number }> {
    const orphaned = await this.prisma.session.findMany({
      where: { status: { in: ['ACTIVE', 'PAUSED'] } },
      include: { stages: true },
    });

    if (orphaned.length === 0) {
      // Also release any lane still pointing at a target with no live session —
      // possible if the process died between completing a session and clearing
      // the lane, and it would block the next session that wants that target.
      const released = await this.releaseIdleLanes();
      if (released > 0) {
        this.logger.warn(`Released ${released} lane(s) still holding a target.`);
      }
      return { sessions: 0, stages: 0, lanes: released };
    }

    const now = new Date();
    let stagesClosed = 0;

    for (const session of orphaned) {
      const openStages = session.stages.filter((s) => s.status === 'ACTIVE');

      await this.prisma.$transaction(async (tx) => {
        for (const stage of openStages) {
          await tx.sessionStage.update({
            where: { id: stage.id },
            data: { status: 'COMPLETED', endedAt: stage.endedAt ?? now },
          });
        }

        // SUPERSEDED, not CANCELLED: an operator did not stop this session, the
        // server did. Keeping the two distinguishable matters when someone
        // later asks why a relay has no scorecard.
        await tx.session.update({
          where: { id: session.id },
          data: { status: 'SUPERSEDED', endedAt: session.endedAt ?? now },
        });

        await tx.lane.update({
          where: { id: session.laneId },
          data: { activeTargetId: null },
        });
      });

      stagesClosed += openStages.length;
      this.logger.warn(
        `Session ${session.id} (lane ${session.laneId}) was ${session.status} at startup — marked SUPERSEDED, ${openStages.length} stage(s) closed.`,
      );
    }

    const released = await this.releaseIdleLanes();

    this.logger.warn(
      `Startup recovery: ${orphaned.length} interrupted session(s) reconciled.`,
    );

    return { sessions: orphaned.length, stages: stagesClosed, lanes: released };
  }

  /** Clear activeTargetId on any lane with no session actually running on it. */
  private async releaseIdleLanes(): Promise<number> {
    const held = await this.prisma.lane.findMany({
      where: { activeTargetId: { not: null } },
      select: { id: true },
    });
    if (held.length === 0) return 0;

    const live = await this.prisma.session.findMany({
      where: {
        laneId: { in: held.map((l) => l.id) },
        status: { in: ['ACTIVE', 'PAUSED'] },
      },
      select: { laneId: true },
    });
    const liveLaneIds = new Set(live.map((s) => s.laneId));

    const idle = held.filter((l) => !liveLaneIds.has(l.id)).map((l) => l.id);
    if (idle.length === 0) return 0;

    await this.prisma.lane.updateMany({
      where: { id: { in: idle } },
      data: { activeTargetId: null },
    });
    return idle.length;
  }
}
