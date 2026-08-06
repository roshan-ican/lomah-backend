import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { HealthController } from './health.controller';
import { SystemService } from './system.service';

@Module({
  controllers: [SystemController, HealthController],
  providers: [SystemService],
})
export class SystemModule {}
