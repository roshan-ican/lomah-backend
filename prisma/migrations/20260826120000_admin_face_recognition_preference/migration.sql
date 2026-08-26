-- ADMIN chooses the default for new sessions; each session snapshots it so a
-- preference change never alters a relay that is already configured/running.
ALTER TABLE "users" ADD COLUMN "faceRecognitionEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "sessions" ADD COLUMN "requiresFaceVerification" BOOLEAN NOT NULL DEFAULT true;
