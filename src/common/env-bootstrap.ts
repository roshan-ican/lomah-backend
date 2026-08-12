import { existsSync } from 'node:fs';

import { config as loadDotenv } from 'dotenv';

import { ENV_FILES } from './runtime-paths';

/**
 * Loads .env before anything else in the process can read process.env.
 *
 * ConfigModule.forRoot also loads these files, but it does so during Nest's
 * module initialisation — after every module file has been imported and after
 * PrismaService has been constructed. Anything that needs configuration at
 * import or construction time (the database URL, most obviously) would read an
 * empty process.env and fall back to a default.
 *
 * dotenv never overwrites a variable that is already set, so loading twice is
 * harmless and the precedence is the one you would expect: real environment
 * beats .env.local beats .env. The desktop shell passes DATABASE_URL, PORT and
 * JWT_SECRET directly, and those keep winning.
 *
 * Imported for its side effect, and it must stay the first import in main.ts.
 */
for (const file of ENV_FILES) {
  if (existsSync(file)) loadDotenv({ path: file });
}
