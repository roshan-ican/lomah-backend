import { Module } from '@nestjs/common';

import { ShootersController } from './shooters.controller';
import { ShootersService } from './shooters.service';

@Module({
  controllers: [ShootersController],
  providers: [ShootersService],
  exports: [ShootersService],
})
export class ShootersModule {}
