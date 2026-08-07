import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Subscription } from 'rxjs';

import {
  buildDevDataFrame,
  buildGetWiperFrame,
  buildHeartbeatFrame,
  buildPlayFrame,
  buildResendFrame,
  buildSelfTestFrame,
  buildStopFrame,
  buildWriteWiperFrame,
  CMD_DEV_DATA,
  CMD_GET_WIPER,
  CMD_HEARTBEAT,
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
  /** Return undefined to decline the frame (not an answer to THIS request);
   *  any other value settles the waiter with that value. */
  match: (frame: InBoundFrame) => T | undefined;
  resolve: (value: T | undefined) => void;
  timer: NodeJS.Timeout;
}

/** A single live UDP round trip: the exact bytes that went out and, when the
 *  board answered, the exact bytes that came back. Every command endpoint the
 *  admin console drives returns one of these so the on-screen packet log shows
 *  real wire traffic, never a reconstruction. */
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
  /** Human-readable summary, including what to check on failure. */
  message: string;
}

/** A wiper page read/write plus the round trip that produced it. */
export interface WiperRead {
  /** The five wiper values (0-255), as the board reported them. */
  values: number[];
  exchange: FrameExchange;
}

/**
 * Command semantics for a target: arm it, disarm it, ask it a question and
 * wait for the answer.
 *
 * Handshake and retry live HERE rather than inside each transport, so the
 * policy is written once and every transport inherits it.
 *
 * Waiters are keyed by sourceKey (the target's normalised IP) rather than by
 * target id, and there is exactly one map for that — a prior version kept a
 * second `awaiting: sourceKey -> targetId` map purely to translate into a
 * `pending: targetId -> ...` map, which was pointless indirection (sourceKey
 * is already a pure function of the ref) and had a real bug: `awaiting`
 * entries were only ever cleared by stop(), never by play() itself, so a
 * target that was armed and never explicitly stopped leaked an entry for the
 * rest of the process's life.
 */
@Injectable()
export class TargetCommandService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TargetCommandService.name);

  /** sourceKey → FIFO of requests currently awaiting a reply from that board. */
  private readonly waiters = new Map<string, Waiter[]>();
  /** sourceKey → per-target UDP round-trips, serialised. Necessary because a
   *  WRITE_WIPER reply is indistinguishable on the wire from a GET_WIPER
   *  reply (same command byte, same shape, no request-id anywhere in a 9-byte
   *  frame) — a concurrent G and W to the SAME board cannot be told apart
   *  except by never letting two be in flight at once. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** sourceKey → timestamp until which a GET_WIPER reply is presumed to be a
   *  LATE echo of a timed-out request rather than an answer to whatever comes
   *  next. See once()'s timeout handler for why this exists. */
  private readonly wiperQuarantineUntil = new Map<string, number>();

  private sub?: Subscription;

  private readonly ackTimeoutMs: number;
  private readonly maxAttempts: number;
  /** Separate, looser budget for the commissioning commands (G/W/T) — the
   *  live PLAY-arm path above stays tight on purpose, and 700-800ms measured
   *  round-trips against a 1500ms PLAY budget leave too little margin to
   *  reuse it here. */
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

  /**
   * Arm a target: send PLAY, succeed only if it echoes PLAY back.
   *
   * External contract is unchanged from before this file was generalised:
   * `Promise<boolean>`, up to PLAY_MAX_ATTEMPTS retries at PLAY_ACK_TIMEOUT_MS
   * each, same log line on final failure. Callers (SessionsService.arm,
   * TargetsService.selfTest) need no changes.
   */
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

  /**
   * Disarm a target, and cancel anything this service is still waiting on for
   * it. STOP itself is fire-and-forget — the original behaviour — but the
   * cancellation matters: if a PLAY (or a wiper request) is still in flight
   * when STOP is called, that waiter must not be left hanging until its own
   * timeout, and any legitimate reply that later arrives for the CANCELLED
   * request must not be interpreted as an answer to whatever runs next.
   */
  async stop(target: TargetRef): Promise<void> {
    this.cancelWaiters(sourceKeyOf(target));
    await this.registry.send(target, buildStopFrame());
  }

  async resend(target: TargetRef, bulletCounter: number): Promise<void> {
    // Deliberately NOT queued — SensorService fires this off the hot ingest
    // path (see its serialize()) and it must not be able to queue behind a
    // multi-second self-test or wiper round-trip.
    const frame = buildResendFrame(bulletCounter);

    // Log the exact outbound datagram.
    //
    // RESEND is fire-and-forget: nothing acks it, and the deployed firmware
    // may not implement 'R' at all. So the only evidence that a request was
    // made — and the only way to tell "the board ignored us" from "we never
    // actually sent anything" — is the bytes on the way out. Without this the
    // feature is unfalsifiable from the log: a silent resend and a resend that
    // was never attempted look identical.
    this.logger.log(
      `↩ RESEND #${bulletCounter} -> ${target.label} (${target.ipAddress}) ` +
      `frame=[${frame.toString('hex').match(/../g)?.join(' ')}]`,
    );

    await this.registry.send(target, frame);
  }

  /**
   * Read one page's five sensitivity trimmers. `undefined` means the board
   * did not answer within budget — the caller decides what that means (503,
   * "board offline", etc.), this layer only reports reachability.
   */
  async getWiperPage(
    target: TargetRef,
    page: WiperPage,
  ): Promise<WiperRead | undefined> {
    return this.wiperRequest(target, buildGetWiperFrame(page), `GET-WIPER ${page}`);
  }

  /**
   * Write one trimmer. Returns the device's own reply — the WHOLE updated
   * page, per the confirmed capture in frame.codec.ts — never the value that
   * was sent. A caller that displays "value == what I sent" without waiting
   * for this return would be lying about what the board actually has.
   */
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

  /**
   * One G/W round trip: send the frame, wait for the board's G-shaped reply
   * (per the capture in frame.codec.ts, a write answers with a read-shaped
   * frame), and report both the values AND the actual bytes exchanged.
   */
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
        message: `${label} — ${values.join(', ')}`,
      },
    };
  }

  /**
   * Run the device's self test. Meaningless unless the board is already
   * armed (see decodeSelfTest — an unarmed board reports NOT_ARMED and
   * nothing else), so callers arm it first; this method does not.
   */
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

  /**
   * One-off PLAY for the commissioning console — same handshake as play(),
   * but returns the actual bytes exchanged so the admin packet log can show
   * them instead of a simulation.
   */
  async playTarget(target: TargetRef): Promise<FrameExchange> {
    return this.exchange(target, buildPlayFrame(), {
      label: 'PLAY',
      match: (f) => f.command === CMD_PLAY,
    });
  }

  /**
   * One-off STOP for the commissioning console. Unlike the session path's
   * stop() (fire-and-forget), this waits for the echo — the board is supposed
   * to confirm receipt — so the operator can SEE the round trip complete.
   */
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
    const result = await this.enqueue(sourceKeyOf(target), () =>
      this.request(target, frame, {
        match: (f) => {
          if (!opts.match(f)) return undefined;
          reply = f;
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
      message: ok
        ? `${opts.label} acknowledged`
        : `${opts.label} — no reply within ${this.requestTimeoutMs * this.requestAttempts}ms. Check power and association.`,
    };
  }

  /** Serialise all round-trips to the same board. A GET/WRITE_WIPER reply
   *  carries no request id, so two in-flight requests to one target cannot be
   *  told apart on the wire — the only fix is to never let that happen. */
  private enqueue<T>(sourceKey: string, work: () => Promise<T>): Promise<T> {
    const tail = this.queues.get(sourceKey) ?? Promise.resolve();
    const run = tail.then(work, work);
    // Chain the NEXT job on a copy that swallows this one's rejection, so one
    // failed request cannot poison the queue for everything behind it — the
    // caller of THIS call still sees the real rejection via `run`.
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
    },
  ): Promise<T | undefined> {
    for (let attempt = 1; attempt <= opts.attempts; attempt++) {
      const result = await this.once(target, frame, opts.match, opts.timeoutMs);
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
  ): Promise<T | undefined> {
    const key = sourceKeyOf(target);
    return new Promise<T | undefined>((resolve) => {
      const waiter: Waiter<T> = {
        match,
        resolve: (value) => resolve(value),
        timer: setTimeout(() => {
          this.removeWaiter(key, waiter as Waiter);
          // A GET_WIPER-shaped reply for THIS attempt may still be on the
          // wire when we give up on it (700-800ms measured RTT leaves little
          // slack). Quarantine briefly so it cannot be mistaken for the
          // answer to whatever the caller sends next.
          this.wiperQuarantineUntil.set(key, Date.now() + timeoutMs);
          resolve(undefined);
        }, timeoutMs),
      };
      waiter.timer.unref?.();

      const list = this.waiters.get(key) ?? [];
      list.push(waiter as Waiter);
      this.waiters.set(key, list);

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

  /** Resolve every outstanding waiter for a target with `undefined` — used by
   *  stop() so a disarm cannot leave a PLAY/wiper/self-test promise hanging
   *  until its own timeout, and by onModuleDestroy for a clean shutdown. */
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
