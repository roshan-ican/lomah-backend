import { Module } from '@nestjs/common';

import { TransportModule } from '@/transport/transport.module';
import { SessionsModule } from '@/sessions/sessions.module';

import { SensorService } from './sensor.service';
import { TargetResolver } from './target-resolver.service';
import { SensorGateService } from './sensor-gate.service';
import { SensorGateController } from './sensor-gate.controller';
import { DebugController } from './debug.controller';

/**
 * Attribution and ingestion. Sits between the transport layer (which knows
 * sockets but not sessions) and the domain (which knows sessions but not
 * sockets).
 *
 * TargetResolver is exported because TargetsService must invalidate its cache
 * whenever a target's ipAddress changes — a stale entry silently attributes
 * shots to the wrong target after a board swap.
 *
 * SensorGateService lives here rather than in SessionsModule: SensorModule
 * already imports SessionsModule (SensorService depends on SessionsService),
 * so putting the gate on the sessions side would need SessionsModule to
 * import SensorModule right back — a cycle. SensorService already listens to
 * sessions.events$ for other reasons, so releasing the gate on
 * session:started/session:resumed happens there instead.
 */
@Module({
  imports: [TransportModule, SessionsModule],
  controllers: [SensorGateController, DebugController],
  providers: [SensorService, TargetResolver, SensorGateService],
  exports: [TargetResolver, SensorService, SensorGateService],
})
export class SensorModule {}
