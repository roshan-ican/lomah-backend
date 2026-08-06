import { Module } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { SessionsController } from './sessions.controller';
import { SessionRecoveryService } from './session-recovery.service';
import { StageMonitorService } from './stage-monitor.service';
import { TransportModule } from '@/transport/transport.module';

@Module({
  imports: [TransportModule],
  controllers: [SessionsController],
  providers: [SessionsService, SessionRecoveryService, StageMonitorService],
  exports: [SessionsService],
})
export class SessionsModule {}
