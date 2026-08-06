-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_targets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "laneId" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "distanceM" INTEGER NOT NULL,
    "positionIndex" INTEGER NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "deviceId" TEXT,
    "offsetXmm" INTEGER NOT NULL DEFAULT 0,
    "offsetYmm" INTEGER NOT NULL DEFAULT 0,
    "profileType" TEXT NOT NULL DEFAULT 'FIGURE',
    "lastSeenAt" DATETIME,
    "rssi" INTEGER,
    "firmwareVersion" TEXT NOT NULL DEFAULT 'LOMAH Dev Board v0.1',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "targets_laneId_fkey" FOREIGN KEY ("laneId") REFERENCES "lanes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_targets" ("createdAt", "deviceId", "distanceM", "firmwareVersion", "id", "ipAddress", "label", "laneId", "lastSeenAt", "offsetXmm", "offsetYmm", "positionIndex", "profileType", "rssi", "updatedAt") SELECT "createdAt", "deviceId", "distanceM", coalesce("firmwareVersion", 'LOMAH Dev Board v0.1') AS "firmwareVersion", "id", "ipAddress", "label", "laneId", "lastSeenAt", "offsetXmm", "offsetYmm", "positionIndex", "profileType", "rssi", "updatedAt" FROM "targets";
DROP TABLE "targets";
ALTER TABLE "new_targets" RENAME TO "targets";
CREATE UNIQUE INDEX "targets_ipAddress_key" ON "targets"("ipAddress");
CREATE UNIQUE INDEX "targets_deviceId_key" ON "targets"("deviceId");
CREATE INDEX "targets_laneId_idx" ON "targets"("laneId");
CREATE UNIQUE INDEX "targets_laneId_positionIndex_key" ON "targets"("laneId", "positionIndex");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
