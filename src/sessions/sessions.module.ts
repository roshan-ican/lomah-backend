import { Module } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { SessionsController } from './sessions.controller';
import { SessionRecoveryService } from './session-recovery.service';
import { StageMonitorService } from './stage-monitor.service';
import { TransportModule } from '@/transport/transport.module';
import { LaneSchedulesModule } from '@/lane-schedules/lane-schedules.module';

@Module({
  imports: [TransportModule, LaneSchedulesModule],
  controllers: [SessionsController],
  providers: [SessionsService, SessionRecoveryService, StageMonitorService],
  exports: [SessionsService],
})
export class SessionsModule {}
