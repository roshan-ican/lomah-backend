import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Logger } from '@nestjs/common';

import { MIGRATIONS_DIR } from '../runtime-paths';

/**
 * Applies pending Prisma migrations without the Prisma CLI.
 *
 * The desktop build used to shell out to `prisma migrate deploy` on every
 * launch, which meant shipping node_modules/prisma (90 MB) and
 * @prisma/engines/schema-engine-windows.exe (76 MB) inside the installer — 166
 * MB of tooling to replay ~100 KB of SQL that we already have on disk. Reading
 * the .sql files and running them through the query engine we are shipping
 * anyway costs nothing and removes both.
 *
 * The bookkeeping table is Prisma's own, with Prisma's own column set and
 * checksums, so a developer can still run `prisma migrate dev` against a
 * database this migrated and the CLI will agree about what has been applied.
 */

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

/** Prisma's SQLite DDL for the ledger, reproduced exactly. */
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id"                  TEXT PRIMARY KEY NOT NULL,
  "checksum"            TEXT NOT NULL,
  "finished_at"         DATETIME,
  "migration_name"      TEXT NOT NULL,
  "logs"                TEXT,
  "rolled_back_at"      DATETIME,
  "started_at"          DATETIME NOT NULL DEFAULT current_timestamp,
  "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

interface MigrationClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export async function runMigrations(
  prisma: MigrationClient,
  logger: Logger,
  databaseFile: string | null,
): Promise<void> {
  const available = readMigrations(logger);
  if (available.length === 0) return;

  await prisma.$executeRawUnsafe(LEDGER_DDL);

  const applied = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
    'SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL',
  );
  const done = new Set(applied.map((row) => row.migration_name));
  const pending = available.filter((m) => !done.has(m.name));

  if (pending.length === 0) {
    logger.log(`schema up to date (${available.length} migrations applied)`);
    return;
  }

  // A half-applied table-redefine migration leaves the database wedged in a
  // way no amount of retrying fixes, and on a range tablet there is no
  // developer standing by to unpick it. Snapshot first, restore on failure.
  const backup = await takeBackup(prisma, databaseFile, logger);

  logger.log(`applying ${pending.length} migration(s)`);

  try {
    for (const migration of pending) {
      await applyOne(prisma, migration, logger);
    }
  } catch (err) {
    restore(backup, databaseFile, logger);
    throw err;
  }

  if (backup) rmSync(backup, { force: true });
  logger.log(`schema up to date (${available.length} migrations applied)`);
}

async function applyOne(
  prisma: MigrationClient,
  migration: MigrationFile,
  logger: Logger,
): Promise<void> {
  const statements = splitStatements(migration.sql);
  const id = randomUUID();

  await prisma.$executeRawUnsafe(
    'INSERT INTO "_prisma_migrations" ("id","checksum","migration_name","started_at","applied_steps_count") VALUES (?,?,?,current_timestamp,0)',
    id,
    migration.checksum,
    migration.name,
  );

  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement);
  }

  // Only now is it applied. A crash between the two writes leaves a row with a
  // null finished_at, which both this runner and the Prisma CLI read as "not
  // applied" — the migration is retried rather than skipped.
  await prisma.$executeRawUnsafe(
    'UPDATE "_prisma_migrations" SET "finished_at" = current_timestamp, "applied_steps_count" = ? WHERE "id" = ?',
    statements.length,
    id,
  );

  logger.log(`  applied ${migration.name} (${statements.length} statements)`);
}

function readMigrations(logger: Logger): MigrationFile[] {
  if (!existsSync(MIGRATIONS_DIR)) {
    logger.warn(`no migrations directory at ${MIGRATIONS_DIR} — skipping schema check`);
    return [];
  }

  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    // Prisma names directories <timestamp>_<label>, so lexical order is
    // chronological order. This is the same ordering the CLI uses.
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = join(MIGRATIONS_DIR, entry.name, 'migration.sql');
      if (!existsSync(file)) return [];
      const sql = readFileSync(file, 'utf8');
      return [
        {
          name: entry.name,
          sql,
          checksum: createHash('sha256').update(sql).digest('hex'),
        },
      ];
    });
}

/**
 * Splits a migration file into statements.
 *
 * Splitting on ";" alone is wrong for these files and the failures are silent:
 * 20260812090000_shot_sensor_mm opens with a ten-line "--" comment block, and
 * 20260803091810_firmware_default embeds a string literal
 * (coalesce("firmwareVersion", 'LOMAH Dev Board v0.1')). Comments are dropped
 * and quoted regions are passed through untouched, including SQL's doubled-
 * quote escape.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      buf += ch;
      i += 1;
      while (i < sql.length) {
        buf += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            buf += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === ';') {
      const statement = buf.trim();
      if (statement) out.push(statement);
      buf = '';
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

async function takeBackup(
  prisma: MigrationClient,
  databaseFile: string | null,
  logger: Logger,
): Promise<string | null> {
  if (!databaseFile || !existsSync(databaseFile)) return null;
  if (statSync(databaseFile).size === 0) return null;

  const backup = `${databaseFile}.pre-migrate`;
  try {
    // Fold the write-ahead log back into the main file first, and await it —
    // copying a WAL database without its -wal sidecar produces a snapshot that
    // is missing every committed transaction still sitting in the log. A
    // "backup" that silently loses the most recent range session is worse than
    // no backup at all.
    await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(databaseFile, backup);
    return backup;
  } catch (err) {
    logger.warn(`could not back up the database before migrating: ${String(err)}`);
    return null;
  }
}

function restore(backup: string | null, databaseFile: string | null, logger: Logger): void {
  if (!backup || !databaseFile) {
    logger.error('migration failed and no backup was taken — database left as-is');
    return;
  }
  try {
    copyFileSync(backup, databaseFile);
    rmSync(`${databaseFile}-wal`, { force: true });
    rmSync(`${databaseFile}-shm`, { force: true });
    rmSync(backup, { force: true });
    logger.error('migration failed — database restored from the pre-migration backup');
  } catch (err) {
    logger.error(
      `migration failed AND the restore failed: ${String(err)}. ` +
        `A copy of the database as it was before migrating is at ${backup}`,
    );
  }
}
