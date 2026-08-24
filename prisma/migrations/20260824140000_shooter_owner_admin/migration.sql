-- Shooter rosters become private to the admin who enrolled them.
--
-- SQLite cannot drop a unique index that a column carries as a constraint, and
-- the old global uniqueness on "name"/"badgeNumber" has to go: kept, one
-- admin's roster would reject a name held by another admin's shooter that they
-- cannot see. So this is the create-copy-drop-rename dance.
--
-- Existing shooters predate ownership. They go to the oldest ADMIN account,
-- which on every range built so far is the seeded `admin`. The COALESCE is not
-- decoration: "ownerAdminId" is NOT NULL, and a hardened range whose default
-- admin was deleted has no ADMIN row at all — the subquery would return NULL
-- and abort the migration midway through a table swap.

PRAGMA foreign_keys=OFF;

CREATE TABLE "new_shooters" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerAdminId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rank" TEXT,
    "badgeNumber" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shooters_ownerAdminId_fkey" FOREIGN KEY ("ownerAdminId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_shooters" ("id", "ownerAdminId", "name", "rank", "badgeNumber", "createdAt")
SELECT
    s."id",
    COALESCE(
      (SELECT u."id" FROM "users" u WHERE u."role" = 'ADMIN'       ORDER BY u."createdAt" ASC LIMIT 1),
      (SELECT u."id" FROM "users" u WHERE u."role" = 'SUPER_ADMIN' ORDER BY u."createdAt" ASC LIMIT 1)
    ),
    s."name",
    s."rank",
    s."badgeNumber",
    s."createdAt"
FROM "shooters" s;

DROP TABLE "shooters";
ALTER TABLE "new_shooters" RENAME TO "shooters";

-- Ids are preserved by the copy above, so the foreign keys pointing here from
-- "sessions" and "lane_schedule_attendees" still resolve.
CREATE UNIQUE INDEX "shooters_ownerAdminId_name_key" ON "shooters"("ownerAdminId", "name");
CREATE UNIQUE INDEX "shooters_ownerAdminId_badgeNumber_key" ON "shooters"("ownerAdminId", "badgeNumber");
CREATE INDEX "shooters_ownerAdminId_idx" ON "shooters"("ownerAdminId");

PRAGMA foreign_keys=ON;
