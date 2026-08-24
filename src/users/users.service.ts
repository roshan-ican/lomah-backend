import { ConflictException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';

import { PrismaService } from '@/common/prisma/prisma.service';

import { CreateAdminDto } from './dto/create-admin.dto';

const UNIQUE_VIOLATION = 'P2002';
const SALT_ROUNDS = 10;

/** What leaves the API. passwordHash must never appear in a response body. */
export interface AdminSummary {
  id: string;
  username: string;
  role: 'SUPER_ADMIN' | 'ADMIN';
  createdAt: Date;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) { }

  async findAll(): Promise<AdminSummary[]> {
    const users = await this.prisma.user.findMany({
      where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, username: true, role: true, createdAt: true }
    });

    return users.map((user) => ({
      ...user,
      role: user.role as AdminSummary['role']
    }));
  }

  async create(dto: CreateAdminDto): Promise<AdminSummary> {
    const existing = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });
    if (existing) {
      throw new ConflictException(`Username "${dto.username}" is already taken`);
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    try {
      const user = await this.prisma.user.create({
        data: {
          username: dto.username,
          passwordHash,
          role: 'ADMIN',
        },
        select: { id: true, username: true, role: true, createdAt: true },
      });

      return { ...user, role: user.role as AdminSummary['role'] };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === UNIQUE_VIOLATION
      ) {
        throw new ConflictException(`Username "${dto.username}" is already taken`);
      }
      throw err;
    }
  }
}
