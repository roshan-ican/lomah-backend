import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { resolveDatabaseUrl } from '../runtime-paths';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly databaseUrl: string;

  constructor() {
    // Passed explicitly rather than left to the ambient DATABASE_URL, because
    // the ambient one is allowed to be relative and Prisma resolves a relative
    // file: path against the working directory. When that misses, the query
    // engine does not fail — it CREATES an empty database and connects to it,
    // so the app boots to an empty range with a valid-looking log. See
    // resolveDatabaseUrl for the anchoring.
    const url = resolveDatabaseUrl(process.env.DATABASE_URL);
    super({ datasources: { db: { url } } });
    this.databaseUrl = url;
  }

  async onModuleInit(): Promise<void> {
    // The schema is already current — prepareDatabase() runs to completion in
    // main.ts before the application is created. Doing it here instead would
    // race the other modules' onModuleInit hooks, which Nest runs
    // concurrently. See common/prisma/prepare-database.ts.
    await this.$connect();
    await this.applyPragmas();
    this.logger.log(`database connected: ${this.databaseUrl}`);
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
