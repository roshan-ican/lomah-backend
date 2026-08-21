-- CreateTable
CREATE TABLE "lane_schedules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerAdminId" TEXT NOT NULL,
    "laneId" INTEGER NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "endsAt" DATETIME NOT NULL,
    "cancelledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "lane_schedules_ownerAdminId_fkey" FOREIGN KEY ("ownerAdminId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "lane_schedules_laneId_fkey" FOREIGN KEY ("laneId") REFERENCES "lanes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "lane_schedule_attendees" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheduleId" TEXT NOT NULL,
    "shooterId" TEXT,
    "displayName" TEXT NOT NULL,
    "identitySource" TEXT NOT NULL,
    "externalProvider" TEXT,
    "externalId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lane_schedule_attendees_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "lane_schedules" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "lane_schedule_attendees_shooterId_fkey" FOREIGN KEY ("shooterId") REFERENCES "shooters" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "lane_schedules_laneId_startsAt_endsAt_idx" ON "lane_schedules"("laneId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "lane_schedules_ownerAdminId_startsAt_idx" ON "lane_schedules"("ownerAdminId", "startsAt");

-- CreateIndex
CREATE INDEX "lane_schedule_attendees_scheduleId_idx" ON "lane_schedule_attendees"("scheduleId");

-- CreateIndex
CREATE INDEX "lane_schedule_attendees_shooterId_idx" ON "lane_schedule_attendees"("shooterId");
