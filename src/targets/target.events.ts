export interface TargetCalibratedEvent {
  laneId: number;
  targetId: string;
  offsetXmm: number;
  offsetYmm: number;
  shotsUpdated: number;
  /** Calibrations performed on the open session so far, this one included.
   *  1 means the one-bullet pick has just been spent; see
   *  Session.calibrationCount. Null when no session was running. */
  sessionCalibrationCount: number | null;
  /** Whether the session's one-bullet pick has been spent. Once true it stays
   *  true for the life of the session — a reset does not restore it. Null when
   *  no session was running. */
  sessionPickUsed: boolean | null;
}
