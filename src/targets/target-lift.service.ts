import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';

export type LiftPosition = 'UP' | 'DOWN';

export interface LiftState {
  position: LiftPosition;
  /** Pin 2 is the only control line. Pin 1 is forced off and never set. */
  d2: boolean;
}

// One board was measured stalling 2.54s on a lost packet. The old 2500ms
// turned that into a spurious "target unreachable", so give it headroom.
const HTTP_TIMEOUT_MS = 4000;

// How long the lift takes to finish travelling. The background check waits
// this long before reading, so it never sees a target mid-travel and "fixes"
// it with another toggle. MEASURE THIS on the slowest target and set it to
// comfortably more than the real figure — too long is harmless, too short
// risks a spurious resend.
const TRAVEL_MS = 1500;

@Injectable()
export class TargetLiftService implements OnModuleInit {
  private readonly logger = new Logger(TargetLiftService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Last position seen per board, refreshed by every read.
   *
   * Commands are planned from this rather than from a fresh status read.
   * Reading first meant every toggle waited on the slowest board's round trip
   * (100-300ms each, sometimes seconds) before anything moved.
   */
  private readonly lastKnown = new Map<string, LiftState>();

  // Bumped per board on every command so an older verifier never undoes a newer one.
  private readonly commandVersion = new Map<string, number>();

  async onModuleInit(): Promise<void> {
    const targets = await this.prisma.target.findMany({
      select: { label: true, ipAddress: true },
    });
    const results = await Promise.allSettled(
      targets.map(async (t) => {
        const started = performance.now();
        const state = await this.read(t.ipAddress);
        this.logger.log(
          `Warm ${t.label} (${t.ipAddress}) -> ${state.position} in ${(performance.now() - started).toFixed(1)}ms`,
        );
      }),
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.logger.warn(`Could not warm ${targets[i].label} (${targets[i].ipAddress})`);
      }
    });
  }

  // ---------------------------------------------------------------- reading

  /**
   * One target, for a single switch. Falls back to cache when the board does
   * not answer, so a dropped packet never blanks the UI.
   */
  async status(id: string): Promise<LiftState> {
    const ip = await this.ipOf(id);
    try {
      return await this.read(ip);
    } catch (err) {
      const cached = this.lastKnown.get(ip);
      if (cached) return cached;
      throw err;
    }
  }

  /** Every target at once, for the dashboard's on-render status check. */
  async statusAll() {
    const targets = await this.prisma.target.findMany({
      select: { id: true, label: true, ipAddress: true },
    });
    const states = await Promise.allSettled(
      targets.map((t) => this.read(t.ipAddress)),
    );
    return targets.map((t, i) => {
      const r = states[i];
      const state =
        r.status === 'fulfilled'
          ? r.value
          : (this.lastKnown.get(t.ipAddress) ?? null);
      return {
        id: t.id,
        label: t.label,
        position: state?.position ?? null,
        online: r.status === 'fulfilled',
      };
    });
  }

  private async read(ip: string): Promise<LiftState> {
    const res = await this.call(ip, '/gpio_status');
    const body = (await res.json()) as { d1?: unknown; d2?: unknown };
    const d2 = Boolean(body.d2);

    // Pin 1 is not one of our control lines, but energising it also pulls the
    // target down. Left on, it would hold the target down while pin 2 reads
    // "up" — the app would show the wrong position and be unable to fix it.
    // So clear it on sight and never set it again.
    if (Boolean(body.d1)) {
      this.logger.warn(`Target ${ip}: pin 1 was on — forcing it off`);
      await this.call(ip, '/toggle?pin=1');
    }

    const state: LiftState = { position: d2 ? 'DOWN' : 'UP', d2 };
    this.lastKnown.set(ip, state);
    return state;
  }

  // ----------------------------------------------------------------- moving

  async move(id: string, to: LiftPosition): Promise<LiftState> {
    const ip = await this.ipOf(id);

    const known = this.lastKnown.get(ip) ?? (await this.read(ip));
    if (known.position === to) return known;

    await this.call(ip, '/toggle?pin=2');
    const state: LiftState = { position: to, d2: to === 'DOWN' };
    this.lastKnown.set(ip, state);

    this.verifyLater({ label: ip, ipAddress: ip }, to, this.nextVersion(ip));
    return state;
  }

  async moveAll(to: LiftPosition) {
    const targets = await this.prisma.target.findMany({
      select: { id: true, label: true, ipAddress: true },
    });
    const t0 = performance.now();

    const already: string[] = [];
    const failed: string[] = [];
    const failedIds: string[] = [];
    let moved = 0;

    // Every board runs independently. Known boards toggle immediately; a board
    // with no cached state reads first, since toggling blind could send it the
    // wrong way — but that read only delays that one board.
    await Promise.all(
      targets.map(async (t) => {
        try {
          const known =
            this.lastKnown.get(t.ipAddress) ?? (await this.read(t.ipAddress));
          if (known.position === to) {
            already.push(t.label);
            return;
          }
          const started = performance.now();
          await this.call(t.ipAddress, '/toggle?pin=2');
          this.logger.debug(
            `${t.label} toggle ${(performance.now() - started).toFixed(1)}ms`,
          );
          this.lastKnown.set(t.ipAddress, { position: to, d2: to === 'DOWN' });
          this.verifyLater(t, to, this.nextVersion(t.ipAddress));
          moved++;
        } catch (err) {
          failed.push(t.label);
          failedIds.push(t.id);
          this.logger.warn(`Target ${t.label} toggle failed: ${err}`);
        }
      }),
    );

    this.logger.log(
      `lift-all ${to}: ${(performance.now() - t0).toFixed(1)}ms — ` +
        `moved=${moved} already=${already.length} failed=${failed.length}`,
    );

    return { total: targets.length, moved, already, failed, failedIds };
  }

  // ------------------------------------------------------- background check

  /**
   * Confirms the targets reached where they were told to go, and resends once
   * if not. Runs after the UI has been answered, so a slow or lost status read
   * costs nothing visible.
   */
  private verifyLater(
    target: { label: string; ipAddress: string },
    to: LiftPosition,
    version: number,
  ): void {
    setTimeout(() => {
      void this.verify(target, to, version).catch(() => undefined);
    }, TRAVEL_MS);
  }

  private nextVersion(ip: string): number {
    const version = (this.commandVersion.get(ip) ?? 0) + 1;
    this.commandVersion.set(ip, version);
    return version;
  }

  private isCurrent(ip: string, version: number): boolean {
    return this.commandVersion.get(ip) === version;
  }

  private async verify(
    t: { label: string; ipAddress: string },
    to: LiftPosition,
    version: number,
  ): Promise<void> {
    try {
      if (!this.isCurrent(t.ipAddress, version)) return;
      let state = await this.read(t.ipAddress);
      if (state.position === to || !this.isCurrent(t.ipAddress, version)) return;

      // One more travel window before concluding it is wrong. A slow target
      // reading "not there yet" is not the same as one that never got the
      // command, and resending on the former reverses it mid-travel.
      await new Promise((r) => setTimeout(r, TRAVEL_MS));
      if (!this.isCurrent(t.ipAddress, version)) return;
      state = await this.read(t.ipAddress);
      if (state.position === to || !this.isCurrent(t.ipAddress, version)) return;

      this.logger.warn(
        `Target ${t.label} still ${state.position} after ${to} — resending`,
      );
      await this.call(t.ipAddress, '/toggle?pin=2');
      this.lastKnown.set(t.ipAddress, { position: to, d2: to === 'DOWN' });
    } catch (err) {
      // Unreachable during verification. Drop it from the cache so the next
      // command reads fresh rather than trusting a stale guess.
      if (this.isCurrent(t.ipAddress, version)) this.lastKnown.delete(t.ipAddress);
      this.logger.warn(`Target ${t.label} verify failed: ${err}`);
    }
  }

  // --------------------------------------------------------------- plumbing

  private async ipOf(id: string): Promise<string> {
    const target = await this.prisma.target.findUnique({
      where: { id },
      select: { ipAddress: true },
    });
    if (!target) throw new NotFoundException(`Target ${id} not found`);
    return target.ipAddress;
  }

  private async call(ip: string, path: string): Promise<Response> {
    try {
      const res = await fetch(`http://${ip}${path}`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
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
