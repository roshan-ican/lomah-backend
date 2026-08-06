/*
  Warnings:

  - You are about to drop the column `bulletLimit` on the `sessions` table. All the data in the column will be lost.
  - You are about to drop the column `durationSeconds` on the `sessions` table. All the data in the column will be lost.
  - You are about to drop the column `profileType` on the `sessions` table. All the data in the column will be lost.
  - You are about to drop the column `targetId` on the `sessions` table. All the data in the column will be lost.
  - You are about to drop the column `sessionId` on the `shots` table. All the data in the column will be lost.
  - Added the required column `sessionStageId` to the `shots` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "session_stages" (
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
    CONSTRAINT "session_stages_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "targets" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "laneId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "shooterId" TEXT,
    "shooterName" TEXT,
    "totalPausedMs" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "feedback" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "reviewedAt" DATETIME,
    CONSTRAINT "sessions_laneId_fkey" FOREIGN KEY ("laneId") REFERENCES "lanes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "sessions_shooterId_fkey" FOREIGN KEY ("shooterId") REFERENCES "shooters" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_sessions" ("createdAt", "createdBy", "endedAt", "feedback", "id", "laneId", "notes", "reviewedAt", "shooterId", "shooterName", "startedAt", "status", "totalPausedMs") SELECT "createdAt", "createdBy", "endedAt", "feedback", "id", "laneId", "notes", "reviewedAt", "shooterId", "shooterName", "startedAt", "status", "totalPausedMs" FROM "sessions";
DROP TABLE "sessions";
ALTER TABLE "new_sessions" RENAME TO "sessions";
CREATE INDEX "sessions_laneId_status_idx" ON "sessions"("laneId", "status");
CREATE TABLE "new_shots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionStageId" TEXT NOT NULL,
    "shotNumber" INTEGER NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "isMiss" BOOLEAN NOT NULL DEFAULT false,
    "firedAt" DATETIME NOT NULL,
    CONSTRAINT "shots_sessionStageId_fkey" FOREIGN KEY ("sessionStageId") REFERENCES "session_stages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_shots" ("firedAt", "id", "isMiss", "score", "shotNumber", "x", "y") SELECT "firedAt", "id", "isMiss", "score", "shotNumber", "x", "y" FROM "shots";
DROP TABLE "shots";
ALTER TABLE "new_shots" RENAME TO "shots";
CREATE INDEX "shots_sessionStageId_idx" ON "shots"("sessionStageId");
CREATE UNIQUE INDEX "shots_sessionStageId_shotNumber_key" ON "shots"("sessionStageId", "shotNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "session_stages_targetId_idx" ON "session_stages"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "session_stages_sessionId_order_key" ON "session_stages"("sessionId", "order");
