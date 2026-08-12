import { ENV_FILES } from './runtime-paths';

/**
 * Fails the boot when configuration the app cannot invent is missing.
 *
 * Every other setting has a sensible code default, so a missing value is at
 * worst a behaviour change. These two are different — each fails much later,
 * somewhere that gives no hint about the real cause:
 *
 *   DATABASE_URL  absent, and Prisma opens a brand-new empty database. The
 *                 backend starts, the log looks healthy, and the range has no
 *                 lanes and no accounts.
 *   JWT_SECRET    absent, and JwtModule is configured with `secret: undefined`.
 *                 Nothing complains until the first login, which fails with
 *                 jsonwebtoken's "secretOrPrivateKey must have a value" as a
 *                 500 — a message that says nothing about configuration.
 *
 * A plain predicate rather than a Joi schema: @nestjs/config supports both, and
 * this needs no new dependency in a bundle we are trying to keep small.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const missing = ['DATABASE_URL', 'JWT_SECRET'].filter((key) => {
    const value = config[key];
    return value === undefined || value === null || String(value).trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required configuration: ${missing.join(', ')}. ` +
        `Set it in the environment, or in ${ENV_FILES[0]}`,
    );
  }

  return config;
}
