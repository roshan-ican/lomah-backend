import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.applyPragmas();
    this.logger.log('database connected');
  }

  async onModuleDestroy(): Promise<void> {

    try {
      await this.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
      this.logger.warn(`wal checkpoint on shutdown failed: ${String(err)}`);
    }
    await this.$disconnect();
  }


  private async applyPragmas(): Promise<void> {
    const [mode] = await this.$queryRawUnsafe<Array<{ journal_mode: string }>>(
      'PRAGMA journal_mode = WAL',
    );

    await this.$executeRawUnsafe('PRAGMA synchronous = NORMAL');

    await this.$queryRawUnsafe('PRAGMA busy_timeout = 5000');

    this.logger.log(`journal_mode=${mode?.journal_mode ?? 'unknown'}`);
  }
}
