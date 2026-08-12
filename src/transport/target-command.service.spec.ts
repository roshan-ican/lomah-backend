import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { CMD_GET_WIPER, CMD_HIT, CMD_PLAY } from './protocol/frame.codec';
import type { InBoundFrame, TargetRef } from './target-transport.interface';
import { TargetCommandService } from './target-command.service';
import type { TransportRegistry } from './transport.registry';

/**
 * A fake registry is enough here — TargetCommandService only ever calls
 * registry.send() and subscribes to registry.frames$. Going through real Nest
 * DI and a real socket would test the transport layer, not this one.
 */
function makeFakeRegistry() {
  const frames = new Subject<InBoundFrame>();
  const send = vi.fn<(target: TargetRef, frame: Buffer) => Promise<void>>(
    () => Promise.resolve(),
  );
  const registry = { frames$: frames.asObservable(), send } as unknown as TransportRegistry;
  return { registry, frames, send };
}

/** get(key, default) always returns `overrides[key] ?? default` — enough to
 *  drive the service's timeout/attempt knobs down to test-speed values. */
function makeFakeConfig(overrides: Record<string, number> = {}) {
  return {
    get: <T>(key: string, def: T): T =>
      (overrides[key] as unknown as T | undefined) ?? def,
  } as unknown as import('@nestjs/config').ConfigService;
}

function targetRef(id: string, ip: string): TargetRef {
  return { id, laneId: '1', label: `Target ${id}`, transport: 'WIFI', ipAddress: ip };
}

function inbound(
  sourceKey: string,
  command: number,
  payload: number[],
  coords: { rawX: number; rawY: number } = { rawX: 0, rawY: 0 },
): InBoundFrame {
  return {
    sourceKey,
    transport: 'WIFI',
    command,
    bulletCounter: payload[0] ?? 0,
    rawX: coords.rawX,
    rawY: coords.rawY,
    payload,
    bytes: [0x24, command, ...payload, 0x00, 0x23],
    receivedAt: new Date(),
  };
}

// Fast budgets so these tests don't actually wait real seconds on a timeout.
const FAST_CONFIG = {
  PLAY_ACK_TIMEOUT_MS: 40,
  PLAY_MAX_ATTEMPTS: 2,
  SENSOR_REQUEST_TIMEOUT_MS: 40,
  SENSOR_REQUEST_ATTEMPTS: 2,
};

describe('TargetCommandService', () => {
  it('play() resolves true on a matching PLAY echo', async () => {
    const { registry, frames } = makeFakeRegistry();
    const svc = new TargetCommandService(registry, makeFakeConfig(FAST_CONFIG));
    svc.onModuleInit();

    const target = targetRef('t1', '10.0.1.11');
    const result = svc.play(target);
    // Reply arrives asynchronously, same tick queue as a real UDP callback.
    queueMicrotask(() => frames.next(inbound('10.0.1.11', CMD_PLAY, [0, 0, 0, 0, 0])));

    expect(await result).toBe(true);
    svc.onModuleDestroy();
  });

  it('play() retries up to maxAttempts and returns false if nothing ever answers', async () => {
    const { registry } = makeFakeRegistry();
    const svc = new TargetCommandService(registry, makeFakeConfig(FAST_CONFIG));
    svc.onModuleInit();

    const target = targetRef('t1', '10.0.1.11');
    const result = await svc.play(target);

    expect(result).toBe(false);
    svc.onModuleDestroy();
  });

  it('concurrent GET-WIPER requests to DIFFERENT targets run in parallel, not serialised', async () => {
    const { registry, frames, send } = makeFakeRegistry();
    const svc = new TargetCommandService(registry, makeFakeConfig(FAST_CONFIG));
    svc.onModuleInit();

    const a = targetRef('a', '10.0.1.11');
    const b = targetRef('b', '10.0.1.21');

    const pA = svc.getWiperPage(a, 'A');
    const pB = svc.getWiperPage(b, 'A');

    // Both sends must have gone out before either reply arrives — proves they
    // were not queued behind one another despite starting "concurrently".
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);

    frames.next(inbound('10.0.1.11', CMD_GET_WIPER, [1, 2, 3, 4, 5]));
    frames.next(inbound('10.0.1.21', CMD_GET_WIPER, [9, 9, 9, 9, 9]));

    expect(await pA).toEqual({ values: [1, 2, 3, 4, 5], exchange: expect.objectContaining({ ok: true, command: 'G' }) });
    expect(await pB).toEqual({ values: [9, 9, 9, 9, 9], exchange: expect.objectContaining({ ok: true }) });
    svc.onModuleDestroy();
  });

  it('a WRITE and a GET to the SAME target are serialised, each getting its own reply in order', async () => {
    const { registry, frames } = makeFakeRegistry();
    const svc = new TargetCommandService(registry, makeFakeConfig(FAST_CONFIG));
    svc.onModuleInit();

    const target = targetRef('t1', '10.0.1.11');

    // Both replies are G-shaped and indistinguishable on the wire — the ONLY
    // thing that can make this correct is that the second request is not even
    // sent until the first has been answered.
    const write = svc.writeWiper(target, 'A', 2, 30);
    await Promise.resolve();
    await Promise.resolve();
    frames.next(inbound('10.0.1.11', CMD_GET_WIPER, [10, 30, 10, 10, 11])); // reply to the write

    const writeResult = await write;
    expect(writeResult).toEqual({
      values: [10, 30, 10, 10, 11],
      exchange: expect.objectContaining({ command: 'G' }),
    });

    const read = svc.getWiperPage(target, 'A');
    await Promise.resolve();
    await Promise.resolve();
    frames.next(inbound('10.0.1.11', CMD_GET_WIPER, [10, 30, 10, 10, 11])); // reply to the read

    expect(await read).toEqual({
      values: [10, 30, 10, 10, 11],
      exchange: expect.objectContaining({ command: 'G' }),
    });
    svc.onModuleDestroy();
  });

  it('a reply that arrives after its own attempt timed out does not settle the NEXT request', async () => {
    const { registry, frames } = makeFakeRegistry();
    const svc = new TargetCommandService(
      registry,
      // 1 attempt only, so the first getWiperPage call times out and gives up
      // (rather than retrying) — isolates the late-reply behaviour cleanly.
      makeFakeConfig({ ...FAST_CONFIG, SENSOR_REQUEST_ATTEMPTS: 1 }),
    );
    svc.onModuleInit();

    const target = targetRef('t1', '10.0.1.11');

    const firstRead = svc.getWiperPage(target, 'A');
    expect(await firstRead).toBeUndefined(); // timed out, nothing ever answered

    // The stale reply for the timed-out request arrives just now, followed
    // immediately by a fresh request. The stale one must not be mistaken for
    // the fresh request's answer.
    const secondRead = svc.getWiperPage(target, 'B');
    frames.next(inbound('10.0.1.11', CMD_GET_WIPER, [99, 99, 99, 99, 99])); // the STALE reply

    const result = await secondRead;
    expect(result).not.toEqual([99, 99, 99, 99, 99]);
    svc.onModuleDestroy();
  });

  it('a GET-WIPER whose first attempt times out is still answered by the retry', async () => {
    const { registry, frames, send } = makeFakeRegistry();
    const svc = new TargetCommandService(registry, makeFakeConfig(FAST_CONFIG));
    svc.onModuleInit();

    const target = targetRef('t1', '10.0.1.11');
    const read = svc.getWiperPage(target, 'A');

    // Let attempt 1's whole budget lapse unanswered, then reply. Attempt 2 put
    // a byte-identical frame on the wire, so this IS its answer — whether it
    // is also attempt 1's straggler is unknowable and does not matter.
    await new Promise((r) => setTimeout(r, FAST_CONFIG.SENSOR_REQUEST_TIMEOUT_MS + 20));
    expect(send).toHaveBeenCalledTimes(2);
    frames.next(inbound('10.0.1.11', CMD_GET_WIPER, [10, 30, 10, 10, 11]));

    expect(await read).toEqual({
      values: [10, 30, 10, 10, 11],
      exchange: expect.objectContaining({ command: 'G' }),
    });
    svc.onModuleDestroy();
  });

  it('stop() cancels a PLAY that is still in flight rather than leaving it hanging', async () => {
    const { registry } = makeFakeRegistry();
    const svc = new TargetCommandService(registry, makeFakeConfig(FAST_CONFIG));
    svc.onModuleInit();

    const target = targetRef('t1', '10.0.1.11');
    const playResult = svc.play(target);

    await Promise.resolve();
    await svc.stop(target);

    // stop() cancelling the waiter resolves it false immediately — the
    // request() retry loop then exhausts its remaining attempts (each of
    // which also finds nothing waiting) and settles false well within the
    // fast test timeout, rather than needing the full un-cancelled budget.
    expect(await playResult).toBe(false);
    svc.onModuleDestroy();
  });

  it('readShotRequest() puts the spec\'s exact read frame on the wire', async () => {
    const { registry, send } = makeFakeRegistry();
    const svc = new TargetCommandService(registry, makeFakeConfig(FAST_CONFIG));
    svc.onModuleInit();

    await svc.readShotRequest(targetRef('t1', '10.0.1.11'), 5);

    // Tx: 0x24 'L' 5 0 0 0 0 crc 0x23, crc = 0x24 + 0x4C + 5 = 0x75.
    expect(send.mock.calls[0]![1]).toEqual(
      Buffer.from([0x24, 0x4c, 0x05, 0, 0, 0, 0, 0x75, 0x23]),
    );
    svc.onModuleDestroy();
  });

  it('readShot() returns the position from a reply for the shot it asked about', async () => {
    const { registry, frames } = makeFakeRegistry();
    const svc = new TargetCommandService(registry, makeFakeConfig(FAST_CONFIG));
    svc.onModuleInit();

    const result = svc.readShot(targetRef('t1', '10.0.1.11'), 5);
    queueMicrotask(() =>
      frames.next(
        inbound('10.0.1.11', CMD_HIT, [5, 0x01, 0x0d, 0x09, 0x41], {
          rawX: 269,
          rawY: 2369,
        }),
      ),
    );

    const { rawX, rawY, exchange } = await result;
    expect(exchange.ok).toBe(true);
    expect(rawX).toBe(269);
    expect(rawY).toBe(2369);
    svc.onModuleDestroy();
  });

  it('readShot() ignores a hit for a DIFFERENT shot number', async () => {
    // The reply shares its opcode with every live hit, so the counter is the
    // only thing that makes it an answer rather than someone else's round.
    const { registry, frames } = makeFakeRegistry();
    const svc = new TargetCommandService(registry, makeFakeConfig(FAST_CONFIG));
    svc.onModuleInit();

    const result = svc.readShot(targetRef('t1', '10.0.1.11'), 5);
    queueMicrotask(() =>
      frames.next(
        inbound('10.0.1.11', CMD_HIT, [6, 0, 0, 0, 0], { rawX: 100, rawY: 100 }),
      ),
    );

    const { rawX, exchange } = await result;
    expect(exchange.ok).toBe(false);
    expect(exchange.rxHex).toBeNull();
    expect(rawX).toBeNull();
    svc.onModuleDestroy();
  });

  it('readShot() reports no reply when the firmware ignores the read', async () => {
    // The whole point of the diagnostic route: a board that does not implement
    // 'L' reads must be distinguishable from one that had nothing to send.
    const { registry } = makeFakeRegistry();
    const svc = new TargetCommandService(registry, makeFakeConfig(FAST_CONFIG));
    svc.onModuleInit();

    const { exchange } = await svc.readShot(targetRef('t1', '10.0.1.11'), 5);

    expect(exchange.ok).toBe(false);
    expect(exchange.txHex).toBe('24 4C 05 00 00 00 00 75 23');
    expect(exchange.rxHex).toBeNull();
    svc.onModuleDestroy();
  });
});
