import * as bcrypt from 'bcryptjs';

import type { Logger } from '@nestjs/common';

/**
 * Creates the first SUPER_ADMIN on an otherwise empty database.
 *
 * prisma/seed.ts cannot do this job for a packaged install: it runs under tsx,
 * which is a dev dependency and is not in the bundle. Without a replacement, a
 * fresh install comes up with a working backend, a correct schema, and nobody
 * who can log in — and since the range is offline there is no way to fix that
 * from outside the tablet.
 *
 * Deliberately narrow: it only fires when the users table is completely empty,
 * so it can never resurrect an account an operator deleted on purpose, and it
 * never touches lanes, targets or shooters — those are commissioning decisions
 * that belong to a SUPER_ADMIN, not to a default.
 */

interface UserBootstrapClient {
  user: {
    count(): Promise<number>;
    create(args: {
      data: { username: string; passwordHash: string; role: 'SUPER_ADMIN' | 'ADMIN' };
    }): Promise<unknown>;
  };
}

const DEFAULT_USERNAME = 'superadmin';
const DEFAULT_PASSWORD = 'changeme123';
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin123';

export async function ensureBootstrapUser(
  prisma: UserBootstrapClient,
  logger: Logger,
): Promise<void> {
  if ((await prisma.user.count()) > 0) return;

  const username = process.env.LOMAH_BOOTSTRAP_USER || DEFAULT_USERNAME;
  const password = process.env.LOMAH_BOOTSTRAP_PASSWORD || DEFAULT_PASSWORD;

  await prisma.user.create({
    data: {
      username,
      passwordHash: await bcrypt.hash(password, 10),
      role: 'SUPER_ADMIN',
    },
  });
  await prisma.user.create({
    data: {
      username: DEFAULT_ADMIN_USERNAME,
      passwordHash: await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10),
      role: 'ADMIN',
    },
  });

  // Logged at warn, not log, and with the password in plain sight on purpose.
  // Whoever commissions this tablet has to be able to get in, and a credential
  // they cannot find is the same as no credential. It is only a default if
  // nobody changes it — which is what the second line is for.
  logger.warn(
    `no accounts found — created SUPER_ADMIN "${username}" with password "${password}" and ADMIN "${DEFAULT_ADMIN_USERNAME}" with password "${DEFAULT_ADMIN_PASSWORD}"`,
  );
  logger.warn('Change these passwords before the system goes on the range.');
}
