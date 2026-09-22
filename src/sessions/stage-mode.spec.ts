import { describe, expect, it } from 'vitest';
import { expandUpDurations, ruleCountsHit, StageModeError, timelinePositionAt, validateStageMode } from './stage-mode';

const peekaboo = { repeat: 5, upForMs: [3000], downForMs: 2000 };
const dropAfter3 = { when: 'hits', zone: 'CENTER', count: 3, then: 'END_STAGE' };

describe('validateStageMode', () => {
  it('defaults to STATIC and keeps the given duration', () => {
    expect(validateStageMode({ durationSeconds: 0 })).toEqual({
      mode: 'STATIC',
      modeConfig: null,
      durationSeconds: 0,
    });
  });

  it('rejects a modeConfig on a STATIC stage', () => {
    expect(() => validateStageMode({ mode: 'STATIC', modeConfig: {} })).toThrow(StageModeError);
  });

  it('derives TIMELINE duration from the program', () => {
    const r = validateStageMode({
      mode: 'TIMELINE',
      modeConfig: { preset: 'PEEKABOO', timeline: peekaboo },
      durationSeconds: 0,
    });
    expect(r.durationSeconds).toBe(25);
    expect(r.modeConfig).toEqual({ preset: 'PEEKABOO', timeline: peekaboo });
  });

  it('cycles upForMs across repeats', () => {
    expect(expandUpDurations({ repeat: 10, upForMs: [1, 3, 5, 7], downForMs: 0 })).toEqual([
      1, 3, 5, 7, 1, 3, 5, 7, 1, 3,
    ]);
  });

  it('rejects steps under 1000 ms', () => {
    expect(() =>
      validateStageMode({ mode: 'TIMELINE', modeConfig: { timeline: { ...peekaboo, downForMs: 500 } } }),
    ).toThrow(/at least 1000/);
  });

  it('rejects a timeline over 600 s with the real figure', () => {
    expect(() =>
      validateStageMode({
        mode: 'TIMELINE',
        modeConfig: { timeline: { repeat: 50, upForMs: [10000], downForMs: 5000 } },
      }),
    ).toThrow(/750s/);
  });

  it('gives an open REACTIVE stage the 600 s cap', () => {
    const r = validateStageMode({ mode: 'REACTIVE', modeConfig: { rules: [dropAfter3] }, durationSeconds: 0 });
    expect(r.durationSeconds).toBe(600);
  });

  it('rejects a zone that does not exist', () => {
    expect(() =>
      validateStageMode({ mode: 'REACTIVE', modeConfig: { rules: [{ ...dropAfter3, zone: 'HEAD' }] } }),
    ).toThrow(/zone/);
  });

  it('rejects a timeline on a REACTIVE stage and rules on a TIMELINE stage', () => {
    expect(() =>
      validateStageMode({ mode: 'REACTIVE', modeConfig: { rules: [dropAfter3], timeline: peekaboo } }),
    ).toThrow(/no timeline/);
    expect(() =>
      validateStageMode({ mode: 'TIMELINE', modeConfig: { timeline: peekaboo, rules: [dropAfter3] } }),
    ).toThrow(/no rules/);
  });

  it('accepts COMBINED with both', () => {
    const r = validateStageMode({ mode: 'COMBINED', modeConfig: { timeline: peekaboo, rules: [dropAfter3] } });
    expect(r.durationSeconds).toBe(25);
  });

  it('rejects unknown keys', () => {
    expect(() =>
      validateStageMode({ mode: 'TIMELINE', modeConfig: { timeline: peekaboo, extra: 1 } }),
    ).toThrow(/unknown/);
  });
});

describe('timelinePositionAt', () => {
  const t = { repeat: 2, upForMs: [3000], downForMs: 2000 };

  it('walks up, down, up, down, finished', () => {
    expect(timelinePositionAt(t, 0)).toMatchObject({ position: 'UP', exposureIndex: 0 });
    expect(timelinePositionAt(t, 3000)).toMatchObject({ position: 'DOWN', exposureIndex: 0 });
    expect(timelinePositionAt(t, 5000)).toMatchObject({ position: 'UP', exposureIndex: 1, exposureStartedAtMs: 5000 });
    expect(timelinePositionAt(t, 8500)).toMatchObject({ position: 'DOWN', exposureIndex: 1, finished: false });
    expect(timelinePositionAt(t, 10000)).toMatchObject({ position: 'DOWN', finished: true });
  });
});

describe('ruleCountsHit', () => {
  const any = { when: 'hits', count: 3, then: 'DROP_AND_HOLD' } as const;
  it('counts any on-paper hit when no zone is set', () => {
    expect(ruleCountsHit(any, { score: 2, isMiss: false }, 'FIGURE')).toBe(true);
    expect(ruleCountsHit(any, { score: 0, isMiss: false }, 'FIGURE')).toBe(false);
    expect(ruleCountsHit(any, { score: 0, isMiss: true }, 'FIGURE')).toBe(false);
  });
  it('treats zones as nested', () => {
    const middle = { ...any, zone: 'MIDDLE' } as const;
    expect(ruleCountsHit(middle, { score: 5, isMiss: false }, 'FIGURE')).toBe(true);
    expect(ruleCountsHit(middle, { score: 4, isMiss: false }, 'FIGURE')).toBe(true);
    expect(ruleCountsHit(middle, { score: 3, isMiss: false }, 'FIGURE')).toBe(false);
  });
});
