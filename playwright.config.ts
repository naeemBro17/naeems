import { defineConfig, devices } from '@playwright/test';

/**
 * Batch 30 Part 1: two groups.
 *   serial   — one test at a time, run last and alone: the frame-timing
 *              specs (they measure animations, so they must not share the
 *              CPU — fix/back-known-good) and the specs that change live
 *              test data (team logins, roles, settings, test orders, test
 *              brands/products), which must never overlap with each other
 *              or with a spec reading the catalogue.
 *   parallel — everything else, E2E_WORKERS at a time (default 2: this PC
 *              has 4 cores and these specs wait fixed times for animations).
 * `npx playwright test` runs parallel first, then serial. npm run verify
 * runs the two separately so both always report.
 */
const SERIAL_SPECS = [
  'back-known-good',
  'batch-23',
  'one-transition-system',
  'phone-back',
  'product-transitions',
  // These two measure scroll positions and glass right after animations;
  // with another test sharing the CPU they missed by a pixel (Batch 30).
  'batch-27',
  'batch-28',
  'batch-24',
  'batch-25',
  'batch-26',
  'batch-30',
  'batch-31',
  'batch-32',
  'batch-33',
  'batch-34',
  'checkout',
];
const SERIAL_MATCH = new RegExp(`(^|[\\\\/])(${SERIAL_SPECS.join('|')})\\.spec\\.ts$`);
const PARALLEL_WORKERS = Number(process.env.E2E_WORKERS ?? 2);

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
  // Whole files are shared out between workers (never tests within one
  // file). The serial group is limited to one worker below.
  workers: PARALLEL_WORKERS,
  retries: 0,
  reporter: [['list']],
  // Batch 24: removes the test customer's leftover orders after every run.
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:4174',
    trace: 'retain-on-failure',
    ...devices['Pixel 7'],
  },
  projects: [
    { name: 'parallel', testIgnore: SERIAL_MATCH },
    { name: 'serial', testMatch: SERIAL_MATCH, workers: 1, dependencies: ['parallel'] },
  ],
  webServer: {
    command: 'npm run preview -- --port 4174 --strictPort',
    url: 'http://localhost:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
