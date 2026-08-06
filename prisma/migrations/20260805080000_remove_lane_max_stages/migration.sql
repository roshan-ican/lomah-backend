-- The maxStages commissioning cap is being removed: a session plan may use
-- every target commissioned on the lane, no SUPER_ADMIN-imposed limit.
ALTER TABLE "lanes" DROP COLUMN "maxStages";
