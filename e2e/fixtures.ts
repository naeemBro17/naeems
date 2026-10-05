import { test as base } from '@playwright/test';
import { blockAdTracking } from './helpers/tracking';
import { mockSteadfastByDefault } from './helpers/steadfastMock';

/**
 * Every test in this suite goes through this fixture, not raw `@playwright/
 * test` — ad-tracking network calls are blocked unconditionally, for every
 * test, so a future spec file can't forget to do it and leak a fake
 * conversion into Naeem's real Facebook Pixel / Google Analytics data
 * (reports/batch-21.txt Part 3).
 *
 * Batch 30: the same for Steadfast. Every page in every test (including
 * extra pages a test opens in the same context) gets a mocked steadfast
 * function, so a test can never reach the real Steadfast API or book a real
 * parcel. A test that needs a particular answer adds its own page.route,
 * which takes precedence (e2e/helpers/steadfastMock.ts).
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    await mockSteadfastByDefault(context);
    await use(context);
  },
  page: async ({ page }, use) => {
    await blockAdTracking(page);
    await use(page);
  },
});

export { expect } from '@playwright/test';
