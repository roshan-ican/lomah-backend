-- CreateTable
CREATE TABLE "lanes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "siteName" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "activeTargetId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "lanes_activeTargetId_fkey" FOREIGN KEY ("activeTargetId") REFERENCES "targets" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "targets" (
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
    "firmwareVersion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "targets_laneId_fkey" FOREIGN KEY ("laneId") REFERENCES "lanes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "laneId" INTEGER NOT NULL,
    "targetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "shooterId" TEXT,
    "shooterName" TEXT,
    "profileType" TEXT NOT NULL DEFAULT 'FIGURE',
    "bulletLimit" INTEGER NOT NULL DEFAULT 0,
    "durationSeconds" INTEGER NOT NULL DEFAULT 600,
    "totalPausedMs" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "feedback" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "reviewedAt" DATETIME,
    CONSTRAINT "sessions_laneId_fkey" FOREIGN KEY ("laneId") REFERENCES "lanes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "sessions_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "targets" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "sessions_shooterId_fkey" FOREIGN KEY ("shooterId") REFERENCES "shooters" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "shots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "shotNumber" INTEGER NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "isMiss" BOOLEAN NOT NULL DEFAULT false,
    "firedAt" DATETIME NOT NULL,
    CONSTRAINT "shots_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "shooters" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "rank" TEXT,
    "badgeNumber" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ADMIN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "client_devices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "laneId" INTEGER,
    "label" TEXT,
    "lastIp" TEXT,
    "lastSeen" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "lanes_activeTargetId_key" ON "lanes"("activeTargetId");

-- CreateIndex
CREATE UNIQUE INDEX "targets_ipAddress_key" ON "targets"("ipAddress");

-- CreateIndex
CREATE UNIQUE INDEX "targets_deviceId_key" ON "targets"("deviceId");

-- CreateIndex
CREATE INDEX "targets_laneId_idx" ON "targets"("laneId");

-- CreateIndex
CREATE UNIQUE INDEX "targets_laneId_positionIndex_key" ON "targets"("laneId", "positionIndex");

-- CreateIndex
CREATE INDEX "sessions_laneId_status_idx" ON "sessions"("laneId", "status");

-- CreateIndex
CREATE INDEX "shots_sessionId_idx" ON "shots"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "shots_sessionId_shotNumber_key" ON "shots"("sessionId", "shotNumber");

-- CreateIndex
CREATE UNIQUE INDEX "shooters_name_key" ON "shooters"("name");

-- CreateIndex
CREATE UNIQUE INDEX "shooters_badgeNumber_key" ON "shooters"("badgeNumber");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "client_devices_deviceId_key" ON "client_devices"("deviceId");
