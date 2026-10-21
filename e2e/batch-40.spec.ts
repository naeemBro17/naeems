import type { BrowserContext, Page, Response } from '@playwright/test';
import { test, expect } from './fixtures';
import { PLACEHOLDER_HEADER, STORAGE_FILE, storageLeakCount, storageLeaksSince } from './helpers/storageGuard';

/**
 * Batch 40 — stop the Supabase bandwidth problem.
 * Part 1: the tests themselves never download real Storage files.
 */

interface StorageTally {
  placeholders: number;
  real: string[];
  realBytes: number;
}

/** Counts every Storage file answer this context receives. */
function tallyStorage(context: BrowserContext): StorageTally {
  const tally: StorageTally = { placeholders: 0, real: [], realBytes: 0 };
  context.on('response', (response: Response) => {
    const url = response.url();
    if (!STORAGE_FILE.test(url) || !['GET', 'HEAD'].includes(response.request().method())) return;
    if (response.headers()[PLACEHOLDER_HEADER] === '1') {
      tally.placeholders += 1;
      return;
    }
    void response.serverAddr().then(async (addr) => {
      if (addr === null) return;
      tally.real.push(url);
      tally.realBytes += (await response.body().catch(() => Buffer.alloc(0))).length;
    });
  });
  return tally;
}

async function scrollToEnd(page: Page): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const done = await page.evaluate(() => {
      window.scrollBy(0, Math.round(window.innerHeight * 0.9));
      return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
    });
    await page.waitForTimeout(150);
    if (done) break;
  }
}

test.describe('Part 1 — tests download no real Storage files', () => {
  test('guard: Home (scrolled to the end) and a product page — zero real Storage bytes', async ({ page, context }) => {
    test.setTimeout(60_000);
    const tally = tallyStorage(context);
    const leaksBefore = storageLeakCount();

    await page.goto('/');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15_000 });
    await scrollToEnd(page);
    await page.waitForTimeout(1500);

    await page.locator('.product-card').first().scrollIntoViewIfNeeded();
    await page.locator('.product-card').first().click();
    await expect(page).toHaveURL(/\/product\//);
    await page.waitForTimeout(2000);

    // The pages really asked for pictures, and every one was answered here.
    expect(tally.placeholders).toBeGreaterThan(5);
    expect(tally.real, 'real Storage files downloaded').toEqual([]);
    expect(tally.realBytes).toBe(0);
    expect(storageLeaksSince(leaksBefore)).toEqual([]);
  });

  test('guard: a page the test opens itself (browser.newPage) gets the same placeholders', async ({ browser }) => {
    test.setTimeout(60_000);
    const page = await browser.newPage();
    const tally = tallyStorage(page.context());
    await page.goto('/');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    expect(tally.placeholders).toBeGreaterThan(0);
    expect(tally.real).toEqual([]);
    await page.close();
  });

  test('guard: Facebook Pixel and Google Analytics never get a fake visit', async ({ page }) => {
    await page.goto('/');
    const reached = await page.evaluate(async () => {
      const urls = ['https://www.google-analytics.com/g/collect?v=2', 'https://connect.facebook.net/en_US/fbevents.js'];
      const results: boolean[] = [];
      for (const url of urls) {
        try {
          await fetch(url, { mode: 'no-cors' });
          results.push(true);
        } catch {
          results.push(false);
        }
      }
      return results;
    });
    expect(reached).toEqual([false, false]);
  });
});
