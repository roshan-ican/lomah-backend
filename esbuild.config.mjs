import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';

import { build } from 'esbuild';

/**
 * Collapses the compiled backend into one file for the desktop installer.
 *
 * Runs AFTER `nest build`, never instead of it, and the order is load-bearing.
 * Nest's dependency injection reads constructor parameter types out of
 * `design:paramtypes` metadata, which only `tsc` can emit — esbuild has never
 * supported emitDecoratorMetadata and silently drops it. Compiling with tsc
 * first and bundling the emitted JavaScript means esbuild only ever sees
 * ordinary `Reflect.metadata(...)` calls, so there is nothing left for it to
 * lose. Point esbuild at the TypeScript instead and every injected constructor
 * fails at runtime with "Nest can't resolve dependencies".
 *
 * The payoff is what the installer no longer carries: ~25 MB of @nestjs and
 * everything downstream of it, replaced by a single file of a few MB.
 */

const here = dirname(fileURLToPath(import.meta.url));

// .cjs, not .js, and it is not cosmetic. Node decides a .js file's module
// system from the nearest package.json above it, and once this is copied into
// the installer that search walks all the way up to frontend/package.json,
// which declares "type": "module" — so a CommonJS bundle named .js is loaded as
// ESM and dies on its first `exports`. The old build happened to avoid this by
// shipping lomah-nest/package.json alongside the backend purely as a boundary
// marker. An explicit extension needs no such accomplice.
const outfile = join(here, 'dist', 'backend.cjs');

await build({
  entryPoints: [join(here, 'dist', 'src', 'main.js')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',

  // Left unminified deliberately. This runs on tablets on a range with no
  // developer present, and the only diagnosis anyone gets is the stack trace in
  // backend.log. A few MB is a fair price for a readable one.
  minify: false,
  sourcemap: false,
  logLevel: 'info',

  // tsc does NOT rewrite the "@/*" path alias at emit — the compiled JS still
  // says require("@/common/..."), and almost every cross-module import in this
  // codebase uses it. Without this, the bundle fails on the first import.
  alias: {
    '@': join(here, 'dist', 'src'),
  },

  external: [
    // The generated Prisma client loads a 20 MB native query engine by
    // computed path and reads schema.prisma off disk next to itself. Neither
    // survives being inlined, so it stays a real directory on disk — see
    // scripts/collect-prisma-runtime.mjs for what actually ships.
    '@prisma/client',
    '.prisma/client',

    // Optional peers that Nest and socket.io probe with require-in-a-try/catch
    // and that this project has never installed. Marking them external is what
    // "not installed" looks like to the bundle: the require throws at runtime
    // and the surrounding catch takes the fallback path, exactly as it does
    // today under node_modules. Without this esbuild treats each as an
    // unresolved import and fails the build.
    '@nestjs/microservices',
    '@nestjs/microservices/microservices-module',
    '@nestjs/platform-fastify',
    'cache-manager',
    'bufferutil',
    'utf-8-validate',

    // Fastify's static handler. @nestjs/serve-static ships a loader for each
    // platform and this project is on Express, so the Fastify branch is never
    // taken.
    '@fastify/static',

    // The fallback half of `try { require('class-transformer/cjs/storage') }
    // catch { require('class-transformer/storage') }` in @nestjs/mapped-types.
    // The cjs path is the one that exists and it bundles, so the catch branch
    // is unreachable — but esbuild still has to be told the path it can't
    // resolve is deliberate.
    'class-transformer/storage',
  ],
});

const { size } = statSync(outfile);
console.log(`\n  dist/backend.cjs  ${(size / 1024 / 1024).toFixed(1)} MB\n`);
