import { Module } from '@nestjs/common';

import { LaneSchedulesController } from './lane-schedules.controller';
import { LaneSchedulesService } from './lane-schedules.service';

@Module({
  controllers: [LaneSchedulesController],
  providers: [LaneSchedulesService],
  exports: [LaneSchedulesService],
})
export class LaneSchedulesModule {}
