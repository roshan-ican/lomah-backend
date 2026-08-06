import { Module } from '@nestjs/common';
import { TargetsService } from './targets.service';
import { TargetsController } from './targets.controller';
import { SensorModule } from '@/sensor/sensor.module';
// Imported directly, not leaned on through SensorModule: SensorModule imports
// TransportModule but does not re-export it, so TargetCommandService is not
// visible here transitively.
import { TransportModule } from '@/transport/transport.module';

@Module({
  imports: [SensorModule, TransportModule],
  controllers: [TargetsController],
  providers: [TargetsService],
  exports: [TargetsService],
})
export class TargetsModule {}
