import { describe, expect, it } from 'vitest';

import { SequenceTracker } from './sequence.tracker';

/**
 * These tests exist because this logic caused a real, expensive bug: every shot
 * past the 256th was silently discarded for the rest of the session. It is also
 * the payoff for keeping SequenceTracker free of Nest decorators and I/O — no
 * bootstrap, no socket, no database, no hardware.
 */
describe('SequenceTracker', () => {
  const T = 'target-a';

  it('passes through a simple ascending run', () => {
    const t = new SequenceTracker();
    for (let i = 0; i < 10; i++) {
      const obs = t.observe(T, i);
      expect(obs.absolute).toBe(i);
      expect(obs.duplicate).toBe(false);
      expect(obs.gaps).toEqual([]);
    }
  });

  it('rejects an exact repeat as a duplicate', () => {
    const t = new SequenceTracker();
    t.observe(T, 5);
    expect(t.observe(T, 5).duplicate).toBe(true);
  });

  it('unwraps the byte counter across a rollover', () => {
    const t = new SequenceTracker();
    for (let i = 0; i < 256; i++) t.observe(T, i % 256);

    // Bullet 0 of the SECOND lap must not collide with bullet 0 of the first.
    const obs = t.observe(T, 0);
    expect(obs.absolute).toBe(256);
    expect(obs.duplicate).toBe(false);
  });

  it('keeps counting well past several rollovers', () => {
    const t = new SequenceTracker();
    let last = -1;
    for (let i = 0; i < 1000; i++) {
      const obs = t.observe(T, i % 256);
      expect(obs.duplicate).toBe(false);
      expect(obs.absolute).toBeGreaterThan(last);
      last = obs.absolute;
    }
    expect(last).toBe(999);
  });

  it('reports skipped numbers so they can be re-requested', () => {
    const t = new SequenceTracker();
    t.observe(T, 0);
    const obs = t.observe(T, 4);
    expect(obs.gaps).toEqual([1, 2, 3]);
  });

  it('does not re-report a gap once the missing bullet arrives late', () => {
    const t = new SequenceTracker();
    t.observe(T, 0);
    t.observe(T, 3); // gaps 1, 2
    const late = t.observe(T, 1);
    expect(late.duplicate).toBe(false);
    expect(late.gaps).toEqual([]);
    expect(t.hasSeen(T, 1)).toBe(true);
  });

  it('keeps targets independent — a lane now holds several', () => {
    const t = new SequenceTracker();
    t.observe('near', 10);
    const far = t.observe('far', 10);
    expect(far.duplicate).toBe(false);
  });

  it('bounds memory over a long relay', () => {
    const t = new SequenceTracker();
    for (let i = 0; i < 5000; i++) t.observe(T, i % 256);
    expect(t.seenSize(T)).toBeLessThanOrEqual(130);
  });
});
