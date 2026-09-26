import { test as base } from '@playwright/test';
import { blockAdTracking } from './helpers/tracking';

/**
 * Every test in this suite goes through this fixture, not raw `@playwright/
 * test` — ad-tracking network calls are blocked unconditionally, for every
 * test, so a future spec file can't forget to do it and leak a fake
 * conversion into Naeem's real Facebook Pixel / Google Analytics data
 * (reports/batch-21.txt Part 3).
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await blockAdTracking(page);
    await use(page);
  },
});

export { expect } from '@playwright/test';
