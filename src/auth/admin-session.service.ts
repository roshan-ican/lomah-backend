import { ConflictException, Injectable } from '@nestjs/common';

interface ActiveAdminSession {
  userId: string;
  username: string;
  since: Date;
}

const MAX_SESSION_AGE_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class AdminSessionService {
  private active: ActiveAdminSession | null = null;

  claim(userId: string, username: string): void {
    if (this.active && this.active.userId !== userId && !this.isStale()) {
      throw new ConflictException(
        `Admin "${this.active.username}" is already active. Only one admin can run the console at a time.`,
      );
    }
    this.active = { userId, username, since: new Date() };
  }

  release(userId: string): void {
    if (this.active?.userId === userId) {
      this.active = null;
    }
  }

  current(): ActiveAdminSession | null {
    return this.isStale() ? null : this.active;
  }

  private isStale(): boolean {
    if (!this.active) return true;
    return Date.now() - this.active.since.getTime() > MAX_SESSION_AGE_MS;
  }
}
