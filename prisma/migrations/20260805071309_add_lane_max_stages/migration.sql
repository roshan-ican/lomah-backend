-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_lanes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "siteName" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "maxStages" INTEGER NOT NULL DEFAULT 0,
    "activeTargetId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "lanes_activeTargetId_fkey" FOREIGN KEY ("activeTargetId") REFERENCES "targets" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_lanes" ("activeTargetId", "createdAt", "id", "name", "siteName", "status", "updatedAt") SELECT "activeTargetId", "createdAt", "id", "name", "siteName", "status", "updatedAt" FROM "lanes";
DROP TABLE "lanes";
ALTER TABLE "new_lanes" RENAME TO "lanes";
CREATE UNIQUE INDEX "lanes_activeTargetId_key" ON "lanes"("activeTargetId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
