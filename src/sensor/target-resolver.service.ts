import { Injectable, Logger } from '@nestjs/common';
import type { Target } from '@prisma/client';

import { PrismaService } from '@/common/prisma/prisma.service';
import { normalizeIp } from '@/transport/target-transport.interface';

/**
 * Answers the only question attribution actually asks: which target sent this?
 *
 * The 9-byte frame is full — there is no field for a lane or a device id (see
 * frame.codec.ts). A target's identity therefore has to be recovered from HOW
 * the frame arrived: its source IP. That makes this lookup the hinge the entire
 * ingestion path turns on.
 *
 * It is also the hot path — one lookup per bullet, per target, under sustained
 * fire — so it is cached in memory rather than hitting Prisma per frame.
 */
@Injectable()
export class TargetResolver {
  private readonly logger = new Logger(TargetResolver.name);

  private readonly bySourceKey = new Map<string, Target>();
  /** Source keys already logged as unknown, so a stray board on the network
   *  produces one line rather than one line per bullet. */
  private readonly warned = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  async resolve(sourceKey: string): Promise<Target | null> {
    const key = normalizeIp(sourceKey);

    const cached = this.bySourceKey.get(key);
    if (cached) return cached;

    const target = await this.prisma.target.findUnique({
      where: { ipAddress: key },
    });

    if (!target) {
      // Not an error. Anything else on the range LAN can send us a datagram,
      // and an unprovisioned board will. Drop it, but never throw — one stray
      // packet must not take ingestion down for every lane.
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.logger.warn(
          `Frame from unknown source ${key} — no target bound to that IP. Ignoring further frames from it.`,
        );
      }
      return null;
    }

    this.bySourceKey.set(key, target);
    return target;
  }

  /**
   * Drop cached entries. Must be called whenever a target's ipAddress changes
   * or a target is deleted, otherwise frames keep resolving to a stale row —
   * the failure mode being shots attributed to the wrong target after a board
   * swap, which is silent and unrecoverable after the fact.
   */
  invalidate(sourceKey?: string): void {
    if (sourceKey) {
      const key = normalizeIp(sourceKey);
      this.bySourceKey.delete(key);
      this.warned.delete(key);
      return;
    }
    this.bySourceKey.clear();
    this.warned.clear();
  }
}
