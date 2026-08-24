// Cover for what account creation must never get wrong: a plaintext password
// reaching the database, a duplicate username escaping as a raw Prisma error,
// and this endpoint minting a second SUPER_ADMIN.

import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UsersService } from './users.service';

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      // Honours `select` the way real Prisma does — an over-generous stub
      // would report a passwordHash leak whether or not one is real.
      create: vi.fn().mockImplementation(({ data, select }: any) => {
        const row: Record<string, unknown> = {
          id: 'user-1',
          username: data.username,
          role: data.role,
          passwordHash: data.passwordHash,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        };
        if (!select) return Promise.resolve(row);

        const projected: Record<string, unknown> = {};
        for (const key of Object.keys(select)) {
          if (select[key]) projected[key] = row[key];
        }
        return Promise.resolve(projected);
      }),
      ...overrides,
    },
  } as any;
}

describe('UsersService.create', () => {
  let prisma: any;
  let service: UsersService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new UsersService(prisma);
  });

  it('stores a bcrypt hash, never the plaintext password', async () => {
    await service.create({ username: 'range2', password: 'correcthorse' });

    const { passwordHash } = prisma.user.create.mock.calls[0][0].data;
    expect(passwordHash).not.toBe('correcthorse');
    expect(await bcrypt.compare('correcthorse', passwordHash)).toBe(true);
  });

  it('creates the account as ADMIN', async () => {
    await service.create({ username: 'range2', password: 'correcthorse' });

    expect(prisma.user.create.mock.calls[0][0].data.role).toBe('ADMIN');
  });

  it('never creates a second SUPER_ADMIN, whatever the caller sends', async () => {
    await service.create({
      username: 'second-super',
      password: 'correcthorse',
      role: 'SUPER_ADMIN',
    } as any);

    expect(prisma.user.create.mock.calls[0][0].data.role).toBe('ADMIN');
  });

  it('never returns the password hash', async () => {
    const created = await service.create({
      username: 'range2',
      password: 'correcthorse',
    });

    expect(created).not.toHaveProperty('passwordHash');
    expect(created).toMatchObject({ username: 'range2', role: 'ADMIN' });
  });

  it('rejects a username that already exists', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'existing' });

    await expect(
      service.create({ username: 'admin', password: 'correcthorse' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('translates a racing unique-constraint violation into a conflict', async () => {
    prisma.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.create({ username: 'admin', password: 'correcthorse' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('UsersService.findAll', () => {
  it('lists only admin roles, oldest first, without hashes', async () => {
    const prisma = makePrisma();
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        username: 'superadmin',
        role: 'SUPER_ADMIN',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const rows = await new UsersService(prisma).findAll();

    const args = prisma.user.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ role: { in: ['SUPER_ADMIN', 'ADMIN'] } });
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
    expect(args.select.passwordHash).toBeUndefined();
    expect(rows[0]).not.toHaveProperty('passwordHash');
  });
});
