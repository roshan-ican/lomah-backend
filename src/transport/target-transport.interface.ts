import { Observable } from "rxjs";

// Single value on purpose, not a leftover. WIFI is the confirmed transport —
// one router, every target a WiFi client on it. A LoRa path was scaffolded
// here and removed; if distance ever forces the question again, this is
// where a second kind would go, alongside a second class implementing
// TargetTransport below and a second entry in TARGET_TRANSPORTS.
export type TransportKind = "WIFI";

export interface TargetRef {
  id: string;
  laneId: string;
  label: string;
  transport: TransportKind;
  ipAddress: string;
}

export interface InBoundFrame {
  sourceKey: string;
  transport: TransportKind;
  command: number;
  bulletCounter: number;
  rawX: number;
  rawY: number;
  /** Bytes 2..6 verbatim, copied. See DecodedFrame.payload in frame.codec.ts —
   *  this is that same field, carried across the transport boundary for
   *  commands that aren't HIT-shaped (wiper reads/writes, self-test). */
  payload: readonly number[];
  /** All nine wire bytes verbatim, copied — what the admin console displays
   *  as the actual frame (see DecodedFrame.bytes in frame.codec.ts). */
  bytes: readonly number[];
  receivedAt: Date;
}

export interface TargetTransport {
  readonly kind: TransportKind;
  send(target: TargetRef, frame: Buffer): Promise<void>;
  readonly frames$: Observable<InBoundFrame>;
  // Synchronous on purpose — it just reads a flag already sitting in memory
  // (set the moment the socket binds). No I/O happens here, so there is
  // nothing to await.
  isReady(): boolean;
}

export const TARGET_TRANSPORTS = Symbol("TARGET_TRANSPORTS");

/** How a target identifies itself on the way back in — its source IP. Kept as
 *  its own function rather than inlined, so TargetCommandService never reaches
 *  into TargetRef's shape directly. */
export function sourceKeyOf(target: TargetRef): string {
  return normalizeIp(target.ipAddress);
}

export function normalizeIp(ip: string | null | undefined): string {
  return (ip ?? "").replace(/^.*:/, "").trim();
}
