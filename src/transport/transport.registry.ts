import { Inject, Injectable } from '@nestjs/common';
import { merge, share, type Observable } from 'rxjs';

import {
  TARGET_TRANSPORTS,
  type InBoundFrame,
  type TargetRef,
  type TargetTransport,
  type TransportKind,
} from './target-transport.interface';


@Injectable()
export class TransportRegistry {
  private readonly byKind = new Map<TransportKind, TargetTransport>();
  readonly frames$: Observable<InBoundFrame>;

  constructor(@Inject(TARGET_TRANSPORTS) transports: TargetTransport[]) {
    for (const t of transports) this.byKind.set(t.kind, t);
    this.frames$ = merge(...transports.map((t) => t.frames$)).pipe(share());
  }

  private resolve(target: TargetRef): TargetTransport {
    const t = this.byKind.get(target.transport);
    if (!t) throw new Error(`No transport for kind "${target.transport}" ("${target.label}")`);
    return t;
  }

  send(target: TargetRef, frame: Buffer): Promise<void> {
    return this.resolve(target).send(target, frame);
  }

  status(): Record<string, boolean> {
    return Object.fromEntries([...this.byKind].map(([k, t]) => [k, t.isReady()]));
  }
}