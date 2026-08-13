import { renameSync } from 'node:fs';

import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { resolveDatabaseUrl } from '../runtime-paths';
import { ensureBootstrapUser } from './first-run';
import {
  MigrationFailedError,
  restoreBackup,
  runMigrations,
  UnrecognisedSchemaError,
} from './migration-runner';

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
  const databaseFile = databaseFileFrom(url);

  try {
    await attempt(url, databaseFile, logger);
  } catch (err) {
    if (!(err instanceof UnrecognisedSchemaError)) throw err;

    // The schema belongs to no point in this history — a prototype build, or
    // one produced by a tool that left no ledger. Refusing to boot is the
    // wrong answer on a range tablet: it leaves an operator with an app that
    // will not open and nothing they can do about it. Move the file aside and
    // start again, once.
    //
    // Only reachable after attempt() has disconnected: renaming a database the
    // query engine still holds open fails with EPERM on Windows.
    quarantine(databaseFile, logger);
    await attempt(url, databaseFile, logger);
  }
}

async function attempt(
  url: string,
  databaseFile: string | null,
  logger: Logger,
): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    await prisma.$connect();

    // WAL is a property of the database file and persists once set; the
    // busy_timeout is per-connection and matters here because a migration
    // holds a write lock for as long as a table rebuild takes.
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000');

    await runMigrations(prisma, logger, databaseFile);
    await ensureBootstrapUser(prisma, logger);
  } catch (err) {
    if (err instanceof MigrationFailedError) {
      // Disconnect BEFORE restoring. The query engine holds -wal and -shm open
      // for the life of the connection, so a restore attempted from here fails
      // on Windows halfway through and leaves the database in a state that is
      // neither the old one nor the new one.
      await prisma.$disconnect();
      restoreBackup(err.backupPath, databaseFile, logger);
      throw err.cause;
    }
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Renames an unusable database out of the way. Never deletes it.
 *
 * What is being moved may be the only copy of a range's records. It is not
 * this code's decision to discard that, and a rename keeps it recoverable by
 * anyone who later works out what schema it holds — while still letting the
 * app open today.
 */
function quarantine(databaseFile: string | null, logger: Logger): void {
  if (!databaseFile) {
    throw new Error('cannot start: the database schema is unrecognised and has no file to move');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const moved = `${databaseFile}.unrecognised-${stamp}`;

  try {
    renameSync(databaseFile, moved);
    // The sidecars belong to the file that just moved; leaving them behind
    // would have SQLite replay them over the new database.
    for (const suffix of ['-wal', '-shm']) {
      try {
        renameSync(`${databaseFile}${suffix}`, `${moved}${suffix}`);
      } catch {
        // Absent is the normal case after a clean shutdown.
      }
    }
  } catch (err) {
    throw new Error(
      `The database schema is unrecognised and it could not be moved aside: ${String(err)}. ` +
        `Move ${databaseFile} somewhere safe by hand and start the app again.`,
    );
  }

  logger.error(`unrecognised database moved to ${moved}`);
  logger.error('starting with a new, empty database — the old one is kept, not deleted');
}

/** The on-disk path behind a `file:` URL, so the migration runner can snapshot
 *  it. Anything else (a real database server) has no file to copy. */
export function databaseFileFrom(url: string): string | null {
  if (!url.startsWith('file:')) return null;
  const withoutScheme = url.slice('file:'.length);
  const at = withoutScheme.indexOf('?');
  return at === -1 ? withoutScheme : withoutScheme.slice(0, at);
}
