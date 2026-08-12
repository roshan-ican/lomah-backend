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

/**
 * Millimetres with an explicit sign, for log lines that quote an offset.
 *
 * The sign is always shown, including on positives: an offset is a correction
 * with a direction, and "cal=(66, 93)" read back later is ambiguous about
 * which way the board was nudged in a way "cal=(+66, +93)" is not.
 */
export function signedMm(value: number): string {
  return `${value > 0 ? '+' : ''}${value}`;
}

export interface ScoredShot {
  /** Millimetres from centre, signed, calibration applied. */
  x: number;
  y: number;
  score: number;
  isMiss: boolean;
  sensorX?: number;
  sensorY?: number;
}

/**
 * Figure-11 scoring boxes, in millimetres from the face centre. Every box is
 * centred on y = 0; only the half-extents differ.
 *
 * The printed Figure-11 face is scored on nested RECTANGLES, not rings. This
 * previously disagreed with the console, which has always drawn and scored the
 * rectangular boxes (see `F11_*` in frontend/src/types/shared/coordinates.ts) —
 * the backend scored the same face radially, with an outermost ring at 300mm
 * against a silhouette that is 500mm tall. Everything in that 300–500mm band
 * was painted inside the target by the UI and scored zero by the server, which
 * is what a bulk calibration surfaced: shots dragged visibly onto the board
 * came back as zeros. These constants are the console's, and they are the
 * physical face.
 */
const F11 = {
  /** The silhouette itself — 450 x 1000mm. Outside this is a located zero. */
  silhouette: { halfW: 225, halfH: 500 },
  center: { halfW: 22.5, halfH: 61.5 },
  middle: { halfW: 46.5, halfH: 90.5 },
  outer: { halfW: 82.5, halfH: 181 },
} as const;

/**
 * Concentric face: 450mm scoring radius in 45mm bands, 10 down to 1.
 *
 * Also taken from the console rather than the old 250mm/25mm table here, for
 * the same reason as the Figure-11 boxes above — the two had drifted, and the
 * drawn face is the real one.
 */
const CIRCULAR_MAX_MM = 450;
const CIRCULAR_RING_MM = 45;

/** Reinterpret a big-endian uint16 off the wire as a signed int16. */
export function toSigned16(raw: number): number {
  const v = raw & 0xffff;
  return v > INT16_SIGN_THRESHOLD ? v - UINT16_RANGE : v;
}

export function isSentinel(rawX: number, rawY: number): boolean {
  return SENTINELS.some(([x, y]) => rawX === x && rawY === y);
}

/**
 * Score a coordinate that is ALREADY in face millimetres — signed from the
 * centre, calibration applied.
 *
 * The single scoring authority. Live ingestion reaches it through scoreShot();
 * the calibration re-score paths (TargetsService.setOffset,
 * SessionsService.calibrateShot) call it directly, because they are moving
 * shots that were already located and have no raw frame to re-derive.
 *
 * Face bounds are checked HERE rather than by the caller. The previous split —
 * an `isOnFace` guard wrapped around a radius lookup — was only ever applied on
 * the ingestion path, so a shot dragged off the edge of the silhouette scored
 * from the ring table while the identical coordinate scored zero when fired.
 * Folding the bound into the score makes that divergence unrepresentable.
 */
export function scoreAt(
  xMm: number,
  yMm: number,
  profile: TargetProfile,
): number {
  if (profile === 'CIRCULAR') {
    const r = Math.hypot(xMm, yMm);
    if (r > CIRCULAR_MAX_MM) return 0;
    return Math.max(1, Math.ceil(10 - r / CIRCULAR_RING_MM));
  }

  const ax = Math.abs(xMm);
  const ay = Math.abs(yMm);

  // Off the paper entirely.
  if (ax > F11.silhouette.halfW || ay > F11.silhouette.halfH) return 0;

  if (ax <= F11.center.halfW && ay <= F11.center.halfH) return 5;
  if (ax <= F11.middle.halfW && ay <= F11.middle.halfH) return 4;
  if (ax <= F11.outer.halfW && ay <= F11.outer.halfH) return 3;

  // On the silhouette but outside every printed box. The face prints 5/4/3/2
  // with no 1 zone, so this is a 2 all the way to the edge.
  return 2;
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
 *   5. scoreAt — face bounds and zone, against the profile the CALLER passes in
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


  const sensorX = toSigned16(rawX);
  const sensorY = toSigned16(rawY) - SENSOR_Y_FLOOR_BIAS_MM;

  const x = sensorX + offsetXmm;
  const y = sensorY + offsetYmm;

  // A shot off the face scores zero but is NOT a miss: the sensor located this
  // bullet, and the coordinates are real and worth keeping — the shooter can
  // see they went wide right rather than being told nothing was detected.
  // isMiss is reserved for the sentinel case, where there are no coordinates
  // at all.
  //
  // No rounding: every term above is an integer. rawX/rawY arrive as uint16
  // from the wire and the offsets are INTEGER columns, so a fractional
  // millimetre cannot arise here, and rounding would only hide it if one ever
  // did.
  return {
    x,
    y,
    score: scoreAt(x, y, profile),
    isMiss: false,
    sensorX,
    sensorY,
  };
}
