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

/**
 * Carries the backup path out to the caller, because restoring it has to
 * happen after the client disconnects — see prepare-database.ts.
 */
/**
 * The database holds a schema that belongs to no point in this history — an
 * early prototype build, or one produced by a tool that left no ledger.
 *
 * Signals the caller to move the file aside and start again rather than
 * refusing to boot. An offline range tablet with an app that will not open is
 * worse than one that opens empty, and the old database is renamed rather than
 * deleted, so the decision stays reversible.
 */
export class UnrecognisedSchemaError extends Error {
  constructor() {
    super('database schema matches no known migration');
    this.name = 'UnrecognisedSchemaError';
  }
}

export class MigrationFailedError extends Error {
  constructor(
    readonly cause: unknown,
    readonly backupPath: string | null,
  ) {
    super(`migration failed: ${String(cause)}`);
    this.name = 'MigrationFailedError';
  }
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

  // An empty ledger does NOT mean an empty database.
  //
  // `prisma db push` builds a schema without recording anything, and so did
  // several earlier builds of this app — so a tablet in the field can be
  // carrying the complete, correct set of tables and a completely blank
  // _prisma_migrations. Trusting the ledger alone there means replaying
  // CREATE TABLE "lanes" over a live range database, which is precisely the
  // crash this replaces. Look at the schema before deciding.
  const schema = done.size === 0 ? await readSchema(prisma) : null;
  const baselining = schema !== null && schema.size > 0;

  // How far along the chain this database already is: the migration whose
  // simulated schema is exactly what is on disk. Everything up to and
  // including it must have run to produce that shape, so it is recorded rather
  // than replayed; everything after it is applied normally.
  let frontier = -1;
  if (baselining) {
    logger.warn(
      'database has tables but no migration history — reconciling against the actual schema',
    );

    // findIndex, so a tie breaks towards the EARLIER migration. Two points in
    // this history do share a shape — 20260807072916 rewrites session_stages
    // to change constraints without touching a column — and matching cannot
    // tell them apart. Choosing the earlier one re-runs a rewrite that adds no
    // columns, which rebuilds the table, keeps its rows and succeeds.
    // Choosing the later one would skip a migration that never ran.
    const expected = simulateSchemas(pending);
    frontier = expected.findIndex((candidate) => schemasEqual(candidate, schema));

    if (frontier === -1) {
      // A schema from before this history existed — an early prototype build,
      // or one built by a tool that left no ledger. There is no safe place to
      // resume from, but refusing to start is the wrong answer on a range
      // tablet: it leaves an operator with an app that will not open and no
      // way to fix it. Move the database aside instead and begin again. The
      // old file is renamed, never deleted, so nothing is lost and a developer
      // can still recover it later.
      // Diagnosed here, quarantined by the caller: renaming the file while the
      // query engine still holds it open fails with EPERM on Windows, the same
      // trap that once turned a recoverable migration error into an
      // unrecoverable one.
      for (const line of describeMismatch(schema, expected, pending)) {
        logger.error(line);
      }
      throw new UnrecognisedSchemaError();
    }
    logger.warn(`schema matches ${pending[frontier].name}; recording everything up to it`);
  }

  // A half-applied table-redefine migration leaves the database wedged in a
  // way no amount of retrying fixes, and on a range tablet there is no
  // developer standing by to unpick it. Snapshot first, restore on failure.
  const backup = await takeBackup(prisma, databaseFile, logger);

  try {
    let recorded = 0;
    let executed = 0;

    for (const [index, migration] of pending.entries()) {
      if (index <= frontier) {
        await record(prisma, migration, 0);
        recorded += 1;
        continue;
      }

      await applyOne(prisma, migration, logger);
      executed += 1;
    }

    if (recorded > 0) {
      logger.warn(`recorded ${recorded} migration(s) as already present in the schema`);
    }
    if (executed > 0) {
      logger.log(`applied ${executed} migration(s)`);
    }
  } catch (err) {
    throw new MigrationFailedError(err, backup);
  }

  if (backup) rmSync(backup, { force: true });
  logger.log(`schema up to date (${available.length} migrations applied)`);
}

// ── Reconciling a ledger-less database against its own schema ────────────────

export type Schema = Map<string, Set<string>>;

/** Every user table and its columns, lowercased for comparison. */
async function readSchema(prisma: MigrationClient): Promise<Schema> {
  const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations'",
  );

  const schema: Schema = new Map();
  for (const { name } of tables) {
    const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info("${name.replace(/"/g, '""')}")`,
    );
    schema.set(name.toLowerCase(), new Set(columns.map((c) => c.name.toLowerCase())));
  }
  return schema;
}

/**
 * Replays the migrations as pure schema arithmetic, returning the shape the
 * database should have after each one.
 *
 * Nothing simpler works, and both simpler things were tried. Asking "are this
 * migration's new columns present?" gives a false NEGATIVE for early
 * migrations, whose columns later migrations legitimately drop — the very
 * first one creates a `lanes` that no current database still has. Scanning
 * from the newest backwards instead gives a false POSITIVE: 20260807072916
 * rewrites `session_stages` to change constraints without adding a single
 * column, so it looks satisfied on a database where it never ran, and
 * baselining past it would silently skip the migration before it and leave
 * `targets.commandHost` missing.
 *
 * Drops are the whole difficulty, and simulating them removes it. Comparing a
 * database against a full expected shape is exact: it either equals the state
 * after migration N or it does not.
 *
 * The vocabulary is small because Prisma's SQLite output is small. A table
 * rewrite is always CREATE "new_x" / DROP "x" / RENAME "new_x" TO "x", and
 * everything else is CREATE TABLE, ADD COLUMN, DROP TABLE or an index.
 */
export function simulateSchemas(migrations: MigrationFile[]): Schema[] {
  const state: Schema = new Map();
  const snapshots: Schema[] = [];

  for (const migration of migrations) {
    for (const statement of splitStatements(migration.sql)) {
      applyToSchema(state, statement);
    }
    snapshots.push(new Map([...state].map(([t, c]) => [t, new Set(c)])));
  }

  return snapshots;
}

function applyToSchema(state: Schema, statement: string): void {
  const create = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s*\(/i.exec(statement);
  if (create) {
    const body = balancedBody(statement, create[0].length - 1);
    const columns = new Set<string>();
    for (const line of body.split('\n')) {
      // A column definition opens with a quoted name. Table constraints open
      // with a keyword (CONSTRAINT, PRIMARY KEY, UNIQUE), so demanding the
      // quote first excludes them.
      const column = /^\s*"([^"]+)"\s+\S/.exec(line);
      if (column) columns.add(column[1].toLowerCase());
    }
    state.set(create[1].toLowerCase(), columns);
    return;
  }

  const drop = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i.exec(statement);
  if (drop) {
    state.delete(drop[1].toLowerCase());
    return;
  }

  const rename = /^ALTER\s+TABLE\s+"([^"]+)"\s+RENAME\s+TO\s+"([^"]+)"/i.exec(statement);
  if (rename) {
    const from = rename[1].toLowerCase();
    const to = rename[2].toLowerCase();
    const columns = state.get(from);
    if (columns) {
      state.delete(from);
      state.set(to, columns);
    }
    return;
  }

  const addColumn = /^ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+"([^"]+)"/i.exec(statement);
  if (addColumn) {
    state.get(addColumn[1].toLowerCase())?.add(addColumn[2].toLowerCase());
    return;
  }

  const dropColumn = /^ALTER\s+TABLE\s+"([^"]+)"\s+DROP\s+COLUMN\s+"([^"]+)"/i.exec(statement);
  if (dropColumn) {
    state.get(dropColumn[1].toLowerCase())?.delete(dropColumn[2].toLowerCase());
  }

  // Indexes, PRAGMAs, UPDATEs and INSERTs change no shape.
}

/**
 * Explains why a database matched nothing, in terms someone can act on.
 *
 * "7 tables, no match" says only that something is wrong. The closest point in
 * the history and the exact tables and columns that differ say whether this is
 * a schema from before the history began, or a bug in the simulation above —
 * and those need opposite responses.
 */
export function describeMismatch(
  live: Schema,
  expected: Schema[],
  migrations: MigrationFile[],
): string[] {
  let best = 0;
  let bestCost = Number.POSITIVE_INFINITY;

  for (const [index, candidate] of expected.entries()) {
    const cost = differences(live, candidate).length;
    if (cost < bestCost) {
      bestCost = cost;
      best = index;
    }
  }

  const diffs = differences(live, expected[best]);
  return [
    `database schema matches no point in the ${migrations.length}-migration history`,
    `  closest is ${migrations[best].name} (${diffs.length} difference(s)):`,
    ...diffs.slice(0, 12).map((d) => `    ${d}`),
    ...(diffs.length > 12 ? [`    …and ${diffs.length - 12} more`] : []),
  ];
}

function differences(live: Schema, expected: Schema): string[] {
  const out: string[] = [];
  const tables = new Set([...live.keys(), ...expected.keys()]);

  for (const table of [...tables].sort()) {
    const here = live.get(table);
    const want = expected.get(table);

    if (!here) {
      out.push(`missing table "${table}"`);
      continue;
    }
    if (!want) {
      out.push(`unexpected table "${table}"`);
      continue;
    }
    for (const column of [...want].sort()) {
      if (!here.has(column)) out.push(`"${table}" is missing column "${column}"`);
    }
    for (const column of [...here].sort()) {
      if (!want.has(column)) out.push(`"${table}" has unexpected column "${column}"`);
    }
  }
  return out;
}

/** Same tables, same columns. Indexes and constraints are out of scope: SQLite
 *  does not expose them through table_info, and they never decide whether a
 *  migration ran. */
export function schemasEqual(a: Schema, b: Schema): boolean {
  if (a.size !== b.size) return false;
  for (const [table, columns] of a) {
    const other = b.get(table);
    if (!other || other.size !== columns.size) return false;
    for (const column of columns) {
      if (!other.has(column)) return false;
    }
  }
  return true;
}

/** The text inside the parenthesis at `open`, honouring nesting and quotes. */
function balancedBody(sql: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;

  for (let i = open; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return '';
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

/** Writes a finished ledger row without running anything — used when the
 *  schema already contains everything the migration would have created. */
async function record(
  prisma: MigrationClient,
  migration: MigrationFile,
  steps: number,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "_prisma_migrations" ("id","checksum","migration_name","started_at","finished_at","applied_steps_count") VALUES (?,?,?,current_timestamp,current_timestamp,?)',
    randomUUID(),
    migration.checksum,
    migration.name,
    steps,
  );
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

/**
 * Puts the pre-migration database back.
 *
 * MUST be called with the Prisma client already disconnected. The query engine
 * keeps -wal and -shm open for as long as it holds the connection, so deleting
 * them from a live process fails with EPERM on Windows — and it fails AFTER the
 * main file has been copied back, leaving a restored database beside a
 * write-ahead log belonging to the attempt that was just undone. That is a
 * worse state than either outcome on its own, and it is what turned a
 * recoverable migration error into an unrecoverable one in the field.
 */
export function restoreBackup(
  backup: string | null,
  databaseFile: string | null,
  logger: Logger,
): void {
  if (!backup || !databaseFile) {
    logger.error('migration failed and no backup was taken — database left as-is');
    return;
  }
  try {
    // Sidecars first. They describe the failed attempt, and a stale -wal
    // applied over a restored main file is exactly the corruption being
    // avoided here.
    rmSync(`${databaseFile}-wal`, { force: true });
    rmSync(`${databaseFile}-shm`, { force: true });
    copyFileSync(backup, databaseFile);
    rmSync(backup, { force: true });
    logger.error('migration failed — database restored from the pre-migration backup');
  } catch (err) {
    logger.error(
      `migration failed AND the restore failed: ${String(err)}. ` +
        `A copy of the database as it was before migrating is at ${backup}`,
    );
  }
}
