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
  score: number;
  isMiss: boolean;
  firedAt: Date;
  /** Running total for the stage, so clients don't have to accumulate it
   *  themselves — a client that reconnects mid-stage would otherwise start
   *  counting from zero. */
  stageShotCount: number;
}
