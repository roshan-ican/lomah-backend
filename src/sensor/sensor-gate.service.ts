import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject, type Observable } from 'rxjs';

export interface SensorGateStatus {
  adminHeld: boolean;
  accepting: boolean;
}

/**
 * The admin's range-wide "cease fire" flag. Ported from the old backend's
 * sensor.gate.ts — deliberately a STATUS SIGNAL, not something that blocks
 * ingestion: real per-shot gating is the active-stage check already in
 * SensorService.persistHit. This is what the admin UI banner reads, and what
 * an operator toggles by hand; it is range-wide, not per-lane, which is why
 * SessionsService.pause() does NOT set this (that would report the whole
 * range held because one lane paused).
 */
@Injectable()
export class SensorGateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SensorGateService.name);
  private adminHeld = true;

  private readonly changes = new Subject<SensorGateStatus>();
  readonly changes$: Observable<SensorGateStatus> = this.changes.asObservable();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.adminHeld = this.config.get<string>('SENSOR_DEFAULT_HELD', 'true') !== 'false';
  }

  onModuleDestroy(): void {
    this.changes.complete();
  }

  isAccepting(): boolean {
    return !this.adminHeld;
  }

  status(): SensorGateStatus {
    return { adminHeld: this.adminHeld, accepting: this.isAccepting() };
  }

  setHeld(held: boolean): SensorGateStatus {
    this.adminHeld = held;
    this.logger.log(held ? 'Admin STOP — sensor held' : 'Admin RELEASE — sensor live');

    const status = this.status();
    this.changes.next(status);
    return status;
  }
}
