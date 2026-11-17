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

/* ----------------------------------- Task 3: admin rows are real links */

test('Task 3: Ctrl+click on an order row opens that order in a new tab; order, product, customer and lot rows are real links', async ({ page, context }) => {
  test.setTimeout(120_000);
  await adminAt(page, '/admin?tab=orders');
  const link = page.getByTestId('order-row-link').first();
  await expect(link).toBeVisible({ timeout: 20_000 });
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/admin\/orders\/[^/]+$/);
  const [tab] = await Promise.all([context.waitForEvent('page'), link.click({ modifiers: ['Control'] })]);
  await tab.waitForLoadState();
  expect(new URL(tab.url()).pathname).toBe(href);
  await expect(tab.getByTestId('admin-order-page')).toBeVisible({ timeout: 20_000 });
  // The first tab did not move.
  expect(new URL(page.url()).pathname).toBe('/admin');
  await tab.close();
  // A plain click still opens the order in this tab.
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.getByTestId('admin-order-page')).toBeVisible({ timeout: 20_000 });

  await page.goto('/admin?tab=products');
  await expect(page.locator('[data-testid="product-row"] a.adm-lrow__open').first()).toHaveAttribute('href', /^\/admin\/products\/[^/]+\/edit$/, { timeout: 20_000 });
  await page.goto('/admin?tab=customers');
  await expect(page.locator('[data-testid="customer-row"] a.adm-lrow__open').first()).toHaveAttribute('href', /^\/admin\/customers\/[^/]+$/, { timeout: 20_000 });
  await page.goto('/admin?tab=inventory');
  const lots = page.getByTestId('inv-lot-link');
  await expect(page.getByTestId('inv-lots').or(page.getByText('No lots yet'))).toBeVisible({ timeout: 20_000 });
  if ((await lots.count()) > 0) await expect(lots.first()).toHaveAttribute('href', /inv=lot&lot=/);
  await page.screenshot({ path: `${SHOTS}/03-lot-rows-links.png` });
});

/* -------------------------- Task 4: Shop/in person — no delivery charge */

test('Task 4: Shop/in person sets delivery to hand delivered at ৳0 (still editable) in New order and ৳0 in Edit order; nothing saved', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route(/\/rest\/v1\/rpc\/(admin_create_order|admin_create_order_v2|admin_edit_order|admin_set_order_source)/, (route) => route.abort());
  await adminAt(page, '/admin/orders/new');
  const sources = page.getByRole('group', { name: 'Order source' });
  await expect(sources).toBeVisible({ timeout: 20_000 });
  const fee = page.getByLabel('Delivery fee');
  const handDelivered = page.getByRole('button', { name: 'No delivery (hand delivered)' });
  await expect(fee).not.toHaveValue('0');
  await sources.getByRole('button', { name: 'Shop/in person' }).click();
  await expect(handDelivered).toHaveClass(/chip-select--on/);
  await expect(fee).toHaveValue('0');
  // A default, not a lock.
  await fee.fill('50');
  await expect(fee).toHaveValue('50');
  await fee.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: `${SHOTS}/04-new-order-shop-in-person.png` });
  // Another source puts the courier zone back.
  await sources.getByRole('button', { name: 'Facebook' }).click();
  await expect(handDelivered).not.toHaveClass(/chip-select--on/);
  await expect(fee).not.toHaveValue('0');

  const number = await latestOrderNumber('&source=neq.shop&delivery_fee=gt.0');
  test.skip(!number, 'No courier order to open in Edit order.');
  await page.goto(`/admin/orders/${number}/edit`);
  const editSources = page.getByTestId('edit-order-source');
  await expect(editSources).toBeVisible({ timeout: 20_000 });
  const editFee = page.locator('#edit-order-fee');
  await expect(editFee).not.toHaveValue('0');
  await editSources.getByRole('button', { name: 'Shop/in person' }).click();
  await expect(editFee).toHaveValue('0');
  await editSources.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: `${SHOTS}/05-edit-order-shop-in-person.png` });
});

/* ---------------------------- Task 5: sizes show once in New / Edit order */

test('Task 5: a product with sizes is one search row in New order and Edit order; the picker adds the chosen size (nothing saved)', async ({ page }) => {
  test.setTimeout(120_000);
  const withOptions = await select<{ product_id: string }[]>(null, 'product_variants_view?select=product_id&limit=50');
  const ids = [...new Set((withOptions.data ?? []).map((v) => v.product_id))];
  const found = await select<{ id: string; name: string }[]>(null, `products_view?select=id,name&is_active=eq.true&id=in.(${ids.join(',')})&limit=1`);
  const product = found.data?.[0];
  test.skip(!product, 'No active product with sizes in the shop.');
  await page.route(/\/rest\/v1\/rpc\/(admin_create_order|admin_create_order_v2|admin_edit_order|admin_set_order_source)/, (route) => route.abort());

  // New order: one row; the picker's first size is the product's own.
  await adminAt(page, '/admin/orders/new');
  const search = page.getByPlaceholder('Search product name...');
  await expect(search).toBeVisible({ timeout: 20_000 });
  await search.fill(product!.name);
  await expect(page.getByTestId('manual-product-result').filter({ hasText: product!.name })).toHaveCount(1);

  // Edit order: the same — before Batch 47 every size was its own row and
  // the product's own size could not be added at all.
  const number = await latestOrderNumber();
  test.skip(!number, 'No order to open in Edit order.');
  await page.goto(`/admin/orders/${number}/edit`);
  const add = page.getByLabel('Add a product');
  await expect(add).toBeVisible({ timeout: 20_000 });
  const before = await page.locator('.edit-order .checkout-cart__row, .edit-order li').count();
  await add.fill(product!.name);
  const row = page.getByTestId('manual-product-result').filter({ hasText: product!.name });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('sizes');
  await row.click();
  const picker = page.getByTestId('manual-option-picker');
  await expect(picker).toBeVisible();
  const options = picker.getByTestId('manual-option');
  expect(await options.count()).toBeGreaterThanOrEqual(2);
  await options.first().click();
  await page.screenshot({ path: `${SHOTS}/06-edit-order-size-picker.png` });
  await picker.getByTestId('manual-pick-add').click();
  await expect(picker).toBeHidden();
  expect(await page.locator('.edit-order .checkout-cart__row, .edit-order li').count()).toBeGreaterThan(before);
  await expect(page.getByTestId('edit-order-sheet')).toContainText(product!.name);
});
