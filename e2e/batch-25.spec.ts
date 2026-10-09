import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_MOD_PASSWORD, E2E_PASSWORD, SUPABASE_ANON_KEY, SUPABASE_URL } from './helpers/env';
import {
  callFunction,
  passwordSession,
  pickStockedProduct,
  placeTestOrder,
  rpc,
  select,
  useSessionInPage,
  type TestSession,
} from './helpers/api';

// Batch 25: the admin redesign. Navigation (5 tabs, More groups, sidebar
// order, no sideways scroll), roles (limited access, server refusals, a
// role change applies at once), Home numbers vs the database, Products
// (row opens Edit, Delete only in ⋮ and confirmed, Low stock chip), no
// emoji anywhere, private admin notes, and the Telegram test-order skip.
// Uses the test Super Admin, a throwaway staff login and the test customer;
// everything it creates is deleted in afterAll.

const STAFF_USERNAME = 'e2e.role25';
const ROLE_NAME = 'E2E Batch25 role';
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2300}-\u{23FF}]/u;

const ADMIN_PAGES: { name: string; query: string }[] = [
  { name: 'Home', query: '' },
  { name: 'Orders', query: '?tab=orders' },
  { name: 'Customers', query: '?tab=customers' },
  { name: 'Products', query: '?tab=products' },
  { name: 'Categories', query: '?tab=categories' },
  { name: 'Brands', query: '?tab=brands' },
  { name: 'Import / Export', query: '?tab=import-export' },
  { name: 'Promo Codes', query: '?tab=promo-codes' },
  { name: 'Wholesalers', query: '?tab=wholesalers' },
  { name: 'Reviews', query: '?tab=reviews' },
  { name: 'Bento Tiles', query: '?tab=bento' },
  { name: 'Banner & Texts', query: '?tab=design' },
  { name: 'Banner slides', query: '?tab=design&dset=banner' },
  { name: 'Expert page (Talk to an Expert)', query: '?tab=design&dset=expert' },
  { name: 'Site texts (checkout note, trust boxes)', query: '?tab=design&dset=texts' },
  { name: 'Team', query: '?tab=team' },
  { name: 'Team', query: '?tab=team&tview=roles' },
  { name: 'Activity Log', query: '?tab=activity' },
  { name: 'Settings', query: '?tab=settings' },
  { name: 'Order number format', query: '?tab=settings&sset=order-number' },
  { name: 'Delivery fees and bKash', query: '?tab=settings&sset=payment' },
  { name: 'Low-stock alert', query: '?tab=settings&sset=low-stock' },
  { name: 'Checkout WhatsApp number', query: '?tab=settings&sset=whatsapp' },
  { name: 'Steadfast', query: '?tab=settings&sset=courier' },
  { name: 'Facebook Pixel and Google Analytics', query: '?tab=settings&sset=tracking' },
  { name: 'Safety Locks', query: '?tab=settings&sset=safety' },
  { name: 'Password, saved data, sign out', query: '?tab=settings&sset=account' },
  { name: 'More', query: '?tab=more' },
];

test.describe.configure({ mode: 'serial' });

test.skip(
  !E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_MOD_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD,
  'Needs the test accounts in .env.e2e (see reports/batch-24.txt).'
);

let admin: TestSession;
let customer: TestSession;
let staffId = '';
let roleId = '';
const createdOrderIds: string[] = [];

async function staffSession(): Promise<TestSession> {
  return passwordSession(`${STAFF_USERNAME}@staff.naeems.internal`, E2E_MOD_PASSWORD);
}

async function setRole(permissions: string[]): Promise<void> {
  const res = await rpc<string>(admin.accessToken, 'admin_role_save', { p_id: roleId, p_name: ROLE_NAME, p_permissions: permissions });
  expect(res.ok, res.error ?? '').toBe(true);
}

async function cleanUp(): Promise<void> {
  const team = await rpc<{ id: string; username: string }[]>(admin.accessToken, 'admin_team_list');
  for (const member of team.data ?? []) {
    if (member.username === STAFF_USERNAME) {
      await callFunction(admin.accessToken, 'admin-team', { action: 'delete', userId: member.id });
    }
  }
  const roles = await rpc<{ id: string; name: string }[]>(admin.accessToken, 'admin_role_list');
  for (const role of roles.data ?? []) {
    if (role.name === ROLE_NAME) await rpc(admin.accessToken, 'admin_role_delete', { p_id: role.id });
  }
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'page scrolls sideways').toBeLessThanOrEqual(0);
}

test.beforeAll(async () => {
  test.setTimeout(60_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  await cleanUp();

  const role = await rpc<string>(admin.accessToken, 'admin_role_save', {
    p_id: null,
    p_name: ROLE_NAME,
    p_permissions: ['view_orders', 'edit_products'],
  });
  expect(role.ok, role.error ?? '').toBe(true);
  roleId = role.data!;

  const created = await callFunction<{ ok: boolean; userId?: string; error?: string }>(admin.accessToken, 'admin-team', {
    action: 'create',
    username: STAFF_USERNAME,
    fullName: 'E2E Role Tester',
    phone: '01700000025',
    password: E2E_MOD_PASSWORD,
  });
  expect(created.ok, created.error).toBe(true);
  staffId = created.userId!;
  const assigned = await rpc(admin.accessToken, 'admin_team_set_role', { p_user_id: staffId, p_role_id: roleId });
  expect(assigned.ok, assigned.error ?? '').toBe(true);
});

test.afterAll(async () => {
  test.setTimeout(90_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  // Some test orders were confirmed, so the Safety Lock is opened for a
  // minute (fresh password sign-in) to remove them, then closed again.
  if (createdOrderIds.length > 0) {
    await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 60 });
    await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: createdOrderIds });
    await rpc(admin.accessToken, 'admin_close_delete_lock');
  }
  await cleanUp();
});

test.describe('phone, 360px', () => {
  test.use({ viewport: { width: 360, height: 760 } });

  test('exactly 5 bottom tabs; More shows the groups; every page reachable without sideways scroll', async ({ page }) => {
    test.setTimeout(180_000);
    await useSessionInPage(page, admin);
    await page.goto('/admin');
    const tabs = page.locator('.adm-tabbar__tab');
    await expect(tabs).toHaveCount(5);
    expect((await tabs.locator('.adm-tabbar__label').allInnerTexts()).map((t) => t.trim())).toEqual([
      'Home',
      'Orders',
      'Products',
      'Customers',
      'More',
    ]);

    await tabs.filter({ hasText: 'More' }).click();
    await expect(page).toHaveURL(/tab=more/);
    expect(await page.locator('.adm-group__title').allInnerTexts()).toEqual([
      'CATALOG',
      'SALES',
      'STORE DESIGN',
      'TEAM & SETTINGS',
    ]);
    await expect(page.locator('.adm-row', { hasText: 'Team' }).locator('.adm-pill-lock')).toHaveText('Super Admin');
    await expect(page.locator('.adm-row', { hasText: 'Activity Log' }).locator('.adm-pill-lock')).toHaveText('Super Admin');

    // Every More item opens its page (by tapping), and phone Back returns.
    for (const label of ['Categories', 'Brands', 'Import / Export', 'Promo Codes', 'Wholesalers', 'Reviews', 'Bento Tiles', 'Banner, Expert page, Texts', 'Team', 'Activity Log', 'Settings']) {
      await page.locator('.adm-row', { hasText: label }).first().click();
      await expect(page.locator('.adm-page-header__title')).toBeVisible();
      await noSidewaysScroll(page);
      await page.goBack();
      await expect(page).toHaveURL(/tab=more/);
    }

    // Every page (and settings sub-page) at 360px: its title, no sideways scroll.
    for (const p of ADMIN_PAGES) {
      await page.goto(`/admin${p.query}`);
      // Batch 32 Part 5: Home's title is "Good morning/afternoon/evening, <name>".
      const pattern =
        p.name === 'Home' ? '^Good (morning|afternoon|evening), E2E' : `^${p.name.replace(/[()&/.]/g, '\\$&')}`;
      await expect(page.locator('.adm-page-header__title')).toHaveText(new RegExp(pattern), {
        timeout: 15_000,
      });
      await page.waitForTimeout(300);
      await noSidewaysScroll(page);
    }
  });
});

test('computer, 1280px: sidebar groups in the mockup order', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=products');
  await expect(page.locator('.adm-sidebar')).toBeVisible();
  await expect(page.locator('.adm-tabbar')).toBeHidden();
  await expect(page.locator('.adm-sidebar__brand')).toHaveText("NAEEM'S SUPER ADMIN");
  expect(await page.locator('.adm-sidebar__heading').allInnerTexts()).toEqual(['CATALOG', 'SALES', 'STORE DESIGN', 'ADMIN']);
  expect((await page.locator('.adm-sidebar__label').allInnerTexts()).map((t) => t.trim())).toEqual([
    'Home', 'Orders', 'Steadfast payouts', 'Customers',
    'Products', 'Categories', 'Brands', 'Import / Export',
    'Promo Codes', 'Wholesalers', 'Reviews',
    'Bento Tiles', 'Banner & Texts',
    'Team', 'Activity Log', 'Settings',
  ]);
  await expect(page.locator('.adm-sidebar__item--on')).toHaveText('Products');
  await expect(page.getByRole('link', { name: /View site/ })).toHaveAttribute('target', '_blank');
  // About 10–12 product rows on a laptop screen. (Batch 30: wait for the
  // list to load first — counting at once sometimes saw 0 rows.)
  await expect(page.locator('[data-testid="product-row"]').first()).toBeVisible({ timeout: 15_000 });
  const visibleRows = await page.locator('[data-testid="product-row"]').evaluateAll(
    (rows) => rows.filter((r) => r.getBoundingClientRect().bottom <= window.innerHeight).length
  );
  expect(visibleRows).toBeGreaterThanOrEqual(6);
});

test('a limited role sees only its items, and the database refuses the rest', async ({ page }) => {
  test.setTimeout(90_000);
  const staff = await staffSession();
  await page.setViewportSize({ width: 1280, height: 800 });
  await useSessionInPage(page, staff);
  await page.goto('/admin');
  await expect(page.locator('.adm-sidebar__brand')).toHaveText(`NAEEM'S ${ROLE_NAME.toUpperCase()}`, { timeout: 15_000 });
  expect((await page.locator('.adm-sidebar__label').allInnerTexts()).map((t) => t.trim())).toEqual([
    'Home', 'Orders', 'Products', 'Categories', 'My Profile',
  ]);
  // A Super-Admin page by URL falls back to Home.
  await page.goto('/admin?tab=team');
  await expect(page.locator('.adm-page-header__eyebrow')).toHaveText(`NAEEM'S ${ROLE_NAME.toUpperCase()}`);

  // Direct API calls outside the role are refused.
  const customers = await rpc<unknown[]>(staff.accessToken, 'admin_customers');
  expect(customers.data ?? []).toHaveLength(0);
  const adminCustomers = await rpc<unknown[]>(admin.accessToken, 'admin_customers');
  expect((adminCustomers.data ?? []).length).toBeGreaterThan(0);
  const wholesalers = await rpc<unknown[]>(staff.accessToken, 'admin_list_profiles');
  expect(wholesalers.data ?? []).toHaveLength(0);
  const roles = await rpc<unknown[]>(staff.accessToken, 'admin_role_list');
  expect(roles.data ?? []).toHaveLength(0);
  const saveRole = await rpc(staff.accessToken, 'admin_role_save', { p_id: roleId, p_name: ROLE_NAME, p_permissions: ['see_sales'] });
  expect(saveRole.ok).toBe(false);
  const setRoleSelf = await rpc(staff.accessToken, 'admin_team_set_role', { p_user_id: staffId, p_role_id: roleId });
  expect(setRoleSelf.ok).toBe(false);
  const dash = await rpc<Record<string, unknown>>(staff.accessToken, 'admin_dashboard');
  expect(dash.ok, dash.error ?? '').toBe(true);
  expect(dash.data).toHaveProperty('to_confirm');
  expect(dash.data).toHaveProperty('low_stock');
  expect(dash.data).not.toHaveProperty('today_total');
  expect(dash.data).not.toHaveProperty('month_total');
  expect(dash.data).not.toHaveProperty('reviews_pending');
  expect(dash.data).not.toHaveProperty('wholesalers_pending');
  const status = await rpc(staff.accessToken, 'admin_set_order_status', {
    p_order_id: '00000000-0000-0000-0000-000000000000',
    p_new_status: 'confirmed',
  });
  expect(status.error ?? '').toContain('Not authorized');
  const logs = await select<unknown[]>(staff.accessToken, 'activity_log?select=id&limit=1');
  expect(logs.data ?? []).toHaveLength(0);
});

test("changing the role's switches changes their access at once", async ({ page }) => {
  test.setTimeout(90_000);
  const staff = await staffSession();
  expect((await rpc<unknown[]>(staff.accessToken, 'admin_customers')).data ?? []).toHaveLength(0);

  await setRole(['view_orders', 'edit_products', 'view_customers']);
  // Same login token, no re-login: the database reads the role every time.
  const now = await rpc<unknown[]>(staff.accessToken, 'admin_customers');
  expect((now.data ?? []).length).toBeGreaterThan(0);
  const rows = now.data as { total_spent: number | null }[];
  expect(rows.every((r) => r.total_spent === null)).toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  await useSessionInPage(page, staff);
  await page.goto('/admin?tab=customers');
  await expect(page.locator('.adm-sidebar__label', { hasText: 'Customers' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('customer-row').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.adm-thead', { hasText: 'TOTAL SPENT' })).toHaveCount(0);

  await setRole(['view_orders', 'edit_products']);
  expect((await rpc<unknown[]>(staff.accessToken, 'admin_customers')).data ?? []).toHaveLength(0);
  await page.goto('/admin?tab=orders');
  await expect(page.locator('.adm-sidebar__label', { hasText: 'Customers' })).toHaveCount(0, { timeout: 15_000 });

  // Role changes are in the Activity Log.
  const log = await select<{ action: string; entity_label: string }[]>(
    admin.accessToken,
    `activity_log?select=action,entity_label&action=in.(team.role_updated,team.role_assigned,team.role_created)&order=id.desc&limit=10`
  );
  const actions = (log.data ?? []).filter((r) => r.entity_label === ROLE_NAME || r.entity_label === STAFF_USERNAME).map((r) => r.action);
  expect(actions).toContain('team.role_updated');
  expect(actions).toContain('team.role_assigned');
});

test('Home numbers match the database; money only with "See sales figures"', async ({ page }) => {
  test.setTimeout(90_000);
  const product = await pickStockedProduct(3);
  const order = await placeTestOrder(customer.accessToken, product.id, 1);
  createdOrderIds.push(order.id);

  const orders = await select<{ status: string; total: number; created_at: string; steadfast_consignment_id: string | null }[]>(
    admin.accessToken,
    'orders?select=status,total,created_at,steadfast_consignment_id'
  );
  const dhakaDay = (iso: string) => new Date(new Date(iso).getTime() + 6 * 3600_000).toISOString().slice(0, 10);
  const today = dhakaDay(new Date().toISOString());
  const live = (orders.data ?? []).filter((o) => o.status !== 'cancelled');
  const todays = live.filter((o) => dhakaDay(o.created_at) === today);
  const month = live.filter((o) => dhakaDay(o.created_at).slice(0, 7) === today.slice(0, 7));
  const expected = {
    today_orders: todays.length,
    today_total: todays.reduce((s, o) => s + Number(o.total), 0),
    to_confirm: (orders.data ?? []).filter((o) => o.status === 'pending').length,
    on_the_way: (orders.data ?? []).filter((o) => o.status === 'shipped' && o.steadfast_consignment_id).length,
    month_orders: month.length,
    month_total: month.reduce((s, o) => s + Number(o.total), 0),
  };
  const dash = await rpc<Record<string, number>>(admin.accessToken, 'admin_dashboard');
  expect(dash.ok, dash.error ?? '').toBe(true);
  for (const [key, value] of Object.entries(expected)) {
    expect(Number(dash.data![key]), key).toBe(value);
  }
  const lowStock = await select<{ id: string }[]>(
    admin.accessToken,
    `products_view?select=id&is_active=eq.true&stock_quantity=lte.${Number(dash.data!.low_stock_threshold)}`
  );
  expect(Number(dash.data!.low_stock)).toBe((lowStock.data ?? []).length);

  // The page shows the same numbers.
  await useSessionInPage(page, admin);
  await page.goto('/admin');
  await expect(page.getByTestId('kpi-today-count')).toHaveText(String(expected.today_orders), { timeout: 15_000 });
  await expect(page.getByTestId('kpi-confirm-count')).toHaveText(String(expected.to_confirm));
  await expect(page.getByTestId('kpi-way-count')).toHaveText(String(expected.on_the_way));
  await expect(page.getByTestId('kpi-today-total')).toContainText('৳');
  await expect(page.getByTestId('kpi-month-total')).toContainText('৳');
  await expect(page.locator('.adm-row', { hasText: 'waiting to confirm' }).locator('.adm-row__count')).toHaveText(
    String(expected.to_confirm)
  );

  // Staff without "See sales figures": counts, but no money on Home.
  const staff = await staffSession();
  const staffPage = await page.context().newPage();
  await useSessionInPage(staffPage, staff);
  await staffPage.goto('/admin');
  await expect(staffPage.getByTestId('kpi-today-count')).toHaveText(String(expected.today_orders), { timeout: 15_000 });
  await expect(staffPage.getByTestId('kpi-today-total')).not.toContainText('৳');
  await expect(staffPage.getByTestId('kpi-month-total')).toHaveCount(0);
  await expect(staffPage.locator('.adm-home')).not.toContainText('৳');

  // With the switch on, the money appears.
  await setRole(['view_orders', 'edit_products', 'see_sales']);
  const withSales = await rpc<Record<string, number>>(staff.accessToken, 'admin_dashboard');
  expect(Number(withSales.data!.month_total)).toBe(expected.month_total);
  await staffPage.reload();
  await expect(staffPage.getByTestId('kpi-month-total')).toContainText('৳', { timeout: 15_000 });
  await setRole(['view_orders', 'edit_products']);
  await staffPage.close();
});

test('Products: row opens Edit; Delete only in the ⋮ menu and confirmed; Low stock chip filters', async ({ page }) => {
  test.setTimeout(90_000);
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=products');
  const firstRow = page.getByTestId('product-row').first();
  await expect(firstRow).toBeVisible({ timeout: 20_000 });

  // No big Edit/Delete buttons on the row.
  await expect(firstRow.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await expect(firstRow.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);

  await firstRow.locator('.adm-lrow__name').click();
  // Batch 32 Part 3: the editor is a page of its own; Back returns here.
  await expect(page.getByTestId('product-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Edit product' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to products' }).click();
  await expect(page.getByTestId('product-page')).toHaveCount(0);
  await expect(firstRow).toBeVisible({ timeout: 15_000 });

  await firstRow.getByRole('button', { name: /^Actions for / }).click();
  const menu = page.getByRole('menu');
  const items = (await menu.getByRole('menuitem').allInnerTexts()).map((t) => t.trim());
  expect(items[0]).toBe('Edit');
  expect(items).toContain('View on site');
  expect(items.some((t) => t === 'Feature on home' || t === 'Remove from home')).toBe(true);
  expect(items[items.length - 1]).toBe('Delete');
  await menu.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete product?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);

  // Low stock chip = live products at or below the threshold.
  const threshold = await select<{ value: string }[]>(null, 'app_settings?select=value&key=eq.low_stock_threshold');
  const limit = Number(threshold.data?.[0]?.value ?? '5');
  const low = await select<{ id: string }[]>(null, `products_view?select=id&is_active=eq.true&stock_quantity=lte.${limit}`);
  const lowCount = (low.data ?? []).length;
  const chip = page.locator('.adm-chip', { hasText: 'Low stock' });
  await expect(chip).toContainText(String(lowCount));
  await chip.click();
  await expect(page).toHaveURL(/pstock=low/);
  await expect(page.getByTestId('product-row')).toHaveCount(lowCount);
  for (const text of await page.locator('[data-testid="product-row"] .adm-mobile-meta .adm-stock').allInnerTexts()) {
    expect(text).toMatch(/left|Out of stock/);
  }
});

test('no emoji anywhere in the rendered admin', async ({ page }) => {
  test.setTimeout(180_000);
  await useSessionInPage(page, admin);
  for (const p of ADMIN_PAGES) {
    await page.goto(`/admin${p.query}`);
    await expect(page.locator('.adm-page-header').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(400);
    // Batch 33: what customers wrote (review quotes) is their own text and
    // may hold emoji; only the admin's own words are checked.
    const text = await page.locator('.adm').first().evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('.review-admin__quote').forEach((q) => q.remove());
      document.body.appendChild(copy);
      const out = copy.innerText;
      copy.remove();
      return out;
    });
    const found = text.match(EMOJI);
    expect(found, `emoji on ${p.query || 'Home'}: ${found?.[0] ?? ''}`).toBeNull();
  }
});

test('admin notes and internal history are private: the customer cannot read them', async ({ page }) => {
  test.setTimeout(60_000);
  const product = await pickStockedProduct(3);
  const order = await placeTestOrder(customer.accessToken, product.id, 1);
  createdOrderIds.push(order.id);
  const note = 'E2E private note: call before delivery';
  const saved = await rpc(admin.accessToken, 'admin_update_order_fields', { p_order_id: order.id, p_fields: { admin_note: note } });
  expect(saved.ok, saved.error ?? '').toBe(true);
  const confirmed = await rpc(admin.accessToken, 'admin_set_order_status', {
    p_order_id: order.id,
    p_new_status: 'confirmed',
    p_note: 'E2E internal step note',
  });
  expect(confirmed.ok, confirmed.error ?? '').toBe(true);

  // As the customer, straight from the database.
  const own = await select<{ id: string; admin_note: string | null }[]>(customer.accessToken, `orders?select=id,admin_note&id=eq.${order.id}`);
  expect(own.data).toHaveLength(1);
  expect(own.data![0].admin_note).toBeNull();
  const history = await select<{ note: string | null; changed_by_username: string | null }[]>(
    customer.accessToken,
    `order_status_history?select=note,changed_by_username&order_id=eq.${order.id}`
  );
  expect((history.data ?? []).length).toBeGreaterThanOrEqual(2);
  for (const row of history.data ?? []) {
    expect(row.note).toBeNull();
    expect(row.changed_by_username).toBeNull();
  }
  expect((await select<unknown[]>(customer.accessToken, `order_private_notes?select=admin_note&order_id=eq.${order.id}`)).data ?? []).toHaveLength(0);
  expect((await select<unknown[]>(customer.accessToken, `order_history_private?select=note&order_id=eq.${order.id}`)).data ?? []).toHaveLength(0);
  expect((await select<unknown[]>(null, `order_private_notes?select=admin_note`)).data ?? []).toHaveLength(0);

  // Staff still see them, on the order screen.
  await useSessionInPage(page, admin);
  await page.goto(`/admin?tab=orders&order=${order.id}`);
  // (Batch 35: the order is a page; its History is folded until tapped.)
  const orderPage = page.getByTestId('admin-order-page');
  await expect(orderPage.getByPlaceholder('Private note, customer never sees this')).toHaveValue(note, { timeout: 15_000 });
  await orderPage.getByTestId('history-toggle').click();
  await expect(orderPage.getByText('E2E internal step note').first()).toBeVisible();
  await expect(orderPage.getByText('by e2e.admin').first()).toBeVisible();

  // The customer's own page still shows only the friendly status.
  const shopper = await page.context().newPage();
  await useSessionInPage(shopper, customer);
  await shopper.goto(`/orders/${order.id}`);
  await expect(shopper.getByTestId('delivery-status')).toBeVisible({ timeout: 15_000 });
  await expect(shopper.locator('body')).not.toContainText(note);
  await expect(shopper.locator('body')).not.toContainText('E2E internal step note');
  await shopper.close();
});

test('Telegram: the live notifier sends nothing for an outside caller', async () => {
  // A cancellation of an "E2E ..." order would page Naeem; the deployed
  // function must send nothing. Since Batch 34 it refuses every caller
  // without the database's shared secret (401), so an outside call like
  // this one never reaches the test-order rule at all — that rule is
  // covered by src/lib/testOrders.test.ts. (Updated in Batch 35: this test
  // still expected the pre-Batch-34 "skipped" answer.)
  const res = await fetch(`${SUPABASE_URL}/functions/v1/notify-telegram-order`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'UPDATE',
      table: 'orders',
      record: {
        id: '00000000-0000-0000-0000-000000000000',
        order_number: 'NM-E2E',
        customer_id: null,
        customer_name: 'E2E Someone Else',
        customer_phone: '01799999999',
        status: 'cancelled',
        steadfast_status: null,
        source: 'phone',
      },
      old_record: { status: 'pending', steadfast_status: null },
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  expect(res.status).toBe(401);
  expect(body.sent).toBeUndefined();
});
