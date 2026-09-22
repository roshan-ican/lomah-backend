-- Stage modes: per-stage target behaviour (timeline / reactive rules).
ALTER TABLE "session_stages" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'STATIC';
ALTER TABLE "session_stages" ADD COLUMN "modeConfig" JSONB;

-- Exposure attribution for timed stages.
ALTER TABLE "shots" ADD COLUMN "exposureIndex" INTEGER;
ALTER TABLE "shots" ADD COLUMN "exposureStartedAt" DATETIME;
