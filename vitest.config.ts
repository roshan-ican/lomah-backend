import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The `@/*` -> `src/*` mapping is declared in tsconfig, which tsc and Nest
  // both honour but Vitest does not — it resolves through Vite, and Vite reads
  // its own alias table. Without this, any spec that imports across modules
  // fails to collect with "Failed to load url @/...", which silently reduced
  // the suite to whichever files happened to use relative imports only.
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
