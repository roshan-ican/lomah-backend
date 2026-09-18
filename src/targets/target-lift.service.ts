import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';

export type LiftPosition = 'UP' | 'DOWN' | 'UNKNOWN';

export interface LiftState {
  position: LiftPosition;
  d1: boolean;
  d2: boolean;
}

const LIFT_TIMEOUT_MS = 2500;

const WANTED: Record<'UP' | 'DOWN', { d1: boolean; d2: boolean }> = {
  UP: { d1: false, d2: false },
  DOWN: { d1: false, d2: true },
};

@Injectable()
export class TargetLiftService {
  private readonly logger = new Logger(TargetLiftService.name);

  constructor(private readonly prisma: PrismaService) {}

  private readonly queues = new Map<string, Promise<unknown>>();

  async status(id: string): Promise<LiftState> {
    const ip = await this.ipOf(id);
    return this.serial(ip, () => this.read(ip));
  }

  async move(id: string, to: 'UP' | 'DOWN'): Promise<LiftState> {
    const ip = await this.ipOf(id);
    return this.serial(ip, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.applyOnce(ip, to);
        const after = await this.waitFor(ip, to);
        if (after.position === to) {
          this.logger.log(`Target ${ip} → ${to}`);
          return after;
        }
      }
      throw new BadGatewayException(`Target ${ip} did not move ${to.toLowerCase()}`);
    });
  }

  private serial<T>(ip: string, job: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(ip) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(job);
    this.queues.set(ip, run);
    void run.finally(() => {
      if (this.queues.get(ip) === run) this.queues.delete(ip);
    }).catch(() => undefined);
    return run;
  }

  private async applyOnce(ip: string, to: 'UP' | 'DOWN') {
    const want = WANTED[to];
    const now = await this.read(ip);
    if (now.d1 !== want.d1) await this.call(ip, '/toggle?pin=1');
    if (now.d2 !== want.d2) await this.call(ip, '/toggle?pin=2');
  }

  private async waitFor(ip: string, to: 'UP' | 'DOWN'): Promise<LiftState> {
    let state = await this.read(ip);
    for (let i = 0; i < 3 && state.position !== to; i++) {
      await new Promise((r) => setTimeout(r, 150));
      state = await this.read(ip);
    }
    return state;
  }

  async moveAll(to: 'UP' | 'DOWN') {
    const targets = await this.prisma.target.findMany({
      select: { id: true, label: true },
    });
    const results = await Promise.allSettled(
      targets.map((t) => this.move(t.id, to)),
    );
    const failed = targets
      .filter((_, i) => results[i].status === 'rejected')
      .map((t) => t.label);
    return { total: targets.length, moved: targets.length - failed.length, failed };
  }

  private async ipOf(id: string): Promise<string> {
    const target = await this.prisma.target.findUnique({
      where: { id },
      select: { ipAddress: true },
    });
    if (!target) throw new NotFoundException(`Target ${id} not found`);
    return target.ipAddress;
  }

  private async read(ip: string): Promise<LiftState> {
    const res = await this.call(ip, '/gpio_status');
    const body = (await res.json()) as { d1?: unknown; d2?: unknown };
    const d1 = Boolean(body.d1);
    const d2 = Boolean(body.d2);
    const position: LiftPosition =
      !d1 && !d2 ? 'UP' : !d1 && d2 ? 'DOWN' : 'UNKNOWN';
    return { position, d1, d2 };
  }

  private async call(ip: string, path: string): Promise<Response> {
    try {
      const res = await fetch(`http://${ip}${path}`, {
        signal: AbortSignal.timeout(LIFT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      throw new BadGatewayException(
        `Target ${ip} unreachable: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
