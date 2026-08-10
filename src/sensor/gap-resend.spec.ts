// What may and may not make the server ask a board to send a shot again.
//
// The request is 'L' — `24 4C n 00 00 00 00 crc 23`, the spec's "reading a
// specific shot". It used to be 'R', which the spec lists as not implemented;
// the board discarded every one, so none of the rules below had ever actually
// recovered a bullet on the range.
//
// The rule, stated once: ask when a shot's position might still be obtainable,
// and only then.
//
//   received 1 2 3 5   -> ask for 4, and only 4; its datagram was lost
//   received 1 2 3     -> ask for nothing
//   received 1 2 3 5 4 -> ask for nothing; 4 was reordered, not lost
//   received 1 2 (0,0) -> ask for 3. The frame arrived but carries no position,
//                         and the board keeps the last ~100 shots, so it may be
//                         able to produce one on a second attempt.
//
// That last line REVERSES what this file used to assert. The old rule — never
// ask about a no-detection, a resend cannot fix a sensor fault — was written
// when the request was a no-op on 'R' and the reply had no way through the
// duplicate check, so asking was pure cost. Both of those are now false. What
// survives from it is the reason it was written: a no-detection storm must not
// emit a request per miss on the hot receive path, which is what
// MAX_CONCURRENT_NODETECT_READS bounds.
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
const HOLD_MS = 200;
const SRC = '192.168.4.51';

function harness({
  resend = true,
  noDetect = false,
  attempts = MAX_ATTEMPTS,
}: { resend?: boolean; noDetect?: boolean; attempts?: number } = {}) {
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
        MAX_RESEND_ATTEMPTS: String(attempts),
        NO_DETECT_REREAD: String(noDetect),
        NO_DETECT_HOLD_MS: String(HOLD_MS),
        // Disable the production floor on the grace/hold values. In the field
        // both must clear the ~900ms a board takes to answer a read; here the
        // whole point is a compressed timeline, and the floor would silently
        // rewrite GRACE_MS out from under every assertion below.
        BOARD_READ_LATENCY_MS: '0',
      })[key] ?? fallback,
  };

  const service = new SensorService(
    { target: { update: vi.fn() } } as any,
    { frames$: { subscribe: vi.fn() } } as any,
    {
      readShotRequest: vi.fn(async (_t: unknown, b: number) => void sent.push(b)),
    } as any,
    new SequenceTracker(),
    { resolve: vi.fn(async () => target) } as any,
    { events$: { subscribe: vi.fn() } } as any,
    { setHeld: vi.fn() } as any,
    config as any,
  );

  // Persistence is a different concern; these tests are about the request
  // decision only. beginNoDetectHold is stubbed to the one thing that decision
  // depends on — that a row was written — so the chase still starts.
  (service as any).serialize = vi.fn((_id: string, work: () => Promise<unknown>) =>
    void work(),
  );
  (service as any).persistHit = vi.fn(async () => ({ shotNumber: 1 }));

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

/** Let the fire-and-forget work started inside onHit reach its scheduling. */
const flush = () => Promise.resolve().then(() => Promise.resolve());

const feed = async (service: SensorService, counters: number[]) => {
  for (const n of counters) {
    await (service as any).onHit(hit(n));
    await flush();
  }
};

const feedFrame = async (service: SensorService, frame: InBoundFrame) => {
  await (service as any).onHit(frame);
  await flush();
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

  it('leaves a no-detection shot alone when the re-read is off', async () => {
    const { service, sent } = harness({ noDetect: false });

    await feed(service, [1, 2]);
    await feedFrame(service, hit(3, 0, 0)); // sentinel, sequence intact
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3);

    expect(sent).toEqual([]);
  });

  it('leaves the other sentinel alone too when the re-read is off', async () => {
    const { service, sent } = harness({ noDetect: false });

    await feed(service, [1, 2]);
    await feedFrame(service, hit(3, 65535, 65535));
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3);

    expect(sent).toEqual([]);
  });

  it('stays silent on a no-detection when resend is off, whatever the re-read flag says', async () => {
    // NO_DETECT_REREAD is a narrowing of SENSOR_RESEND_ENABLED, not a second
    // way in. A range that has turned requests off must get none.
    const { service, sent } = harness({ resend: false, noDetect: true });

    await feed(service, [1, 2]);
    await feedFrame(service, hit(3, 0, 0));
    await vi.advanceTimersByTimeAsync(GRACE_MS * 5);

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

  it('does not let an echo of a GAP request write the bullet off as a miss', async () => {
    const { service, sent } = harness();

    await feed(service, [1, 2, 3, 5]);
    await vi.advanceTimersByTimeAsync(GRACE_MS + 5);
    expect(sent).toEqual([4]);

    // The board bounces `24 4C 04 00 00 00 00 74 23` back at us. Bullet 4 has
    // never been seen, so unless this is caught before the sequence tracker it
    // is recorded as a genuine no-detection for #4 — a bullet we never received
    // filed as "arrived, board saw nothing", and the chase cancelled on the
    // strength of our own request.
    await feedFrame(service, hit(4, 0, 0));
    await vi.advanceTimersByTimeAsync(GRACE_MS * 8);

    expect(sent).toEqual([4, 4]);
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

describe('re-reading a no-detection shot', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks the board for a shot that arrived carrying no position', async () => {
    const { service, sent } = harness({ noDetect: true });

    await feed(service, [1, 2]);
    await feedFrame(service, hit(3, 0, 0));
    await vi.advanceTimersByTimeAsync(GRACE_MS + 5);

    expect(sent).toEqual([3]);
  });

  it('asks about the 65535 sentinel too — it is the same fault', async () => {
    const { service, sent } = harness({ noDetect: true });

    await feed(service, [1, 2]);
    await feedFrame(service, hit(3, 65535, 65535));
    await vi.advanceTimersByTimeAsync(GRACE_MS + 5);

    expect(sent).toEqual([3]);
  });

  it('stops asking the moment the board answers with a position', async () => {
    const { service, sent } = harness({ noDetect: true });

    await feed(service, [1, 2]);
    await feedFrame(service, hit(3, 0, 0));
    await vi.advanceTimersByTimeAsync(GRACE_MS + 5);
    expect(sent).toEqual([3]);

    // The reply. Counter 3 is already recorded, so the sequence tracker calls
    // this a duplicate — the whole point is that an asked-for duplicate is the
    // answer rather than noise.
    await feedFrame(service, hit(3, 100, 100));
    await vi.advanceTimersByTimeAsync(GRACE_MS * 8);

    expect(sent).toEqual([3]);
  });

  it('does not count our own echoed request as an answer', async () => {
    const { service, sent } = harness({ noDetect: true });

    await feed(service, [1, 2]);
    await feedFrame(service, hit(3, 0, 0));
    await vi.advanceTimersByTimeAsync(GRACE_MS + 5);
    expect(sent).toEqual([3]);

    // A board that echoes commands sends back our exact request, which is
    // byte-identical to a no-detection hit for shot 3. If that stopped the
    // chase, one echo would end every recovery attempt.
    await feedFrame(service, hit(3, 0, 0));
    await vi.advanceTimersByTimeAsync(GRACE_MS * 8);

    expect(sent).toEqual([3, 3]);
    expect(sent).toHaveLength(MAX_ATTEMPTS);
  });

  it('does not re-chase a gap bullet the board just answered with (0,0)', async () => {
    // Six attempts so the backoff (60, 120, 240, 480, 960, 1920ms) leaves a
    // wide quiet stretch to land the answer in — it has to clear
    // ECHO_WINDOW_MS since the last request, or the echo guard eats it, and
    // still arrive while the chase is running.
    const { service, sent } = harness({ noDetect: true, attempts: 6 });

    // 2 never arrived, so it is chased as a GAP.
    await feed(service, [1, 3]);
    await vi.advanceTimersByTimeAsync(GRACE_MS + 5);
    expect(sent).toEqual([2]);

    await vi.advanceTimersByTimeAsync(GRACE_MS * 19); // t ≈ 1205ms
    const askedBeforeTheAnswer = sent.length;
    expect(askedBeforeTheAnswer).toBeGreaterThan(1);

    // The board answers, slowly, that it has no position for bullet 2 — 245ms
    // after the last request went out, so well past the echo window.
    await feedFrame(service, hit(2, 0, 0));
    await vi.advanceTimersByTimeAsync(GRACE_MS * 100);

    // Counter 2 is new to the tracker, so this frame arrives on the fresh-shot
    // path looking exactly like a live no-detection. Treating it as one started
    // a SECOND chase for the same bullet, whose answer started a third: the
    // feedback loop that put twenty datagrams on the wire in two seconds.
    // Answering a question is not asking a new one.
    expect(sent).toHaveLength(askedBeforeTheAnswer);
  });

  it('caps how many no-detections it chases at once', async () => {
    const { service, sent } = harness({ noDetect: true });

    // Ten consecutive misses — a sensitivity fault, not a link fault. Asking
    // once per miss is the storm this cap exists to prevent.
    for (let n = 1; n <= 10; n++) await feedFrame(service, hit(n, 0, 0));
    await vi.advanceTimersByTimeAsync(GRACE_MS + 5);

    expect(new Set(sent).size).toBe(4); // MAX_CONCURRENT_NODETECT_READS
  });

  it('still chases a genuine gap while no-detections are in flight', async () => {
    const { service, sent } = harness({ noDetect: true });

    await feedFrame(service, hit(1, 0, 0));
    await feedFrame(service, hit(3, 0, 0)); // 2 never arrived
    await vi.advanceTimersByTimeAsync(GRACE_MS + 5);

    expect([...new Set(sent)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});
