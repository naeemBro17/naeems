import { test as base, type Browser, type BrowserContext } from '@playwright/test';
import { blockAdTracking, blockAdTrackingInContext } from './helpers/tracking';
import { mockSteadfastByDefault } from './helpers/steadfastMock';
import { guardStorage, storageLeakCount, storageLeaksSince } from './helpers/storageGuard';

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
 *
 * Batch 40: the same for Supabase Storage files (e2e/helpers/storageGuard.ts)
 * — pictures and videos are answered locally with tiny placeholders, in
 * every context, including the ones a test opens itself with
 * browser.newContext() / browser.newPage(). A test that still downloads a
 * real Storage file fails.
 */

/** Everything every browser context in the suite gets. */
async function prepareContext(context: BrowserContext): Promise<void> {
  await guardStorage(context);
  await blockAdTrackingInContext(context);
  await mockSteadfastByDefault(context);
}

const prepared = new WeakSet<BrowserContext>();

/** Contexts a test makes itself get the same protections. */
function protectNewContexts(browser: Browser): void {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args: Parameters<Browser['newContext']>) => {
    const context = await newContext(...args);
    if (!prepared.has(context)) {
      prepared.add(context);
      await prepareContext(context);
    }
    return context;
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args: Parameters<Browser['newPage']>) => {
    const page = await newPage(...args);
    const context = page.context();
    if (!prepared.has(context)) {
      prepared.add(context);
      await prepareContext(context);
    }
    return page;
  };
}

export const test = base.extend<object, { protectedBrowser: void }>({
  protectedBrowser: [
    async ({ browser }, use) => {
      protectNewContexts(browser);
      await use();
    },
    { scope: 'worker', auto: true },
  ],
  context: async ({ context }, use) => {
    if (!prepared.has(context)) {
      prepared.add(context);
      await prepareContext(context);
    }
    const leaksBefore = storageLeakCount();
    await use(context);
    const leaked = storageLeaksSince(leaksBefore);
    if (leaked.length > 0) {
      throw new Error(
        `This test downloaded ${leaked.length} real file(s) from Supabase Storage (Batch 40: tests must not). ` +
          `First: ${leaked[0]}. Use route.fallback() (not route.continue()) in a page.route for Storage.`
      );
    }
  },
  page: async ({ page }, use) => {
    await blockAdTracking(page);
    await use(page);
  },
});

export { expect } from '@playwright/test';
