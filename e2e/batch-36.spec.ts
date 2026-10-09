import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_MOD_PASSWORD, E2E_PASSWORD } from './helpers/env';
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
import { CORS, DAY, OLD_PLAIN, mockPayouts, restAnswer, withRichProduct } from './helpers/batch36';

// Batch 36: Steadfast payouts, rich product text, Smart paste on New order,
// and the product photo's corner seam. Steadfast is ALWAYS mocked, and so
// is every payout number on screen (nothing is read from the real
// Steadfast). Test orders are the test customer's, deleted in afterAll;
// the test staff login and role are deleted too. Real products are only
// opened, never saved.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const STAFF_USERNAME = 'e2e.role36';
const ROLE_NAME = 'E2E Batch36 role';

let admin: TestSession;
let customer: TestSession;
let product: { id: string; name: string; stock: number };
const createdOrderIds: string[] = [];
let staffId = '';
let roleId = '';

async function freshAdmin(): Promise<void> {
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
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
  staffId = '';
  roleId = '';
}

/** A test staff login whose role has exactly these switches. */
async function staffWith(permissions: string[]): Promise<TestSession> {
  const role = await rpc<string>(admin.accessToken, 'admin_role_save', { p_id: roleId || null, p_name: ROLE_NAME, p_permissions: permissions });
  expect(role.ok, role.error ?? '').toBe(true);
  roleId = role.data!;
  if (!staffId) {
    const created = await callFunction<{ ok: boolean; userId?: string; error?: string }>(admin.accessToken, 'admin-team', {
      action: 'create',
      username: STAFF_USERNAME,
      fullName: 'E2E Batch36 Staff',
      phone: '01700000036',
      password: E2E_MOD_PASSWORD,
    });
    expect(created.ok, created.error).toBe(true);
    staffId = created.userId!;
    const set = await rpc(admin.accessToken, 'admin_team_set_role', { p_user_id: staffId, p_role_id: roleId });
    expect(set.ok, set.error ?? '').toBe(true);
  }
  return passwordSession(`${STAFF_USERNAME}@staff.naeems.internal`, E2E_MOD_PASSWORD);
}

/** A test order "booked" on Steadfast with a made-up consignment id
 *  (database only — Steadfast is never called). */
async function bookedOrder(): Promise<{ id: string; orderNumber: string }> {
  const order = await placeTestOrder(customer.accessToken, product.id, 1);
  createdOrderIds.push(order.id);
  const confirm = await rpc(admin.accessToken, 'admin_set_order_status', { p_order_id: order.id, p_new_status: 'confirmed' });
  expect(confirm.ok, confirm.error ?? '').toBe(true);
  const res = await rpc(admin.accessToken, 'admin_record_steadfast_shipment', {
    p_order_id: order.id,
    p_consignment_id: `E2E-B36-${Date.now()}`,
    p_tracking_code: 'E2EB36',
    p_tracking_link: '',
    p_courier_status: 'in_review',
  });
  expect(res.ok, res.error ?? '').toBe(true);
  return order;
}

test.beforeAll(async () => {
  test.setTimeout(90_000);
  await freshAdmin();
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  product = await pickStockedProduct(10);
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

/* ------------------------------------------------------------ helpers */

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/* ---------------------------------------------------------------- Part 1 */

test('Part 1: payouts page — balance, 7-day alert, this month, list; Refresh asks the function', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const unpaid = [
    { order_id: 'u1', order_number: 'NM-1451', delivered_at: new Date(Date.now() - 10 * DAY).toISOString() },
    { order_id: 'u2', order_number: 'NM-1460', delivered_at: new Date(Date.now() - 2 * DAY).toISOString() },
  ];
  const calls = await mockPayouts(page, { unpaid });
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=payouts');

  await expect(page.getByRole('heading', { name: 'Steadfast payouts' })).toBeVisible();
  const balance = page.getByTestId('payouts-balance');
  await expect(balance).toContainText('৳12,481');
  await expect(balance).toContainText('From 2 delivered orders');
  await expect(balance).toContainText('updated 10 min ago');

  const alert = page.getByTestId('payouts-overdue');
  await expect(alert).toContainText('1 order not paid after 7 days');
  await expect(alert).toContainText('NM-1451');
  await expect(alert).not.toContainText('NM-1460');

  // This month = the exact sum of the parcels, shown in whole taka.
  const month = page.getByTestId('payouts-month');
  await expect(month).toContainText('৳7,298');
  await expect(month).toContainText('− ৳390');
  await expect(month).toContainText('− ৳73');
  await expect(page.getByTestId('payouts-month-received')).toHaveText('৳6,835');
  await expect(page.getByTestId('payouts-month-received')).toHaveAttribute('title', '৳6,835.02');

  const row = page.getByTestId('payouts-list').getByRole('button').first();
  await expect(row).toContainText('Payout #48213');
  await expect(row).toContainText('3 orders · fees ৳463');
  await expect(row).toContainText('1 to check');
  await noSideScroll(page);

  await page.getByTestId('payouts-refresh').click();
  await expect.poll(() => calls.includes('payouts_sync')).toBe(true);
});

test('Part 1: payout detail — orders, fees, what you get, total, "to check" reason; order opens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockPayouts(page);
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=payouts');
  await page.getByTestId('payouts-list').getByRole('button').first().click();
  await expect(page).toHaveURL(/\/admin\/payouts\/p-48213$/);
  await expect(page.getByTestId('payout-pill')).toHaveText('1 to check');
  const table = page.getByTestId('payout-table');
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table.locator('tbody tr').first()).toContainText('NM-1722');
  await expect(table.locator('tbody tr').first()).toContainText('৳2,299');
  await expect(table.locator('tbody tr').first()).toContainText('−153');
  await expect(table.locator('tbody tr').first()).toContainText('৳2,146');
  await expect(page.getByTestId('payout-total')).toHaveText('৳6,835');
  await expect(page.getByTestId('payout-reason')).toContainText('Expected ৳3,799.00');
  await expect(page.getByText('Fees = delivery charge + 1% COD fee')).toBeVisible();
  await noSideScroll(page);
  await table.getByRole('button', { name: 'NM-1722' }).click();
  await expect(page).toHaveURL(/\/admin\/orders\/NM-1722$/);
});

test('Part 1: the 7-day unpaid row on Home appears and disappears', async ({ page }) => {
  await mockPayouts(page, {
    unpaid: [{ order_id: 'u1', order_number: 'NM-1451', delivered_at: new Date(Date.now() - 9 * DAY).toISOString() }],
  });
  await useSessionInPage(page, admin);
  await page.goto('/admin');
  await expect(page.getByTestId('home-unpaid-row')).toHaveText('order not paid by Steadfast after 7 days');

  const later = await page.context().newPage();
  await mockPayouts(later, { unpaid: [] });
  await useSessionInPage(later, admin);
  await later.goto('/admin');
  await expect(later.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await expect(later.getByTestId('home-unpaid-row')).toHaveCount(0);
  await later.close();
});

test('Part 1: order page shows "Steadfast paid ৳X on 8 Oct (fees ৳Y)" or "not paid yet"', async ({ page }) => {
  test.setTimeout(60_000);
  const order = await bookedOrder();
  await mockPayouts(page);
  let paid = true;
  await page.route(/\/rest\/v1\/order_courier_costs\?/, (route) =>
    restAnswer(
      route,
      paid
        ? [{ net_received: 2146.01, total_kept: 152.99, paid_at: '2026-10-08T10:10:00Z', payout_id: 'p-48213', steadfast_payouts: { steadfast_payment_id: '48213' } }]
        : []
    )
  );
  await useSessionInPage(page, admin);
  await page.goto(`/admin/orders/${order.orderNumber}`);
  const line = page.getByTestId('order-steadfast-paid');
  await expect(line).toContainText('Steadfast paid ৳2,146 on 8 Oct (fees ৳153)');
  await expect(line).toContainText('Payout #48213');

  paid = false;
  await page.reload();
  await expect(page.getByTestId('order-steadfast-paid')).toHaveText('Steadfast: not paid yet');
});

test('Part 1: staff without "View profit & costs" never see payouts (menu, links, database)', async ({ page }) => {
  test.setTimeout(90_000);
  const staff = await staffWith(['view_orders']);
  await useSessionInPage(page, staff);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Steadfast payouts|^Payouts$/)).toHaveCount(0);
  await page.goto('/admin?tab=payouts');
  await expect(page.getByRole('heading', { name: 'Steadfast payouts' })).toHaveCount(0);
  await page.goto('/admin/payouts/anything');
  await expect(page).toHaveURL(/\/admin$/);

  // The database itself (needs migration-038; skipped until it is run).
  const probe = await select<unknown[]>(admin.accessToken, 'steadfast_payouts?select=id&limit=1');
  test.skip(!probe.ok, 'migration-038 not run yet.');
  for (const table of ['steadfast_payouts', 'steadfast_payout_items', 'order_courier_costs', 'steadfast_sync_state']) {
    const asStaff = await select<unknown[]>(staff.accessToken, `${table}?select=*&limit=5`);
    expect(asStaff.data ?? [], `${table} as staff`).toEqual([]);
    const anon = await select<unknown[]>(null, `${table}?select=*&limit=5`);
    expect(anon.ok && (anon.data ?? []).length > 0, `${table} as a visitor`).toBe(false);
  }
  const unpaid = await rpc<unknown[]>(staff.accessToken, 'steadfast_unpaid_orders', { p_days: 0 });
  expect(unpaid.data ?? []).toEqual([]);

  // With the switch On they see what the Super Admin sees.
  const allowed = await staffWith(['view_orders', 'view_profit_costs']);
  const asAdmin = await select<unknown[]>(admin.accessToken, 'steadfast_payouts?select=id');
  const asAllowed = await select<unknown[]>(allowed.accessToken, 'steadfast_payouts?select=id');
  expect((asAllowed.data ?? []).length).toBe((asAdmin.data ?? []).length);
});

/* ---------------------------------------------------------------- Part 2 */

async function productSlug(): Promise<string> {
  return (await select<{ slug: string }[]>(null, `products_view?select=slug&id=eq.${product.id}`)).data?.[0]?.slug ?? product.id;
}

test('Part 2: customer page — boxes, steps, colours by name; links safe; scripts stripped; old text unchanged; plain meta', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await withRichProduct(page, product.id);
  await page.goto(`/product/${await productSlug()}`);
  const about = page.getByTestId('pdp-about');
  await expect(about.locator('div[data-box="benefits"] li')).toHaveCount(2);
  await expect(about.locator('div[data-box="warning"]')).toBeVisible();
  await expect(about.locator('div[data-box="tip"]')).toBeAttached();
  await expect(about.locator('ol > li')).toHaveCount(2);
  await expect(about.locator('span[data-color="teal"]')).toHaveCount(1);
  await expect(about.locator('mark[data-hl="peach"]')).toHaveCount(1);
  const good = about.locator('a[href="https://naeems.com"]');
  await expect(good).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  await expect(good).toHaveAttribute('target', '_blank');
  expect(await about.innerHTML()).not.toMatch(/javascript:|onclick|onerror|<script|<img/);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

  // Old plain text: exactly the old paragraph, line breaks kept.
  await page.getByRole('button', { name: 'How to use' }).click();
  const how = page.getByTestId('pdp-how-to-use');
  await expect(how).toHaveClass(/accordion__text/);
  expect(await how.textContent()).toBe(OLD_PLAIN);

  // Search engines get the plain-text version.
  const ld = await page.locator('#product-json-ld').textContent();
  const description = (JSON.parse(ld ?? '{}') as { description?: string }).description ?? '';
  expect(description).toContain('খুশকির মূল কারণ দূর করে');
  expect(description).not.toMatch(/[<>]/);

  // Readable in dark mode too: the teal text is the bright shade.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  const darkTeal = await about.locator('span[data-color="teal"]').evaluate((el) => getComputedStyle(el).color);
  expect(darkTeal).toBe('rgb(95, 212, 200)');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  const lightTeal = await about.locator('span[data-color="teal"]').evaluate((el) => getComputedStyle(el).color);
  expect(lightTeal).toBe('rgb(15, 111, 104)');
});

test('Part 2: editor toolbar makes the allowed formatting; paste is cleaned; leaving asks first; toolbar scrolls on a phone', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 360, height: 780 });
  await useSessionInPage(page, admin);
  await page.goto(`/admin/products/${product.id}/edit`);
  const editor = page.getByTestId('rt-editor-pf-description');
  const content = editor.locator('.rt-editor__content');
  await expect(content).toBeVisible({ timeout: 15_000 });

  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Key point');
  await page.keyboard.press('ControlOrMeta+a');
  await editor.getByTestId('rt-bold').click();
  await expect(content.locator('strong')).toHaveText('Key point');
  await editor.getByTestId('rt-colour').click();
  await editor.getByRole('button', { name: 'Teal', exact: true }).click();
  await expect(content.locator('span[data-color="teal"]')).toHaveText('Key point');
  await editor.getByRole('button', { name: 'Peach highlight' }).click();
  await expect(content.locator('mark[data-hl="peach"]')).toHaveCount(1);
  await editor.getByTestId('rt-warning').click();
  await expect(content.locator('div[data-box="warning"]')).toHaveCount(1);
  await content.locator('div[data-box="warning"] p').click();
  await editor.getByTestId('rt-numbered').click();
  await expect(content.locator('div[data-box="warning"] ol li')).toHaveCount(1);

  // Pasting from Word / a web page: scripts, handlers, styles and unknown
  // tags are dropped, the words stay.
  await content.click();
  await page.keyboard.press('ControlOrMeta+End');
  await content.evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/html', '<p onclick="window.__xss=1" style="color:red;font-size:30px">Pasted <script>window.__xss=1</script><font face="Arial">words</font><img src=x onerror="window.__xss=1"></p>');
    data.setData('text/plain', 'Pasted words');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(content).toContainText('Pasted words');
  const html = await content.innerHTML();
  expect(html).not.toMatch(/onclick|<script|<font|<img|style="color/);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

  // The toolbar scrolls sideways on a phone and stays at the top of the field.
  const row = editor.locator('.rt-toolbar__row');
  const sizes = await row.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  expect(await editor.locator('.rt-toolbar').evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
  await noSideScroll(page);

  // Unsaved-changes guard still works (nothing is saved).
  await page.getByRole('button', { name: 'Back to products' }).click();
  await expect(page.getByText('Discard changes?')).toBeVisible();
});

/* ---------------------------------------------------------------- Part 3 */

const MESSAGE = 'Rume\nYousuf traders dhan dokaner pisone basha,uttar bazar,poroshuram, Feni\n01638820872';

/** Samples the orb and the flower every frame: the most both were ever
 *  visible at the same moment. */
async function startOverlapSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __overlap: number; __sampling: boolean };
    w.__overlap = 0;
    w.__sampling = true;
    const tick = () => {
      const mark = document.querySelector('[data-testid="smart-paste"] .am');
      if (mark) {
        const orb = Number(getComputedStyle(mark.querySelector('[data-part="orb"]')!).opacity);
        const petals = Number(getComputedStyle(mark.querySelector('[data-part="petals"]')!).opacity);
        w.__overlap = Math.max(w.__overlap, Math.min(orb, petals));
      }
      if (w.__sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test('Part 3: Smart paste — reading 2–3 s (orb and flower never together), then Parshuram, Feni filled; outlines; Undo fill', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  await page.goto('/admin/orders/new');
  const card = page.getByTestId('smart-paste');
  await expect(card).toContainText('Smart paste');
  await expect(card).toContainText("Paste the customer's message");
  await expect(page.getByText(/\bAI\b/)).toHaveCount(0);

  await page.getByTestId('smart-paste-text').fill(MESSAGE);
  await startOverlapSampler(page);
  const started = Date.now();
  await page.getByTestId('smart-paste-fill').click();
  await expect(page.getByTestId('smart-paste-reading')).toHaveText('Reading the message…');
  await expect(card).toHaveAttribute('data-state', 'filled', { timeout: 5000 });
  const reading = Date.now() - started;
  expect(reading).toBeGreaterThanOrEqual(2000);
  expect(reading).toBeLessThanOrEqual(3300);

  await expect(page.locator('#manual-order-name')).toHaveValue('Rume');
  await expect(page.locator('#manual-order-phone')).toHaveValue('01638820872');
  await expect(page.locator('#manual-order-address')).toHaveValue(
    'Yousuf traders dhan dokaner pisone basha, uttar bazar, poroshuram, Feni'
  );
  await expect(page.locator('#manual-order-thana')).toHaveText('Parshuram');
  await expect(page.locator('#manual-order-district')).toHaveText('Feni');
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    (window as unknown as { __sampling: boolean }).__sampling = false;
  });
  expect(await page.evaluate(() => (window as unknown as { __overlap: number }).__overlap)).toBeLessThanOrEqual(0.02);

  await expect(card).toContainText('Filled, please check');
  await expect(card).toContainText('Orange outline = guessed, tap to change');
  const guess = page.locator('.smart-guess');
  await expect(guess).toHaveAttribute('data-guess-name', '');
  await expect(guess).toHaveAttribute('data-guess-address', '');
  await expect(guess).toHaveAttribute('data-guess-thana', '');
  const outline = await page.locator('#manual-order-name').evaluate((el) => getComputedStyle(el).borderColor);
  expect(outline).toBe('rgb(242, 89, 42)');
  await expect(page.getByTestId('smart-thana')).toContainText('matched “poroshuram”');
  await expect(page.locator('.smart-thana__chip')).toHaveCount(3);
  await expect(page.locator('.smart-thana__chip.is-on')).toHaveText('Parshuram');

  // Typing in a guessed field confirms it.
  await page.locator('#manual-order-name').fill('Rume Akter');
  await expect(guess).not.toHaveAttribute('data-guess-name', '');
  await expect(guess).toHaveAttribute('data-guess-address', '');

  // Undo fill puts the form back as it was.
  await page.getByTestId('smart-paste-undo').click();
  await expect(page.locator('#manual-order-name')).toHaveValue('');
  await expect(page.locator('#manual-order-phone')).toHaveValue('');
  await expect(page.locator('#manual-order-address')).toHaveValue('');
  await expect(card).toHaveAttribute('data-state', 'idle');
  await noSideScroll(page);
});

test('Part 3: a saved customer with the pasted phone is offered; one tap fills from the profile', async ({ page }) => {
  await page.route(/\/rest\/v1\/rpc\/admin_find_customers_v2/, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const query = String((route.request().postDataJSON() as { p_query?: string } | null)?.p_query ?? '');
    const rows = query.includes('1638820872')
      ? [{
          customer_key: 'ph:01638820872',
          profile_id: null,
          full_name: 'Rume Akter',
          phone: '01638820872',
          alt_phone: null,
          division: 'Chattagram',
          district: 'Feni',
          thana: 'Parshuram',
          address_line: 'Uttar Bazar, Yousuf traders',
          order_count: 2,
          total_due: 0,
        }]
      : [];
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(rows) });
  });
  await useSessionInPage(page, admin);
  await page.goto('/admin/orders/new');
  await page.getByTestId('smart-paste-text').fill(MESSAGE);
  await page.getByTestId('smart-paste-fill').click();
  const saved = page.getByTestId('smart-paste-saved');
  await expect(saved).toContainText('Saved customer: Rume Akter, Parshuram, Feni', { timeout: 6000 });
  await saved.getByRole('button', { name: 'Use saved details' }).click();
  await expect(page.locator('#manual-order-name')).toHaveValue('Rume Akter');
  await expect(page.locator('#manual-order-address')).toHaveValue('Uttar Bazar, Yousuf traders');
  await expect(page.locator('.smart-guess')).not.toHaveAttribute('data-guess-name', '');
});

test('Part 3: COD / Product labels are hints only; reduced motion — no spin, still 2–3 s', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await useSessionInPage(page, admin);
  await page.goto('/admin/orders/new');
  await page.getByTestId('smart-paste-text').fill('Name: Tania\nPhone: +88 01812-345678\nAddress: House 4, Road 2, Dhanmondi, Dhaka\nCOD: 1250 tk\nProduct: Scalpe Plus x2');
  await page.getByTestId('smart-paste-fill').click();
  const spin = await page.locator('[data-testid="smart-paste"] .am__spin').evaluate((el) => getComputedStyle(el).animationName);
  expect(spin).toBe('none');
  await expect(page.getByTestId('smart-paste')).toHaveAttribute('data-state', 'filled', { timeout: 5000 });
  await expect(page.locator('#manual-order-name')).toHaveValue('Tania');
  await expect(page.locator('#manual-order-phone')).toHaveValue('01812345678');
  await expect(page.locator('#manual-order-thana')).toHaveText('Dhanmondi');
  await expect(page.getByTestId('smart-paste-hints')).toHaveText('In the message (not added): COD 1250 tk · Product: Scalpe Plus x2');
  // Nothing is in the order until Naeem adds it.
  await expect(page.locator('.checkout-cart__row')).toHaveCount(0);
});

/* ---------------------------------------------------------------- Part 4 */

let photoSlug: string | null = null;
let photoCount = 1;

async function productWithPhotos(): Promise<string> {
  if (photoSlug) return photoSlug;
  const rows = await select<{ slug: string; image_urls: string[] | null }[]>(
    null,
    'products_view?select=slug,image_urls&is_active=eq.true&limit=300'
  );
  const many = (rows.data ?? []).find((r) => (r.image_urls ?? []).length >= 2);
  const any = (rows.data ?? []).find((r) => (r.image_urls ?? []).length >= 1);
  const pick = many ?? any;
  photoCount = (pick?.image_urls ?? []).length;
  photoSlug = pick?.slug ?? (await productSlug());
  return photoSlug;
}

async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const shot = PNG.sync.read(await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } }));
  return [shot.data[0], shot.data[1], shot.data[2]];
}

async function seamAt(page: Page, label: string): Promise<void> {
  const photo = (await page.locator('.product-detail__image').first().boundingBox())!;
  const sheet = (await page.getByTestId('pdp-sheet').boundingBox())!;
  const bottom = photo.y + photo.height;
  for (const [side, x] of [['left', sheet.x + 3], ['right', sheet.x + sheet.width - 4]] as const) {
    const above = await pixel(page, x, bottom - 2);
    const below = await pixel(page, x, bottom + 2);
    const worst = Math.max(...above.map((v, i) => Math.abs(v - below[i])));
    expect(worst, `${label} ${side}: above ${above} vs below ${below}`).toBeLessThanOrEqual(6);
  }
}

for (const width of [360, 390, 430, 1280]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`Part 4: no colour seam at the sheet's corners — ${width} px ${theme}, photo 1 and 2`, async ({ page }) => {
      await page.setViewportSize({ width, height: width > 600 ? 900 : 860 });
      await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
      await page.goto(`/product/${await productWithPhotos()}`);
      await expect(page.locator('.product-detail__image').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('photo-mirror')).toBeAttached();
      await page.waitForFunction(() => {
        const imgs = [...document.querySelectorAll<HTMLImageElement>('.product-detail__mirror-slide:first-child img')];
        return imgs.length === 2 && imgs.every((i) => i.complete && i.naturalWidth > 0);
      });
      await page.waitForTimeout(900);
      await seamAt(page, `${width} ${theme} photo 1`);

      // The strip follows the carousel exactly (transform only).
      if (photoCount >= 2) {
        await page.locator('.product-detail__carousel').evaluate((el) => el.scrollTo({ left: el.clientWidth, behavior: 'instant' as ScrollBehavior }));
        await expect(page.getByTestId('image-counter')).toHaveText(/^2 \//);
        const clientWidth = await page.locator('.product-detail__carousel').evaluate((el) => el.clientWidth);
        await expect
          .poll(() => page.locator('.product-detail__mirror-track').evaluate((el) => (el as HTMLElement).style.transform))
          .toBe(`translate3d(${-clientWidth}px, 0px, 0px)`);
        await page.waitForFunction(() => {
          const imgs = [...document.querySelectorAll<HTMLImageElement>('.product-detail__mirror-slide:nth-child(2) img')];
          return imgs.length === 2 && imgs.every((i) => i.complete && i.naturalWidth > 0);
        });
        await page.waitForTimeout(600);
        await seamAt(page, `${width} ${theme} photo 2`);
      }
    });
  }
}
