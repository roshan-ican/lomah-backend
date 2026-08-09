-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_session_stages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "bulletLimit" INTEGER NOT NULL DEFAULT 0,
    "durationSeconds" INTEGER NOT NULL DEFAULT 600,
    "profileType" TEXT NOT NULL DEFAULT 'FIGURE',
    CONSTRAINT "session_stages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "session_stages_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "targets" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_session_stages" ("bulletLimit", "durationSeconds", "endedAt", "id", "order", "profileType", "sessionId", "startedAt", "status", "targetId") SELECT "bulletLimit", "durationSeconds", "endedAt", "id", "order", "profileType", "sessionId", "startedAt", "status", "targetId" FROM "session_stages";
DROP TABLE "session_stages";
ALTER TABLE "new_session_stages" RENAME TO "session_stages";
CREATE INDEX "session_stages_targetId_idx" ON "session_stages"("targetId");
CREATE UNIQUE INDEX "session_stages_sessionId_order_key" ON "session_stages"("sessionId", "order");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
