import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '@/common/prisma/prisma.service';
import type { JwtPayload } from '@/auth/auth.service';

import { CreateShooterDto } from './dto/create-shooter.dto';
import { UpdateShooterDto } from './dto/update-shooter.dto';

/** Prisma's code for "a unique constraint was violated". */
const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class ShootersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(actor: JwtPayload, dto: CreateShooterDto) {
    try {
      return await this.prisma.shooter.create({
        data: { ...dto, ownerAdminId: actor.sub },
      });
    } catch (err) {
      throw this.translate(err, dto);
    }
  }

  findAll(actor: JwtPayload) {
    return this.prisma.shooter.findMany({
      where: this.ownerScope(actor),
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string, actor: JwtPayload) {
    const shooter = await this.prisma.shooter.findFirst({
      where: { id, ...this.ownerScope(actor) },
      include: {
        sessions: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            laneId: true,
            status: true,
            createdAt: true,
            startedAt: true,
            endedAt: true,
          },
        },
      },
    });
    if (!shooter) {
      throw new NotFoundException(`Shooter ${id} not found`);
    }
    return shooter;
  }

  async update(id: string, actor: JwtPayload, dto: UpdateShooterDto) {
    await this.findOne(id, actor);
    try {
      return await this.prisma.shooter.update({ where: { id }, data: dto });
    } catch (err) {
      throw this.translate(err, dto);
    }
  }

  /**
   * Sessions reference a shooter, and that reference is the record of who fired
   * a relay. Deleting a shooter with history would either orphan those sessions
   * or cascade away real scorecards, so it is refused — the roster is
   * append-mostly by design.
   */
  async remove(id: string, actor: JwtPayload) {
    await this.findOne(id, actor);

    const sessionCount = await this.prisma.session.count({
      where: { shooterId: id },
    });
    if (sessionCount > 0) {
      throw new BadRequestException(
        `Shooter ${id} has ${sessionCount} recorded session(s) and cannot be deleted.`,
      );
    }

    return this.prisma.shooter.delete({ where: { id } });
  }


  private ownerScope(actor: JwtPayload) {
    return actor.role === 'SUPER_ADMIN' ? {} : { ownerAdminId: actor.sub };
  }


  private translate(
    err: unknown,
    dto: CreateShooterDto | UpdateShooterDto,
  ): Error {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === UNIQUE_VIOLATION
    ) {
      const fields = (err.meta?.target as string[] | undefined) ?? [];
      if (fields.includes('badgeNumber')) {
        return new BadRequestException(
          `Badge number "${dto.badgeNumber}" is already assigned to another shooter.`,
        );
      }
      if (fields.includes('name')) {
        return new BadRequestException(
          `A shooter named "${dto.name}" already exists.`,
        );
      }
      return new BadRequestException('That shooter already exists.');
    }
    return err as Error;
  }
}
