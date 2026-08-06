import { describe, expect, it } from 'vitest';

import { isSentinel, scoreShot, toSigned16 } from './scoring';

const base = { offsetXmm: 0, offsetYmm: 0, profile: 'CIRCULAR' as const };

describe('toSigned16', () => {
  it('leaves positive values alone', () => {
    expect(toSigned16(0)).toBe(0);
    expect(toSigned16(100)).toBe(100);
    expect(toSigned16(32767)).toBe(32767);
  });

  it('reinterprets the top half of the range as negative', () => {
    expect(toSigned16(32768)).toBe(-32768);
    expect(toSigned16(65535)).toBe(-1);
    expect(toSigned16(65436)).toBe(-100);
  });
});

describe('sentinels', () => {
  it('recognises both no-detection markers', () => {
    expect(isSentinel(0, 0)).toBe(true);
    expect(isSentinel(65535, 65535)).toBe(true);
  });

  it('does not treat a real coordinate as a sentinel', () => {
    expect(isSentinel(0, 100)).toBe(false);
    expect(isSentinel(65535, 0)).toBe(false);
  });

  it('scores (65535,65535) as a MISS, not a bullseye', () => {
    // The regression this whole ordering exists to prevent: sign-correcting
    // first turns 65535 into -1, which is 1mm from centre — the highest
    // possible score. A miss must never invert into a perfect shot.
    const shot = scoreShot({ ...base, rawX: 65535, rawY: 65535 });
    expect(shot.isMiss).toBe(true);
    expect(shot.score).toBe(0);
  });

  it('scores (0,0) as a MISS, not a bullseye', () => {
    const shot = scoreShot({ ...base, rawX: 0, rawY: 0 });
    expect(shot.isMiss).toBe(true);
    expect(shot.score).toBe(0);
  });
});

describe('scoreShot', () => {
  it('scores a near-centre hit highest', () => {
    const shot = scoreShot({ ...base, rawX: 10, rawY: 510 });
    expect(shot.isMiss).toBe(false);
    expect(shot.score).toBe(10);
  });

  it('scores by radius, not by axis', () => {
    // (30, 40) is exactly 50mm out — the 9-ring boundary.
    expect(scoreShot({ ...base, rawX: 30, rawY: 540 }).score).toBe(9);
  });

  it('treats negative coordinates the same as positive at equal radius', () => {
    const right = scoreShot({ ...base, rawX: 60, rawY: 500 });
    const left = scoreShot({ ...base, rawX: 65476, rawY: 500 }); // -60
    expect(left.x).toBe(-60);
    expect(left.score).toBe(right.score);
  });

  it('scores a located-but-outside-the-rings shot as 0 WITHOUT marking it a miss', () => {
    const shot = scoreShot({ ...base, rawX: 5000, rawY: 5000 });
    expect(shot.score).toBe(0);
    // Distinct from a sentinel: the sensor DID resolve a position here.
    expect(shot.isMiss).toBe(false);
  });

  it('applies calibration offset before scoring', () => {
    const shot = scoreShot({
      rawX: 100,
      rawY: 500,
      offsetXmm: -80,
      offsetYmm: 0,
      profile: 'CIRCULAR',
    });
    expect(shot.x).toBe(20);
    expect(shot.score).toBe(10); // 20mm out, not 100mm
  });

  it('never awards 1 on a FIGURE face — the printed zones are only 5/4/3/2', () => {
    // Sweep the whole face outward in 5mm steps along +Y from centre. The old
    // ring table had a [300, 1] band, so a regression here shows up as a 1
    // rather than as a wrong-looking number somewhere no test was watching.
    const scores = new Set<number>();
    for (let mm = 0; mm <= 400; mm += 5) {
      scores.add(
        scoreShot({ ...base, rawX: 0, rawY: 500 + mm, profile: 'FIGURE' }).score,
      );
    }
    expect(scores.has(1)).toBe(false);
    expect([...scores].sort((a, b) => a - b)).toEqual([0, 2, 3, 4, 5]);
  });

  it('scores the outermost FIGURE band as 2 out to 300mm, 0 past it', () => {
    expect(scoreShot({ ...base, rawX: 0, rawY: 700, profile: 'FIGURE' }).score)
      .toBe(2); // 200mm out — was the old [200,2] edge
    expect(scoreShot({ ...base, rawX: 0, rawY: 800, profile: 'FIGURE' }).score)
      .toBe(2); // 300mm out — used to score 1
    expect(scoreShot({ ...base, rawX: 0, rawY: 805, profile: 'FIGURE' }).score)
      .toBe(0); // past the silhouette
  });

  it('scores the same coordinates differently per profile', () => {
    const coords = { rawX: 60, rawY: 500, offsetXmm: 0, offsetYmm: 0 };
    const circular = scoreShot({ ...coords, profile: 'CIRCULAR' });
    const figure = scoreShot({ ...coords, profile: 'FIGURE' });
    expect(circular.score).not.toBe(figure.score);
  });
});

describe('Y floor bias', () => {
  it('maps raw 500 (mid-board) to dead centre', () => {
    const shot = scoreShot({ ...base, rawX: 0, rawY: 500 });
    expect(shot.y).toBe(0);
  });

  it('shifts Y down 500mm so raw is relative to the board centre', () => {
    expect(scoreShot({ ...base, rawX: 0, rawY: 510 }).y).toBe(10);
    expect(scoreShot({ ...base, rawX: 0, rawY: 490 }).y).toBe(-10);
    expect(scoreShot({ ...base, rawX: 10, rawY: 0 }).y).toBe(-500);
  });

  it('composes with the per-target calibration offset', () => {
    // Bias first, then the offset: a centre raw with +20 of mounting error.
    const biased = scoreShot({ ...base, rawX: 0, rawY: 500, offsetYmm: 20 });
    expect(biased.y).toBe(20);
    // And an offset can cancel the bias entirely.
    const corrected = scoreShot({ ...base, rawX: 0, rawY: 510, offsetYmm: -10 });
    expect(corrected.y).toBe(0);
  });

  it('never applies the bias to a sentinel miss', () => {
    // The sentinel check runs on raw values BEFORE the sign/bias step.
    const shot = scoreShot({ ...base, rawX: 0, rawY: 0 });
    expect(shot.isMiss).toBe(true);
    expect(shot.y).toBe(0);
  });
});
