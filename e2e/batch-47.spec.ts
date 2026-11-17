import { mkdirSync, readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, select, useSessionInPage, type TestSession } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';
import { signInAsTestCustomer } from './helpers/auth';

// Batch 47: admin and customer bug fixes.
//
// The live shop is never changed: screens are checked at 390 px and nothing
// is saved — no order is deleted, placed or moved. Database functions that
// would change something are answered in the browser. The database rules
// run in e2e/sql/batch-47.sql together with the whole Batch 47 migration,
// inside ONE transaction that is always rolled back.
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

/* ------------------------------------------- the database rules (4, 6, 12) */

test('database: source change, admin orders in My Orders, move an order (money untouched), settle / undo a payout line (one rolled-back transaction)', async () => {
  test.setTimeout(300_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  const migration = readFileSync('supabase/migration-048-batch47.sql', 'utf8').replace(/\r\n/g, '\n');
  const body = migration.slice(migration.indexOf('\nBEGIN;\n') + 8, migration.lastIndexOf('\nCOMMIT;\n'));
  const tests = readFileSync('e2e/sql/batch-47.sql', 'utf8')
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(`BEGIN;\n${body}\n${tests}`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(40);
  // Nothing of it stayed.
  const left = await select<unknown[]>(admin.accessToken, 'products?select=id&sku=like.E2E-B47-*');
  expect(left.data).toHaveLength(0);
});

/* --------------------------------------- Task 6b: Move order (the screen) */

test('Task 6b: Move order to another customer — only accounts are offered, the confirm says what moves and what does not (move answered in the browser)', async ({ page }) => {
  test.setTimeout(90_000);
  const number = await latestOrderNumber();
  test.skip(!number, 'No order to open.');
  const accountId = '00000000-0000-4000-8000-000000000047';
  await mockRpc(page, 'admin_find_customers_v2', [
    { customer_key: `p:${accountId}`, profile_id: accountId, full_name: 'Ayesha Rahman', phone: '01711000047', alt_phone: null, division: 'Dhaka', district: 'Dhaka', thana: 'Gulshan', address_line: 'Road 1', order_count: 2, total_due: 0 },
    { customer_key: 'ph:1711000048', profile_id: null, full_name: 'No Account', phone: '01711000048', alt_phone: null, division: 'Dhaka', district: 'Dhaka', thana: 'Gulshan', address_line: 'Road 2', order_count: 1, total_due: 0 },
  ]);
  const sent: unknown[] = [];
  await page.route(/\/rest\/v1\/rpc\/admin_move_order_customer/, async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ moved: true, to: 'Ayesha Rahman' }) });
  });
  await adminAt(page, `/admin/orders/${number}`);
  await expect(page.getByTestId('admin-order-page')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('careful-move').click();
  const sheet = page.getByTestId('move-order-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByTestId('move-order-search').fill('Ayesha');
  const results = sheet.getByTestId('move-order-result');
  await expect(results).toHaveCount(1);
  await expect(results).toContainText('Ayesha Rahman');
  await results.click();
  await expect(sheet.getByTestId('move-order-confirm-text')).toContainText('Its money, payments, stock and Steadfast stay exactly as they are');
  await page.screenshot({ path: `${SHOTS}/07-move-order-confirm.png` });
  await sheet.getByTestId('move-order-yes').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ p_profile_id: accountId });
  await expect(sheet).toBeHidden();
});

/* ------------------------------------------ Task 7: back after logging in */

async function googleReturnFor(page: Page, start: () => Promise<void>): Promise<{ redirectTo: string; historyGrew: boolean }> {
  let redirectTo = '';
  // Google is never opened: the sign-in request is caught on its way out.
  await page.route(/\/auth\/v1\/authorize/, async (route) => {
    redirectTo = new URL(route.request().url()).searchParams.get('redirect_to') ?? '';
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Google</title><p>google</p>' });
  });
  await start();
  const before = await page.evaluate(() => window.history.length);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect.poll(() => redirectTo, { timeout: 15_000 }).not.toBe('');
  await page.waitForLoadState();
  const after = await page.evaluate(() => window.history.length);
  return { redirectTo, historyGrew: after > before };
}

test('Task 7: logging in from the account page returns to the page before it (the shop home when opened directly), and the login page leaves the history', async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: WIDTH, height: 844 });
  const origin = new URL(String(test.info().project.use.baseURL)).origin;

  // From a search page, then the account page.
  const fromSearch = await googleReturnFor(page, async () => {
    await page.goto('/search?q=cerave');
    await page.waitForLoadState('domcontentloaded');
    await page.goto('/account');
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${SHOTS}/08-account-login.png` });
  });
  expect(fromSearch.redirectTo).toBe(`${origin}/search?q=cerave`);
  expect(fromSearch.historyGrew, 'the login page was replaced, not stacked').toBe(false);

  // Opened directly in a fresh tab: the shop home.
  const fresh = await context.newPage();
  await fresh.setViewportSize({ width: WIDTH, height: 844 });
  const direct = await googleReturnFor(fresh, async () => {
    await fresh.goto('/account');
    await expect(fresh.getByRole('button', { name: 'Continue with Google' })).toBeVisible({ timeout: 20_000 });
  });
  expect(direct.redirectTo).toBe(`${origin}/`);
  await fresh.close();
});

/* ------------------- Tasks 8, 9, 10: order summary and the "Order placed" page */

const B47_ADDRESS = {
  fullName: 'E2E Test Customer',
  phone: '01712345678',
  division: 'Dhaka',
  district: 'Dhaka',
  thana: 'Gulshan',
  fullAddress: '123 Test Road (e2e)',
};

function placedSnapshot(paymentMethod: 'cod' | 'bkash') {
  return {
    zoneId: 'inside_dhaka',
    address: B47_ADDRESS,
    promo: null,
    lastOrder: {
      orderId: '00000000-0000-4000-8000-000000004747',
      orderNumber: 'NM-4747',
      items: [{ product: { id: 'p', name: 'E2E B47 Cream' }, variantId: null, variantLabel: null, quantity: 2, unitPrice: 850, listPrice: 900 }],
      zone: { id: 'inside_dhaka', label: 'Inside Dhaka', fee: 70 },
      address: B47_ADDRESS,
      promo: null,
      subtotal: 1700,
      discount: 0,
      total: 1770,
      paymentMethod,
      bkashTrxId: paymentMethod === 'bkash' ? 'TRX47' : null,
      placedAt: new Date().toISOString(),
    },
  };
}

test('Tasks 8 + 10: "Order placed" says Pay on delivery for cash on delivery (Total paid only for bKash) and has a neutral "Need help?" to the shop on WhatsApp with the order number', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: WIDTH, height: 844 });
  // A made-up order receipt in this tab only — no order is placed.
  await page.addInitScript((state) => window.sessionStorage.setItem('nph_checkout_state', state), JSON.stringify(placedSnapshot('cod')));
  await page.goto('/checkout/success');
  const total = page.getByTestId('placed-total');
  await expect(total).toBeVisible({ timeout: 20_000 });
  await expect(total).toContainText('Pay on delivery');
  await expect(total).not.toContainText('paid');
  const help = page.getByTestId('placed-need-help');
  await expect(help).toBeVisible();
  const href = (await help.getAttribute('data-href')) ?? '';
  expect(href).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
  expect(decodeURIComponent(href.split('text=')[1] ?? '')).toContain('NM-4747');
  // Neutral, not a second orange button.
  const bg = await help.evaluate((el) => getComputedStyle(el).backgroundColor);
  const primaryBg = await page.getByRole('button', { name: 'View my order' }).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe(primaryBg);
  await page.screenshot({ path: `${SHOTS}/09-order-placed-cod.png`, fullPage: true });

  const paid = await page.context().newPage();
  await paid.setViewportSize({ width: WIDTH, height: 844 });
  await paid.addInitScript((state) => window.sessionStorage.setItem('nph_checkout_state', state), JSON.stringify(placedSnapshot('bkash')));
  await paid.goto('/checkout/success');
  await expect(paid.getByTestId('placed-total')).toContainText('Total paid', { timeout: 20_000 });
  await paid.close();
});

test('Tasks 8 + 9: order summary at 390 px — long names wrap to two lines, every line shows its quantity, cash on delivery total says Pay on delivery (nothing ordered)', async ({ page }) => {
  test.setTimeout(90_000);
  const list = await select<{ id: string; name: string; retail_price: number; offer_price: number | null; stock_quantity: number | null }[]>(
    null,
    'products_view?select=id,name,retail_price,offer_price,stock_quantity&is_active=eq.true&stock_quantity=gte.3&limit=200'
  );
  const products = (list.data ?? []).sort((a, b) => b.name.length - a.name.length);
  test.skip(products.length < 2, 'Not enough products in stock.');
  const [long, short] = [products[0], products[products.length - 1]];
  const price = (p: { retail_price: number; offer_price: number | null }) => (p.offer_price !== null && p.offer_price < p.retail_price ? p.offer_price : p.retail_price);
  await page.setViewportSize({ width: WIDTH, height: 844 });
  await signInAsTestCustomer(page);
  const cart = [
    { productId: long.id, variantId: null, variantLabel: null, quantity: 2, priceAtAdd: price(long) },
    { productId: short.id, variantId: null, variantLabel: null, quantity: 1, priceAtAdd: price(short) },
  ];
  await page.addInitScript(
    ([c, s]) => {
      if (window.sessionStorage.getItem('e2e-b47-seeded')) return;
      window.sessionStorage.setItem('e2e-b47-seeded', '1');
      window.localStorage.setItem('nph_cart', c);
      window.sessionStorage.setItem('nph_checkout_state', s);
    },
    [JSON.stringify(cart), JSON.stringify({ zoneId: 'inside_dhaka', address: B47_ADDRESS, promo: null, lastOrder: null })]
  );
  // Placing is refused in the browser, in case anything clicks it.
  await page.route(/\/rest\/v1\/rpc\/place_order/, (route) => route.abort());
  await page.goto('/checkout/summary');
  await expect(page.getByRole('button', { name: /Place order/i })).toBeVisible({ timeout: 20_000 });

  const names = page.getByTestId('summary-item-name');
  const qtys = page.getByTestId('summary-item-qty');
  await expect(names).toHaveCount(2);
  await expect(qtys.nth(0)).toHaveText('× 2');
  await expect(qtys.nth(1)).toHaveText('× 1');
  for (let i = 0; i < 2; i += 1) {
    await expect(qtys.nth(i)).toBeInViewport();
    const box = await qtys.nth(i).boundingBox();
    expect(box && box.x + box.width <= WIDTH, 'the quantity is on screen').toBe(true);
  }
  // Two lines of height for every name (rows line up), and the long name
  // really uses its second line instead of being cut on the first.
  const heights = await names.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
  const lineHeight = await names.first().evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  expect(heights[0]).toBeGreaterThanOrEqual(Math.floor(lineHeight * 2) - 1);
  expect(heights[1]).toBe(heights[0]);
  const longLines = await names.first().evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
  });
  if (long.name.length > 30) expect(longLines).toBeGreaterThanOrEqual(2);

  await expect(page.getByTestId('summary-total')).toContainText('Pay on delivery');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at phone width').toBeLessThanOrEqual(0);
  await page.locator('.checkout-summary-card').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/10-order-summary-390.png` });
});

/* ------------------------------------ Task 12: settle a payout line (screen) */

function b47Line(id: string, invoice: string, cod: number, charge: number, extra: Record<string, unknown> = {}) {
  return {
    id, payout_id: 'p-b47', consignment_id: `c-${id}`, invoice, order_id: null, cod_collected: cod, delivery_charge: charge,
    cod_fee: 0, other_deduction: 0, net_paid: cod - charge, expected_cod: null, match_status: 'to_check',
    match_reason: 'order_not_found', note: 'Order not found', line_kind: 'order',
    settle_reason: null, settle_note: null, settled_by_username: null, settled_at: null, ...extra,
  };
}

test('Task 12: Settle on an unmatched payout line — pick a reason, it turns green with who / when, the total still adds up, Undo puts it back (answered in the browser)', async ({ page }) => {
  test.setTimeout(120_000);
  let settled = false;
  const payout = () => ({
    id: 'p-b47', steadfast_payment_id: 'SFC-B47', paid_at: new Date(Date.now() - 3600_000).toISOString(),
    total_amount: 2000 - 60 - 50 - 75, parcel_count: 3,
    steadfast_payout_items: [
      b47Line('1', 'NM-5101', 2000, 60, { order_id: 'o-1', match_status: 'matched', match_reason: null, note: null }),
      b47Line('2', 'NM-5102', 0, 50, settled
        ? { line_kind: 'returned', match_status: 'matched', match_reason: null, note: 'Returned parcel (nothing collected): the charge counts as a delivery cost — came back 3 Nov', settle_reason: 'returned', settle_note: 'came back 3 Nov', settled_by_username: 'naeem', settled_at: new Date().toISOString() }
        : {}),
      b47Line('3', 'NM-3315', 0, 75, { line_kind: 'courier_only', match_status: 'matched', match_reason: null, note: 'Not a shop sale: courier only', settle_reason: 'not_shop_sale', settled_by_username: 'Batch 46' }),
    ],
  });
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  await page.route(/\/rest\/v1\/steadfast_payouts\?/, (route) => {
    const one = (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object');
    return route.fulfill(json(one ? payout() : [payout()]));
  });
  const calls: { fn: string; body: unknown }[] = [];
  await page.route(/\/rest\/v1\/rpc\/admin_(un)?settle_payout_line/, async (route) => {
    const fn = route.request().url().includes('unsettle') ? 'unsettle' : 'settle';
    calls.push({ fn, body: route.request().postDataJSON() });
    settled = fn === 'settle';
    await route.fulfill(json(fn === 'settle' ? { line_kind: 'returned' } : null));
  });

  await adminAt(page, '/admin/payouts/p-b47');
  const table = page.getByTestId('payout-table');
  await expect(table).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('payout-total')).toHaveText('৳1,815');
  await expect(page.getByTestId('payout-pill')).toHaveText('1 to check');
  // Settle only on the line that does not match; the Batch 46 line shows as settled.
  await expect(table.getByTestId('payout-settle')).toHaveCount(1);
  await expect(table.getByTestId('payout-line').nth(2)).toContainText('Settled: Not a shop sale');
  await expect(table.getByTestId('payout-line').nth(2)).toContainText('by Batch 46');

  await table.getByTestId('payout-settle').click();
  const sheet = page.getByTestId('settle-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('settle-reason')).toHaveCount(6);
  // "Other" needs a note.
  await sheet.getByTestId('settle-reason').filter({ hasText: 'Other' }).click();
  await expect(sheet.getByTestId('settle-confirm')).toBeDisabled();
  await sheet.getByTestId('settle-reason').filter({ hasText: 'Returned parcel' }).click();
  await sheet.getByTestId('settle-note').fill('came back 3 Nov');
  await page.screenshot({ path: `${SHOTS}/11-settle-dialog.png` });
  await sheet.getByTestId('settle-confirm').click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toEqual({ fn: 'settle', body: { p_item_id: '2', p_reason: 'returned', p_note: 'came back 3 Nov' } });

  await expect(sheet).toBeHidden();
  const line = table.getByTestId('payout-line').nth(1);
  await expect(line).toHaveClass(/is-settled/);
  await expect(line).toContainText('Settled: Returned parcel');
  await expect(line).toContainText('by naeem');
  await expect(page.getByTestId('payout-pill')).toHaveText('Matched');
  await expect(page.getByTestId('payout-total')).toHaveText('৳1,815');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at phone width').toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/12-payout-settled.png`, fullPage: true });

  await line.getByTestId('payout-undo').click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]).toEqual({ fn: 'unsettle', body: { p_item_id: '2' } });
  await expect(page.getByTestId('payout-pill')).toHaveText('1 to check');
});
