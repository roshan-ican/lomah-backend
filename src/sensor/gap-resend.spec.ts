// What may and may not trigger a RESEND.
//
// The rule, stated once: a resend is a claim that a datagram was LOST. The
// bullet-counter sequence is the only evidence that can support that claim.
//
//   received 1 2 3 5   -> ask for 4, and only 4
//   received 1 2 3     -> ask for nothing
//   received 1 2 3 5 4 -> ask for nothing; 4 was reordered, not lost
//   received 1 2 (0,0) -> ask for nothing; the frame ARRIVED, the board just
//                         failed to triangulate. That is a sensor fault on the
//                         target and no retransmission can fix it.
//
// The last case is the one that mattered in practice: a no-detection storm on
// 25M was emitting a resend request per miss, none of which could ever have
// recovered anything, on the hot receive path during sustained fire.
//
// Frames are built and decoded through the real codec rather than hand-rolled,
// so the bullet-counter byte (and its wrap at 256) is exercised for real.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildHitFrame,
  decodeFrame,
} from '@/transport/protocol/frame.codec';
import { SequenceTracker } from '@/transport/protocol/sequence.tracker';
import type { InBoundFrame } from '@/transport/target-transport.interface';

import { SensorService } from './sensor.service';

const GRACE_MS = 60;
const MAX_ATTEMPTS = 2;
const SRC = '192.168.4.51';

function harness({ resend = true }: { resend?: boolean } = {}) {
  const sent: number[] = [];
  const target = {
    id: 't1',
    label: '25M',
    laneId: 1,
    ipAddress: SRC,
  } as any;

  const config = {
    get: (key: string, fallback?: string) =>
      ({
        SENSOR_RESEND_ENABLED: String(resend),
        RESEND_GRACE_MS: String(GRACE_MS),
        MAX_RESEND_ATTEMPTS: String(MAX_ATTEMPTS),
      })[key] ?? fallback,
  };

  const service = new SensorService(
    { target: { update: vi.fn() } } as any,
    { frames$: { subscribe: vi.fn() } } as any,
    { resend: vi.fn(async (_t: unknown, b: number) => void sent.push(b)) } as any,
    new SequenceTracker(),
    { resolve: vi.fn(async () => target) } as any,
    { events$: { subscribe: vi.fn() } } as any,
    { setHeld: vi.fn() } as any,
    config as any,
  );

  // Persistence is a different concern; these tests are about the resend
  // decision only.
  (service as any).serialize = vi.fn();

  return { service, sent };
}

/** A real 9-byte hit frame, encoded then decoded like one off the wire. */
function hit(counter: number, x = 100, y = 100): InBoundFrame {
  const decoded = decodeFrame(buildHitFrame(x, y, counter));
  if (!decoded.ok) throw new Error(`bad fixture: ${decoded.reason}`);
  return {
    ...decoded.frame,
    sourceKey: SRC,
    transport: 'WIFI',
    receivedAt: new Date(),
  };
}

const feed = async (service: SensorService, counters: number[]) => {
  for (const n of counters) await (service as any).onHit(hit(n));
};

describe('resend is for broken sequences only', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks for nothing when the sequence is intact', async () => {
    const { service, sent } = harness();

    await feed(service, [1, 2, 3]);
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3);

    expect(sent).toEqual([]);
  });

  it('asks for 4 and only 4 after 1 2 3 5', async () => {
    const { service, sent } = harness();

    await feed(service, [1, 2, 3, 5]);
    // Nothing goes out immediately — the hole gets its grace window first.
    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(GRACE_MS + 5);
    expect(sent).toEqual([4]);
  });

  it('asks for nothing when the missing bullet was merely reordered', async () => {
    const { service, sent } = harness();

    await feed(service, [1, 2, 3, 5]);
    // 4 turns up inside the grace window: the sequence was never actually
    // broken, so no request may ever be sent.
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    await feed(service, [4]);
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3);

    expect(sent).toEqual([]);
  });

  it('does NOT ask for a no-detection shot — the frame arrived', async () => {
    const { service, sent } = harness();

    await feed(service, [1, 2]);
    await (service as any).onHit(hit(3, 0, 0)); // sentinel, sequence intact
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3);

    expect(sent).toEqual([]);
  });

  it('does NOT ask for the other sentinel either (65535, 65535)', async () => {
    const { service, sent } = harness();

    await feed(service, [1, 2]);
    await (service as any).onHit(hit(3, 65535, 65535));
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3);

    expect(sent).toEqual([]);
  });

  it('retries a genuinely lost bullet, then writes it off', async () => {
    const { service, sent } = harness();

    await feed(service, [1, 2, 3, 5]);
    await vi.advanceTimersByTimeAsync(GRACE_MS * (MAX_ATTEMPTS + 3));

    // Capped — a board that never answers must not be asked forever.
    expect(sent).toEqual([4, 4]);
    expect(sent).toHaveLength(MAX_ATTEMPTS);
  });

  it('asks for every number in a multi-bullet hole, and nothing else', async () => {
    const { service, sent } = harness();

    await feed(service, [1, 2, 6]);
    await vi.advanceTimersByTimeAsync(GRACE_MS + 5);

    expect([...sent].sort((a, b) => a - b)).toEqual([3, 4, 5]);
  });

  it('stays silent when resend is disabled, even on a real gap', async () => {
    const { service, sent } = harness({ resend: false });

    await feed(service, [1, 2, 3, 5]);
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3);

    expect(sent).toEqual([]);
  });

  it('does not stack timers when a later bullet re-reports the same hole', async () => {
    const { service, sent } = harness();

    // 4 is missing; 5, 6 and 7 all arrive after it. The hole must be chased
    // once, not once per subsequent bullet.
    await feed(service, [1, 2, 3, 5]);
    await feed(service, [6, 7]);
    await vi.advanceTimersByTimeAsync(GRACE_MS + 5);

    expect(sent).toEqual([4]);
  });
});
