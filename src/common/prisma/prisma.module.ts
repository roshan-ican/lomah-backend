import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/** Global so feature modules can inject PrismaService without importing this
 *  module everywhere. Standard Nest practice for a single shared datasource. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
