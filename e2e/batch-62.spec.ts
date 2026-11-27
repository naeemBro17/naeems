import { mkdirSync, readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, rpc, select, useSessionInPage, type TestSession } from './helpers/api';
import { signInAsTestCustomer } from './helpers/auth';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 62. Every wallet, combo and stock answer the screens need is
// mocked in the browser, so nothing is saved to Supabase; the Edit product
// and product pages read real products (read only, nothing is saved). The
// database rules are tested in e2e/sql/batch-62.sql (one transaction,
// always rolled back). No real Storage file is downloaded (./fixtures).

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-62-screens';
const SHOP_WHATSAPP = '01711000062';
let admin: TestSession;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) };
}

async function mockRpc(page: Page, fn: string, reply: unknown): Promise<Record<string, unknown>[]> {
  const calls: Record<string, unknown>[] = [];
  await page.route(new RegExp(`/rest/v1/rpc/${fn}(\\?|$)`), async (route: Route) => {
    calls.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
    await route.fulfill(json(reply));
  });
  return calls;
}

/** The shop's settings with a known WhatsApp number. */
async function withShopWhatsApp(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/app_settings\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const rows = ((await response.json()) as { key: string; value: string }[]).filter((r) => r.key !== 'shop_whatsapp_number');
    rows.push({ key: 'shop_whatsapp_number', value: SHOP_WHATSAPP });
    await route.fulfill({ response, json: rows });
  });
}

function myWallet(over: Partial<Record<string, unknown>> = {}) {
  return { available: true, open: true, balance: 0, due: 0, waiting: [], results: [], history: [], ...over };
}

async function customerAt(page: Page, path: string): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsTestCustomer(page);
  await withShopWhatsApp(page);
  await page.goto(path);
}

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at phone width').toBeLessThanOrEqual(0);
}

/** The words of an element's first paragraph, line by line, as drawn. */
async function lineBreaks(page: Page, selector: string): Promise<string[]> {
  // Both pages draw Bangla with Noto Sans Bengali once it has loaded.
  await page.evaluate(async () => {
    await document.fonts.load('400 13.5px "Noto Sans Bengali"', 'কখগ');
    await document.fonts.load('400 13.5px "Plus Jakarta Sans"', 'abc');
    await document.fonts.ready;
  });
  await page.waitForTimeout(300);
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const para = root ? [...root.querySelectorAll('p')].find((p) => (p.textContent ?? '').trim().split(/\s+/).length > 12) : null;
    if (!para) return [];
    const lines: { top: number; words: string[] }[] = [];
    const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      const re = /\S+/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const top = Math.round(range.getBoundingClientRect().top);
        const line = lines.find((l) => Math.abs(l.top - top) < 4);
        if (line) line.words.push(m[0]);
        else lines.push({ top, words: [m[0]] });
      }
    }
    return lines.sort((a, b) => a.top - b.top).map((l) => l.words.join(' '));
  }, selector);
}

/** A real active product with 2+ sizes and a long description (read only). */
async function productWithSizes(): Promise<{ id: string; slug: string; name: string }> {
  const rows = await select<{ id: string; slug: string; name: string; description: string | null }[]>(
    admin.accessToken,
    'products_view?select=id,slug,name,description&is_active=eq.true&description=not.is.null&order=name.asc&limit=200'
  );
  const variants = await select<{ product_id: string }[]>(admin.accessToken, 'product_variants_view?select=product_id');
  const count = new Map<string, number>();
  for (const v of variants.data ?? []) count.set(v.product_id, (count.get(v.product_id) ?? 0) + 1);
  const found = (rows.data ?? [])
    .filter((p) => (count.get(p.id) ?? 0) >= 2 && (p.description ?? '').replace(/<[^>]+>/g, '').split(/\s+/).length > 40)
    .sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0))[0];
  expect(found, 'an active product with 2 or more sizes and a description').toBeTruthy();
  return found;
}

/* ------------------------------------------------------------- database */

test('database: wallet open / closed, hidden size, tab word, Keep selling reopen, payout lines, balance check ৳0.00 (one rolled-back transaction)', async () => {
  test.setTimeout(240_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  // The migration runs first in the same transaction (safe to run more
  // than once), so this works before and after Naeem has run it.
  const migration = readFileSync('supabase/migration-061-batch62.sql', 'utf8').replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
  const script = readFileSync('e2e/sql/batch-62.sql', 'utf8')
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(`BEGIN;\n${migration}\n${script}`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(45);
});

/* --------------------------------------------------------------- wallet */

for (const scheme of ['light', 'dark'] as const) {
  test(`Wallet A, closed (${scheme}): the jar story, INVITE ONLY, three promises, Ask us on WhatsApp`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: scheme });
    await mockRpc(page, 'store_wallet_my', myWallet({ open: false }));
    await customerAt(page, '/wallet');
    const story = page.getByTestId('wallet-page');
    await expect(story).toHaveAttribute('data-view', 'closed', { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Save for the glow you love' })).toBeVisible();
    await expect(page.getByTestId('wallet-badge')).toHaveText('INVITE ONLY');
    const promises = page.getByTestId('wallet-promise');
    await expect(promises).toHaveCount(3);
    await expect(promises.nth(0)).toContainText('Your wallet pays first');
    await expect(promises.nth(0)).toContainText('Put money aside at your own pace. When you order, your balance is used first and the rest is paid on delivery.');
    await expect(promises.nth(1)).toContainText('It never expires');
    await expect(promises.nth(1)).toContainText('Your balance waits for you, always. Use it on any order, anytime.');
    await expect(promises.nth(2)).toContainText('Opened by our team');
    await expect(promises.nth(2)).toContainText('For your safety, we turn on each wallet ourselves. Just ask us.');
    await expect(story).toContainText("Wallet balance is for shopping with us and can't be refunded as cash.");
    await expect(page.getByTestId('wallet-add')).toHaveCount(0);
    const ask = page.getByTestId('wallet-ask');
    await expect(ask).toHaveText('Ask us to open my wallet');
    // The WhatsApp message, to the shop's number.
    // (The shop's settings may first come from the saved copy; the fresh
    // ones, with this test's number, follow.)
    await expect(ask).toHaveAttribute('data-href', /^https:\/\/wa\.me\/8801711000062\?text=/, { timeout: 15_000 });
    const href = (await ask.getAttribute('data-href')) ?? '';
    const text = decodeURIComponent(href.split('?text=')[1] ?? '');
    expect(text.split('\n')[0]).toBe('হাই, আমি আমার Wallet চালু করতে চাই।');
    expect(text.split('\n')[1]).toMatch(/^নাম: /);
    // The headline font is Anton (the Wallet page's own font).
    const family = await page.locator('.mwj-title').evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toContain('Anton');
    // Only transform and opacity move.
    const names = await page.evaluate(() =>
      [...document.querySelectorAll('.mw-story *')].map((el) => getComputedStyle(el).animationName).filter((n) => n !== 'none')
    );
    expect(new Set(names.flatMap((n) => n.split(', ')))).toEqual(new Set(['mwj-rise', 'mwj-sway', 'mwj-fill', 'mwj-drop', 'mwj-appear', 'mwj-bob']));
    // After the animation: everything shows.
    await expect.poll(async () => Number(await page.locator('.mwj-cta').evaluate((el) => getComputedStyle(el).opacity)), { timeout: 10_000 }).toBe(1);
    await page.waitForTimeout(600);
    await noSideScroll(page);
    await page.screenshot({ path: `${SHOTS}/wallet-a-closed-${scheme}-390.png`, fullPage: true });
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`Wallet B, open and empty (${scheme}): YOUR WALLET IS OPEN, two promises, Add money`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: scheme });
    await mockRpc(page, 'store_wallet_my', myWallet());
    await customerAt(page, '/wallet');
    const story = page.getByTestId('wallet-page');
    await expect(story).toHaveAttribute('data-view', 'open', { timeout: 20_000 });
    await expect(page.getByTestId('wallet-badge')).toHaveText('YOUR WALLET IS OPEN');
    await expect(page.getByTestId('wallet-promise')).toHaveCount(2);
    await expect(story).not.toContainText('Opened by our team');
    await expect(page.getByTestId('wallet-ask')).toHaveCount(0);
    await expect.poll(async () => Number(await page.locator('.mwj-cta').evaluate((el) => getComputedStyle(el).opacity)), { timeout: 10_000 }).toBe(1);
    await page.waitForTimeout(600);
    await noSideScroll(page);
    await page.screenshot({ path: `${SHOTS}/wallet-b-open-${scheme}-390.png`, fullPage: true });
    await page.getByTestId('wallet-add').click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
}

test('Wallet C, a balance: Batch 60 balance view with "Save for the glow you love."; rejected request in a neutral box with a red dot', async ({ page }) => {
  test.setTimeout(90_000);
  await mockRpc(page, 'store_wallet_seen', true);
  await mockRpc(page, 'store_wallet_my', myWallet({
    balance: 2500,
    results: [{ id: 'rj', amount: 3000, method: 'bkash', status: 'rejected', decided_at: '2026-11-24T08:00:00Z' }],
    history: [{ id: 'h1', date: '2026-11-20', at: '2026-11-20T09:00:00Z', kind: 'added', amount: 2500, order_id: null, order_number: null, by_shop: true }],
  }));
  await customerAt(page, '/wallet');
  await expect(page.getByTestId('wallet-page')).toHaveAttribute('data-view', 'balance', { timeout: 20_000 });
  await expect(page.getByTestId('wallet-balance')).toContainText('৳ 2,500');
  await expect(page.locator('.mw-head--small')).toHaveText('Save for the glow you love.');
  const box = page.getByTestId('wallet-rejected');
  await expect(box).toContainText("Your ৳3,000 wasn't added. The payment didn't match our records. Message us on WhatsApp and we'll sort it out.");
  await expect(box.getByRole('button', { name: 'WhatsApp' })).toBeVisible();
  await expect(box.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  const look = await box.evaluate((el) => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--color-bg-secondary)';
    probe.style.color = 'var(--color-text-primary)';
    document.body.appendChild(probe);
    const want = getComputedStyle(probe);
    const out = {
      bg: getComputedStyle(el).backgroundColor === want.backgroundColor,
      fg: getComputedStyle(el).color === want.color,
      dot: getComputedStyle(el, '::before').backgroundColor,
    };
    probe.remove();
    return out;
  });
  expect(look).toEqual({ bg: true, fg: true, dot: 'rgb(229, 55, 44)' });
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/wallet-c-balance-390.png`, fullPage: true });
  await box.scrollIntoViewIfNeeded();
  await box.screenshot({ path: `${SHOTS}/wallet-rejected-box-390.png` });
});

test('Wallet with reduced motion: everything shows at once, no falling coins', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockRpc(page, 'store_wallet_my', myWallet({ open: false }));
  await customerAt(page, '/wallet');
  await expect(page.getByTestId('wallet-page')).toHaveAttribute('data-view', 'closed', { timeout: 20_000 });
  const states = await page.evaluate(() =>
    [...document.querySelectorAll('.mwj-title .w, .mwj-badge, .mwj-ben, .mwj-cta')].map((el) => [getComputedStyle(el).animationName, getComputedStyle(el).opacity])
  );
  expect(states.length).toBeGreaterThan(8);
  for (const [name, opacity] of states) {
    expect(name).toBe('none');
    expect(opacity).toBe('1');
  }
  const coins = await page.locator('.mwj-coin.c1, .mwj-coin.c2, .mwj-coin.c3').evaluateAll((els) => els.map((el) => getComputedStyle(el).display));
  expect(coins).toEqual(['none', 'none', 'none']);
});

test('Account card: closed shows "Save for the glow you love · Invite only"; open shows the balance', async ({ page }) => {
  test.setTimeout(90_000);
  let open = false;
  await page.route(/\/rest\/v1\/rpc\/store_wallet_my(\?|$)/, (route) => route.fulfill(json(myWallet(open ? { balance: 1200 } : { open: false }))));
  await customerAt(page, '/account');
  const card = page.getByTestId('account-wallet');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveAttribute('data-open', 'false');
  await expect(card).toContainText('MY WALLET');
  await expect(card).toContainText('Save for the glow you love');
  await expect(card).toContainText('Invite only · Tap to learn more');
  await noSideScroll(page);
  await card.screenshot({ path: `${SHOTS}/account-card-closed-390.png` });
  open = true;
  await page.reload();
  await expect(card).toHaveAttribute('data-open', 'true', { timeout: 20_000 });
  await expect(card).toContainText('৳ 1,200');
  await expect(card).toContainText('Your skincare fund');
  await card.screenshot({ path: `${SHOTS}/account-card-open-390.png` });
});

test('Pre-orders: a floating card 12 px from the edges, every corner rounded, no ×; Got it closes it', async ({ page }) => {
  test.setTimeout(90_000);
  await customerAt(page, '/account');
  await page.getByTestId('account-preorders').click();
  const sheet = page.locator('.acct-sheet');
  await expect(page.getByTestId('preorders-sheet')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(450);
  const box = (await sheet.boundingBox())!;
  const view = page.viewportSize()!;
  expect(Math.round(box.x)).toBe(12);
  expect(Math.round(view.width - (box.x + box.width))).toBe(12);
  expect(Math.round(view.height - (box.y + box.height))).toBe(12);
  const radius = await sheet.evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius];
  });
  expect(radius).toEqual(['24px', '24px', '24px', '24px']);
  await expect(sheet.getByRole('button', { name: 'Close' })).toHaveCount(0);
  await expect(sheet).toContainText('COMING SOON');
  await page.screenshot({ path: `${SHOTS}/preorders-sheet-390.png` });
  await page.getByRole('button', { name: 'Got it' }).click();
  await expect(page.getByTestId('preorders-sheet')).toHaveCount(0);
});

/* ----------------------------------------------------- admin wallet card */

const FAKE_KEY = 'ph:01799960062';

async function adminCustomer(page: Page, open: boolean) {
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  await mockRpc(page, 'admin_customers_v3', [
    {
      customer_key: FAKE_KEY, profile_id: null, full_name: 'E2E B62 Karima', email: '', phone: '01799960062', order_count: 1,
      total_spent: 1070, total_due: 0, last_order_at: '2026-11-20T08:00:00Z', joined_at: null, all_orders: 1, hidden: false,
      note: null, alt_phone: null, added_by_hand: false, added_at: null,
    },
  ]);
  await mockRpc(page, 'admin_customer_orders_v2', []);
  await mockRpc(page, 'money_customer_dues', []);
  await mockRpc(page, 'money_customer_history', { phone_key: '01799960062', previous: [], previous_left: 0, corrections: [], payments: [], reminders: [] });
  await mockRpc(page, 'store_wallet_customer', { open, balance: 0, waiting: [], requests: [], history: [] });
  const adds = await mockRpc(page, 'store_wallet_add', { entry_id: 'e10', balance: 5000 });
  const switches = await mockRpc(page, 'store_wallet_set_open', { open: !open });
  await page.goto(`/admin/customers/${encodeURIComponent(FAKE_KEY)}`);
  await expect(page.getByTestId('customer-wallet-card')).toBeVisible({ timeout: 20_000 });
  return { adds, switches };
}

test('Admin WALLET card: Wallet open switch; after Add to wallet and the switch, Back does not ask "Discard changes?"', async ({ page }) => {
  test.setTimeout(120_000);
  const { adds, switches } = await adminCustomer(page, false);
  const toggle = page.getByTestId('customer-wallet-open').getByRole('switch', { name: 'Wallet open' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect.poll(() => switches.length).toBe(1);
  expect(switches[0]).toEqual({ p_customer_key: FAKE_KEY, p_open: true });

  await page.getByTestId('customer-wallet-add').click();
  const sheet = page.getByTestId('confirm-sheet');
  await page.getByTestId('customer-wallet-add-amount').fill('5000');
  await sheet.getByLabel('Note').fill('Sent on WhatsApp');
  await sheet.getByRole('button', { name: 'Add ৳5,000' }).click();
  await expect.poll(() => adds.length).toBe(1);
  await expect(page.getByTestId('confirm-sheet')).toHaveCount(0, { timeout: 10_000 });
  await page.getByTestId('customer-wallet-card').screenshot({ path: `${SHOTS}/admin-wallet-open-switch-390.png` });

  // Back: straight to the list, no "Discard changes?".
  await page.getByRole('button', { name: 'Back to customers' }).click();
  await expect(page.getByText('Discard changes?')).toHaveCount(0);
  await expect(page).toHaveURL(/\/admin(\?tab=customers|\/customers$|\?.*customers)/, { timeout: 10_000 });
});

test('Admin WALLET card: closing a wallet with money shows the database refusal', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  await mockRpc(page, 'admin_customers_v3', [
    {
      customer_key: FAKE_KEY, profile_id: null, full_name: 'E2E B62 Karima', email: '', phone: '01799960062', order_count: 1,
      total_spent: 1070, total_due: 0, last_order_at: '2026-11-20T08:00:00Z', joined_at: null, all_orders: 1, hidden: false,
      note: null, alt_phone: null, added_by_hand: false, added_at: null,
    },
  ]);
  await mockRpc(page, 'admin_customer_orders_v2', []);
  await mockRpc(page, 'money_customer_dues', []);
  await mockRpc(page, 'money_customer_history', { phone_key: '01799960062', previous: [], previous_left: 0, corrections: [], payments: [], reminders: [] });
  await mockRpc(page, 'store_wallet_customer', { open: true, balance: 2000, waiting: [], requests: [], history: [] });
  await page.route(/\/rest\/v1\/rpc\/store_wallet_set_open(\?|$)/, (route) =>
    route.fulfill(json({ code: 'P0001', message: 'This wallet still has ৳2,000. It can be closed when the balance is ৳0.' }, 400))
  );
  await page.goto(`/admin/customers/${encodeURIComponent(FAKE_KEY)}`);
  const toggle = page.getByTestId('customer-wallet-open').getByRole('switch', { name: 'Wallet open' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
  await toggle.click();
  await expect(page.getByTestId('customer-wallet-open-error')).toHaveText('This wallet still has ৳2,000. It can be closed when the balance is ৳0.');
});

test('Home "Needs attention": a wallet request with no name never shows the internal key', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  await mockRpc(page, 'store_wallet_waiting', [
    { id: 'w1', customer_key: 'p:f05af719-1111-2222-3333-444455556666', name: 'p:f05af719-1111-2222-3333-444455556666', amount: 1000, method: 'bkash', trx_id: 'AB12CD34', created_at: '2026-11-24T08:00:00Z' },
  ]);
  await page.goto('/admin');
  await expect(page.getByText('৳1,000 wallet money from A customer to confirm')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/p:f05af719/)).toHaveCount(0);
});

/* ---------------------------------------------------------- edit product */

test('Edit product at 390 px: editor text breaks at the same words as the product page', async ({ page }) => {
  test.setTimeout(150_000);
  const product = await productWithSizes();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/product/${product.slug}`);
  const about = page.getByTestId('pdp-about');
  await expect(about).toBeVisible({ timeout: 30_000 });
  const shop = await lineBreaks(page, '[data-testid="pdp-about"]');
  const shopWidth = await about.evaluate((el) => el.getBoundingClientRect().width);
  await about.scrollIntoViewIfNeeded();
  await about.screenshot({ path: `${SHOTS}/linebreaks-product-page-390.png` });

  await useSessionInPage(page, admin);
  await page.goto(`/admin/products/${product.id}/edit`);
  const editor = page.getByTestId('rt-editor-pf-description').locator('.rt-editor__content');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled({ timeout: 30_000 });
  const edit = await lineBreaks(page, '[data-testid="rt-editor-pf-description"] .rt-editor__content');
  const editWidth = await editor.evaluate((el) => {
    const s = getComputedStyle(el);
    return el.getBoundingClientRect().width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
  });
  await editor.scrollIntoViewIfNeeded();
  await page.getByTestId('rt-editor-pf-description').screenshot({ path: `${SHOTS}/linebreaks-editor-390.png` });
  expect(shop.length).toBeGreaterThan(2);
  expect(Math.round(editWidth), 'same text width').toBe(Math.round(shopWidth));
  expect(edit, 'the same paragraph breaks at the same words').toEqual(shop);
});

/** Top of each Edit product section, by its id. */
async function sectionBoxes(page: Page): Promise<Record<string, { x: number; y: number; w: number }>> {
  return page.evaluate(() => {
    const out: Record<string, { x: number; y: number; w: number }> = {};
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid^="pf-section-"]')) {
      const r = el.getBoundingClientRect();
      out[(el.dataset.testid ?? '').replace('pf-section-', '')] = { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width) };
    }
    const more = document.querySelector('.pform-more');
    if (more) out.more = { x: 0, y: Math.round(more.getBoundingClientRect().y + window.scrollY), w: 0 };
    return out;
  });
}

async function openEditProduct(page: Page, id: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await useSessionInPage(page, admin);
  await page.goto(`/admin/products/${id}/edit`);
  await expect(page.locator('#pf-name')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Save changes' }).first()).toBeEnabled({ timeout: 30_000 });
}

async function rpcRows<T>(fn: string): Promise<T[]> {
  const answer = await rpc<T[]>(admin.accessToken, fn, {});
  return answer.data ?? [];
}

test('Edit product on a computer (1440 px): two columns, most-used on top; phone preview equals the product page text', async ({ page }) => {
  test.setTimeout(150_000);
  const product = await productWithSizes();
  await openEditProduct(page, product.id, 1440);
  const s = await sectionBoxes(page);
  // Product | Price over Shop
  expect(s.price.x).toBeGreaterThan(s.basics.x + 100);
  expect(s.shop.x).toBe(s.price.x);
  expect(s.shop.y).toBeGreaterThan(s.price.y);
  expect(s.basics.y).toBe(s.price.y);
  // Photos full width below; Variants | Stock; text full width; More details; search | note
  expect(s.photos.y).toBeGreaterThan(s.shop.y);
  expect(s.photos.w).toBeGreaterThan(s.basics.w * 1.8);
  expect(s.variants.y).toBeGreaterThan(s.photos.y);
  expect(s.stock.y).toBe(s.variants.y);
  expect(s.stock.x).toBeGreaterThan(s.variants.x + 100);
  expect(s.details.y).toBeGreaterThan(s.variants.y);
  expect(s.details.w).toBeGreaterThan(s.basics.w * 1.8);
  expect(s.more.y).toBeGreaterThan(s.details.y);
  // Batch 72: "Where it shows" takes the old "For search and filters" slot.
  expect(s.where.y).toBeGreaterThan(s.more.y);
  expect(s.reference.y).toBe(s.where.y);
  expect(s.reference.x).toBeGreaterThan(s.where.x + 100);
  // Shop holds the three switches; Keep selling is no longer in Stock.
  const shop = page.getByTestId('pf-section-shop');
  for (const name of ['Active', 'Keep selling when out of stock', 'Featured']) await expect(shop.getByRole('switch', { name })).toBeVisible();
  await expect(page.getByTestId('pf-section-stock').getByRole('switch', { name: 'Keep selling when out of stock' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add photos' })).toBeVisible();
  // Text tabs, and the phone preview renders the product page's text.
  const preview = page.getByTestId('pf-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('About this product');
  const previewText = (await page.getByTestId('pf-preview-text').innerText()).replace(/\s+/g, ' ').trim();
  await page.getByRole('tab', { name: 'How to Use' }).click();
  await expect(page.getByTestId('rt-editor-pf-how-to-use')).toBeVisible();
  await expect(page.getByTestId('rt-editor-pf-description')).toBeHidden();
  await page.getByRole('tab', { name: 'Description' }).click();
  await page.screenshot({ path: `${SHOTS}/edit-product-computer-1440.png`, fullPage: true });

  const shopPage = await page.context().newPage();
  await shopPage.goto(`/product/${product.slug}`);
  const about = shopPage.getByTestId('pdp-about');
  await expect(about).toBeVisible({ timeout: 30_000 });
  expect((await about.innerText()).replace(/\s+/g, ' ').trim()).toBe(previewText);
  await shopPage.close();
});

test('Edit product on a phone (390 px): Product, Photos, Price, Shop, Variants, Stock, text, More details; price three across', async ({ page }) => {
  test.setTimeout(150_000);
  const product = await productWithSizes();
  await openEditProduct(page, product.id, 390);
  const s = await sectionBoxes(page);
  // Batch 72: "Where it shows" right after Price; the old search section is gone.
  const order = ['basics', 'photos', 'price', 'where', 'shop', 'variants', 'stock', 'details', 'more', 'reference'];
  const ys = order.map((k) => s[k].y);
  expect(ys).toEqual([...ys].sort((a, b) => a - b));
  const tops = await Promise.all(['#pf-retail', '#pf-offer', '#pf-wholesale'].map(async (sel) => Math.round((await page.locator(sel).boundingBox())?.y ?? -1)));
  expect(new Set(tops).size).toBe(1);
  await expect(page.getByTestId('pf-preview')).toBeHidden();
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/edit-product-phone-390.png`, fullPage: true });
});

test('Edit product on a phone: Brand opens the picker sheet; a typed new name still works (nothing saved)', async ({ page }) => {
  test.setTimeout(120_000);
  const product = await productWithSizes();
  await openEditProduct(page, product.id, 390);
  await page.getByTestId('pf-brand-pick').click();
  const sheet = page.getByRole('dialog', { name: 'Brand' });
  await expect(sheet).toBeVisible();
  const first = sheet.locator('.picker-sheet__row').first();
  const label = (await first.innerText()).trim();
  await first.click();
  await expect(page.locator('#pf-brand')).toHaveValue(label);
  await page.locator('#pf-brand').fill('E2E Brand Typed');
  await expect(page.locator('#pf-brand')).toHaveValue('E2E Brand Typed');
});

test('Show in shop: the eye hides a size (saved as is_visible = false); a hidden size is marked', async ({ page }) => {
  test.setTimeout(120_000);
  const product = await productWithSizes();
  const all = await select<{ id: string }[]>(admin.accessToken, `product_variants_view?select=id&product_id=eq.${product.id}&order=sort_order.asc`);
  const hiddenId = (all.data ?? [])[(all.data ?? []).length - 1]?.id ?? '';
  await page.route(/\/rest\/v1\/product_variants_view\?/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = route.request().url().replace(/%2C\s*is_visible|,\s*is_visible/, '');
    const response = await route.fetch({ url });
    const rows = (await response.json()) as { id: string }[];
    await route.fulfill({ response, json: Array.isArray(rows) ? rows.map((r) => ({ ...r, is_visible: r.id !== hiddenId })) : rows });
  });
  const patches: Record<string, unknown>[] = [];
  await page.route(/\/rest\/v1\/product_variants\?/, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    patches.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
    await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
  });
  await openEditProduct(page, product.id, 390);
  await expect(page.getByTestId('variant-row').first()).toBeVisible({ timeout: 20_000 });
  const hidden = page.locator('[data-testid="variant-row"][data-visible="false"]');
  await expect(hidden).toHaveCount(1);
  await expect(hidden).toContainText('Hidden from the shop');
  await expect(hidden.getByTestId('variant-show-in-shop')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('pf-section-variants').scrollIntoViewIfNeeded();
  await page.getByTestId('pf-section-variants').screenshot({ path: `${SHOTS}/variants-hidden-size-390.png` });
  const shown = page.locator('[data-testid="variant-row"][data-visible="true"]').first();
  await shown.getByTestId('variant-show-in-shop').click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ is_visible: false });
});

test('New lot: a row entered in loose ml says "Lot total · 100 ml" (nothing saved)', async ({ page }) => {
  test.setTimeout(120_000);
  const packs = await rpcRows<{ product_id: string; variant_id: string | null; stock_unit: string; pack_size: number }>('inventory_pack_units');
  const pick = packs.find((p) => p.variant_id === null && p.pack_size > 1 && p.stock_unit === 'ml');
  test.skip(!pick, 'No product counted in ml with a pack size above 1.');
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  await page.goto(`/admin?tab=inventory&inv=new&add=${pick?.product_id ?? ''}`);
  const enterIn = page.getByLabel(/^Enter .* in$/).first();
  await expect(enterIn).toBeVisible({ timeout: 30_000 });
  await enterIn.selectOption('unit');
  await page.getByLabel(/^Qty of /).first().fill('100');
  await expect(page.getByTestId('inv-lot-total')).toContainText('Lot total · 100 ml');
  await page.getByTestId('inv-lot-total').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/lot-total-ml-390.png` });
});

test('Admin New order: a product in packs shows "Stock: N bottles (… unit)" (nothing saved)', async ({ page }) => {
  test.setTimeout(120_000);
  const packs = await rpcRows<{ product_id: string; variant_id: string | null; pack_size: number }>('inventory_pack_units');
  const products = await select<{ id: string; name: string }[]>(admin.accessToken, 'products_view?select=id,name&is_active=eq.true');
  const pick = (products.data ?? []).find((p) => packs.some((k) => k.product_id === p.id && k.variant_id === null && k.pack_size > 1));
  test.skip(!pick, 'No active product with a pack size above 1.');
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  await page.goto('/admin/orders/new');
  const search = page.getByPlaceholder('Search product name...');
  await expect(search).toBeVisible({ timeout: 30_000 });
  await search.fill(pick?.name.slice(0, 18) ?? '');
  await page.getByTestId('manual-product-result').filter({ hasText: pick?.name ?? '' }).first().click();
  const picker = page.getByTestId('manual-option-picker');
  if (await picker.isVisible().catch(() => false)) {
    await picker.getByTestId('manual-option').first().click();
    await page.getByTestId('manual-pick-add').click();
  }
  const line = page.getByTestId('line-pack-stock').first();
  await expect(line).toHaveText(/^Stock: [\d,]+ bottles?( \+ [\d,]+ (pcs|ml|g|tab))?( \([\d,]+ (pcs|ml|g|tab)\))?$/, { timeout: 20_000 });
  await line.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/order-stock-line-390.png` });
});

test('Combos: New combo → Add products finds any active product; status, quantity, remove (nothing saved)', async ({ page }) => {
  test.setTimeout(120_000);
  const creates = await mockRpc(page, 'admin_create_combo', { id: 'x', code: 'x' });
  const product = await productWithSizes();
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=combos');
  await page.getByTestId('admin-combo-new').click();
  const search = page.getByTestId('combo-add-search');
  await expect(search).toBeVisible({ timeout: 20_000 });
  await search.fill(product.name.slice(0, 14));
  await page.getByTestId('manual-product-result').filter({ hasText: product.name }).first().click();
  const picker = page.getByTestId('manual-option-picker');
  await expect(picker).toBeVisible();
  await picker.getByTestId('manual-option').first().click();
  await page.getByTestId('manual-pick-add').click();
  const row = page.getByTestId('combo-edit-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('combo-edit-status')).toHaveText(/^(In stock|Out of stock|Keep selling: bought after the order|Only \d+ left .+) · ৳/);
  await row.getByRole('button', { name: `One more ${product.name}` }).click();
  await expect(row.getByTestId('combo-edit-qty')).toHaveText('2');
  await page.screenshot({ path: `${SHOTS}/combo-add-products-390.png` });
  await row.getByTestId('combo-edit-remove').click();
  await expect(row).toHaveCount(0);
  expect(creates.length).toBe(0);
});

test('Coming back: the shop shows the last copy at once while the fresh one is on its way', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/shop');
  await expect(page.locator('.product-card__name').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  // The products answer now takes 6 seconds: the cards still show at once.
  let slow = 0;
  await page.route(/\/rest\/v1\/products_view\?/, async (route) => {
    slow += 1;
    await new Promise((r) => setTimeout(r, 6000));
    await route.abort().catch(() => undefined);
  });
  const started = Date.now();
  await page.reload();
  await expect(page.locator('.product-card__name').first()).toBeVisible({ timeout: 4000 });
  expect(Date.now() - started).toBeLessThan(5000);
  await expect.poll(() => slow, { message: 'the fresh copy was still asked for' }).toBeGreaterThan(0);
  // Let the slow answer finish before the test ends (no half-handled route).
  await page.waitForTimeout(6500);
});
