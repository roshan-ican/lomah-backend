-- Command address override for a target.
--
-- A board normally answers from the same address it is commanded on, so
-- `ipAddress` is enough. A simulated or containerised target does not: it
-- reports from its bridge IP but must be commanded through a published
-- loopback port. These two columns carry that override; NULL on both means
-- "command it at `ipAddress` on the transport default port".
--
-- Reconstructed after the fact. This migration was applied to the range
-- database but its directory went missing from the repo, which left Prisma
-- looking at history it could not account for and offering to reset. The SQL
-- below is taken from the live schema, so applying it to a fresh database
-- produces exactly the table the existing one already has.
ALTER TABLE "targets" ADD COLUMN "commandHost" TEXT;
ALTER TABLE "targets" ADD COLUMN "commandPort" INTEGER;
