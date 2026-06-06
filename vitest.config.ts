import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['lib/**/*.test.ts', 'apps/web/src/**/*.test.ts', 'apps/web/src/**/*.test.tsx'],
    setupFiles: ['./apps/web/src/test/setup.ts'],
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'apps/web/src'),
      '@lib': path.resolve(__dirname, 'lib'),
    },
  },
});
