import { Module } from '@nestjs/common';
import { TargetsService } from './targets.service';
import { TargetsController } from './targets.controller';
import { TargetLiftService } from './target-lift.service';
import { StageProgramService } from './stage-program.service';
import { SensorModule } from '@/sensor/sensor.module';
// Imported directly, not leaned on through SensorModule: SensorModule imports
// TransportModule but does not re-export it, so TargetCommandService is not
// visible here transitively.
import { TransportModule } from '@/transport/transport.module';
import { SessionsModule } from '@/sessions/sessions.module';

@Module({
  imports: [SensorModule, TransportModule, SessionsModule],
  controllers: [TargetsController],
  providers: [TargetsService, TargetLiftService, StageProgramService],
  exports: [TargetsService],
})
export class TargetsModule {}
