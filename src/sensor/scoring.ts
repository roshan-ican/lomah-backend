/**
 * Shot geometry and scoring — pure functions, no Nest, no Prisma, no I/O.
 *
 * Kept framework-free on purpose: this is the layer most likely to be wrong in
 * a way only a test can catch (sign handling and sentinels are both easy to get
 * subtly wrong and impossible to notice on a live range), so it must be
 * exercisable without a socket, a database, or a target.
 */

import type { TargetProfile } from '@prisma/client';

/**
 * The firmware's "no detection" markers. These are NOT coordinates — they mean
 * the sensor fired but resolved nothing.
 *
 * These are checked against the RAW uint16 values, before sign correction.
 * 65535 corrects to -1, so testing after correction loses the marker entirely
 * and a miss silently becomes a shot 1mm off dead centre — the highest possible
 * score. That inversion is the single worst bug this file can produce.
 */
const SENTINELS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [65535, 65535],
];

/** uint16 values above this are negative numbers in two's complement. */
const INT16_SIGN_THRESHOLD = 32767;
const UINT16_RANGE = 65536;

/**
 * The sensor's Y origin is the bottom edge of the board, so a wire value of 0
 * is the floor and the 1000mm-tall board's centre sits at raw 500. Restored
 * from the original backend (v1's `sensorRawToSensorMm` subtracted
 * `SENSOR_Y_MAX / 2`) — this constant is the best value found under live
 * testing, and it applies to every shot before any per-target calibration.
 */
export const SENSOR_Y_FLOOR_BIAS_MM = 500;

export interface ScoredShot {
  /** Millimetres from centre, signed, calibration applied. */
  x: number;
  y: number;
  score: number;
  isMiss: boolean;
}

/**
 * Ring boundaries in millimetres from centre, ascending, paired with the score
 * awarded inside that radius. First match wins; past the last ring is a zero.
 *
 * Provisional values — these need confirming against the physical target faces
 * before the system is scored on for real. The STRUCTURE is what matters here;
 * the numbers are a single-line edit once the real face dimensions are known.
 */
const RINGS: Record<TargetProfile, ReadonlyArray<readonly [number, number]>> = {
  // Figure-11 style silhouette. Scored on a coarser band than a circular face.
  FIGURE: [
    [50, 5],
    [100, 4],
    [150, 3],
    [200, 2],
    [300, 1],
  ],
  // Concentric competition face, 10 down to 1.
  CIRCULAR: [
    [25, 10],
    [50, 9],
    [75, 8],
    [100, 7],
    [125, 6],
    [150, 5],
    [175, 4],
    [200, 3],
    [225, 2],
    [250, 1],
  ],
};

/** Reinterpret a big-endian uint16 off the wire as a signed int16. */
export function toSigned16(raw: number): number {
  const v = raw & 0xffff;
  return v > INT16_SIGN_THRESHOLD ? v - UINT16_RANGE : v;
}

export function isSentinel(rawX: number, rawY: number): boolean {
  return SENTINELS.some(([x, y]) => rawX === x && rawY === y);
}

export function scoreForRadius(radiusMm: number, profile: TargetProfile): number {
  for (const [limit, score] of RINGS[profile]) {
    if (radiusMm <= limit) return score;
  }
  return 0;
}

/**
 * Turn one raw frame's coordinates into a scored shot.
 *
 * Order is load-bearing:
 *   1. sentinel check on RAW values (see SENTINELS above)
 *   2. sign correction
 *   3. Y floor bias — the sensor measures Y from the board's bottom edge, so
 *      every Y is shifted down by SENSOR_Y_FLOOR_BIAS_MM (500mm) to centre it
 *   4. calibration offset — mounting error belongs to the hardware, so it is
 *      applied before scoring, never stored raw and corrected at read time
 *   5. radius -> score, against the profile the CALLER passes in
 *
 * `profile` is the stage's snapshot, not the target's current face. Re-facing a
 * target must not retroactively rescore a stage that already happened.
 */
export function scoreShot(params: {
  rawX: number;
  rawY: number;
  offsetXmm: number;
  offsetYmm: number;
  profile: TargetProfile;
}): ScoredShot {
  const { rawX, rawY, offsetXmm, offsetYmm, profile } = params;

  if (isSentinel(rawX, rawY)) {
    return { x: 0, y: 0, score: 0, isMiss: true };
  }

  const x = toSigned16(rawX) + offsetXmm;
  const y = toSigned16(rawY) - SENSOR_Y_FLOOR_BIAS_MM + offsetYmm;

  const radius = Math.hypot(x, y);
  const score = scoreForRadius(radius, profile);

  // Outside the last ring is a real, located shot that simply scored nothing —
  // distinct from a sentinel miss, where there are no coordinates at all.
  return { x: Math.round(x), y: Math.round(y), score, isMiss: false };
}
