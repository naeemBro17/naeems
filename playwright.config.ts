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
  // One test at a time. Several spec files running side by side made the
  // screenshot- and frame-timing tests share one machine's CPU, so a
  // different timing test failed on each full run while every one passed
  // alone (fix/back-known-good). Serial is slower but deterministic.
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // Batch 24: removes the test customer's leftover orders after every run.
  globalTeardown: './e2e/global-teardown.ts',
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
