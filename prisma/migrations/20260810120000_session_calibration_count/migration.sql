-- Tracks how many times a session's target has been calibrated, so the
-- one-bullet "pick" calibration can be offered exactly once per session and
-- every later calibration in that session is a bulk group drag.
--
-- Existing rows default to 0. That is deliberately generous: a session already
-- in flight when this ships will offer pick once more even if it has been
-- calibrated. Backfilling is not possible — nothing recorded the count before
-- now — and one extra pick on a live relay is a far smaller problem than
-- withholding it from a session that has never been calibrated at all.
ALTER TABLE "sessions" ADD COLUMN "calibrationCount" INTEGER NOT NULL DEFAULT 0;
