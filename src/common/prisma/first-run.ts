import * as bcrypt from 'bcryptjs';

import type { Logger } from '@nestjs/common';

/**
 * Creates the default accounts an install needs to be usable.
 *
 * prisma/seed.ts cannot do this job for a packaged install: it runs under tsx,
 * which is a dev dependency and is not in the bundle. Without a replacement, a
 * fresh install comes up with a working backend, a correct schema, and nobody
 * who can log in — and since the range is offline there is no way to fix that
 * from outside the tablet.
 *
 * Each account is tracked separately in _lomah_bootstrap, and that is the
 * whole point of the table. The obvious guard — "only seed when the users
 * table is empty" — silently breaks the moment a new default is added: a
 * machine that already had `superadmin` from an earlier build has a non-empty
 * table, so it skips everything and never gains `admin`, while a machine
 * installed fresh gets both. That is exactly the split seen in the field, and
 * it is invisible in the log because the skip path says nothing.
 *
 * Recording an account also stops it coming back. Deleting a default account
 * is a reasonable thing for a SUPER_ADMIN to do when hardening a range, and
 * recreating it on the next launch — with its published password — would
 * quietly undo that. Once an account is in the table it is never created
 * again, whether or not it still exists.
 */

interface BootstrapClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  user: {
    findUnique(args: { where: { username: string } }): Promise<unknown | null>;
    create(args: {
      data: { username: string; passwordHash: string; role: 'SUPER_ADMIN' | 'ADMIN' };
    }): Promise<unknown>;
  };
}

interface DefaultAccount {
  username: string;
  password: string;
  role: 'SUPER_ADMIN' | 'ADMIN';
}

const DEFAULT_USERNAME = 'superadmin';
const DEFAULT_PASSWORD = 'changeme123';
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin123';

/** Lives in the database rather than beside it, so it travels with a database
 *  copied onto another tablet — which is how a range gets provisioned. */
const MARKER_DDL = `
CREATE TABLE IF NOT EXISTS "_lomah_bootstrap" (
  "account"    TEXT PRIMARY KEY NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT current_timestamp
)`;

function defaultAccounts(): DefaultAccount[] {
  return [
    {
      username: process.env.LOMAH_BOOTSTRAP_USER || DEFAULT_USERNAME,
      password: process.env.LOMAH_BOOTSTRAP_PASSWORD || DEFAULT_PASSWORD,
      role: 'SUPER_ADMIN',
    },
    {
      username: DEFAULT_ADMIN_USERNAME,
      password: DEFAULT_ADMIN_PASSWORD,
      role: 'ADMIN',
    },
  ];
}

export async function ensureBootstrapUser(
  prisma: BootstrapClient,
  logger: Logger,
): Promise<void> {
  await prisma.$executeRawUnsafe(MARKER_DDL);

  const rows = await prisma.$queryRawUnsafe<Array<{ account: string }>>(
    'SELECT "account" FROM "_lomah_bootstrap"',
  );
  const alreadyHandled = new Set(rows.map((row) => row.account));

  const created: DefaultAccount[] = [];

  for (const account of defaultAccounts()) {
    if (alreadyHandled.has(account.username)) continue;

    // Present already — an upgrade from a build that seeded it. Record it so
    // it is treated as handled from now on, but leave the existing row alone:
    // its password may have been changed, and overwriting it would lock out
    // whoever changed it.
    const exists = await prisma.user.findUnique({ where: { username: account.username } });

    if (!exists) {
      await prisma.user.create({
        data: {
          username: account.username,
          passwordHash: await bcrypt.hash(account.password, 10),
          role: account.role,
        },
      });
      created.push(account);
    }

    await prisma.$executeRawUnsafe(
      'INSERT OR IGNORE INTO "_lomah_bootstrap" ("account") VALUES (?)',
      account.username,
    );
  }

  if (created.length === 0) return;

  // Logged at warn, and with the passwords in plain sight on purpose. Whoever
  // commissions this tablet has to be able to get in, and a credential they
  // cannot find is the same as no credential. It is only a default if nobody
  // changes it — which is what the second line is for.
  for (const account of created) {
    logger.warn(
      `created ${account.role} "${account.username}" with password "${account.password}"`,
    );
  }
  logger.warn('Change these passwords before the system goes on the range.');
}
