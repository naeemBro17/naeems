import { defineConfig, devices } from '@playwright/test';

/**
 * Phone-first per CLAUDE.md: every test runs at a real mid-range Android
 * viewport, touch-enabled, mobile UA — the same target this whole site is
 * designed for. See reports/batch-21.txt Part 3 for the test account this
 * suite signs in with and why it's safe.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4174',
    trace: 'retain-on-failure',
    ...devices['Pixel 7'],
  },
  webServer: {
    command: 'npm run preview -- --port 4174 --strictPort',
    url: 'http://localhost:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
