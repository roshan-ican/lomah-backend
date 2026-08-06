import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';

export interface ConnectedShooter {
  key: string;
  ip: string;
  deviceId: string | null;
  laneId: number | null;
  connectedAt: Date;
}

@Injectable()
export class ConnectedShootersService {
  private readonly connections = new Map<string, ConnectedShooter>();

  constructor(private readonly prisma: PrismaService) {}

  async connect(ip: string, deviceId?: string): Promise<ConnectedShooter> {
    const normalizedIp = ip.replace(/^.*:/, '').trim();
    const key = deviceId ?? normalizedIp;

    // Only devices that identify themselves get a persisted binding — an
    // IP-only tablet forgets its lane the moment it reconnects from a new
    // DHCP lease, same limitation the old ip-to-lane-map had.
    //
    // But within the SAME lease, this is also the heartbeat the shooter polls
    // every ~10s to notice a reassignment (see ShooterWait.tsx). An IP-only
    // device has no ClientDevice row to read back, so without this it would
    // reconnect here with laneId forced to null on every poll — wiping out
    // whatever `assign()` had just set in memory before the shooter's next
    // tick could ever see it.
    let laneId: number | null = this.connections.get(key)?.laneId ?? null;
    if (deviceId) {
      const device = await this.prisma.clientDevice.upsert({
        where: { deviceId },
        update: { lastIp: normalizedIp, lastSeen: new Date() },
        create: { deviceId, lastIp: normalizedIp, lastSeen: new Date() },
      });
      laneId = device.laneId;
    }

    const entry: ConnectedShooter = {
      key,
      ip: normalizedIp,
      deviceId: deviceId ?? null,
      laneId,
      connectedAt: new Date(),
    };
    this.connections.set(key, entry);
    return entry;
  }

  list(): ConnectedShooter[] {
    return Array.from(this.connections.values());
  }


  async assign(
    key: string,
    laneId: number | null,
  ): Promise<ConnectedShooter> {
    const entry = this.connections.get(key);
    if (!entry) {
      throw new NotFoundException(
        `No connected device "${key}" — it may have gone stale.`,
      );
    }

    if (laneId !== null) {
      await this.releaseLane(laneId, key);
    }

    entry.laneId = laneId;
    this.connections.set(key, entry);

    if (entry.deviceId) {
      await this.prisma.clientDevice.upsert({
        where: { deviceId: entry.deviceId },
        update: { laneId, lastIp: entry.ip },
        create: { deviceId: entry.deviceId, laneId, lastIp: entry.ip },
      });
    }

    return entry;
  }


  private async releaseLane(laneId: number, keepKey: string): Promise<void> {
    for (const [otherKey, other] of this.connections) {
      if (otherKey === keepKey || other.laneId !== laneId) continue;
      other.laneId = null;
      this.connections.set(otherKey, other);
    }

    // Spelled out rather than leaning on `{ not: undefined }`, which Prisma
    // strips to "no condition" — correct here by accident, and only by
    // accident. A keeper with no deviceId has no ClientDevice row at all, so
    // every row on this lane belongs to somebody else.
    const keeperDeviceId = this.connections.get(keepKey)?.deviceId ?? null;
    await this.prisma.clientDevice.updateMany({
      where: keeperDeviceId
        ? { laneId, deviceId: { not: keeperDeviceId } }
        : { laneId },
      data: { laneId: null },
    });
  }
}
