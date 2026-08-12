import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { schemasEqual, simulateSchemas, splitStatements } from './migration-runner';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'prisma', 'migrations');

function realMigrations(): Array<{ name: string; sql: string; checksum: string }> {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      name: e.name,
      sql: readFileSync(join(MIGRATIONS_DIR, e.name, 'migration.sql'), 'utf8'),
      checksum: '',
    }));
}

describe('splitStatements', () => {
  it('drops line comments without eating the statement after them', () => {
    // 20260812090000_shot_sensor_mm opens with ten lines of "--" before its
    // first ALTER. Treating those as SQL is a syntax error; treating the whole
    // file as one statement silently applies only the first ALTER.
    const sql = `
-- Keeps the board's own reading alongside the calibrated one.
-- x/y are post-offset; a zero would be indistinguishable from dead centre.
ALTER TABLE "shots" ADD COLUMN "sensorXmm" INTEGER;
ALTER TABLE "shots" ADD COLUMN "sensorYmm" INTEGER;
`;
    expect(splitStatements(sql)).toEqual([
      'ALTER TABLE "shots" ADD COLUMN "sensorXmm" INTEGER',
      'ALTER TABLE "shots" ADD COLUMN "sensorYmm" INTEGER',
    ]);
  });

  it('does not split inside a string literal', () => {
    const sql = `INSERT INTO "t" ("a") VALUES ('one; two'); SELECT 1;`;
    expect(splitStatements(sql)).toEqual([
      `INSERT INTO "t" ("a") VALUES ('one; two')`,
      'SELECT 1',
    ]);
  });

  it("keeps a doubled-quote escape intact", () => {
    const sql = `INSERT INTO "t" VALUES ('it''s; fine');`;
    expect(splitStatements(sql)).toEqual([`INSERT INTO "t" VALUES ('it''s; fine')`]);
  });

  it('keeps the PRAGMA guards a table rewrite depends on', () => {
    // Prisma brackets its SQLite rewrites in foreign-key PRAGMAs. Losing them
    // means the DROP TABLE in the middle cascades.
    const rewrite = realMigrations().find((m) => m.name.endsWith('firmware_default'));
    const statements = splitStatements(rewrite!.sql);

    expect(statements[0]).toBe('PRAGMA defer_foreign_keys=ON');
    expect(statements[1]).toBe('PRAGMA foreign_keys=OFF');
    expect(statements.at(-2)).toBe('PRAGMA foreign_keys=ON');
    expect(statements.at(-1)).toBe('PRAGMA defer_foreign_keys=OFF');
  });

  it('parses every shipped migration into at least one statement', () => {
    for (const { name, sql } of realMigrations()) {
      expect(splitStatements(sql).length, name).toBeGreaterThan(0);
    }
  });
});

describe('simulateSchemas', () => {
  const migrations = realMigrations();
  const states = simulateSchemas(migrations);

  it('produces one snapshot per migration', () => {
    expect(states).toHaveLength(migrations.length);
  });

  it('folds a table rewrite through its scratch table', () => {
    // CREATE "new_targets" / DROP "targets" / RENAME. If the rename is not
    // modelled, the scratch table survives as its own entry and every later
    // comparison fails.
    const [state] = simulateSchemas([
      {
        name: 'rewrite',
        checksum: '',
        sql: `
CREATE TABLE "targets" ("id" TEXT NOT NULL, "label" TEXT NOT NULL);
CREATE TABLE "new_targets" (
  "id" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "firmwareVersion" TEXT NOT NULL DEFAULT 'v0.1',
  CONSTRAINT "targets_lane_fkey" FOREIGN KEY ("laneId") REFERENCES "lanes" ("id")
);
DROP TABLE "targets";
ALTER TABLE "new_targets" RENAME TO "targets";
`,
      },
    ]);

    expect([...state.keys()]).toEqual(['targets']);
    expect(state.get('targets')).toEqual(new Set(['id', 'label', 'firmwareversion']));
  });

  it('models a column that is added and later removed', () => {
    // maxStages arrives in 20260805071309 and leaves in 20260805080000.
    // Treating drops as invisible is what made an up-to-date database look
    // like it had never been migrated.
    const lanesAt = (i: number) => states[i].get('lanes')!;
    const added = migrations.findIndex((m) => m.name.endsWith('add_lane_max_stages'));
    const removed = migrations.findIndex((m) => m.name.endsWith('remove_lane_max_stages'));

    expect(lanesAt(added).has('maxstages')).toBe(true);
    expect(lanesAt(removed).has('maxstages')).toBe(false);
  });

  it('resolves a schema-identical pair to the EARLIER migration', () => {
    // 20260807072916_shot_lost rewrites session_stages to change constraints
    // and adds no column, so it leaves the schema exactly as its predecessor
    // did. Two points in history share one shape, and matching cannot tell
    // them apart.
    //
    // The tie must break towards the earlier one, which is what findIndex
    // does. Getting it wrong in this direction re-runs a rewrite that changes
    // no columns — it rebuilds the table, keeps the rows and succeeds.
    // Breaking the other way would SKIP a migration that never ran.
    const commandAddress = migrations.findIndex((m) =>
      m.name.endsWith('add_target_command_address'),
    );
    const shotLost = migrations.findIndex((m) => m.name.endsWith('shot_lost'));

    expect(shotLost).toBe(commandAddress + 1);
    expect(schemasEqual(states[shotLost], states[commandAddress])).toBe(true);
    expect(states.findIndex((s) => schemasEqual(s, states[shotLost]))).toBe(commandAddress);
  });

  it('has exactly the known set of schema-identical pairs', () => {
    // Every collision is a place where matching cannot tell two points in
    // history apart, so the tie-break decides which migrations get re-run.
    // All three below are safe in the earlier direction: a constraint-only
    // rewrite replays fine, and maxStages is added by 20260805071309 then
    // removed by 20260805080000, so replaying that pair lands back where it
    // started.
    //
    // This list is pinned deliberately. A NEW collision means some future
    // migration could be silently skipped on a ledger-less database, and
    // whoever adds it needs to look at this and decide, not discover it on a
    // tablet.
    const collisions: string[] = [];
    for (let i = 0; i < states.length; i += 1) {
      for (let j = i + 1; j < states.length; j += 1) {
        if (schemasEqual(states[i], states[j])) {
          collisions.push(`${migrations[i].name} == ${migrations[j].name}`);
        }
      }
    }

    expect(collisions).toEqual([
      // Adds a DEFAULT and NOT NULL to targets.firmwareVersion; the column
      // itself already exists.
      '20260803074913_drop_lora == 20260803091810_firmware_default',
      // Changes the session -> lane foreign key to ON DELETE CASCADE.
      '20260803132244_session_pause_tracking == 20260805053104_add_cascade_delete_session_lane',
      // lanes.maxStages is added by 20260805071309 and removed again here, so
      // the schema returns to where it was two migrations earlier.
      '20260803132244_session_pause_tracking == 20260805080000_remove_lane_max_stages',
      '20260805053104_add_cascade_delete_session_lane == 20260805080000_remove_lane_max_stages',
      // Rewrites session_stages for constraints only.
      '20260805083811_add_target_command_address == 20260807072916_shot_lost',
    ]);
  });

  it('never leaves a scratch table behind', () => {
    for (const [i, state] of states.entries()) {
      for (const table of state.keys()) {
        expect(table, `${migrations[i].name} leaked ${table}`).not.toMatch(/^new_/);
      }
    }
  });

  it('ends with the tables the application actually queries', () => {
    const final = states.at(-1)!;
    expect([...final.keys()].sort()).toEqual([
      'client_devices',
      'lanes',
      'session_stages',
      'sessions',
      'shooters',
      'shots',
      'targets',
      'users',
    ]);
    expect(final.get('shots')).toContain('sensorxmm');
    expect(final.get('targets')).toContain('commandhost');
  });
});
