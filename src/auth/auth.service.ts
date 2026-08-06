import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import type { User, UserRole } from '@prisma/client';

import { PrismaService } from '@/common/prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { AdminSessionService } from './admin-session.service';

export interface JwtPayload {
  sub: string;
  username: string;
  role: UserRole;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly adminSession: AdminSessionService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.authenticate(dto.username, dto.password);

    // SUPER_ADMIN is exempt — commissioning is a one-time, brief visit, not
    // the day-to-day console this lock protects.
    if (user.role === 'ADMIN') {
      this.adminSession.claim(user.id, user.username);
    }

    return this.issueSession(user);
  }

  logout(userId: string): void {
    this.adminSession.release(userId);
  }

  private async authenticate(username: string, password: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { username } });

    // Same error for "no such user" and "wrong password", and no early return
    // before hashing either way. A distinct message (or a fast path that
    // skips the bcrypt compare when the user doesn't exist) tells an attacker
    // which usernames are real by how the response differs.
    if (!user) throw new UnauthorizedException('Invalid username or password');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid username or password');

    return user;
  }

  private async issueSession(user: User) {
    const payload: JwtPayload = { sub: user.id, username: user.username, role: user.role };

    return {
      accessToken: await this.jwt.signAsync(payload),
      user: { id: user.id, username: user.username, role: user.role },
    };
  }
}
