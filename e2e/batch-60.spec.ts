import { mkdirSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, select, useSessionInPage, type TestSession } from './helpers/api';
import { signInAsTestCustomer } from './helpers/auth';

// Batch 60: My Wallet. Every wallet answer is mocked in the browser, so
// nothing is saved to Supabase and the screens show known numbers: the
// Account card, (the story moved to e2e/batch-62.spec.ts in Batch 62),
// Add money (errors, Submit, "Almost there!" with the WhatsApp message),
// checkout (part from the wallet, fully paid) and the admin WALLET card.
// The money rules themselves are tested in e2e/sql/batch-60.sql (rolled
// back). No real Storage file is downloaded (./fixtures).

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-60-screens';
const SHOP_WHATSAPP = '01711000060';
const SHOP_BKASH = '01811000060';

let admin: TestSession;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
});

// Answers still in flight when a test ends are dropped quietly.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) };
}

/** Answers one database function in the browser. */
async function mockRpc(page: Page, fn: string, reply: unknown | ((args: Record<string, unknown>) => { status?: number; body: unknown })): Promise<Record<string, unknown>[]> {
  const calls: Record<string, unknown>[] = [];
  await page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), async (route: Route) => {
    const args = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push(args);
    if (typeof reply === 'function') {
      const answer = (reply as (a: Record<string, unknown>) => { status?: number; body: unknown })(args);
      await route.fulfill(json(answer.body, answer.status ?? 200));
    } else {
      await route.fulfill(json(reply));
    }
  });
  return calls;
}

/** The shop's settings with a known bKash and WhatsApp number. */
async function withShopNumbers(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/app_settings\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const rows = ((await response.json()) as { key: string; value: string }[]).filter(
      (r) => !['shop_whatsapp_number', 'shop_bkash_number', 'advance_discount_enabled', 'advance_discount_type', 'advance_discount_value'].includes(r.key)
    );
    rows.push(
      { key: 'shop_whatsapp_number', value: SHOP_WHATSAPP },
      { key: 'shop_bkash_number', value: SHOP_BKASH },
      { key: 'advance_discount_enabled', value: 'true' },
      { key: 'advance_discount_type', value: 'fixed' },
      { key: 'advance_discount_value', value: '50' }
    );
    await route.fulfill({ response, json: rows });
  });
}

function myWallet(over: Partial<Record<string, unknown>> = {}) {
  return { available: true, balance: 0, due: 0, waiting: [], results: [], history: [], ...over };
}

async function customerAt(page: Page, path: string): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsTestCustomer(page);
  await withShopNumbers(page);
  await page.goto(path);
}

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at phone width').toBeLessThanOrEqual(0);
}

/** Orange used anywhere other than the one primary button? */
async function orangeOutsidePrimary(page: Page, root: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const isOrange = (c: string) => /rgb\(255, 122, 69\)/.test(c);
    for (const el of document.querySelectorAll<HTMLElement>(`${sel} *`)) {
      if (el.closest('.mw-btn--primary')) continue;
      const s = getComputedStyle(el);
      if (isOrange(s.color) || isOrange(s.backgroundColor)) out.push(el.className || el.tagName);
    }
    return out;
  }, root);
}

/* ------------------------------------------------------------ Account card */

test('Account page: the My Wallet card right under the header, with a request waiting', async ({ page }) => {
  test.setTimeout(90_000);
  await mockRpc(page, 'store_wallet_my', myWallet({
    balance: 3000,
    waiting: [{ id: 'r1', amount: 2000, method: 'bkash', trx_id: '9AK2XYZ1AB', created_at: '2026-11-23T10:00:00Z' }],
  }));
  await customerAt(page, '/account');
  const card = page.getByTestId('account-wallet');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('MY WALLET');
  await expect(card).toContainText('৳ 3,000');
  await expect(card).toContainText('Your skincare fund');
  await expect(card).toContainText('৳ 2,000 waiting for confirmation');
  // Right after the header, before Delivery details.
  const order = await page.evaluate(() => {
    const header = document.querySelector('.account-header');
    const wallet = document.querySelector('[data-testid="account-wallet"]');
    const delivery = document.querySelector('.account-card');
    return header?.nextElementSibling === wallet && wallet?.nextElementSibling === delivery;
  });
  expect(order, 'header, then the wallet card, then Delivery details').toBe(true);
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/account-card-waiting-390.png` });
  await card.click();
  await expect(page).toHaveURL(/\/wallet$/);
});

test('Account page: a confirmed request shows "৳3,000 added to your wallet" once', async ({ page }) => {
  test.setTimeout(90_000);
  const seen = await mockRpc(page, 'store_wallet_seen', true);
  await mockRpc(page, 'store_wallet_my', myWallet({
    balance: 3000,
    results: [{ id: 'r9', amount: 3000, method: 'bkash', status: 'confirmed', decided_at: '2026-11-23T11:00:00Z' }],
  }));
  await customerAt(page, '/account');
  await expect(page.getByText('৳3,000 added to your wallet')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  expect(seen[0]).toEqual({ p_request_id: 'r9' });
});

/* --------------------------------------------------------------- the story */

// Batch 62 replaced this story with the jar story (invite only / your
// wallet is open): its tests, fading in and reduced motion included, are in
// e2e/batch-62.spec.ts.

/* -------------------------------------------------------------- Add money */

test('Add money: the errors, Submit, then "Almost there!" with the WhatsApp message', async ({ page }) => {
  test.setTimeout(120_000);
  await mockRpc(page, 'store_wallet_my', myWallet());
  const requests = await mockRpc(page, 'store_wallet_request', (args) =>
    String(args.p_trx_id) === 'USEDBEFORE1'
      ? { status: 400, body: { code: 'P0001', message: 'This transaction ID has already been used.' } }
      : { body: { id: 'r2', amount: args.p_amount, method: args.p_method, trx_id: String(args.p_trx_id).toUpperCase(), status: 'waiting', created_at: '2026-11-23T12:00:00Z' } }
  );
  await customerAt(page, '/wallet');
  await page.getByTestId('wallet-add').click();
  const sheet = page.getByTestId('wallet-add-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('wallet-method-bkash')).toContainText(SHOP_BKASH);
  await expect(page.getByTestId('wallet-method-bkash')).toHaveAttribute('aria-checked', 'true');
  await expect(sheet).toContainText('Send money to this number (Personal), then enter the transaction ID below. Minimum ৳500.');

  // Everything missing.
  await page.getByTestId('wallet-submit').click();
  await expect(sheet).toContainText('Minimum ৳500');
  await expect(sheet).toContainText('Transaction ID is required');
  await expect(sheet).toContainText('Enter a valid number');
  expect(requests).toHaveLength(0);

  // ৳499 is too little; the chips fill the amount.
  await page.getByTestId('wallet-amount').fill('499');
  await page.getByTestId('wallet-trx').fill('usedbefore1');
  await expect(page.getByTestId('wallet-trx')).toHaveValue('USEDBEFORE1');
  await page.getByTestId('wallet-sender').fill('01712345678');
  await page.getByTestId('wallet-submit').click();
  await expect(sheet).toContainText('Minimum ৳500');
  await sheet.getByRole('button', { name: '৳2,000', exact: true }).click();
  await expect(page.getByTestId('wallet-amount')).toHaveValue('2000');
  await page.getByTestId('wallet-amount').fill('3000');
  if (await page.getByTestId('wallet-method-nagad').count()) {
    await page.getByTestId('wallet-method-nagad').click();
    await expect(sheet).toContainText('Your Nagad number');
    await page.getByTestId('wallet-method-bkash').click();
  }
  await page.screenshot({ path: `${SHOTS}/add-money-390.png` });

  // A transaction ID used before is refused by the database.
  await page.getByTestId('wallet-submit').click();
  await expect(sheet).toContainText('This transaction ID has already been used.');

  await page.getByTestId('wallet-trx').fill('9AK2XYZ1AB');
  await page.getByTestId('wallet-submit').click();
  const done = page.getByTestId('wallet-sent');
  await expect(done).toBeVisible();
  await expect(done).toContainText('Almost there!');
  await expect(done).toContainText('৳ 3,000');
  await expect(done).toContainText('bKash');
  await expect(done).toContainText('9AK2XYZ1AB');
  expect(requests.at(-1)).toEqual({ p_amount: 3000, p_method: 'bkash', p_trx_id: '9AK2XYZ1AB', p_sender: '01712345678' });

  const wa = page.getByTestId('wallet-whatsapp');
  await expect(wa).toHaveText('Let us know on WhatsApp');
  const href = (await wa.getAttribute('data-href')) ?? '';
  expect(href.startsWith('https://wa.me/8801711000060?text=')).toBe(true);
  const text = decodeURIComponent(href.split('?text=')[1]);
  expect(text.split('\n')[0]).toBe('হাই, আমি আমার Wallet-এ ৳3,000 পাঠিয়েছি।');
  expect(text.split('\n')[1]).toBe('bKash, Transaction ID: 9AK2XYZ1AB');
  expect(text.split('\n')[2]).toMatch(/^নাম: /);
  expect(text.split('\n')[3]).toBe('প্লিজ কনফার্ম করবেন। ধন্যবাদ!');
  await page.waitForTimeout(900);
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/almost-there-390.png` });
});

test('Wallet page with money: balance, waiting line, Due, history newest first, a rejected request until dismissed', async ({ page }) => {
  test.setTimeout(90_000);
  const seen = await mockRpc(page, 'store_wallet_seen', true);
  await mockRpc(page, 'store_wallet_my', myWallet({
    balance: 1930,
    due: 70,
    waiting: [{ id: 'r3', amount: 2000, method: 'nagad', trx_id: 'N8XYZ', created_at: '2026-11-23T10:00:00Z' }],
    results: [{ id: 'r4', amount: 3000, method: 'bkash', status: 'rejected', decided_at: '2026-11-23T11:00:00Z' }],
    history: [
      { id: 'e3', date: '2026-11-23', at: '2026-11-23T12:00:00Z', kind: 'order', amount: -1070, order_id: '00000000-0000-4000-8000-000000006001', order_number: 'NM-5120', by_shop: false },
      { id: 'e2', date: '2026-11-22', at: '2026-11-22T12:00:00Z', kind: 'added', amount: 2000, order_id: null, order_number: null, by_shop: true },
      { id: 'e1', date: '2026-11-21', at: '2026-11-21T12:00:00Z', kind: 'added', amount: 1000, order_id: null, order_number: null, by_shop: false },
    ],
  }));
  await customerAt(page, '/wallet');
  const pageEl = page.getByTestId('wallet-page');
  await expect(pageEl).toHaveAttribute('data-view', 'balance', { timeout: 20_000 });
  await expect(page.getByTestId('wallet-balance')).toContainText('৳ 1,930');
  await expect(page.getByTestId('wallet-due')).toContainText('৳ 70');
  await expect(page.getByTestId('wallet-waiting')).toContainText('৳ 2,000 waiting for confirmation');
  await expect(page.getByTestId('wallet-waiting')).toContainText('Nagad · N8XYZ');
  await expect(page.getByTestId('wallet-rejected')).toContainText("Your ৳3,000 wasn't added. The payment didn't match our records. Message us on WhatsApp and we'll sort it out.");
  const rows = page.getByTestId('wallet-history-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Used on order NM-5120');
  await expect(rows.nth(0)).toContainText('−৳1,070');
  await expect(rows.nth(1)).toContainText("Added by NAEEM'S");
  await expect(rows.nth(2)).toContainText('+৳1,000');
  await expect(rows.nth(0).getByRole('link', { name: 'NM-5120' })).toHaveAttribute('href', '/orders/00000000-0000-4000-8000-000000006001');
  await expect(pageEl).toContainText("Use your balance on any order, anytime. It never expires and can't be refunded as cash.");
  await expect.poll(async () => Number(await page.locator('.mw-head--small').evaluate((el) => getComputedStyle(el).opacity)), { timeout: 5000 }).toBeGreaterThan(0.8);
  expect(await orangeOutsidePrimary(page, '[data-testid="wallet-page"]')).toEqual([]);
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/wallet-balance-390.png`, fullPage: true });
  await page.getByTestId('wallet-rejected-dismiss').click();
  await expect(page.getByTestId('wallet-rejected')).toHaveCount(0);
  expect(seen.at(-1)).toEqual({ p_request_id: 'r4' });
});

test('Wallet page: signed-out visitors are sent to sign in', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/wallet');
  await expect(page).toHaveURL(/\/account$/, { timeout: 20_000 });
});

/* ---------------------------------------------------------------- checkout */

interface ShopProduct {
  id: string;
  price: number;
}

async function shopProduct(): Promise<ShopProduct | null> {
  const list = await select<{ id: string; retail_price: number; offer_price: number | null }[]>(
    null,
    'products_view?select=id,retail_price,offer_price&is_active=eq.true&stock_quantity=gte.3&limit=50'
  );
  const first = (list.data ?? []).find((p) => p.retail_price >= 300);
  if (!first) return null;
  return { id: first.id, price: Number(first.offer_price !== null && first.offer_price < first.retail_price ? first.offer_price : first.retail_price) };
}

async function openPaymentStep(page: Page, p: ShopProduct, balance: number): Promise<Record<string, unknown>[]> {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsTestCustomer(page);
  await withShopNumbers(page);
  await mockRpc(page, 'store_wallet_my', myWallet({ balance }));
  const cart = [{ productId: p.id, variantId: null, variantLabel: null, quantity: 1, priceAtAdd: p.price }];
  const address = { fullName: 'Ayesha Test', phone: '01712345678', division: 'Dhaka', district: 'Dhaka', thana: 'Gulshan', fullAddress: '1 Test Road (e2e)' };
  await page.addInitScript(
    ([c, s]) => {
      if (window.sessionStorage.getItem('e2e-b60-seeded')) return;
      window.sessionStorage.setItem('e2e-b60-seeded', '1');
      window.localStorage.setItem('nph_cart', c);
      window.sessionStorage.setItem('nph_checkout_state', s);
    },
    [JSON.stringify(cart), JSON.stringify({ zoneId: 'inside_dhaka', address, promo: null, lastOrder: null })]
  );
  const calls: Record<string, unknown>[] = [];
  await page.route(/\/rest\/v1\/rpc\/place_order(_wallet)?(\?|$)/, async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push({ ...body, fn: route.request().url().includes('place_order_wallet') ? 'place_order_wallet' : 'place_order' });
    const total = Number(await page.getByTestId('summary-total').locator('[data-total]').getAttribute('data-total')) + Number(body.p_store_wallet ?? 0);
    await route.fulfill(
      json([{ order_id: '00000000-0000-4000-8000-000000006060', order_number: 'NM-6060', total, discount: 0, advance_discount: 0, store_wallet: body.p_store_wallet ?? 0 }])
    );
  });
  await page.goto('/checkout/summary');
  await expect(page.getByRole('button', { name: /Place order/i })).toBeVisible({ timeout: 20_000 });
  return calls;
}

test('Checkout: "Use wallet balance" off by default; on: From wallet and On delivery, then Pay now with bKash', async ({ page }) => {
  test.setTimeout(120_000);
  const p = await shopProduct();
  test.skip(!p, 'No product in stock.');
  if (!p) return;
  const calls = await openPaymentStep(page, p, 200);
  const card = page.getByTestId('checkout-use-wallet');
  await expect(card).toBeVisible();
  await expect(card).toContainText('You have ৳ 200');
  const toggle = card.getByRole('switch', { name: 'Use wallet balance' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('summary-store-wallet')).toHaveCount(0);
  const before = Number(await page.getByTestId('summary-total').locator('[data-total]').getAttribute('data-total'));
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const split = page.getByTestId('checkout-wallet-split');
  await expect(split).toContainText('From wallet');
  await expect(split).toContainText('৳ 200');
  await expect(split).toContainText('On delivery');
  await expect(page.getByTestId('summary-store-wallet')).toContainText('Paid from wallet');
  await expect(page.getByTestId('summary-store-wallet')).toContainText('৳ 200');
  await expect.poll(async () => Number(await page.getByTestId('summary-total').locator('[data-total]').getAttribute('data-total'))).toBe(before - 200);
  // The payment methods stay (something is left to pay).
  await expect(page.getByTestId('pay-option-cod')).toBeVisible();
  await page.getByTestId('pay-option-bkash').click();
  await expect(split).toContainText('Pay now');
  // ৳1,000 rule: the badge only when ৳1,000 or more is paid in advance.
  const left = Number(await page.getByTestId('summary-total').locator('[data-total]').getAttribute('data-total'));
  if (before - 200 < 1000) await expect(page.getByTestId('advance-badge')).toHaveCount(0);
  expect(left).toBeGreaterThan(0);
  await page.getByTestId('pay-option-cod').click();
  await expect(page.getByTestId('summary-total')).toContainText((before - 200).toLocaleString('en-US'));
  await noSideScroll(page);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/checkout-split-390.png` });
  await page.getByRole('button', { name: /Place order/i }).click();
  await expect(page).toHaveURL(/\/checkout\/success$/, { timeout: 20_000 });
  expect(calls[0].fn).toBe('place_order_wallet');
  expect(calls[0].p_store_wallet).toBe(200);
  expect(calls[0].p_payment_method).toBe('cod');
  await expect(page.getByTestId('placed-store-wallet')).toContainText('Paid from wallet');
});

test('Checkout: the wallet covers everything: methods hide, "Fully paid from your wallet", placed with nothing left', async ({ page }) => {
  test.setTimeout(120_000);
  const p = await shopProduct();
  test.skip(!p, 'No product in stock.');
  if (!p) return;
  const calls = await openPaymentStep(page, p, 50000);
  const card = page.getByTestId('checkout-use-wallet');
  await expect(card).toBeVisible();
  const before = Number(await page.getByTestId('summary-total').locator('[data-total]').getAttribute('data-total'));
  await card.getByRole('switch', { name: 'Use wallet balance' }).click();
  await expect(page.getByTestId('checkout-wallet-full')).toHaveText('Fully paid from your wallet');
  await expect(page.locator('.cf-pay')).toHaveCount(0);
  await expect(page.getByTestId('summary-total')).toContainText('Left to pay');
  await expect.poll(async () => Number(await page.getByTestId('summary-total').locator('[data-total]').getAttribute('data-total'))).toBe(0);
  await expect(page.getByTestId('summary-store-wallet')).toContainText(String(before.toLocaleString('en-US')));
  await expect(page.getByTestId('summary-total')).toContainText('৳ 0');
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/checkout-fully-paid-390.png` });
  await page.getByRole('button', { name: /Place order/i }).click();
  await expect(page).toHaveURL(/\/checkout\/success$/, { timeout: 20_000 });
  expect(calls[0].fn).toBe('place_order_wallet');
  expect(calls[0].p_store_wallet).toBe(before);
  expect(calls[0].p_payment_method).toBe('cod');
  expect(calls[0].p_bkash_trx_id).toBeNull();
  await expect(page.getByTestId('placed-payment')).toHaveText('Wallet');
  await expect(page.getByTestId('placed-total')).toContainText('Left to pay');
});

test('Checkout with an empty wallet: no wallet card, place_order as before', async ({ page }) => {
  test.setTimeout(90_000);
  const p = await shopProduct();
  test.skip(!p, 'No product in stock.');
  if (!p) return;
  await openPaymentStep(page, p, 0);
  await expect(page.getByTestId('checkout-use-wallet')).toHaveCount(0);
  await expect(page.getByTestId('pay-option-cod')).toBeVisible();
});

/* ------------------------------------------------------------------- admin */

const FAKE_KEY = 'ph:01799960061';

async function adminCustomer(page: Page): Promise<{ confirms: Record<string, unknown>[]; adds: Record<string, unknown>[] }> {
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  await mockRpc(page, 'admin_customers_v3', [
    {
      customer_key: FAKE_KEY, profile_id: null, full_name: 'E2E B60 Karima', email: '', phone: '01799960061', order_count: 1,
      total_spent: 1070, total_due: 0, last_order_at: '2026-11-20T08:00:00Z', joined_at: null, all_orders: 1, hidden: false,
      note: null, alt_phone: null, added_by_hand: false, added_at: null,
    },
  ]);
  await mockRpc(page, 'admin_customer_orders_v2', []);
  await mockRpc(page, 'money_customer_dues', []);
  await mockRpc(page, 'money_customer_history', { phone_key: '01799960061', previous: [], previous_left: 0, corrections: [], payments: [], reminders: [] });
  await mockRpc(page, 'store_wallet_customer', {
    balance: 3000,
    waiting: [{ id: 'r5', amount: 2000, method: 'bkash', trx_id: '9AK2XYZ1AB', sender: '01712345678', created_at: '2026-11-23T10:00:00Z' }],
    requests: [],
    history: [
      { id: 'h2', date: '2026-11-23', at: '2026-11-23T09:00:00Z', kind: 'order', amount: -1070, order_id: null, order_number: 'NM-5120', account: null, note: null, by: 'naeem', by_shop: false },
      { id: 'h1', date: '2026-11-22', at: '2026-11-22T09:00:00Z', kind: 'added', amount: 4070, order_id: null, order_number: null, account: 'bKash', note: null, by: 'naeem', by_shop: true },
    ],
  });
  const confirms = await mockRpc(page, 'store_wallet_confirm', { entry_id: 'e9', balance: 5000 });
  const adds = await mockRpc(page, 'store_wallet_add', { entry_id: 'e10', balance: 8000 });
  await page.goto(`/admin/customers/${encodeURIComponent(FAKE_KEY)}`);
  return { confirms, adds };
}

test('Admin customer page: the WALLET card above TO RECEIVE: balance, waiting request with Confirm, history', async ({ page }) => {
  test.setTimeout(90_000);
  const { confirms } = await adminCustomer(page);
  const card = page.getByTestId('customer-wallet-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('customer-wallet-balance')).toHaveText('৳3,000');
  await expect(card).toContainText('৳2,000 waiting · bKash · TrxID 9AK2XYZ1AB');
  await expect(card).toContainText('Used on order NM-5120');
  await expect(card).toContainText("Added by NAEEM'S");
  // Above TO RECEIVE.
  const above = await page.evaluate(() => {
    const w = document.querySelector('[data-testid="customer-wallet-card"]');
    const d = document.querySelector('[data-testid="customer-due-card"]');
    return Boolean(w && d && w.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(above, 'WALLET comes before TO RECEIVE').toBe(true);
  // No separate Credit line any more.
  await expect(page.getByTestId('customer-credit')).toHaveCount(0);
  await noSideScroll(page);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: `${SHOTS}/admin-wallet-card-390.png` });
  await page.getByTestId('customer-wallet-confirm').click();
  const sheet = page.getByTestId('confirm-sheet');
  await expect(sheet).toContainText('TrxID 9AK2XYZ1AB');
  // Default account: bKash for a bKash request.
  await expect(sheet.getByLabel('Received in account').locator('option:checked')).toHaveText('bKash');
  await sheet.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => confirms.length).toBe(1);
  expect(confirms[0].p_request_id).toBe('r5');
});

test('Admin customer page: "Add to wallet" sheet: amount, account (not Steadfast), date, note, "Add ৳5,000"', async ({ page }) => {
  test.setTimeout(90_000);
  const { adds } = await adminCustomer(page);
  await expect(page.getByTestId('customer-wallet-card')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('customer-wallet-add').click();
  const sheet = page.getByTestId('confirm-sheet');
  await page.getByTestId('customer-wallet-add-amount').fill('5000');
  await expect(sheet.getByRole('button', { name: 'Add ৳5,000' })).toBeVisible();
  const options = await sheet.getByLabel('Received in', { exact: true }).locator('option').allTextContents();
  expect(options).not.toContain('With Steadfast');
  await sheet.getByLabel('Note').fill('Sent on WhatsApp');
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/admin-add-sheet-390.png` });
  await sheet.getByRole('button', { name: 'Add ৳5,000' }).click();
  await expect.poll(() => adds.length).toBe(1);
  expect(adds[0]).toMatchObject({ p_customer_key: FAKE_KEY, p_amount: 5000, p_note: 'Sent on WhatsApp' });
});
