import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Subscription } from 'rxjs';

import {
  buildDevDataFrame,
  buildGetWiperFrame,
  buildHeartbeatFrame,
  buildPlayFrame,
  buildReadShotFrame,
  buildSelfTestFrame,
  buildStopFrame,
  buildWriteWiperFrame,
  CMD_DEV_DATA,
  CMD_GET_WIPER,
  CMD_HEARTBEAT,
  CMD_HIT,
  CMD_PLAY,
  CMD_SELF_TEST,
  CMD_STOP,
  decodeDevData,
  decodeSelfTest,
  decodeWiperPage,
  formatFrame,
  type SelfTestReply,
  type WiperPage,
} from './protocol/frame.codec';
import {
  sourceKeyOf,
  type InBoundFrame,
  type TargetRef,
} from './target-transport.interface';
import { TransportRegistry } from './transport.registry';

interface Waiter<T = unknown> {
  match: (frame: InBoundFrame) => T | undefined;
  resolve: (value: T | undefined) => void;
  timer: NodeJS.Timeout;
}

export interface FrameExchange {
  /** True if the board answered the request within budget. For STOP, which is
   *  fire-and-forget at the transport, this reports whether an echo arrived —
   *  not whether the disarm happened (it was sent regardless). */
  ok: boolean;
  /** ASCII command byte that was sent — P/S/T/H/D/G/W. */
  command: string;
  /** The exact 9-byte frame sent, space-separated uppercase hex. */
  txHex: string;
  /** The board's reply frame, space-separated uppercase hex, or null if it
   *  never answered within budget. */
  rxHex: string | null;
  /**
   * Milliseconds between putting the winning attempt on the wire and the reply
   * arriving, or null if there was no reply.
   *
   * Carried out of the transport because for read-shot it is load-bearing, not
   * diagnostic: a board with nothing stored for a bullet answers with the exact
   * bytes it was asked with, so round-trip time is the only thing separating
   * "no position for that shot" from "this firmware just echoes commands".
   * See ECHO_WINDOW_MS.
   */
  elapsedMs: number | null;
  /** Human-readable summary, including what to check on failure. */
  message: string;
}

/** A wiper page read/write plus the round trip that produced it. */
export interface WiperRead {
  /** The five wiper values (0-255), as the board reported them. */
  values: number[];
  exchange: FrameExchange;
}


@Injectable()
export class TargetCommandService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TargetCommandService.name);

  /** sourceKey → FIFO of requests currently awaiting a reply from that board. */
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly wiperQuarantineUntil = new Map<string, number>();

  private sub?: Subscription;

  private readonly ackTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly requestAttempts: number;

  constructor(
    private readonly registry: TransportRegistry,
    config: ConfigService,
  ) {
    this.ackTimeoutMs = config.get<number>('PLAY_ACK_TIMEOUT_MS', 1500);
    this.maxAttempts = config.get<number>('PLAY_MAX_ATTEMPTS', 3);
    this.requestTimeoutMs = config.get<number>('SENSOR_REQUEST_TIMEOUT_MS', 2500);
    this.requestAttempts = config.get<number>('SENSOR_REQUEST_ATTEMPTS', 2);
  }

  onModuleInit(): void {
    this.sub = this.registry.frames$.subscribe((frame) => {
      const list = this.waiters.get(frame.sourceKey);
      if (!list?.length) return;

      for (let i = 0; i < list.length; i++) {
        const value = list[i]!.match(frame);
        if (value === undefined) continue;

        const [waiter] = list.splice(i, 1);
        clearTimeout(waiter!.timer);
        if (list.length === 0) this.waiters.delete(frame.sourceKey);
        waiter!.resolve(value);
        return; // one inbound frame settles at most one waiter
      }
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    for (const list of this.waiters.values()) {
      for (const w of list) {
        clearTimeout(w.timer);
        w.resolve(undefined);
      }
    }
    this.waiters.clear();
    this.queues.clear();
    this.wiperQuarantineUntil.clear();
  }

  async play(target: TargetRef): Promise<boolean> {
    const ok = await this.enqueue(sourceKeyOf(target), () =>
      this.request(target, buildPlayFrame(), {
        match: (f) => (f.command === CMD_PLAY ? true : undefined),
        label: 'PLAY',
        timeoutMs: this.ackTimeoutMs,
        attempts: this.maxAttempts,
      }),
    );
    if (ok !== true) {
      this.logger.warn(
        `${target.label} never acknowledged PLAY — check power and association.`,
      );
      return false;
    }
    // The board echoed PLAY back at us — that echo IS the handshake, so this
    // is the one place that can honestly say the target is armed.
    this.logger.log(`🤝 ${target.label} echoed PLAY — handshake complete, armed.`);
    return true;
  }

  async stop(target: TargetRef): Promise<void> {
    this.cancelWaiters(sourceKeyOf(target));
    await this.registry.send(target, buildStopFrame());
  }

  /**
   * Ask a board to send one shot again — fire-and-forget, no waiter.
   *
   * Deliberately outside the request/once retry wrapper that every other
   * command uses. The reply is an ordinary 'L' hit frame, which SensorService
   * must ingest through its own sequence/slot machinery; latching a waiter onto
   * it here would settle on whichever 'L' arrived first, including a live shot
   * from the shooter. Retries are SensorService's job — it is the only place
   * that knows whether the bullet has since turned up.
   */
  async readShotRequest(target: TargetRef, shot: number): Promise<void> {
    const frame = buildReadShotFrame(shot);

    this.logger.log(
      `↩ READ SHOT #${shot} -> ${target.label} (${target.ipAddress}) ` +
      `frame=[${frame.toString('hex').match(/../g)?.join(' ')}]`,
    );

    await this.registry.send(target, frame);
  }

  /**
   * One read-shot round trip with the raw bytes kept — the commissioning
   * console's way of answering "does this firmware implement the read at all?"
   * without needing a live relay to produce a gap first.
   *
   * Unlike readShotRequest this DOES wait for a reply, which is only safe
   * because the route behind it refuses to run mid-relay: the match is on
   * command + bullet counter, and during sustained fire a real shot carrying
   * that counter would settle the waiter just as well as an answer would.
   */
  async readShot(
    target: TargetRef,
    shot: number,
  ): Promise<{ rawX: number | null; rawY: number | null; exchange: FrameExchange }> {
    let rawX: number | null = null;
    let rawY: number | null = null;
    const exchange = await this.exchange(target, buildReadShotFrame(shot), {
      label: 'READ-SHOT',
      match: (f) => {
        if (f.command !== CMD_HIT || f.bulletCounter !== (shot & 0xff)) return false;
        rawX = f.rawX;
        rawY = f.rawY;
        return true;
      },
    });
    return { rawX, rawY, exchange };
  }


  async getWiperPage(
    target: TargetRef,
    page: WiperPage,
  ): Promise<WiperRead | undefined> {
    return this.wiperRequest(target, buildGetWiperFrame(page), `GET-WIPER ${page}`);
  }

  async writeWiper(
    target: TargetRef,
    page: WiperPage,
    wiper: number,
    value: number,
  ): Promise<WiperRead | undefined> {
    return this.wiperRequest(
      target,
      buildWriteWiperFrame(page, wiper, value),
      `WRITE-WIPER ${page}${wiper}=${value}`,
    );
  }


  private async wiperRequest(
    target: TargetRef,
    frame: Buffer,
    label: string,
  ): Promise<WiperRead | undefined> {
    const key = sourceKeyOf(target);
    let reply: InBoundFrame | undefined;
    const result = await this.enqueue(key, () =>
      this.request(target, frame, {
        match: (f) => {
          if (f.command !== CMD_GET_WIPER) return undefined;
          const quarantineUntil = this.wiperQuarantineUntil.get(key);
          if (quarantineUntil !== undefined && Date.now() < quarantineUntil) {
            return undefined;
          }
          reply = f;
          return true;
        },
        label,
        timeoutMs: this.requestTimeoutMs,
        attempts: this.requestAttempts,
      }),
    );
    if (result !== true || !reply) return undefined;
    const values = decodeWiperPage(reply.payload);
    return {
      values,
      exchange: {
        ok: true,
        command: 'G',
        txHex: formatFrame(frame),
        rxHex: formatFrame(Buffer.from(reply.bytes)),
        // Wiper reads go through `request` directly rather than `exchange`, and
        // nothing downstream distinguishes a wiper reply from an echo — a 'G'
        // answer carries five values, so it is never byte-identical to the
        // request that asked for it.
        elapsedMs: null,
        message: `${label} — ${values.join(', ')}`,
      },
    };
  }

  async selfTest(target: TargetRef): Promise<SelfTestReply | undefined> {
    return this.enqueue(sourceKeyOf(target), () =>
      this.request(target, buildSelfTestFrame(), {
        match: (f) =>
          f.command === CMD_SELF_TEST ? decodeSelfTest(f.payload) : undefined,
        label: 'SELF-TEST',
        timeoutMs: this.requestTimeoutMs,
        attempts: this.requestAttempts,
      }),
    );
  }


  async playTarget(target: TargetRef): Promise<FrameExchange> {
    return this.exchange(target, buildPlayFrame(), {
      label: 'PLAY',
      match: (f) => f.command === CMD_PLAY,
    });
  }

  async stopTarget(target: TargetRef): Promise<FrameExchange> {
    return this.exchange(target, buildStopFrame(), {
      label: 'STOP',
      match: (f) => f.command === CMD_STOP,
    });
  }

  /** Ask the board whether it is alive: send 'H', wait for the echo. */
  async heartbeat(target: TargetRef): Promise<FrameExchange> {
    return this.exchange(target, buildHeartbeatFrame(), {
      label: 'HEARTBEAT',
      match: (f) => f.command === CMD_HEARTBEAT,
    });
  }

  /**
   * 'D' — developer per-shot diagnostic. The reply's byte[2] is a bitmask of
   * which sensors detected the requested shot; that is decoded and returned
   * alongside the raw bytes.
   */
  async devData(
    target: TargetRef,
    shot: number,
  ): Promise<{ sensors: number | null; exchange: FrameExchange }> {
    let sensors: number | null = null;
    const exchange = await this.exchange(target, buildDevDataFrame(shot), {
      label: 'DEV-DATA',
      match: (f) => {
        if (f.command !== CMD_DEV_DATA) return false;
        sensors = decodeDevData(f.payload);
        return true;
      },
    });
    return { sensors, exchange };
  }

  /** Self-test round trip that keeps the raw bytes — the decoded outcome plus
   *  the actual frame exchanged, for the commissioning console's packet log. */
  async selfTestExchange(
    target: TargetRef,
  ): Promise<{ reply: SelfTestReply | undefined; exchange: FrameExchange }> {
    let reply: SelfTestReply | undefined;
    const exchange = await this.exchange(target, buildSelfTestFrame(), {
      label: 'SELF-TEST',
      match: (f) => {
        if (f.command !== CMD_SELF_TEST) return false;
        reply = decodeSelfTest(f.payload);
        return true;
      },
    });
    return { reply, exchange };
  }

  /** Send a frame and wait for the board to answer, reporting the real bytes. */
  private async exchange(
    target: TargetRef,
    frame: Buffer,
    opts: { label: string; match: (f: InBoundFrame) => boolean },
  ): Promise<FrameExchange> {
    let reply: InBoundFrame | undefined;
    // Stamped per attempt, not once for the whole exchange: `enqueue` can park
    // this behind another command for arbitrarily long, and `request` may retry.
    // Only the gap between the winning send and its reply says anything.
    let sentAt = 0;
    let elapsedMs: number | null = null;
    const result = await this.enqueue(sourceKeyOf(target), () =>
      this.request(target, frame, {
        onSend: () => {
          sentAt = Date.now();
        },
        match: (f) => {
          if (!opts.match(f)) return undefined;
          reply = f;
          elapsedMs = sentAt > 0 ? Date.now() - sentAt : null;
          return true;
        },
        label: opts.label,
        timeoutMs: this.requestTimeoutMs,
        attempts: this.requestAttempts,
      }),
    );
    const ok = result === true;
    return {
      ok,
      command: opts.label,
      txHex: formatFrame(frame),
      rxHex: reply ? formatFrame(Buffer.from(reply.bytes)) : null,
      elapsedMs: ok ? elapsedMs : null,
      message: ok
        ? `${opts.label} acknowledged`
        : `${opts.label} — no reply within ${this.requestTimeoutMs * this.requestAttempts}ms. Check power and association.`,
    };
  }

  private enqueue<T>(sourceKey: string, work: () => Promise<T>): Promise<T> {
    const tail = this.queues.get(sourceKey) ?? Promise.resolve();
    const run = tail.then(work, work);
    this.queues.set(
      sourceKey,
      run.catch(() => undefined),
    );
    return run;
  }

  /** Retrying wrapper: up to `attempts` single tries, each `timeoutMs` long. */
  private async request<T>(
    target: TargetRef,
    frame: Buffer,
    opts: {
      match: (f: InBoundFrame) => T | undefined;
      label: string;
      timeoutMs: number;
      attempts: number;
      /** Called immediately before each attempt goes on the wire. */
      onSend?: () => void;
    },
  ): Promise<T | undefined> {
    for (let attempt = 1; attempt <= opts.attempts; attempt++) {
      const result = await this.once(
        target,
        frame,
        opts.match,
        opts.timeoutMs,
        opts.onSend,
      );
      if (result !== undefined) return result;
      if (attempt < opts.attempts) {
        this.logger.warn(
          `${opts.label} timeout ${target.label} — retry ${attempt + 1}/${opts.attempts}`,
        );
      }
    }
    return undefined;
  }

  /** One attempt: register the waiter, send, wait, clean up either way. */
  private once<T>(
    target: TargetRef,
    frame: Buffer,
    match: (f: InBoundFrame) => T | undefined,
    timeoutMs: number,
    onSend?: () => void,
  ): Promise<T | undefined> {
    const key = sourceKeyOf(target);
    return new Promise<T | undefined>((resolve) => {
      const waiter: Waiter<T> = {
        match,
        resolve: (value) => resolve(value),
        timer: setTimeout(() => {
          this.removeWaiter(key, waiter as Waiter);
          this.wiperQuarantineUntil.set(key, Date.now() + timeoutMs);
          resolve(undefined);
        }, timeoutMs),
      };
      waiter.timer.unref?.();

      const list = this.waiters.get(key) ?? [];
      list.push(waiter as Waiter);
      this.waiters.set(key, list);

      // Before the send, not after: the echo this timestamp exists to detect
      // can be back inside a millisecond on a direct AP link.
      onSend?.();

      this.registry.send(target, frame).catch((err: Error) => {
        this.removeWaiter(key, waiter as Waiter);
        resolve(undefined);
        this.logger.error(`send → ${target.label} failed: ${err.message}`);
      });
    });
  }

  private removeWaiter(sourceKey: string, waiter: Waiter): void {
    const list = this.waiters.get(sourceKey);
    if (!list) return;
    clearTimeout(waiter.timer);
    const idx = list.indexOf(waiter);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) this.waiters.delete(sourceKey);
  }

  private cancelWaiters(sourceKey: string): void {
    const list = this.waiters.get(sourceKey);
    if (!list) return;
    this.waiters.delete(sourceKey);
    for (const w of list) {
      clearTimeout(w.timer);
      w.resolve(undefined);
    }
  }
}
