import type { Page } from '@playwright/test';

/**
 * A fake e2e "purchase" or "add to cart" must never reach Facebook Pixel or
 * Google Analytics — it would pollute Naeem's real ad/conversion data with
 * events that never happened. Blocked at the network layer (not by trusting
 * the app not to fire them) so this holds even if a future page adds a new
 * tracking call the test author never anticipated.
 */
const BLOCKED_HOST_PATTERNS = [
  /connect\.facebook\.net/,
  /facebook\.com\/tr/,
  /google-analytics\.com/,
  /googletagmanager\.com/,
  /analytics\.google\.com/,
];

export async function blockAdTracking(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(url))) {
      route.abort();
      return;
    }
    route.continue();
  });
}
