-- Keeps the board's own reading alongside the calibrated one.
--
-- x/y are post-offset and are mutated in place by two different corrections:
-- setOffset shifts every shot in the session by a delta, and calibrateShot
-- overwrites one shot with a dragged position. Once either has run there is
-- nothing left to say where the sensor originally put the bullet, so a range
-- officer looking at a suspicious group has no way to tell a mounting error
-- from a sensor fault.
--
-- Nullable with no default on purpose. Existing rows genuinely do not have
-- this reading and never will — a zero would be indistinguishable from a shot
-- the board placed at dead centre, which is exactly the confusion the column
-- exists to remove. Callers must treat NULL as "not recorded" and show
-- nothing rather than substituting a number.
ALTER TABLE "shots" ADD COLUMN "sensorXmm" INTEGER;
ALTER TABLE "shots" ADD COLUMN "sensorYmm" INTEGER;
