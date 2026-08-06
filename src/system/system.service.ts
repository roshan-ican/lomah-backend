import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/common/prisma/prisma.service';

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
      databaseUrl: this.config.get<string>('DATABASE_URL', ''),
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
