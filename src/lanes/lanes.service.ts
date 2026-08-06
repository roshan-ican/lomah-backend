import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { CreateLaneDto } from './dto/create-lane.dto';
import { UpdateLaneDto } from './dto/update-lane.dto';
import { PrismaService } from '@/common/prisma/prisma.service';

@Injectable()
export class LanesService {

  constructor(private readonly prisma: PrismaService) { }

  create(dto: CreateLaneDto) {
    return this.prisma.lane.create({ data: dto })
  }

  findAll() {
    return this.prisma.lane.findMany({ include: { targets: true } });
  }

  async findOne(id: number) {
    const lane = await this.prisma.lane.findUnique({ where: { id }, include: { targets: true, activeTarget: true } });
    if (!lane) {
      // NotFoundException -> 404. A plain `throw new Error` is unhandled and
      // surfaces as a 500 — "the server broke" instead of "no such lane".
      throw new NotFoundException(`Lane ${id} not found`);
    }
    return lane;
  }

  async update(id: number, dto: UpdateLaneDto) {
    await this.findOne(id);
    return this.prisma.lane.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.lane.delete({ where: { id } });
    await this.prisma.$executeRaw`DELETE FROM sqlite_sequence WHERE name = 'lanes'`;
  }

  async setActiveTarget(laneId: number, targetId: string) {
    const target = await this.prisma.target.findUnique({ where: { id: targetId } });
    if (!target) {
      throw new NotFoundException(`Target ${targetId} not found`);
    }
    if (target.laneId !== laneId) {
      // BadRequestException -> 400. This is a genuine client mistake (wrong
      // target id for this lane), not "target doesn't exist" (404) or an
      // unhandled crash (500).
      throw new BadRequestException(
        `Target ${targetId} belongs to lane ${target.laneId}, not lane ${laneId}.`,
      );
    }
    return this.prisma.lane.update({
      where: { id: laneId },
      data: { activeTargetId: targetId },
    });
  }
}
