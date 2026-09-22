-- Officer-saved sensitivity defaults per target, restored by Reset.
ALTER TABLE "targets" ADD COLUMN "sensitivityDefaults" JSONB;
