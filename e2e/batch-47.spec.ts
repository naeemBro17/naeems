import { mkdirSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, select, useSessionInPage, type TestSession } from './helpers/api';

// Batch 47: admin and customer bug fixes.
//
// The live shop is never changed: screens are checked at 390 px and nothing
// is saved — no order is deleted, placed or moved. Database functions that
// would change something are answered in the browser.
// Steadfast is mocked by ./fixtures; no real Storage file is downloaded.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-47-screens';
const WIDTH = 390;

let admin: TestSession;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
});

async function adminAt(page: Page, path: string): Promise<void> {
  await page.setViewportSize({ width: WIDTH, height: 844 });
  await useSessionInPage(page, admin);
  await page.goto(path);
}

async function mockRpc(page: Page, fn: string, reply: unknown): Promise<void> {
  await page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(reply) });
  });
}

async function latestOrderNumber(filter = ''): Promise<string | null> {
  const res = await select<{ order_number: string }[]>(admin.accessToken, `orders?select=order_number${filter}&order=created_at.desc&limit=1`);
  return res.data?.[0]?.order_number ?? null;
}

/* ------------------------------------------- Task 1: Safety Lock field */

test('Task 1: the delete confirm field keeps focus and takes typed digits while the Safety Lock countdown ticks', async ({ page }) => {
  test.setTimeout(90_000);
  const number = await latestOrderNumber();
  test.skip(!number, 'No order to open.');
  // The lock is "open" for 10 minutes (answered in the browser): the
  // countdown re-renders the order page every second, which used to pull
  // focus to the dialog's Close button.
  await mockRpc(page, 'admin_delete_lock_until', new Date(Date.now() + 10 * 60 * 1000).toISOString());
  await page.route(/\/rest\/v1\/rpc\/admin_delete_orders/, (route) => route.abort());
  await adminAt(page, `/admin/orders/${number}`);
  await expect(page.getByTestId('admin-order-page')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Delete…' }).click();
  const input = page.getByTestId('delete-orders-input');
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await input.click();
  const digits = number!.replace(/\D/g, '');
  for (const d of digits) {
    await page.keyboard.type(d);
    // Longer than one countdown tick between key presses.
    await page.waitForTimeout(1200);
    await expect(input).toBeFocused();
  }
  await expect(input).toHaveValue(digits);
  await page.screenshot({ path: `${SHOTS}/01-delete-field-typed.png` });
  await page.getByRole('button', { name: 'Cancel' }).click();
});
