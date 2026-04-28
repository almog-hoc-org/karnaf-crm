import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Integration suite. Targets a locally-running Supabase via `supabase start`.
// Skipped by default; the runner needs INTEGRATION_SUPABASE_URL +
// INTEGRATION_SERVICE_ROLE_KEY set, otherwise each spec self-skips.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['integration/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: true,
  },
  resolve: {
    alias: {
      '@lib': path.resolve(__dirname, 'lib'),
      '@': path.resolve(__dirname, 'apps/web/src'),
    },
  },
});
