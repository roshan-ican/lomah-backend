import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { resolveDatabaseUrl } from '../runtime-paths';
import { ensureBootstrapUser } from './first-run';
import { runMigrations } from './migration-runner';

/**
 * Brings the database up to date BEFORE the Nest application is created.
 *
 * The obvious home for this is PrismaService.onModuleInit, and it does not
 * work: Nest runs onModuleInit for every provider in a module concurrently
 * (Promise.all) and offers no ordering guarantee across modules, so
 * SessionRecoveryService.reconcile() fires its first findMany while the
 * migrations are still running. On a fresh install that is a hard crash —
 * "The table `main.sessions` does not exist" — and on an upgrade it would be
 * an intermittent one, which is worse.
 *
 * Doing it here, on a throwaway connection, restores the property the old
 * design had for free: `prisma migrate deploy` ran as a separate process that
 * had to exit before the server was spawned. Nothing in the application can
 * observe a half-migrated schema, because nothing in the application exists
 * yet.
 */
export async function prepareDatabase(): Promise<void> {
  const logger = new Logger('Database');
  const url = resolveDatabaseUrl(process.env.DATABASE_URL);
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    await prisma.$connect();

    // WAL is a property of the database file and persists once set; the
    // busy_timeout is per-connection and matters here because a migration
    // holds a write lock for as long as a table rebuild takes.
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000');

    await runMigrations(prisma, logger, databaseFileFrom(url));
    await ensureBootstrapUser(prisma, logger);
  } finally {
    await prisma.$disconnect();
  }
}

/** The on-disk path behind a `file:` URL, so the migration runner can snapshot
 *  it. Anything else (a real database server) has no file to copy. */
export function databaseFileFrom(url: string): string | null {
  if (!url.startsWith('file:')) return null;
  const withoutScheme = url.slice('file:'.length);
  const at = withoutScheme.indexOf('?');
  return at === -1 ? withoutScheme : withoutScheme.slice(0, at);
}
