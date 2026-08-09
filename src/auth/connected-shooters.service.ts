import { Injectable, NotFoundException } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import { PrismaService } from '@/common/prisma/prisma.service';

export interface ConnectedShooter {
  key: string;
  ip: string;
  deviceId: string | null;
  laneId: number | null;
  connectedAt: Date;
}

/** A device's lane binding changed. `laneId: null` means it was released. */
export interface DeviceAssignmentEvent {
  key: string;
  laneId: number | null;
}
@Injectable()
export class ConnectedShootersService {
  private readonly connections = new Map<string, ConnectedShooter>();

  private readonly assignments = new Subject<DeviceAssignmentEvent>();
  readonly assignments$: Observable<DeviceAssignmentEvent> =
    this.assignments.asObservable();

  constructor(private readonly prisma: PrismaService) {}

  async connect(ip: string, deviceId?: string): Promise<ConnectedShooter> {
    const normalizedIp = ip.replace(/^.*:/, '').trim();
    const key = deviceId ?? normalizedIp;

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

    this.assignments.next({ key, laneId });

    return entry;
  }


  private async releaseLane(laneId: number, keepKey: string): Promise<void> {
    const bumped: string[] = [];
    for (const [otherKey, other] of this.connections) {
      if (otherKey === keepKey || other.laneId !== laneId) continue;
      other.laneId = null;
      this.connections.set(otherKey, other);
      bumped.push(otherKey);
    }

    const keeperDeviceId = this.connections.get(keepKey)?.deviceId ?? null;
    await this.prisma.clientDevice.updateMany({
      where: keeperDeviceId
        ? { laneId, deviceId: { not: keeperDeviceId } }
        : { laneId },
      data: { laneId: null },
    });

    for (const key of bumped) {
      this.assignments.next({ key, laneId: null });
    }
  }
}
