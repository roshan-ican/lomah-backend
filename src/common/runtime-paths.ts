import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Where things are on disk, answered once and absolutely.
 *
 * Every path in this backend used to be resolved against process.cwd(), which
 * worked only because the Electron shell spawned it with `cwd: BACKEND_DIR`
 * pinned. That is a load-bearing invariant nobody can see from inside this
 * process, and when it breaks nothing throws:
 *
 *   - a relative DATABASE_URL makes Prisma CREATE a new empty database rather
 *     than fail, so the app boots to zero lanes and nobody can log in (the
 *     0-byte lomah.db that used to sit in the repo root was exactly this)
 *   - a missed .env silently swaps every setting for its code default, and
 *     SENSOR_RESEND_ENABLED defaults the opposite way to the shipped config —
 *     shots start going missing with nothing in the log to say why
 *
 * So the anchor is __dirname, not cwd: the directory this file was loaded
 * from is a fact about the install, not about how it was launched. From there
 * we walk up to whichever ancestor owns prisma/migrations, which lands on
 * <repo>/lomah-nest in development and on resources/app/backend when packaged,
 * with no branch on "am I packaged" anywhere.
 */

function findProjectRoot(): string {
  let dir = __dirname;

  // dev:      <repo>/lomah-nest/dist/src/common -> up 3
  // packaged: resources/app/backend             -> hits on the first check
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'prisma', 'migrations'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Nothing found — an unpacked layout we do not know about. cwd is a worse
  // answer than __dirname but it is the historical one, so behaviour does not
  // change for whoever was relying on it.
  return process.cwd();
}

export const PROJECT_ROOT = findProjectRoot();

export const MIGRATIONS_DIR = join(PROJECT_ROOT, 'prisma', 'migrations');

/**
 * .env files, absolute. ConfigModule hands these to dotenv, which resolves
 * relative paths against cwd — the one thing we are trying to stop depending
 * on.
 */
export const ENV_FILES = [join(PROJECT_ROOT, '.env'), join(PROJECT_ROOT, '.env.local')];

/**
 * The built SPA. ServeStaticModule needs a real directory; Express reads these
 * files off disk, so this cannot be satisfied from inside a bundle.
 *
 * LOMAH_STATIC_DIR is what the desktop shell sets, and it wins. The two
 * fallbacks are the historical cwd probes, kept so `npm run start:dev` and the
 * current packaged layout both behave exactly as they did.
 */
export function resolveStaticDir(): string {
  const fromEnv = process.env.LOMAH_STATIC_DIR;
  if (fromEnv && existsSync(join(fromEnv, 'index.html'))) return fromEnv;

  const packaged = join(process.cwd(), '..', 'dist');
  if (existsSync(join(packaged, 'index.html'))) return packaged;

  return join(process.cwd(), '..', 'frontend', 'dist');
}

/**
 * DATABASE_URL, guaranteed absolute.
 *
 * A relative `file:./lomah.db` is not resolved against the schema directory by
 * the query engine — it is resolved against the process working directory, and
 * the two only agreed by accident. Anchoring it here means the same connection
 * string opens the same file no matter who launched the process or from where.
 *
 * Query parameters are preserved deliberately: `connection_limit=1` is what
 * keeps every statement on one SQLite connection, which the migration runner
 * depends on — Prisma's table-redefine migrations bracket their work in
 * PRAGMA foreign_keys=OFF, and a PRAGMA only applies to the connection that
 * issued it. Spread those statements over a pool and the migration corrupts
 * the foreign keys it was meant to preserve.
 */
export function resolveDatabaseUrl(raw: string | undefined): string {
  if (!raw) {
    throw new Error(
      'DATABASE_URL is not set. The desktop shell passes it explicitly; ' +
        `for a local run put it in ${ENV_FILES[0]}`,
    );
  }

  if (!raw.startsWith('file:')) return raw;

  const [filePart, query] = splitQuery(raw.slice('file:'.length));
  if (isAbsolute(filePart)) return raw;

  // Relative paths have always meant "next to schema.prisma", because that is
  // where they land when Prisma's CLI resolves them. Keep that meaning.
  const absolute = resolve(join(PROJECT_ROOT, 'prisma'), filePart);
  return `file:${absolute}${query}`;
}

function splitQuery(value: string): [string, string] {
  const at = value.indexOf('?');
  return at === -1 ? [value, ''] : [value.slice(0, at), value.slice(at)];
}
