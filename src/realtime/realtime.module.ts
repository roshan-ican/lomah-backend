import { Module } from '@nestjs/common';

import { AuthModule } from '@/auth/auth.module';
import { SensorModule } from '@/sensor/sensor.module';
import { SessionsModule } from '@/sessions/sessions.module';
import { TargetsModule } from '@/targets/targets.module';
import { LaneSchedulesModule } from '@/lane-schedules/lane-schedules.module';

import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [
    SensorModule,
    SessionsModule,
    TargetsModule,
    AuthModule,
    LaneSchedulesModule,
  ],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
