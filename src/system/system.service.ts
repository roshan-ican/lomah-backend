import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/common/prisma/prisma.service';
import { resolveDatabaseUrl } from '@/common/runtime-paths';

@Injectable()
export class SystemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async info() {
    const [shooterCount, sessionCount] = await Promise.all([
      this.prisma.shooter.count(),
      this.prisma.session.count(),
    ]);

    return {
      // The resolved URL, not the configured one. This endpoint exists to
      // answer "which database did this build actually open?", and the raw
      // config value is `file:./lomah.db` — a relative path that says nothing
      // about where it landed. Reporting it unresolved would hide precisely
      // the failure this is the fastest way to diagnose: an install that came
      // up against a brand-new empty database somewhere unexpected.
      databaseUrl: resolveDatabaseUrl(this.config.get<string>('DATABASE_URL', '')),
      shooterCount,
      sessionCount,
    };
  }

  async laneSensors() {
    const lanes = await this.prisma.lane.findMany({
      orderBy: { id: 'asc' },
      include: {
        targets: {
          orderBy: { positionIndex: 'asc' },
          select: { id: true, label: true, ipAddress: true, positionIndex: true },
        },
      },
    });

    return lanes
      .filter((l) => l.targets.length > 0)
      .map((l) => ({ laneId: l.id, name: l.name, targets: l.targets }));
  }
}
