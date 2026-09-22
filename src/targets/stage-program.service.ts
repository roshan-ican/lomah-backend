import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Subscription } from 'rxjs';

import { PrismaService } from '@/common/prisma/prisma.service';
import type { ShotEvent } from '@/sensor/sensor.events';
import { SensorService } from '@/sensor/sensor.service';
import type { SessionEvent } from '@/sessions/session.events';
import { SessionsService } from '@/sessions/sessions.service';
import {
  STAGE_MODES_ENABLED,
  ruleCountsHit,
  timelinePositionAt,
  type StageModeConfig,
} from '@/sessions/stage-mode';

import { TargetLiftService, type LiftPosition } from './target-lift.service';

const TICK_MS = 100;
const RESUME_AFTER_MS = 3000;

interface DrivenStage {
  targetId: string;
  position: LiftPosition;
}

interface RuleState {
  counted: Set<number>;
  hits: number[];
  fired: boolean[];
}

/**
 * Runs a stage's target behaviour.
 *
 * Timed stages (TIMELINE / COMBINED): position is recomputed every tick from
 * startedAt and totalPausedMs, so a restart or a slow HTTP call never shifts
 * the schedule. A stage that stops being ACTIVE gets its target dropped once;
 * StageMonitorService ends it, since durationSeconds is derived from the program.
 *
 * Hit rules (REACTIVE / COMBINED): each recorded shot is checked against the
 * stage's rules and fires DROP_AND_HOLD, DROP_AND_RESUME or END_STAGE.
 *
 * Every stage start raises the target, so a board left down never starts a relay.
 */
@Injectable()
export class StageProgramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StageProgramService.name);
  private readonly driven = new Map<string, DrivenStage>();
  private readonly inFlight = new Set<string>();
  private readonly held = new Set<string>();
  private readonly rules = new Map<string, RuleState>();
  private readonly resumeTimers = new Map<string, NodeJS.Timeout>();
  private subs: Subscription[] = [];
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lift: TargetLiftService,
    private readonly sensor: SensorService,
    private readonly sessions: SessionsService,
  ) {}

  onModuleInit(): void {
    this.subs = [
      this.sensor.shots$.subscribe((shot) => void this.onShot(shot).catch((err) => this.fail('shot', err))),
      this.sessions.events$.subscribe((ev) => void this.onSession(ev).catch((err) => this.fail('session', err))),
    ];
  }

  onModuleDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.resumeTimers.forEach((t) => clearTimeout(t));
  }

  @Interval(TICK_MS)
  async tick(): Promise<void> {
    if (!STAGE_MODES_ENABLED || this.ticking) return;
    this.ticking = true;
    try {
      await this.drive();
    } catch (err) {
      this.fail('tick', err);
    } finally {
      this.ticking = false;
    }
  }

  // ------------------------------------------------------------ stage start

  private async onSession(ev: SessionEvent): Promise<void> {
    const stageId =
      ev.type === 'session:started' ? ev.stageId
        : ev.type === 'session:advanced' ? ev.toStageId
          : undefined;

    if (ev.type === 'session:advanced') this.forget(ev.fromStageId);
    if (ev.type === 'session:completed') {
      const stages = await this.prisma.sessionStage.findMany({
        where: { sessionId: ev.sessionId },
        select: { id: true },
      });
      stages.forEach((s) => this.forget(s.id));
    }

    if (!stageId) return;
    const stage = await this.prisma.sessionStage.findUnique({
      where: { id: stageId },
      select: { id: true, targetId: true, mode: true, modeConfig: true },
    });
    if (!stage) return;
    const rules = (stage.modeConfig as StageModeConfig | null)?.rules ?? [];
    rules.forEach((r, i) =>
      this.logger.log(
        `Stage ${stage.id} rule ${i + 1}: ${r.count} hits ${r.zone ?? 'any'} -> ${r.then}`,
      ),
    );
    if (STAGE_MODES_ENABLED && (stage.mode === 'TIMELINE' || stage.mode === 'COMBINED')) return;

    this.logger.log(`Stage ${stage.id} started — checking target is up`);
    this.command(stage.id, stage.targetId, 'UP', false, true);
  }

  private forget(stageId: string): void {
    this.held.delete(stageId);
    this.rules.delete(stageId);
    const timer = this.resumeTimers.get(stageId);
    if (timer) clearTimeout(timer);
    this.resumeTimers.delete(stageId);
  }

  // -------------------------------------------------------------- hit rules

  private async onShot(shot: ShotEvent): Promise<void> {
    if (!STAGE_MODES_ENABLED || shot.isLost) return;
    const stage = await this.prisma.sessionStage.findUnique({
      where: { id: shot.sessionStageId },
      select: { id: true, sessionId: true, targetId: true, status: true, mode: true, modeConfig: true, profileType: true },
    });
    if (!stage || stage.status !== 'ACTIVE') return;
    if (stage.mode !== 'REACTIVE' && stage.mode !== 'COMBINED') return;
    if (this.held.has(stage.id)) return;

    const rules = (stage.modeConfig as StageModeConfig | null)?.rules ?? [];
    if (!rules.length) return;

    let state = this.rules.get(stage.id);
    if (!state) {
      state = { counted: new Set(), hits: rules.map(() => 0), fired: rules.map(() => false) };
      this.rules.set(stage.id, state);
    }
    if (state.counted.has(shot.shotNumber)) return;
    state.counted.add(shot.shotNumber);

    for (const [i, rule] of rules.entries()) {
      if (state.fired[i] || !ruleCountsHit(rule, shot, stage.profileType)) continue;
      state.hits[i] += 1;
      this.logger.log(
        `Stage ${stage.id} rule ${i + 1}: ${state.hits[i]}/${rule.count} hits${rule.zone ? ` in ${rule.zone}` : ''}`,
      );
      if (state.hits[i] < rule.count) continue;

      this.logger.log(`Stage ${stage.id} rule ${i + 1} reached — ${rule.then}`);
      if (rule.then === 'END_STAGE') {
        state.fired[i] = true;
        await this.sessions.advance(stage.sessionId);
        return;
      }

      this.held.add(stage.id);
      this.command(stage.id, stage.targetId, 'DOWN', false);

      if (rule.then === 'DROP_AND_HOLD') {
        state.fired[i] = true;
        return;
      }

      state.hits[i] = 0;
      this.resumeTimers.set(
        stage.id,
        setTimeout(() => {
          this.resumeTimers.delete(stage.id);
          if (!this.held.delete(stage.id)) return;
          this.logger.log(`Stage ${stage.id} resuming — raising target`);
          if (stage.mode === 'REACTIVE') this.command(stage.id, stage.targetId, 'UP', false);
          else this.driven.delete(stage.id);
        }, RESUME_AFTER_MS),
      );
      return;
    }
  }

  // --------------------------------------------------------------- timeline

  private async drive(): Promise<void> {
    const stages = await this.prisma.sessionStage.findMany({
      where: {
        status: 'ACTIVE',
        startedAt: { not: null },
        mode: { in: ['TIMELINE', 'COMBINED'] },
        session: { status: 'ACTIVE' },
      },
      select: {
        id: true,
        targetId: true,
        startedAt: true,
        modeConfig: true,
        session: { select: { totalPausedMs: true } },
      },
    });

    const now = Date.now();
    const live = new Set<string>();

    for (const stage of stages) {
      const timeline = (stage.modeConfig as StageModeConfig | null)?.timeline;
      if (!timeline || !stage.startedAt) continue;
      live.add(stage.id);
      if (this.held.has(stage.id)) continue;

      const elapsed = now - stage.startedAt.getTime() - stage.session.totalPausedMs;
      const { position, exposureIndex } = timelinePositionAt(timeline, elapsed);
      if (this.driven.get(stage.id)?.position === position) continue;

      this.logger.log(
        `Stage ${stage.id} exposure ${exposureIndex + 1}/${timeline.repeat} -> ${position}`,
      );
      this.command(stage.id, stage.targetId, position, true, !this.driven.has(stage.id));
    }

    for (const [stageId, state] of this.driven) {
      if (live.has(stageId)) continue;
      this.driven.delete(stageId);
      if (state.position === 'DOWN') continue;
      this.logger.log(`Stage ${stageId} no longer running — dropping target`);
      this.command(stageId, state.targetId, 'DOWN', false);
    }
  }

  // --------------------------------------------------------------- plumbing

  private command(stageId: string, targetId: string, to: LiftPosition, track = true, fresh = false): void {
    const key = `${stageId}:${to}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    if (track) this.driven.set(stageId, { targetId, position: to });

    void this.lift
      .move(targetId, to, { fresh })
      .catch((err) => {
        this.logger.warn(`Stage ${stageId} lift ${to} failed: ${(err as Error).message}`);
        if (track) this.driven.delete(stageId);
      })
      .finally(() => this.inFlight.delete(key));
  }

  private fail(where: string, err: unknown): void {
    this.logger.error(`Stage program ${where} failed: ${(err as Error).message}`);
  }
}
