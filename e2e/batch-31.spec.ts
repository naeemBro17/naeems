import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_MOD_PASSWORD, E2E_PASSWORD, SUPABASE_ANON_KEY } from './helpers/env';
import { callFunction, passwordSession, pickStockedProduct, placeTestOrder, rpc, select, useSessionInPage, type TestSession } from './helpers/api';
import { mockSteadfast, type MockFraudResult } from './helpers/steadfastMock';

// Batch 31 (reports/batch-31.txt). Steadfast is always mocked (e2e/
// fixtures.ts); the only real function calls below are the "refused" checks,
// which are turned away before Steadfast is ever asked. Test orders, the
// test staff login and its role are created here and deleted in afterAll.
// Nothing is written into shared lists: the thana list is mocked, and the
// small-images tool runs with every write (Storage uploads, products /
// categories updates) answered by the test itself.

test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.describe.configure({ mode: 'serial' });

const STAFF_USERNAME = 'e2e.role31';
const ROLE_NAME = 'E2E Batch31 role';
const MANUAL_PHONE_TYPED = '+880 1799-990031';

let admin: TestSession;
let customer: TestSession;
let product: { id: string; name: string; stock: number };
let staffId = '';
const createdOrderIds: string[] = [];

const GOOD: MockFraudResult = { deliveryRatio: 92, cancellationRatio: 7, volumeBand: 'high', volumeRange: '50+', totalReports: 0 };
const WARN: MockFraudResult = { deliveryRatio: 64, cancellationRatio: 35, volumeBand: 'medium', volumeRange: '10+', totalReports: 1 };
const RISK: MockFraudResult = { deliveryRatio: 30, cancellationRatio: 70, volumeBand: 'low', volumeRange: '7', totalReports: 3 };
const NONE: MockFraudResult = { deliveryRatio: null, cancellationRatio: null, volumeBand: 'none', volumeRange: null, totalReports: 0 };

async function freshAdmin(): Promise<TestSession> {
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  return admin;
}

async function newWebOrder(): Promise<{ id: string; orderNumber: string }> {
  const order = await placeTestOrder(customer.accessToken, product.id, 1);
  createdOrderIds.push(order.id);
  return order;
}

async function openAdminOrder(page: Page, orderId: string, session: TestSession = admin): Promise<void> {
  await useSessionInPage(page, session);
  await page.goto(`/admin?tab=orders&order=${orderId}`);
  await expect(page.getByRole('dialog').first()).toBeVisible({ timeout: 15_000 });
}

async function deleteStaffAndRole(): Promise<void> {
  const team = await rpc<{ id: string; username: string }[]>(admin.accessToken, 'admin_team_list');
  for (const member of team.data ?? []) {
    if (member.username === STAFF_USERNAME) await callFunction(admin.accessToken, 'admin-team', { action: 'delete', userId: member.id });
  }
  const roles = await rpc<{ id: string; name: string }[]>(admin.accessToken, 'admin_role_list');
  for (const role of roles.data ?? []) {
    if (role.name === ROLE_NAME) await rpc(admin.accessToken, 'admin_role_delete', { p_id: role.id });
  }
}

test.beforeAll(async () => {
  test.setTimeout(60_000);
  await freshAdmin();
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  product = await pickStockedProduct(6);
  await deleteStaffAndRole();
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  await freshAdmin();
  if (createdOrderIds.length > 0) {
    await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 60 });
    await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: createdOrderIds });
    await rpc(admin.accessToken, 'admin_close_delete_lock');
  }
  await deleteStaffAndRole();
});

/* ---------------------------------------------------------------- Part 1 */

test('Part 1: the backup workflow is valid, runs nightly and never writes into this repo', () => {
  const yml = readFileSync('.github/workflows/backup.yml', 'utf8');
  expect(yml).toContain("cron: '0 21 * * *'");
  expect(yml).toContain('workflow_dispatch:');
  expect(yml).toMatch(/permissions:\s*\n\s*contents: read/);
  for (const secret of ['SUPABASE_DB_URL', 'BACKUP_PASSWORD', 'BACKUP_DEPLOY_KEY', 'BACKUP_ALERT_SECRET']) {
    expect(yml).toContain(`secrets.${secret}`);
  }
  expect(yml).toContain('image: postgres:17');
  const script = readFileSync('scripts/backup/backup.sh', 'utf8');
  expect(script).toContain('--cipher-algo AES256');
  expect(script).toContain('pg_restore --list');
  expect(script).toContain('git push --quiet --force origin nightly:main');
  expect(script).toContain('git@github.com:$BACKUP_REPO.git');
  expect(script).toMatch(/is PUBLIC\. Refusing/);
  // actionlint, when installed (ACTIONLINT=<path> or on PATH).
  const actionlint = process.env.ACTIONLINT ?? 'actionlint';
  let output = '';
  try {
    output = execFileSync(actionlint, ['.github/workflows/backup.yml'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { code?: string; stdout?: string };
    if (e.code === 'ENOENT') test.info().annotations.push({ type: 'note', description: 'actionlint not installed; structure checked only' });
    else output = e.stdout ?? 'actionlint failed';
  }
  expect(output.trim()).toBe('');
});

/* ---------------------------------------------------------------- Part 2 */

test('Part 2: courier history card — numbers and colour, cached on the second open', async ({ page }) => {
  test.setTimeout(90_000);
  const order = await newWebOrder();
  const calls = await mockSteadfast(page, { fraud: { '01712345678': GOOD } });
  await openAdminOrder(page, order.id);
  const card = page.getByTestId('fraud-card');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveAttribute('data-tone', 'good');
  await expect(card.getByTestId('fraud-parcels')).toHaveText('50+');
  await expect(card.getByTestId('fraud-success')).toHaveText('92%');
  await expect(card.getByTestId('fraud-returned')).toHaveText('7%');
  await expect(card.locator('.fraud-card__hint')).toHaveCount(0);
  expect(calls.filter((c) => c.action === 'fraud_check')).toHaveLength(1);
  expect(calls.find((c) => c.action === 'fraud_check')?.phone).toBe('01712345678');

  // Close and open the same order again: no second call.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByTestId('order-row').filter({ hasText: order.orderNumber }).first().click();
  await expect(page.getByTestId('fraud-card')).toBeVisible({ timeout: 15_000 });
  expect(calls.filter((c) => c.action === 'fraud_check')).toHaveLength(1);

  // Refresh asks again.
  await page.getByTestId('fraud-card').getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => calls.filter((c) => c.action === 'fraud_check').length).toBe(2);
  expect(calls.filter((c) => c.action === 'fraud_check')[1].refresh).toBe(true);
});

test('Part 2: New order — amber 50–79 %, red < 50 % with the hint, neutral with no history', async ({ page }) => {
  test.setTimeout(90_000);
  await mockSteadfast(page, {
    fraud: { '01711000001': WARN, '01711000002': RISK, '01711000003': NONE },
  });
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=orders');
  await page.getByRole('button', { name: 'New order' }).click();
  const phone = page.locator('#manual-order-phone');
  const card = page.getByTestId('fraud-card');

  await phone.fill('+880 1711-000001');
  await expect(card).toHaveAttribute('data-tone', 'warn', { timeout: 15_000 });
  await expect(card.getByTestId('fraud-success')).toHaveText('64%');
  await expect(card).toContainText('Reported 1 time by other merchants');
  await expect(card.locator('.fraud-card__hint')).toHaveCount(0);

  await phone.fill('01711000002');
  await expect(card).toHaveAttribute('data-tone', 'risk', { timeout: 15_000 });
  await expect(card.getByTestId('fraud-success')).toHaveText('30%');
  await expect(card.locator('.fraud-card__hint')).toHaveText('High return risk — consider an advance payment');

  await phone.fill('8801711000003');
  await expect(card).toHaveAttribute('data-tone', 'none', { timeout: 15_000 });
  await expect(card).toContainText('No courier history yet');

  // A number the check doesn't answer for (or the action missing): nothing.
  await phone.fill('01711000009');
  await expect(card).toHaveCount(0);
});

test('Part 2: without the fraud_check action nothing is shown; customers and visitors are refused', async ({ page }) => {
  test.setTimeout(90_000);
  const order = await newWebOrder();
  // The default mock answers as if the action didn't exist.
  await openAdminOrder(page, order.id);
  await expect(page.getByRole('button', { name: 'Edit order' })).toBeVisible();
  await expect(page.getByTestId('fraud-card')).toHaveCount(0);

  // The real function refuses a customer and a visitor before asking Steadfast.
  const asCustomer = await callFunction<{ ok: boolean }>(customer.accessToken, 'steadfast', { action: 'fraud_check', phone: '01712345678' });
  expect(asCustomer.ok).toBe(false);
  const asVisitor = await callFunction<{ ok: boolean }>(SUPABASE_ANON_KEY, 'steadfast', { action: 'fraud_check', phone: '01712345678' });
  expect(asVisitor.ok).toBe(false);

  // The customer's own order page never shows it.
  const customerPage = await page.context().newPage();
  await mockSteadfast(customerPage, { fraud: { '01712345678': RISK } });
  await useSessionInPage(customerPage, customer);
  await customerPage.goto(`/orders/${order.id}`);
  await expect(customerPage.getByText(order.orderNumber).first()).toBeVisible({ timeout: 15_000 });
  await expect(customerPage.getByTestId('fraud-card')).toHaveCount(0);
  await customerPage.close();
});

/* ---------------------------------------------------------------- Part 3 */

const STATIONS = [
  { name: 'Gulshan', district: 'Dhaka' },
  { name: 'Gulshan Model Town', district: 'Dhaka' },
  { name: 'Gulistan', district: 'Dhaka' },
  { name: 'Mirpur', district: 'Dhaka' },
  { name: 'Bagerhat Sadar', district: 'Bagerhat' },
  { name: 'test thana', district: 'Bagerhat' },
  { name: 'Mongla', district: 'Bagerhat' },
];

async function pickDhakaDhaka(page: Page, prefix: string): Promise<void> {
  await page.locator(`#${prefix}-division`).click();
  await page.getByPlaceholder('Search division...').fill('Dhaka');
  await page.locator('.picker-sheet__row', { hasText: /^Dhaka$/ }).first().click();
  await page.locator(`#${prefix}-district`).click();
  await page.getByPlaceholder('Search district...').fill('Dhaka');
  await page.locator('.picker-sheet__row', { hasText: /^Dhaka$/ }).first().click();
}

/** Types letter by letter like a phone keyboard; after every letter the
 *  search box must still have the cursor and the sheet must not move. */
async function typeInThanaSearch(page: Page, text: string): Promise<void> {
  const search = page.getByLabel('Search thana');
  await search.click();
  const panel = page.locator('.sheet-panel--fixed-height');
  await expect(panel).toBeVisible();
  // Let the opening slide-up finish before measuring.
  await page.waitForTimeout(400);
  const top = (await panel.boundingBox())!.y;
  for (const letter of text) {
    await page.keyboard.type(letter);
    await page.waitForTimeout(120);
    expect(await search.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(Math.abs((await panel.boundingBox())!.y - top)).toBeLessThanOrEqual(1);
  }
  await expect(search).toHaveValue(text);
}

test('Part 3: checkout thana search — 4 letters in a row keep the keyboard, the sheet stays put, no test thana', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSteadfast(page, { policeStations: STATIONS });
  await page.addInitScript(() => window.localStorage.removeItem('steadfast-thanas-v1'));
  await useSessionInPage(page, customer);
  await page.goto('/');
  await page.waitForSelector('.product-card');
  await page.getByRole('button', { name: /^Add .* to cart$/ }).first().click();
  await page.goto('/cart');
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page).toHaveURL(/\/checkout\/delivery/);
  const prefix = (await page.locator('[id$="-division"]').first().getAttribute('id'))!.replace(/-division$/, '');
  await pickDhakaDhaka(page, prefix);
  await page.locator(`#${prefix}-thana`).click();
  await expect(page.getByTestId('thana-list')).toContainText('Mirpur', { timeout: 15_000 });

  await typeInThanaSearch(page, 'Guls');
  await expect(page.getByTestId('thana-list').getByRole('button', { name: 'Gulshan', exact: true })).toBeVisible();

  // Steadfast's own "test thana" never shows.
  await page.getByLabel('Search thana').fill('bagerhat');
  await expect(page.getByTestId('thana-list')).toContainText('Mongla');
  await expect(page.getByTestId('thana-list')).not.toContainText(/test thana/i);
  await page.getByLabel('Search thana').fill('test');
  await expect(page.getByTestId('thana-list').getByRole('button', { name: /test thana/i })).toHaveCount(0);
});

test('Part 3: admin New order thana search keeps focus and height too', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSteadfast(page, { policeStations: STATIONS });
  await page.addInitScript(() => window.localStorage.removeItem('steadfast-thanas-v1'));
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=orders');
  await page.getByRole('button', { name: 'New order' }).click();
  await pickDhakaDhaka(page, 'manual-order');
  await page.locator('#manual-order-thana').click();
  await expect(page.getByTestId('thana-list')).toContainText('Mirpur', { timeout: 15_000 });
  await typeInThanaSearch(page, 'Mirp');
  await expect(page.getByTestId('thana-list').getByRole('button', { name: 'Mirpur', exact: true })).toBeVisible();
});

test('Part 3: real staff never see the tests\' own customers; the test logins still do', async ({ page }) => {
  test.setTimeout(60_000);
  // As the test Super Admin (a test login) the test customer is listed.
  await useSessionInPage(page, admin);
  await page.goto(`/admin?tab=customers&cq=${encodeURIComponent(E2E_EMAIL)}`);
  await expect(page.getByTestId('customer-row').first()).toBeVisible({ timeout: 15_000 });
  // The rule real staff get (isTestCustomer) is unit-tested in
  // src/lib/batch31.test.ts; here: the live list has nothing else test-like.
  const products = await select<{ name: string }[]>(null, 'products_view?select=name&is_active=eq.true');
  expect((products.data ?? []).filter((p) => /\b(e2e|test|dummy|demo)\b/i.test(p.name))).toEqual([]);
  const categories = await select<{ name: string }[]>(null, 'categories?select=name');
  expect((categories.data ?? []).filter((c) => /\b(e2e|test|dummy|demo)\b/i.test(c.name))).toEqual([]);
  const brands = await select<{ name: string }[]>(null, 'brands?select=name');
  expect((brands.data ?? []).filter((b) => /\b(e2e|test|dummy|demo)\b/i.test(b.name))).toEqual([]);
});

/* ---------------------------------------------------------------- Part 4 */

test('Part 4: no inline "Edit price" or fee "Edit"; the pen beside ✕ opens Edit order', async ({ page }) => {
  test.setTimeout(90_000);
  const order = await newWebOrder();
  await openAdminOrder(page, order.id);
  const sheet = page.getByRole('dialog').first();
  await expect(sheet.getByRole('button', { name: /^Edit price/ })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Edit order' })).toHaveCount(1);
  // Text buttons are gone: the pen is an icon, sitting in the header next to Close.
  const header = sheet.locator('.sheet-header');
  const pen = header.getByRole('button', { name: 'Edit order' });
  await expect(pen).toBeVisible();
  await expect(pen).toHaveText('');
  const close = header.getByRole('button', { name: 'Close' });
  const [penBox, closeBox] = [(await pen.boundingBox())!, (await close.boundingBox())!];
  expect(Math.abs(penBox.width - closeBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(penBox.y - closeBox.y)).toBeLessThanOrEqual(1);
  expect(penBox.x).toBeLessThan(closeBox.x);
  // Call / WhatsApp / Invoice stay.
  for (const name of ['Call', 'WhatsApp', 'Invoice']) await expect(sheet.getByRole(name === 'Invoice' ? 'button' : 'link', { name })).toBeVisible();
  await pen.click();
  await expect(page.getByTestId('edit-order-page')).toBeVisible({ timeout: 10_000 });
});

test('Part 4: staff without "Edit orders" get no pen', async ({ page }) => {
  test.setTimeout(120_000);
  const role = await rpc<string>(admin.accessToken, 'admin_role_save', {
    p_id: null,
    p_name: ROLE_NAME,
    p_permissions: ['view_orders'],
  });
  expect(role.ok, role.error ?? '').toBe(true);
  const created = await callFunction<{ ok: boolean; userId?: string; error?: string }>(admin.accessToken, 'admin-team', {
    action: 'create',
    username: STAFF_USERNAME,
    fullName: 'E2E Batch31 Staff',
    phone: '01700000031',
    password: E2E_MOD_PASSWORD,
  });
  expect(created.ok, created.error).toBe(true);
  staffId = created.userId!;
  const setRole = await rpc(admin.accessToken, 'admin_team_set_role', { p_user_id: staffId, p_role_id: role.data! });
  expect(setRole.ok, setRole.error ?? '').toBe(true);

  const order = await newWebOrder();
  const staff = await passwordSession(`${STAFF_USERNAME}@staff.naeems.internal`, E2E_MOD_PASSWORD);
  await openAdminOrder(page, order.id, staff);
  await expect(page.getByText(order.orderNumber).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit order' })).toHaveCount(0);
});

/* ---------------------------------------------------------------- Part 5 */

test('Part 5: WhatsApp and Call use 880… whatever way the phone was typed', async ({ page }) => {
  test.setTimeout(90_000);
  const web = await newWebOrder();
  await openAdminOrder(page, web.id);
  let sheet = page.getByRole('dialog').first();
  await expect(sheet.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('href', 'https://wa.me/8801712345678');
  await expect(sheet.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:+8801712345678');

  const manual = await rpc<{ order_id: string }[]>(admin.accessToken, 'admin_create_order', {
    p_source: 'phone',
    p_items: [{ product_id: product.id, variant_id: null, quantity: 1 }],
    p_full_name: 'E2E B31 Phone Format',
    p_phone: MANUAL_PHONE_TYPED,
    p_division: 'Dhaka',
    p_district: 'Dhaka',
    p_thana: 'Mirpur',
    p_address_line: 'House 31 (e2e)',
    p_delivery_zone: 'inside_dhaka',
    p_delivery_fee: 70,
  });
  expect(manual.ok, manual.error ?? '').toBe(true);
  createdOrderIds.push(manual.data![0].order_id);
  await page.goto(`/admin?tab=orders&order=${manual.data![0].order_id}`);
  sheet = page.getByRole('dialog').first();
  await expect(sheet.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('href', 'https://wa.me/8801799990031', { timeout: 15_000 });
  await expect(sheet.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:+8801799990031');
});

/* ---------------------------------------------------------------- Part 6 */

test('Part 6: "Price Hub" is gone — title, link previews, manifest, menu', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.waitForSelector('.product-card');
  await expect(page).toHaveTitle("NAEEM'S");
  const head = await page.evaluate(() => document.head.innerHTML);
  expect(head).not.toMatch(/price[ -]?hub/i);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', "NAEEM'S");
  const manifest = await (await page.request.get('/manifest.webmanifest')).text();
  expect(manifest).not.toMatch(/price[ -]?hub/i);
  await page.getByRole('button', { name: 'Open menu' }).click();
  const menu = page.locator('.menu-list');
  await expect(menu.getByText('About Us')).toBeVisible();
  await expect(menu).not.toContainText(/price[ -]?hub/i);
  await expect(menu.getByText(/^About/)).toHaveCount(1);
  expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/price[ -]?hub/i);
});

async function menuHasAdminPanel(page: Page): Promise<number> {
  await page.goto('/');
  await page.waitForSelector('.product-card');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.locator('.menu-list').getByText('About Us')).toBeVisible();
  // Give the signed-in profile time to load before counting.
  await page.waitForTimeout(1500);
  return page.locator('.menu-list').getByText('Admin Panel').count();
}

test('Part 6: Admin Panel in the menu — only for signed-in staff', async ({ browser }) => {
  test.setTimeout(90_000);
  const visitor = await browser.newPage();
  expect(await menuHasAdminPanel(visitor)).toBe(0);
  await visitor.close();

  const shopper = await browser.newPage();
  await useSessionInPage(shopper, customer);
  expect(await menuHasAdminPanel(shopper)).toBe(0);
  await shopper.close();

  const staff = await browser.newPage();
  await useSessionInPage(staff, admin);
  await staff.goto('/');
  await staff.getByRole('button', { name: 'Open menu' }).click();
  await expect(staff.locator('.menu-list').getByText('Admin Panel')).toBeVisible({ timeout: 15_000 });
  await staff.close();
});

/* ---------------------------------------------------------------- Part 7 */

test('Part 7: manifest, theme colours, the offline helper and the version in Settings', async ({ page }) => {
  test.setTimeout(60_000);
  const manifest = (await (await page.request.get('/manifest.webmanifest')).json()) as {
    name: string;
    short_name: string;
    display: string;
    theme_color: string;
    background_color: string;
    icons: { src: string; purpose?: string; sizes: string }[];
  };
  expect(manifest.name).toBe("NAEEM'S");
  expect(manifest.short_name).toBe("NAEEM'S");
  expect(manifest.display).toBe('standalone');
  expect(manifest.theme_color).toBe('#FFFFFF');
  expect(manifest.background_color).toBe('#FFFFFF');
  expect(manifest.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
  expect(manifest.icons.some((i) => i.purpose === 'any' && i.sizes === '512x512')).toBe(true);
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok()).toBe(true);

  await page.addInitScript(() => window.localStorage.setItem('theme', 'light'));
  await page.goto('/');
  await page.waitForSelector('.product-card');
  await expect(page.locator('meta[name="theme-color"][media="(prefers-color-scheme: light)"]')).toHaveCount(1);
  await expect(page.locator('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]')).toHaveCount(1);
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#FFFFFF');
  // The status bar follows the app's own Dark Mode switch.
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('switch', { name: 'Dark Mode' }).click();
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#000000');
  await expect(page.locator('meta[name="theme-color"]').last()).toHaveAttribute('content', '#000000');

  // The offline helper registers after load.
  const scope = await page.evaluate(async () => {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
    ]);
    return reg ? reg.scope : null;
  });
  expect(scope).toMatch(/\/$/);

  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=settings');
  // Batch 32 Part 2: "Version 1.N.0" with "Build <commit>" under it (no date).
  await expect(page.getByTestId('app-version')).toHaveText(/^Version \d+\.\d+\.\d+$/, { timeout: 15_000 });
  await expect(page.getByTestId('app-build')).toHaveText(/^Build ([0-9a-f]{7}|local)$/);
});

/* ---------------------------------------------------------------- Part 8 */

test('Part 8: cards use the small copy when there is one, the full photo otherwise', async ({ page }) => {
  test.setTimeout(60_000);
  const rows = await select<{ id: string; name: string; image_urls: string[]; image_urls_thumb: string[] | null }[]>(
    null,
    'products_view?select=id,name,image_urls,image_urls_thumb&is_active=eq.true'
  );
  const all = rows.data ?? [];
  const withSmall = all.find((p) => (p.image_urls_thumb?.[0] ?? '').includes('/thumb/'));
  const withoutSmall = all.find((p) => p.image_urls?.length && (!p.image_urls_thumb?.[0] || p.image_urls_thumb[0] === p.image_urls[0]));
  for (const [item, expectSmall] of [
    [withSmall, true],
    [withoutSmall, false],
  ] as const) {
    if (!item) continue;
    // Batch 32: found through search — nearly every product has a small
    // copy now, so the one without may not be among Home's cards.
    await page.goto(`/search?q=${encodeURIComponent(item.name)}`);
    await page.waitForSelector('.product-card');
    const card = page.locator('.product-card', { hasText: item.name }).first();
    await card.scrollIntoViewIfNeeded();
    const src = (await card.locator('img').first().getAttribute('src')) ?? '';
    if (expectSmall) expect(src).toContain('/thumb/');
    else expect(src.split('?')[0]).toBe(item.image_urls[0].split('?')[0]);
  }
});

test('Part 8: "Generate small images" covers a product without a small copy (storage and saves mocked)', async ({ page }) => {
  test.setTimeout(180_000);
  const rows = await select<{ id: string; image_urls: string[]; image_urls_thumb: string[] | null }[]>(
    null,
    'products_view?select=id,image_urls,image_urls_thumb'
  );
  const needing = (rows.data ?? []).filter((p) => p.image_urls?.length && (p.image_urls ?? []).some((u, i) => !(p.image_urls_thumb?.[i] ?? '').includes('/thumb/')));
  test.skip(needing.length === 0, 'Every product already has small copies — nothing for the tool to do.');

  const icon = readFileSync('public/icons/icon-192.png');
  const uploads: string[] = [];
  const productSaves: { id: string; thumbs: string[] }[] = [];
  // The full photos are "downloaded" from here (a small real image).
  await page.route(/small-copy-source=/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: icon }));
  // Storage uploads never reach Supabase.
  await page.route(/\/storage\/v1\/object\/product-images\//, async (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PUT') {
      uploads.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ Key: 'mock', Id: 'mock' }) });
    }
    return route.fallback();
  });
  // Neither do saves to products / categories / variants.
  await page.route(/\/rest\/v1\/(products|categories|product_variants)\?/, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON() as { image_urls_thumb?: string[] };
    if (url.pathname.endsWith('/products') && body.image_urls_thumb) {
      productSaves.push({ id: (url.searchParams.get('id') ?? '').replace(/^eq\./, ''), thumbs: body.image_urls_thumb });
    }
    return route.fulfill({ status: 204, body: '' });
  });

  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=products');
  await expect(page.getByTestId('product-row').first()).toBeVisible({ timeout: 20_000 });
  const generate = page.getByRole('button', { name: 'Generate small images' }).first();
  if (await generate.isVisible()) {
    await generate.click();
  } else {
    await page.getByRole('button', { name: /More actions for Products/ }).click();
    await page.getByRole('menuitem', { name: 'Generate small images' }).click();
  }
  await expect(page.getByText(/Done: /)).toBeVisible({ timeout: 150_000 });

  const target = needing[0];
  const saved = productSaves.find((s) => s.id === target.id);
  expect(saved, 'the product without a small copy was processed').toBeTruthy();
  expect(saved!.thumbs.length).toBe(target.image_urls.length);
  for (const t of saved!.thumbs) expect(t).toMatch(/\/thumb\/.+\?v=\d+$/);
  expect(uploads.some((u) => u.includes('/thumb/'))).toBe(true);
});
