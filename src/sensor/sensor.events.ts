/**
 * What ingestion announces to anyone listening.
 *
 * Deliberately a plain data shape, not a Prisma row: the realtime layer sends
 * this straight down a socket to tablets and the admin board, so it carries
 * exactly what a client needs to render a shot and nothing else. Widening it
 * to `Shot & {...}` would leak schema changes onto every connected device.
 */
export interface ShotEvent {
  laneId: number;
  targetId: string;
  targetLabel: string;
  sessionId: string;
  sessionStageId: string;
  /** 0-based stage index within the session, for "stage 2 of 3" displays. */
  stageOrder: number;
  shotNumber: number;
  x: number;
  y: number;
  /** Where the board put the bullet before the target's calibration offset, in
   *  the same millimetres as x/y. Absent on misses and lost placeholders, and
   *  on shots recorded before the column existed — a client must render nothing
   *  in that case rather than falling back to x/y or to zero. */
  sensorXmm?: number;
  sensorYmm?: number;
  score: number;
  /** Sensor fired, resolved nothing. The frame arrived; x/y are meaningless. */
  isMiss: boolean;
  /** Frame never arrived. Placeholder so the sequence has no hole — see the
   *  Shot model's isLost. Always implies isMiss, never the other way round. */
  isLost: boolean;
  firedAt: Date;
  /** Running total for the stage, so clients don't have to accumulate it
   *  themselves — a client that reconnects mid-stage would otherwise start
   *  counting from zero. */
  stageShotCount: number;
}

export interface BenchHitEvent {
  targetId: string;
  laneId: number;
  targetLabel: string;
  shot: number;
  xMm: number;
  yMm: number;
  score: number;
  isMiss: boolean;
  firedAt: Date;
}
