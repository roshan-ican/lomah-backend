import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds prisma-runtime/ — the only part of Prisma the shipped app needs.
 *
 * Prisma is 285 MB of the 495 MB node_modules tree the installer used to carry,
 * and almost none of it runs on a range tablet. The bulk is tooling and other
 * databases' engines: the CLI (90 MB), the schema engine that only `migrate`
 * uses (18 MB, replaced by src/common/prisma/migration-runner.ts), five sets of
 * WebAssembly query engines for Postgres/MySQL/CockroachDB/SQL Server (~50 MB),
 * duplicate .mjs builds, and 12 MB of source maps.
 *
 * What is actually loaded at runtime is four files deep:
 *
 *   @prisma/client/index.js  -> .prisma/client/default.js
 *                            -> .prisma/client/index.js
 *                            -> @prisma/client/runtime/library.js
 *                            +  query_engine-windows.dll.node   (read by path)
 *                            +  schema.prisma                   (read by path)
 *
 * Hence an allowlist rather than a filter: a deny-list silently regains weight
 * every time Prisma adds a file, and the last one cost 50 MB of engines for
 * databases this project will never speak to.
 *
 * This cannot be folded into the esbuild bundle. The query engine is a native
 * .node library that process.dlopen has to load from a real path, and the
 * generated client locates both it and schema.prisma with
 * path.join(__dirname, ...) — neither survives being inlined.
 */

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(here);
const nodeModules = join(projectRoot, 'node_modules');
const outDir = join(projectRoot, 'prisma-runtime');

/** Windows x64 only — the tablets are the only deployment target. Building for
 *  another platform means regenerating the client for that binaryTarget and
 *  renaming this. */
const QUERY_ENGINE = 'query_engine-windows.dll.node';

const FILES = [
  ['@prisma/client/package.json'],
  ['@prisma/client/index.js'],
  ['@prisma/client/default.js'],
  ['@prisma/client/runtime/library.js'],

  ['.prisma/client/package.json'],
  ['.prisma/client/index.js'],
  ['.prisma/client/default.js'],
  ['.prisma/client/client.js'],
  // Read at runtime by the generated client, not just by the CLI.
  ['.prisma/client/schema.prisma'],
  [`.prisma/client/${QUERY_ENGINE}`],
];

rmSync(outDir, { recursive: true, force: true });

let total = 0;
for (const [relative] of FILES) {
  const from = join(nodeModules, relative);
  const to = join(outDir, relative);

  if (!existsSync(from)) {
    throw new Error(
      `Missing ${relative}. Run \`npm run prisma:generate\` first — the ` +
        `generated client and its query engine are produced by that step.`,
    );
  }

  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  total += statSync(to).size;
}

// `prisma generate` leaves a partially-written engine behind when it is
// interrupted (query_engine-windows.dll.node.tmp<pid>, another 20 MB). It is
// never loaded, but a glob-based resource copy would ship it.
for (const stray of readdirSync(join(nodeModules, '.prisma', 'client'))) {
  if (stray.includes('.tmp')) {
    rmSync(join(nodeModules, '.prisma', 'client', stray), { force: true });
    console.log(`  removed stray ${stray}`);
  }
}

console.log(`\n  prisma-runtime/  ${(total / 1024 / 1024).toFixed(1)} MB  (${FILES.length} files)\n`);
