import { Module } from '@nestjs/common';
import { LanesService } from './lanes.service';
import { LanesController } from './lanes.controller';

@Module({
  controllers: [LanesController],
  providers: [LanesService],
})
export class LanesModule {}
