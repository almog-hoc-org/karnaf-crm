import { defineConfig, devices } from '@playwright/test';

// Opt-in E2E suite. Run with `npm run e2e`. Reads .env from the repo root
// for VITE_SUPABASE_URL/anon and runs against a locally-served Vite build.
//
// CI does NOT run these by default — they require a live Supabase project
// and Meta sandbox to actually push end-to-end.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    locale: 'he-IL',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
