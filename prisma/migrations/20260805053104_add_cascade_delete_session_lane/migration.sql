-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "laneId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "shooterId" TEXT,
    "shooterName" TEXT,
    "pausedAt" DATETIME,
    "totalPausedMs" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "feedback" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "reviewedAt" DATETIME,
    CONSTRAINT "sessions_laneId_fkey" FOREIGN KEY ("laneId") REFERENCES "lanes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "sessions_shooterId_fkey" FOREIGN KEY ("shooterId") REFERENCES "shooters" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_sessions" ("createdAt", "createdBy", "endedAt", "feedback", "id", "laneId", "notes", "pausedAt", "reviewedAt", "shooterId", "shooterName", "startedAt", "status", "totalPausedMs") SELECT "createdAt", "createdBy", "endedAt", "feedback", "id", "laneId", "notes", "pausedAt", "reviewedAt", "shooterId", "shooterName", "startedAt", "status", "totalPausedMs" FROM "sessions";
DROP TABLE "sessions";
ALTER TABLE "new_sessions" RENAME TO "sessions";
CREATE INDEX "sessions_laneId_status_idx" ON "sessions"("laneId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
