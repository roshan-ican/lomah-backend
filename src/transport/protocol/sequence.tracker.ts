/**
 * Wrap-safe per-target bullet sequence tracking.
 *
 * PORTED from `backend/services/sensor-sequence.ts`, with one change: state is
 * keyed by TARGET id rather than lane id, because a lane now holds several
 * targets and each carries its own counter.
 *
 * The comment that follows is the single most expensive lesson in the original
 * codebase — keep it:
 *
 *   The sensor's bullet counter is a single byte (frame offset [2]), so it
 *   rolls over every 256 shots. Deduplicating on that raw byte silently
 *   discards every shot past the first wrap: bullet 0 of the second lap
 *   collides with bullet 0 of the first and is rejected as a duplicate for the
 *   rest of the session.
 *
 * This class unwraps the byte into a monotonic absolute sequence, dedups on
 * that, and reports which numbers were skipped so the caller can ask the target
 * to resend them.
 *
 * Deliberately pure — no I/O, no sockets, no Nest decorators — so it can be
 * exercised by a plain test and can never create a circular import with the
 * transport layer. Gap detection over LoRa matters MORE than over WiFi, since
 * LoRa has no link-layer retry to hide losses.
 */

const RANGE = 256;
/** A jump larger than half the range is a rollover, not ordinary reordering. */
const HALF = RANGE / 2;
/** How far back individual numbers are kept for duplicate detection. */
const SEEN_WINDOW = 128;

interface TargetState {
  /** Highest absolute seen; the anchor every new byte is resolved against. */
  maxAbsolute: number | undefined;
  seen: Set<number>;
}

export interface Observation {
  /** Monotonic sequence number, continuous across byte rollovers. */
  absolute: number;
  /** This exact bullet has already been processed for this target. */
  duplicate: boolean;
  /** Absolute numbers skipped by this observation, ascending. */
  gaps: number[];
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export class SequenceTracker {
  private readonly byTarget = new Map<string, TargetState>();

  private stateFor(targetId: string): TargetState {
    let state = this.byTarget.get(targetId);
    if (!state) {
      state = { maxAbsolute: undefined, seen: new Set() };
      this.byTarget.set(targetId, state);
    }
    return state;
  }

  /** Record a raw bullet byte and classify it. Does not mutate on a duplicate. */
  observe(targetId: string, rawBullet: number): Observation {
    const state = this.stateFor(targetId);
    const raw = mod(Math.trunc(rawBullet), RANGE);

    let absolute: number;
    if (state.maxAbsolute === undefined) {
      absolute = raw;
    } else {
      // Resolve the byte onto whichever lap puts it closest to where we already
      // are: a late bullet lands just behind the anchor, a rollover just ahead.
      const base = state.maxAbsolute - mod(state.maxAbsolute, RANGE);
      absolute = base + raw;
      if (absolute - state.maxAbsolute > HALF) absolute -= RANGE;
      else if (state.maxAbsolute - absolute > HALF) absolute += RANGE;
      // Only reachable if the very first bullets arrive badly out of order.
      if (absolute < 0) absolute = raw;
    }

    if (state.seen.has(absolute)) {
      return { absolute, duplicate: true, gaps: [] };
    }

    const gaps: number[] = [];
    if (state.maxAbsolute !== undefined && absolute > state.maxAbsolute + 1) {
      for (let n = state.maxAbsolute + 1; n < absolute; n++) {
        if (!state.seen.has(n)) gaps.push(n);
      }
    }

    state.seen.add(absolute);
    if (state.maxAbsolute === undefined || absolute > state.maxAbsolute) {
      state.maxAbsolute = absolute;
    }

    // Keep the set bounded — a long relay would otherwise grow it without limit.
    const floor = state.maxAbsolute - SEEN_WINDOW;
    if (floor > 0) {
      for (const n of state.seen) if (n < floor) state.seen.delete(n);
    }

    return { absolute, duplicate: false, gaps };
  }

  /** True once this target has recorded the given absolute number. */
  hasSeen(targetId: string, absolute: number): boolean {
    return this.byTarget.get(targetId)?.seen.has(absolute) ?? false;
  }

  reset(targetId: string): void {
    this.byTarget.delete(targetId);
  }

  resetAll(): void {
    this.byTarget.clear();
  }

  /** Test/diagnostic hook — how many numbers a target is currently retaining. */
  seenSize(targetId: string): number {
    return this.byTarget.get(targetId)?.seen.size ?? 0;
  }
}
