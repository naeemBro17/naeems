import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import type { Browser, Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, select, useSessionInPage, type TestSession } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 52: "Share as a combo", real links (Open in new tab), leaving
// Facebook's in-app browser, link previews.
//
// The live shop is never changed. The database rules run in
// e2e/sql/batch-52.sql against today's live functions (Batch 61: no old migration is replayed) inside
// ONE transaction that is always rolled back. In the browser every combo
// call (get_combo, admin_create_combo, the combos list, delete, the
// preview upload) is answered locally — no combo is ever saved, so there
// is nothing to delete afterwards, and nothing needs the SQL to have been
// run. Storage files are never downloaded (fixtures).

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-52-screens';
const WIDTH = 390;
const CODE = 'k7m2xq9p';

let admin: TestSession;
let customer: TestSession;

interface LiveProduct {
  id: string;
  name: string;
  slug: string;
  retail_price: number;
  offer_price: number | null;
}

/** Three plain products (no options); `out` is shown as sold out. */
let picks: { a: LiveProduct; b: LiveProduct; out: LiveProduct };

const shown = (p: LiveProduct) => (p.offer_price !== null && p.offer_price < p.retail_price ? p.offer_price : p.retail_price);
const taka = (n: number) => '৳ ' + n.toLocaleString('en-US');

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  const res = await select<LiveProduct[]>(
    null,
    'products_view?select=id,name,slug,retail_price,offer_price&is_active=eq.true&image_url=not.is.null&offer_price=not.is.null&order=name.asc&limit=80'
  );
  const variants = await select<{ product_id: string }[]>(null, 'product_variants_view?select=product_id');
  const withOptions = new Set((variants.data ?? []).map((v) => v.product_id));
  const plain = (res.data ?? []).filter((p) => !withOptions.has(p.id) && p.slug && p.offer_price !== null && p.offer_price < p.retail_price);
  expect(plain.length, 'three plain products on offer').toBeGreaterThanOrEqual(3);
  picks = { a: plain[0], b: plain[1], out: plain[2] };
  // The shop's own link-preview banner, for the report's screenshots.
  copyFileSync('public/og-shop.jpg', `${SHOTS}/shop-preview-og-shop.jpg`);
});

// The cart's own stock check may still be asking when a test ends.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

/* ------------------------------------------------------ the database rules */

test('database: combos — admin only to make / list / change / delete, anyone reads one by its code, nothing else touched (one rolled-back transaction)', async () => {
  test.setTimeout(180_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  const fill = (s: string) => s.replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL).replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const tests = fill(readFileSync('e2e/sql/batch-52.sql', 'utf8'));
  const output = await runSql(`BEGIN;\n${tests}`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(20);
});

/* ------------------------------------------------------- browser answers */

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

type Row = Record<string, unknown>;

/** products_view as the shop would show it: `out` sold out. */
async function dressShop(page: Page, outOfStock: boolean): Promise<void> {
  await page.route(/\/rest\/v1\/products_view\?/, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Row[] | Row;
    const dress = (row: Row): Row => {
      const id = String(row.id);
      if (outOfStock && id === picks.out.id) return { ...row, keep_selling: false, stock_quantity: 0, stock_status: 'out_of_stock', in_hand: false };
      if (id === picks.a.id || id === picks.b.id || id === picks.out.id) {
        return { ...row, keep_selling: true, stock_quantity: null, stock_status: 'in_stock', in_hand: true };
      }
      return row;
    };
    await route.fulfill({ response: res, json: Array.isArray(body) ? body.map(dress) : body });
  });
}

function comboBody(note: string | null) {
  return {
    code: CODE,
    name: "Sadia's glow routine",
    note,
    preview_url: null,
    items: [
      { product_id: picks.a.id, variant_id: null, quantity: 1 },
      { product_id: picks.b.id, variant_id: null, quantity: 2 },
      { product_id: picks.out.id, variant_id: null, quantity: 1 },
    ],
  };
}

async function answerCombo(page: Page, combo: unknown): Promise<void> {
  await page.route(/\/rest\/v1\/rpc\/get_combo/, (route) => json(route, combo));
}

async function prepare(page: Page, theme: 'light' | 'dark', session: TestSession | null, width = WIDTH): Promise<void> {
  await page.setViewportSize({ width, height: 844 });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  if (session) await useSessionInPage(page, session);
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at phone width').toBeLessThanOrEqual(0);
}

/** Visible elements painted in the brand orange (#FF7A45 / #F05020 family). */
async function orangeCount(page: Page, selector = 'body'): Promise<string[]> {
  return page.locator(selector).first().evaluate((root) => {
    const hits: string[] = [];
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.opacity === '0') continue;
      for (const c of [s.backgroundColor, s.color]) {
        const m = /rgba?\((\d+), (\d+), (\d+)/.exec(c);
        if (m && Number(m[1]) > 225 && Number(m[2]) > 70 && Number(m[2]) < 140 && Number(m[3]) < 90) {
          hits.push(String((el as HTMLElement).className || el.tagName));
          break;
        }
      }
    }
    return hits;
  });
}

/* --------------------------------------------- the customer's combo page */

for (const theme of ['light', 'dark'] as const) {
  test(`combo page at 390 px (${theme}): photos, note, live prices and stock, total, Add all to cart, chat`, async ({ page }) => {
    test.setTimeout(120_000);
    await dressShop(page, false);
    await answerCombo(page, comboBody('Cleanser morning & night. Serum only at night.'));
    await prepare(page, theme, null);
    await page.goto(`/c/${CODE}`);

    await expect(page.getByTestId('combo-title')).toHaveText("Sadia's glow routine", { timeout: 30_000 });
    await expect(page.locator('.combo-kicker')).toHaveText('PICKED FOR YOU BY NAEEM');
    await expect(page.getByTestId('combo-note-card')).toContainText("Naeem's note");
    await expect(page.getByTestId('combo-note-card')).toContainText('Cleanser morning & night. Serum only at night.');
    await expect(page.getByTestId('combo-row')).toHaveCount(3);
    await expect(page.getByTestId('combo-row-stock').first()).toHaveText('In Stock');
    await expect(page.getByTestId('combo-collage').locator('img')).toHaveCount(3);
    // Each row opens its product (a real link).
    await expect(page.getByTestId('combo-row').first().locator('a')).toHaveAttribute('href', `/product/${picks.a.slug}`);

    const total = shown(picks.a) + shown(picks.b) * 2 + shown(picks.out);
    const retail = picks.a.retail_price + picks.b.retail_price * 2 + picks.out.retail_price;
    await expect(page.getByTestId('combo-total-amount')).toHaveText(taka(total));
    await expect(page.getByTestId('combo-save')).toHaveText(`You save ${taka(retail - total)}`);
    await expect(page.getByTestId('combo-add-all')).toHaveText('Add all to cart');
    const chat = page.getByTestId('combo-chat');
    await expect(chat).toHaveText('Want to change something? Chat with us');
    expect(decodeURIComponent((await chat.getAttribute('href')) ?? '')).toContain("Hi! About my combo: Sadia's glow routine");

    // One orange thing on the screen: Add all to cart. Prices are not orange.
    expect(await orangeCount(page, '.combo-main')).toEqual(['button button--primary button--full combo-add']);
    await noSidewaysScroll(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-04-combo-page.png`, fullPage: true });

    // Add all → the cart, with the combo's quantities.
    await page.getByTestId('combo-add-all').click();
    await expect(page).toHaveURL(/\/cart$/);
    await expect(page.locator('[data-testid="cart-line"]')).toHaveCount(3);
    const cart = await page.evaluate(() => JSON.parse(localStorage.getItem('nph_cart') ?? '[]') as { productId: string; quantity: number }[]);
    expect(cart.find((l) => l.productId === picks.b.id)?.quantity).toBe(2);
    await expect(page.locator('.toast').first()).toContainText('Added 3 items');
  });

  test(`combo page at 390 px (${theme}): a sold-out item is shown, not counted, not added`, async ({ page }) => {
    test.setTimeout(120_000);
    await dressShop(page, true);
    await answerCombo(page, comboBody(null));
    await prepare(page, theme, customer);
    await page.goto(`/c/${CODE}`);

    await expect(page.getByTestId('combo-title')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('combo-note-card')).toHaveCount(0);
    const outRow = page.getByTestId('combo-row').filter({ hasText: picks.out.name });
    await expect(outRow.getByTestId('combo-row-stock')).toHaveText('Sold out');
    const total = shown(picks.a) + shown(picks.b) * 2;
    await expect(page.getByTestId('combo-total-amount')).toHaveText(taka(total));
    await page.screenshot({ path: `${SHOTS}/${theme}-05-combo-page-sold-out.png`, fullPage: true });

    await page.getByTestId('combo-add-all').click();
    await expect(page).toHaveURL(/\/cart$/);
    await expect(page.locator('.toast').first()).toContainText('Added 2 items. 1 sold out.');
    const cart = await page.evaluate(() => JSON.parse(localStorage.getItem('nph_cart') ?? '[]') as { productId: string }[]);
    expect(cart.map((l) => l.productId).sort()).toEqual([picks.a.id, picks.b.id].sort());
  });

  test(`combo page at 390 px (${theme}): deleted or unknown code → friendly page with Browse the shop`, async ({ page }) => {
    await answerCombo(page, null);
    await prepare(page, theme, null);
    await page.goto(`/c/${CODE}`);
    await expect(page.getByTestId('combo-gone')).toContainText("This combo isn't available anymore.", { timeout: 30_000 });
    await expect(page.getByTestId('combo-browse')).toHaveAttribute('href', '/');
    await page.screenshot({ path: `${SHOTS}/${theme}-06-combo-gone.png` });
    // A badly shaped code never even asks the database.
    await page.goto('/c/NOT-A-CODE');
    await expect(page.getByTestId('combo-gone')).toBeVisible({ timeout: 30_000 });
  });
}

test('combo page: the order limit still applies (4 wanted, limit 4, 3 already in the cart → 1 added)', async ({ page }) => {
  await dressShop(page, false);
  await answerCombo(page, { ...comboBody(null), items: [{ product_id: picks.a.id, variant_id: null, quantity: 4 }] });
  await prepare(page, 'light', null);
  await page.addInitScript(
    ([id, price]) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('nph_cart', JSON.stringify([{ productId: id, variantId: null, variantLabel: null, quantity: 3, priceAtAdd: price }]));
        sessionStorage.setItem('seeded', '1');
      }
    },
    [picks.a.id, shown(picks.a)] as const
  );
  await page.goto(`/c/${CODE}`);
  await page.getByTestId('combo-add-all').click();
  await expect(page).toHaveURL(/\/cart$/);
  const cart = await page.evaluate(() => JSON.parse(localStorage.getItem('nph_cart') ?? '[]') as { quantity: number }[]);
  expect(cart[0].quantity).toBe(4);
});

/* -------------------------------------------- the admin's cart and sheets */

async function seedCart(page: Page): Promise<void> {
  await page.addInitScript(
    (lines) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('nph_cart', JSON.stringify(lines));
        sessionStorage.setItem('seeded', '1');
      }
    },
    [
      { productId: picks.a.id, variantId: null, variantLabel: null, quantity: 1, priceAtAdd: shown(picks.a) },
      { productId: picks.b.id, variantId: null, variantLabel: null, quantity: 2, priceAtAdd: shown(picks.b) },
      { productId: picks.out.id, variantId: null, variantLabel: null, quantity: 1, priceAtAdd: shown(picks.out) },
    ]
  );
}

interface Made {
  rpc: Record<string, unknown> | null;
  patched: boolean;
  uploaded: boolean;
}

async function answerAdminCombos(page: Page, made: Made): Promise<void> {
  await page.route(/\/rest\/v1\/rpc\/admin_create_combo/, async (route) => {
    made.rpc = (route.request().postDataJSON() ?? null) as Record<string, unknown> | null;
    await json(route, '00000000-0000-4000-8000-00000000c0b0');
  });
  await page.route(/\/rest\/v1\/combos\?/, async (route) => {
    if (route.request().method() === 'PATCH') {
      made.patched = true;
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.fallback();
  });
  await page.route(/\/storage\/v1\/object\/product-images\/combos\//, async (route) => {
    if (route.request().method() === 'POST') {
      made.uploaded = true;
      await json(route, { Key: 'product-images/combos/x.jpg' });
      return;
    }
    await route.fallback();
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`admin cart at 390 px (${theme}): dark "Share as a combo" card → make the combo → link ready → Clear my cart`, async ({ page, context }) => {
    test.setTimeout(120_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const made: Made = { rpc: null, patched: false, uploaded: false };
    await dressShop(page, false);
    await answerAdminCombos(page, made);
    await prepare(page, theme, admin);
    await seedCart(page);
    await page.goto('/cart');

    const card = page.getByTestId('combo-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('ONLY YOU SEE THIS');
    await expect(card).toContainText('Picked these for a customer?');
    await expect(card).toContainText('Turn this cart into a link. Your customer opens it and adds everything in one tap.');
    await expect(page.getByTestId('combo-open')).toHaveText('Share as a combo');
    // Checkout stays the one orange button.
    expect(await orangeCount(page, '.combo-card')).toEqual([]);
    await card.scrollIntoViewIfNeeded();
    await noSidewaysScroll(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-01-admin-cart-combo-card.png` });

    await page.getByTestId('combo-open').click();
    const sheet = page.getByTestId('combo-make');
    await expect(sheet).toBeVisible();
    const total = shown(picks.a) + shown(picks.b) * 2 + shown(picks.out);
    await expect(sheet.locator('.combo-make__sub')).toHaveText(`3 products · total ${taka(total)}`);
    await expect(page.getByTestId('combo-name')).toHaveAttribute('placeholder', "e.g. Sadia's glow routine");
    await expect(page.getByTestId('combo-note')).toHaveAttribute('placeholder', 'e.g. Cleanser morning & night. Serum only at night.');
    await expect(page.getByTestId('combo-name')).toHaveAttribute('maxlength', '60');
    await expect(page.getByTestId('combo-note')).toHaveAttribute('maxlength', '300');
    await page.getByTestId('combo-name').fill("Sadia's glow routine");
    await page.getByTestId('combo-note').fill('Cleanser morning & night. Serum only at night.');
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${SHOTS}/${theme}-02-make-combo-sheet.png` });

    await page.getByTestId('combo-create').click();
    const ready = page.getByTestId('combo-ready');
    await expect(ready).toBeVisible({ timeout: 20_000 });
    await expect(ready.locator('.combo-ready__title')).toHaveText('Your combo link is ready');
    await expect(ready.locator('.combo-ready__sub')).toHaveText(`Sadia's glow routine · ${taka(total)}`);
    const link = (await page.getByTestId('combo-link').textContent()) ?? '';
    expect(link).toMatch(/\/c\/[a-z2-9]{8}$/);
    const code = link.slice(-8);
    expect(made.rpc).toMatchObject({ p_code: code, p_name: "Sadia's glow routine", p_note: 'Cleanser morning & night. Serum only at night.' });
    expect(made.rpc?.p_items).toEqual([
      { product_id: picks.a.id, variant_id: null, quantity: 1 },
      { product_id: picks.b.id, variant_id: null, quantity: 2 },
      { product_id: picks.out.id, variant_id: null, quantity: 1 },
    ]);
    await expect(page.getByTestId('combo-share-whatsapp')).toHaveAttribute('href', `https://wa.me/?text=${encodeURIComponent(`http://${link}`)}`);
    await expect(page.getByTestId('combo-chat-preview')).toContainText("Sadia's glow routine, picked for you by NAEEM'S");
    await expect(page.getByTestId('combo-chat-preview')).toContainText('3 products, hand-picked by Naeem. 100% authentic.');
    await page.getByTestId('combo-copy').click();
    await expect(page.getByTestId('combo-copy')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://${link}`);
    // On a phone (this test browser is one) Messenger opens its own share
    // screen (the link format is in the unit tests); on a computer it copies
    // the link — see the 'Messenger on a computer' test below.
    await expect(page.getByTestId('combo-share-messenger')).toHaveText('Messenger');
    await expect(page.getByTestId('combo-share-more')).toHaveText('More');
    expect(await orangeCount(page, '[data-testid="combo-ready"]')).toEqual([]);
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${SHOTS}/${theme}-03-link-ready.png` });

    await page.getByTestId('combo-clear-cart').click();
    await expect(page.getByText('Your cart is empty')).toBeVisible();
  });
}

test('the combo card is only for the admin (a customer and a logged-out visitor never see it)', async ({ page, browser }) => {
  await dressShop(page, false);
  await prepare(page, 'light', customer);
  await seedCart(page);
  await page.goto('/cart');
  await expect(page.locator('[data-testid="cart-line"]').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('combo-card')).toHaveCount(0);

  const anon = await browser.newPage();
  await anon.setViewportSize({ width: WIDTH, height: 844 });
  await seedCart(anon);
  await anon.goto('/cart');
  await expect(anon.locator('[data-testid="cart-line"]').first()).toBeVisible({ timeout: 30_000 });
  await expect(anon.getByTestId('combo-card')).toHaveCount(0);
  await anon.close();
});

/* ------------------------------------------------------- Admin → Combos */

for (const theme of ['light', 'dark'] as const) {
  test(`Admin → Combos at 390 px (${theme}): list, Open / Copy link / Share / Delete (confirm)`, async ({ page, context }) => {
    test.setTimeout(120_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    let rows = [
      {
        id: '00000000-0000-4000-8000-00000000c0b1',
        code: CODE,
        name: "Sadia's glow routine",
        note: 'Morning and night.',
        preview_url: null,
        created_at: '2026-11-18T10:00:00Z',
        combo_items: [
          { product_id: picks.a.id, variant_id: null, quantity: 1, sort_order: 0 },
          { product_id: picks.b.id, variant_id: null, quantity: 2, sort_order: 1 },
        ],
      },
      {
        id: '00000000-0000-4000-8000-00000000c0b2',
        code: 'p3vn8tqe',
        name: 'Rumi — oily skin starter',
        note: null,
        preview_url: null,
        created_at: '2026-11-12T10:00:00Z',
        combo_items: [{ product_id: picks.out.id, variant_id: null, quantity: 1, sort_order: 0 }],
      },
    ];
    let deleted = '';
    await page.route(/\/rest\/v1\/combos\?/, async (route) => {
      const req = route.request();
      if (req.method() === 'GET') return json(route, rows);
      if (req.method() === 'DELETE') {
        deleted = new URL(req.url()).searchParams.get('id') ?? '';
        rows = rows.filter((r) => `eq.${r.id}` !== deleted);
        return route.fulfill({ status: 204, body: '' });
      }
      return route.fallback();
    });
    await prepare(page, theme, admin);
    await page.goto('/admin?tab=combos');

    await expect(page.getByTestId('admin-combo-row')).toHaveCount(2, { timeout: 30_000 });
    const first = page.getByTestId('admin-combo-row').first();
    await expect(first).toContainText("Sadia's glow routine");
    await expect(first).toContainText('2 products');
    await expect(first).toContainText('18 Nov 2026');
    await expect(first.getByTestId('admin-combo-open')).toHaveAttribute('href', `/c/${CODE}`);
    await noSidewaysScroll(page);
    await page.screenshot({ path: `${SHOTS}/${theme}-07-admin-combos.png` });

    await first.getByTestId('admin-combo-copy').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/c/${CODE}$`));

    await first.getByTestId('admin-combo-share').click();
    await expect(page.getByTestId('combo-ready')).toBeVisible();
    await expect(page.getByTestId('combo-link')).toHaveText(new RegExp(`/c/${CODE}$`));
    await page.getByRole('button', { name: 'Close' }).first().click();
    await expect(page.getByTestId('combo-ready')).toHaveCount(0);

    await first.getByTestId('admin-combo-delete').click();
    await expect(page.getByRole('dialog')).toContainText('Delete this combo?');
    await expect(page.getByRole('dialog')).toContainText('Its link will stop working.');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${theme}-07b-admin-combos-delete.png` });
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('admin-combo-row')).toHaveCount(1);
    expect(deleted).toBe('eq.00000000-0000-4000-8000-00000000c0b1');
  });
}

test('Messenger on a computer: copies the link and says "Link copied — paste it in Messenger"', async ({ browser }) => {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await ctx.newPage();
  await page.route(/\/rest\/v1\/combos\?/, (route) =>
    route.request().method() === 'GET'
      ? json(route, [{ id: '00000000-0000-4000-8000-00000000c0b1', code: CODE, name: 'Glow', note: null, preview_url: null, created_at: '2026-11-18T10:00:00Z', combo_items: [] }])
      : route.fallback()
  );
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=combos');
  await page.getByTestId('admin-combo-share').click({ timeout: 30_000 });
  await page.getByTestId('combo-share-messenger').click();
  await expect(page.locator('.toast').first()).toContainText('Link copied. Paste it in Messenger');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/c/${CODE}$`));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await ctx.close();
});

/* ------------------------------------------- Part 2: Open in new tab */

test('Part 2: menus and rows are real links; Ctrl+click opens a new tab and this page stays', async ({ page, context }) => {
  test.setTimeout(120_000);
  await prepare(page, 'light', admin, 1280);
  await page.goto('/admin?tab=orders');
  const sidebar = page.getByRole('navigation', { name: 'Admin sections' }).first();
  await expect(sidebar.getByRole('link', { name: 'Customers' })).toHaveAttribute('href', '/admin?tab=customers', { timeout: 30_000 });
  await expect(sidebar.getByRole('link', { name: 'Combos' })).toHaveAttribute('href', '/admin?tab=combos');
  const opened = context.waitForEvent('page');
  await sidebar.getByRole('link', { name: 'Customers' }).click({ modifiers: ['Control'] });
  const tab = await opened;
  await tab.waitForLoadState('domcontentloaded');
  expect(tab.url()).toContain('/admin?tab=customers');
  expect(page.url()).toContain('/admin?tab=orders');
  await tab.close();
  // A normal click still moves inside the app (no reload).
  await page.evaluate(() => ((window as unknown as { __stay: number }).__stay = 1));
  await sidebar.getByRole('link', { name: 'Customers' }).click();
  await expect(page).toHaveURL(/tab=customers/);
  expect(await page.evaluate(() => (window as unknown as { __stay?: number }).__stay)).toBe(1);

  // Phone: the bottom bar and the More page.
  await page.setViewportSize({ width: WIDTH, height: 844 });
  await expect(page.locator('.adm-tabbar a.adm-tabbar__tab').first()).toHaveAttribute('href', '/admin');

  // Shop: bottom bar, product names, side menu, category circles.
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Search', exact: true })).toHaveAttribute('href', '/search', { timeout: 30_000 });
  await expect(page.locator('a.product-card__name-link').first()).toHaveAttribute('href', /^\/product\//);
  const circle = page.getByRole('link', { name: /^Show .* products$/ }).first();
  if ((await circle.count()) > 0) await expect(circle).toHaveAttribute('href', /^\/\?cat=/);
});

/* -------------------------------- Part 4: Facebook / Messenger / Instagram */

const IPHONE_FB =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/478.0.0.41.105;FBBV/641035718;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.6;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]';
const ANDROID_FB =
  'Mozilla/5.0 (Linux; Android 14; SM-A546E Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/484.0.0.53.109;]';

async function inAppPage(browser: Browser, userAgent: string, theme: 'light' | 'dark'): Promise<Page> {
  const ctx = await browser.newContext({ userAgent, viewport: { width: WIDTH, height: 844 }, colorScheme: theme, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  return page;
}

for (const theme of ['light', 'dark'] as const) {
  test(`iPhone inside Facebook (${theme}): the calm bar, How? sheet, Copy link, ✕ hides it; Google login shows the help instead`, async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await inAppPage(browser, IPHONE_FB, theme);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    const bar = page.getByTestId('inapp-bar');
    await expect(bar).toContainText('For Google login and faster checkout, open this page in Safari.', { timeout: 30_000 });
    await expect(page.getByTestId('inapp-how')).toHaveText('How?');
    await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/${theme}-08-iphone-bar.png` });

    await page.getByTestId('inapp-how').click();
    await expect(page.getByTestId('inapp-sheet')).toContainText('Tap ••• in the corner of the screen, then choose Open in browser.');
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${SHOTS}/${theme}-09-iphone-sheet.png` });
    await page.getByTestId('inapp-copy').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/$/);
    await page.getByRole('button', { name: 'Close' }).last().click();

    await page.getByTestId('inapp-close').click();
    await expect(bar).toHaveCount(0);
    await page.goto('/account');
    await expect(page.getByTestId('inapp-bar')).toHaveCount(0);

    // Google login inside the in-app browser: no trip to Google, the help sheet.
    const google = page.getByRole('button', { name: /Google/ }).first();
    await expect(google).toBeVisible({ timeout: 30_000 });
    const toGoogle: string[] = [];
    page.on('request', (r) => {
      if (/accounts\.google\.com|\/auth\/v1\/authorize/.test(r.url())) toGoogle.push(r.url());
    });
    await google.click();
    await expect(page.getByTestId('inapp-sheet')).toBeVisible();
    expect(toGoogle).toEqual([]);
    await page.context().close();
  });
}

test('Android inside Facebook: reopens in Chrome once (no loop); if that fails, the bar says Chrome', async ({ browser }) => {
  const page = await inAppPage(browser, ANDROID_FB, 'light');
  // The jump to Chrome interrupts the page's load event here (the test
  // browser has no Chrome app), so wait only for the page to start.
  await page.goto('/', { waitUntil: 'commit' });
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('nph_inapp_chrome_tried')), { timeout: 15_000 }).toBe('1');
  // The test browser has no Chrome app to open, so it stays: the bar shows.
  await expect(page.getByTestId('inapp-bar')).toContainText('open this page in Chrome', { timeout: 30_000 });
  // Once per visit: a reload does not try again (no loop), the bar stays.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('inapp-bar')).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => sessionStorage.getItem('nph_inapp_chrome_tried'))).toBe('1');
  await page.context().close();
});

test('a normal phone browser sees nothing different', async ({ page }) => {
  await prepare(page, 'light', null);
  await page.goto('/');
  await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('inapp-bar')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('nph_inapp_chrome_tried'))).toBeNull();
});
