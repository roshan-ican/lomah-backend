export const STAGE_MODES = ['STATIC', 'TIMELINE', 'REACTIVE', 'COMBINED'] as const;
export type StageModeName = (typeof STAGE_MODES)[number];

export const STAGE_PRESETS = ['PEEKABOO', 'DROP_AFTER_N', 'SNAP', 'CUSTOM'] as const;
export const RULE_ZONES = ['CENTER', 'MIDDLE', 'OUTER', 'SILHOUETTE'] as const;
export const RULE_ACTIONS = ['DROP_AND_HOLD', 'DROP_AND_RESUME', 'END_STAGE'] as const;

export const MIN_STEP_MS = 1000;
export const MAX_REPEAT = 50;
export const MAX_RULES = 10;
export const MAX_TOTAL_SECONDS = 600;

export interface TimelineConfig {
  repeat: number;
  upForMs: number[];
  downForMs: number;
}

export interface StageRule {
  when: 'hits';
  zone?: (typeof RULE_ZONES)[number];
  count: number;
  then: (typeof RULE_ACTIONS)[number];
}

export interface StageModeConfig {
  preset?: (typeof STAGE_PRESETS)[number];
  timeline?: TimelineConfig;
  rules?: StageRule[];
}

export interface StageModeInput {
  mode?: string;
  modeConfig?: unknown;
  durationSeconds?: number;
}

export interface NormalizedStageMode {
  mode: StageModeName;
  modeConfig: StageModeConfig | null;
  durationSeconds?: number;
}

export class StageModeError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isInt = (v: unknown): v is number => Number.isInteger(v);

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], where: string) {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) throw new StageModeError(`${where}: unknown field(s) ${extra.join(', ')}`);
}

export function expandUpDurations(t: TimelineConfig): number[] {
  return Array.from({ length: t.repeat }, (_, i) => t.upForMs[i % t.upForMs.length]);
}

export function timelineTotalMs(t: TimelineConfig): number {
  return expandUpDurations(t).reduce((sum, up) => sum + up + t.downForMs, 0);
}

function parseTimeline(raw: unknown): TimelineConfig {
  if (!isObject(raw)) throw new StageModeError('timeline must be an object');
  rejectUnknownKeys(raw, ['repeat', 'upForMs', 'downForMs'], 'timeline');
  const { repeat, upForMs, downForMs } = raw;

  if (!isInt(repeat) || repeat < 1 || repeat > MAX_REPEAT) {
    throw new StageModeError(`timeline.repeat must be an integer from 1 to ${MAX_REPEAT}`);
  }
  if (!Array.isArray(upForMs) || upForMs.length < 1 || upForMs.length > MAX_REPEAT) {
    throw new StageModeError(`timeline.upForMs must list 1 to ${MAX_REPEAT} durations`);
  }
  for (const ms of upForMs) {
    if (!isInt(ms) || ms < MIN_STEP_MS) {
      throw new StageModeError(`timeline.upForMs values must be integers of at least ${MIN_STEP_MS} ms`);
    }
  }
  if (!isInt(downForMs) || downForMs < MIN_STEP_MS) {
    throw new StageModeError(`timeline.downForMs must be an integer of at least ${MIN_STEP_MS} ms`);
  }

  const timeline: TimelineConfig = { repeat, upForMs: upForMs as number[], downForMs };
  const totalSeconds = timelineTotalMs(timeline) / 1000;
  if (totalSeconds > MAX_TOTAL_SECONDS) {
    throw new StageModeError(
      `timeline runs ${totalSeconds}s, over the ${MAX_TOTAL_SECONDS}s limit`,
    );
  }
  return timeline;
}

function parseRules(raw: unknown): StageRule[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RULES) {
    throw new StageModeError(`rules must list 1 to ${MAX_RULES} rules`);
  }
  return raw.map((r, i) => {
    const where = `rules[${i}]`;
    if (!isObject(r)) throw new StageModeError(`${where} must be an object`);
    rejectUnknownKeys(r, ['when', 'zone', 'count', 'then'], where);
    if (r.when !== 'hits') throw new StageModeError(`${where}.when must be "hits"`);
    if (r.zone !== undefined && !RULE_ZONES.includes(r.zone as never)) {
      throw new StageModeError(`${where}.zone must be one of ${RULE_ZONES.join(', ')}`);
    }
    if (!isInt(r.count) || r.count < 1 || r.count > MAX_REPEAT) {
      throw new StageModeError(`${where}.count must be an integer from 1 to ${MAX_REPEAT}`);
    }
    if (!RULE_ACTIONS.includes(r.then as never)) {
      throw new StageModeError(`${where}.then must be one of ${RULE_ACTIONS.join(', ')}`);
    }
    return {
      when: 'hits',
      ...(r.zone !== undefined && { zone: r.zone as StageRule['zone'] }),
      count: r.count,
      then: r.then as StageRule['then'],
    };
  });
}

export function validateStageMode(input: StageModeInput): NormalizedStageMode {
  const mode = (input.mode ?? 'STATIC') as StageModeName;
  if (!STAGE_MODES.includes(mode)) {
    throw new StageModeError(`mode must be one of ${STAGE_MODES.join(', ')}`);
  }

  if (mode === 'STATIC') {
    if (input.modeConfig != null) throw new StageModeError('STATIC stages take no modeConfig');
    return { mode, modeConfig: null, durationSeconds: input.durationSeconds };
  }

  const raw = input.modeConfig;
  if (!isObject(raw)) throw new StageModeError(`${mode} stages require a modeConfig object`);
  rejectUnknownKeys(raw, ['preset', 'timeline', 'rules'], 'modeConfig');

  if (raw.preset !== undefined && !STAGE_PRESETS.includes(raw.preset as never)) {
    throw new StageModeError(`modeConfig.preset must be one of ${STAGE_PRESETS.join(', ')}`);
  }

  const wantsTimeline = mode === 'TIMELINE' || mode === 'COMBINED';
  const wantsRules = mode === 'REACTIVE' || mode === 'COMBINED';
  if (!wantsTimeline && raw.timeline !== undefined) {
    throw new StageModeError(`${mode} stages take no timeline`);
  }
  if (!wantsRules && raw.rules !== undefined) {
    throw new StageModeError(`${mode} stages take no rules`);
  }

  const modeConfig: StageModeConfig = {
    ...(raw.preset !== undefined && { preset: raw.preset as StageModeConfig['preset'] }),
    ...(wantsTimeline && { timeline: parseTimeline(raw.timeline) }),
    ...(wantsRules && { rules: parseRules(raw.rules) }),
  };

  const durationSeconds = modeConfig.timeline
    ? Math.ceil(timelineTotalMs(modeConfig.timeline) / 1000)
    : Math.min(input.durationSeconds || MAX_TOTAL_SECONDS, MAX_TOTAL_SECONDS);

  return { mode, modeConfig, durationSeconds };
}

export interface TimelinePosition {
  position: 'UP' | 'DOWN';
  exposureIndex: number;
  exposureStartedAtMs: number;
  finished: boolean;
}

export function timelinePositionAt(t: TimelineConfig, elapsedMs: number): TimelinePosition {
  let cursor = 0;
  const ups = expandUpDurations(t);
  for (let i = 0; i < ups.length; i++) {
    if (elapsedMs < cursor + ups[i]) {
      return { position: 'UP', exposureIndex: i, exposureStartedAtMs: cursor, finished: false };
    }
    if (elapsedMs < cursor + ups[i] + t.downForMs) {
      return { position: 'DOWN', exposureIndex: i, exposureStartedAtMs: cursor, finished: false };
    }
    cursor += ups[i] + t.downForMs;
  }
  const last = ups.length - 1;
  return {
    position: 'DOWN',
    exposureIndex: last,
    exposureStartedAtMs: cursor - ups[last] - t.downForMs,
    finished: true,
  };
}

// Zones are nested boxes, so a hit in CENTER also counts for MIDDLE, OUTER and SILHOUETTE.
const ZONE_MIN_SCORE: Record<'FIGURE' | 'CIRCULAR', Record<StageRule['zone'] & string, number>> = {
  FIGURE: { CENTER: 5, MIDDLE: 4, OUTER: 3, SILHOUETTE: 2 },
  CIRCULAR: { CENTER: 9, MIDDLE: 7, OUTER: 4, SILHOUETTE: 1 },
};

export function ruleCountsHit(
  rule: StageRule,
  shot: { score: number; isMiss: boolean; isLost?: boolean },
  profile: 'FIGURE' | 'CIRCULAR',
): boolean {
  if (shot.isMiss || shot.isLost || shot.score <= 0) return false;
  if (!rule.zone) return true;
  return shot.score >= ZONE_MIN_SCORE[profile][rule.zone];
}
