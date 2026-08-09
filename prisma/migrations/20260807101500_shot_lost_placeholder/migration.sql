-- A lost bullet now gets a placeholder row so shotNumber stays contiguous with
-- the rounds the shooter actually fired. Existing rows predate the distinction
-- and are all "arrived", so the default is correct for the backfill.
ALTER TABLE "shots" ADD COLUMN "isLost" BOOLEAN NOT NULL DEFAULT false;
