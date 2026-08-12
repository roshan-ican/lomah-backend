import { Injectable, NotFoundException } from '@nestjs/common';
import type { TargetProfile } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';

const HISTORY_STATUSES = ['COMPLETED', 'CANCELLED'] as const;
const DEFAULT_RANGE_DAYS = 30;

export type RingBucket = '10' | '8-9' | '6-7' | '4-5' | 'miss';

/**
 * Collapse a score onto a display bucket. Mirrors scoreToRingBucket in
 * shared/coordinates.ts — the two must agree or the report and the live board
 * will colour the same shot differently.
 */
function toRingBucket(score: number, profile: TargetProfile): RingBucket {
  if (score <= 0) return 'miss';
  if (profile === 'FIGURE') {
    // Figure-11 scale tops out at 5, so its bands are compressed.
    if (score >= 5) return '10';
    if (score >= 4) return '8-9';
    if (score >= 3) return '6-7';
    return '4-5';
  }
  if (score >= 10) return '10';
  if (score >= 8) return '8-9';
  if (score >= 6) return '6-7';
  if (score >= 4) return '4-5';
  return 'miss';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfDay(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function endOfDay(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59.999Z`);
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  listSessions() {
    return this.prisma.session.findMany({
      where: { status: { in: [...HISTORY_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      include: {
        stages: {
          orderBy: { order: 'asc' },
          select: {
            id: true,
            targetId: true,
            order: true,
            bulletLimit: true,
            durationSeconds: true,
            _count: { select: { shots: true } },
          },
        },
      },
    });
  }

  async getSession(id: string) {
    const session = await this.prisma.session.findUnique({
      where: { id },
      include: {
        stages: {
          orderBy: { order: 'asc' },
          include: {
            target: true,
            shots: { orderBy: { shotNumber: 'asc' } },
          },
        },
      },
    });
    if (!session) {
      throw new NotFoundException(`Session ${id} not found`);
    }

    /**
     * A FLAT `shots` array alongside the nested stages.
     *
     * The session-history preview asks this endpoint for one session and reads
     * `data.shots` — the shape the old Express backend sent
     * (`{ session, shots }`). The rewrite returned the raw Prisma row instead,
     * where shots live at `stages[].shots`, so `data.shots` was undefined and
     * every expanded session rendered "no shots recorded" over an empty target.
     *
     * `shotNumber` is renumbered session-wide here. On the model it is 1-based
     * PER STAGE, so a two-stage session has two shots numbered 1 — and the
     * client keys the target board and the shot list off that number, which
     * would collide. The per-stage value is kept as `stageShotNumber`.
     */
    let sequence = 0;
    const shots = session.stages.flatMap((stage) =>
      stage.shots.map((shot) => ({
        id: shot.id,
        shotNumber: ++sequence,
        stageShotNumber: shot.shotNumber,
        sessionStageId: stage.id,
        stageOrder: stage.order,
        targetId: stage.targetId,
        x: shot.x,
        y: shot.y,
        // Carried into history for the same reason it is carried live: once a
        // session is closed, x/y is all that survives of a calibration that
        // may have moved every shot on the board, and nothing else records
        // what the sensor originally read. Null on sessions fired before the
        // column existed.
        sensorXmm: shot.sensorXmm,
        sensorYmm: shot.sensorYmm,
        score: shot.score,
        // Read the persisted flag, never `score === 0`: a real hit that landed
        // outside every scoring ring scores 0 and is NOT a miss. Inferring it
        // coloured those amber in history and red on the live board.
        isMiss: shot.isMiss,
        isLost: shot.isLost,
        // The client reads `timestamp`; the column is `firedAt`.
        timestamp: shot.firedAt,
      })),
    );

    return { ...session, shots };
  }

  async getShooterReport(username: string, from?: string, to?: string) {
    const rangeFrom = from ? startOfDay(from) : startOfDay(toDateOnly(daysAgo(DEFAULT_RANGE_DAYS)));
    const rangeTo = to ? endOfDay(to) : endOfDay(toDateOnly(new Date()));

    const sessions = await this.prisma.session.findMany({
      where: {
        shooterName: username,
        status: { in: [...HISTORY_STATUSES] },
        createdAt: { gte: rangeFrom, lte: rangeTo },
      },
      orderBy: { createdAt: 'desc' },
      include: { stages: { include: { shots: true } } },
    });

    const allShots = sessions.flatMap((s) => s.stages.flatMap((st) => st.shots));
    const hits = allShots.filter((s) => !s.isMiss);

    const trend = sessions
      .slice()
      .reverse()
      .map((s) => {
        const sessionHits = s.stages.flatMap((st) => st.shots).filter((sh) => !sh.isMiss);
        return {
          sessionId: s.id,
          date: s.createdAt,
          shotCount: sessionHits.length,
          avgScore: sessionHits.length
            ? round2(sessionHits.reduce((sum, sh) => sum + sh.score, 0) / sessionHits.length)
            : 0,
        };
      });

    const summary = {
      sessionCount: sessions.length,
      shotCount: allShots.length,
      hitCount: hits.length,
      /** Every shot including sentinel misses — what the shooter actually
       *  fired, as opposed to hitCount. */
      totalShots: allShots.length,
      missCount: allShots.length - hits.length,
      avgScore: hits.length ? round2(hits.reduce((sum, s) => sum + s.score, 0) / hits.length) : 0,
      bestScore: hits.length ? Math.max(...hits.map((s) => s.score)) : 0,
      /** Best SESSION average, not the best single shot — the headline number
       *  for "what is this shooter capable of on a good day". */
      bestSessionAvg: trend.length
        ? Math.max(...trend.map((t) => t.avgScore))
        : 0,
    };

    // Bucketed, not one entry per raw score: FIGURE scores 1–5 and CIRCULAR
    // scores 1–10, so raw counts are not comparable across profiles and would
    // give the chart a different set of columns per shooter. Bucket boundaries
    // mirror shared/coordinates.ts scoreToRingBucket so the report and the
    // live target board agree.
    const ringDistribution: Record<RingBucket, number> = {
      "10": 0,
      "8-9": 0,
      "6-7": 0,
      "4-5": 0,
      miss: 0,
    };
    for (const shot of allShots) {
      const stage = sessions
        .flatMap((s) => s.stages)
        .find((st) => st.id === shot.sessionStageId);
      ringDistribution[
        toRingBucket(shot.isMiss ? 0 : shot.score, stage?.profileType ?? 'FIGURE')
      ] += 1;
    }

    return {
      username,
      from: toDateOnly(rangeFrom),
      to: toDateOnly(rangeTo),
      summary,
      trend,
      ringDistribution,
      sessions: sessions.map((s) => {
        const sessionShots = s.stages.flatMap((st) => st.shots);
        const sessionHits = sessionShots.filter((sh) => !sh.isMiss);
        return {
          id: s.id,
          laneId: s.laneId,
          status: s.status,
          createdAt: s.createdAt,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          shotCount: sessionShots.length,
          // Averaged over HITS, not all shots: a sentinel miss has no
          // coordinates and scoring it as a zero would drag the average down
          // for something the shooter may not have fired at all.
          avgScore: sessionHits.length
            ? round2(
                sessionHits.reduce((sum, sh) => sum + sh.score, 0) /
                  sessionHits.length,
              )
            : 0,
          bestScore: sessionHits.length
            ? Math.max(...sessionHits.map((sh) => sh.score))
            : 0,
          /** Targets engaged, in firing order — a session can span several. */
          targetIds: s.stages
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((st) => st.targetId),
        };
      }),
    };
  }

  async getShooterShots(username: string, date?: string, from?: string, to?: string) {
    const hasRange = Boolean(from && to);
    const rangeFrom = hasRange ? startOfDay(from!) : startOfDay(date ?? toDateOnly(new Date()));
    const rangeTo = hasRange ? endOfDay(to!) : endOfDay(date ?? toDateOnly(new Date()));

    const sessions = await this.prisma.session.findMany({
      where: {
        shooterName: username,
        createdAt: { gte: rangeFrom, lte: rangeTo },
      },
      include: { stages: { include: { shots: { orderBy: { shotNumber: 'asc' } } } } },
    });

    const shots = sessions.flatMap((s) =>
      s.stages.flatMap((st) =>
        st.shots.map((sh) => ({ ...sh, sessionId: s.id })),
      ),
    );

    return hasRange
      ? { username, from: toDateOnly(rangeFrom), to: toDateOnly(rangeTo), shots }
      : { username, date: toDateOnly(rangeFrom), shots };
  }
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}
