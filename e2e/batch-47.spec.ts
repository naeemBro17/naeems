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

/* ------------------------------- Task 2: description keeps the keyboard */

test('Task 2: typing a long product description keeps the same editor focused the whole time (no re-mount)', async ({ page }) => {
  test.setTimeout(120_000);
  const found = await select<{ id: string }[]>(null, 'products_view?select=id&is_active=eq.true&order=name.asc&limit=1');
  const id = found.data?.[0]?.id;
  test.skip(!id, 'No product to open.');
  // Nothing is saved: any product write is refused in the browser.
  await page.route(/\/rest\/v1\/products(\?|$)/, (route) => (route.request().method() === 'GET' ? route.fallback() : route.abort()));
  await adminAt(page, `/admin/products/${id}/edit`);
  const box = page.locator('#pf-description');
  await expect(box).toBeVisible({ timeout: 20_000 });
  await box.click();
  await page.keyboard.press('Control+End');
  // Mark the editor's DOM node, then count how often Tiptap pushes new
  // options (setProps + updateState) into the live editor while typing —
  // what used to happen on every key press.
  const hooked = await page.evaluate(() => {
    type Ed = { setOptions: (o: unknown) => void };
    const el = document.getElementById('pf-description') as HTMLElement & { b47?: boolean; editor?: Ed };
    el.b47 = true;
    const w = window as Window & { b47Set?: number };
    w.b47Set = 0;
    const ed = el.editor;
    if (!ed) return false;
    const original = ed.setOptions.bind(ed);
    ed.setOptions = (o: unknown) => {
      w.b47Set = (w.b47Set ?? 0) + 1;
      original(o);
    };
    return true;
  });
  expect(hooked, 'the editor instance is reachable').toBe(true);
  const text = ' Gentle foaming cleanser for normal to oily skin, with ceramides and niacinamide.';
  for (let i = 0; i < text.length; i += 1) {
    await page.keyboard.type(text[i]);
    if (i % 10 === 0) await page.waitForTimeout(400);
  }
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => {
    const el = document.getElementById('pf-description') as (HTMLElement & { b47?: boolean }) | null;
    return {
      same: el?.b47 === true,
      focused: document.activeElement === el,
      setOptionsCalls: (window as Window & { b47Set?: number }).b47Set ?? -1,
    };
  });
  expect(after.same, 'the editor was never replaced').toBe(true);
  expect(after.focused, 'the editor kept focus').toBe(true);
  expect(after.setOptionsCalls, 'nothing was pushed into the editor while typing').toBe(0);
  await expect(box).toContainText('ceramides and niacinamide.');
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/02-description-typing.png` });
});
