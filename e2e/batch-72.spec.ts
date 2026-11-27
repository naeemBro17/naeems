import { mkdirSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { passwordSession, select, useSessionInPage, type TestSession } from './helpers/api';
import { signInAsTestCustomer } from './helpers/auth';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './helpers/env';

// Batch 72: products in several categories, skin type and concern tags,
// "Complete your routine" (side cart + product page), the side cart's
// question, "My skin" and Home's "Picked for you".
//
// Nothing is written to Supabase. The product list is the live one with
// changes made inside the test browser only; the settings, the customer's
// skin answers and two test categories are answered in the test browser;
// every save (product, settings, profile) is caught here and answered
// locally, and any other write fails the test. No real Storage file is
// downloaded (./fixtures).

test.use({ serviceWorkers: 'block', timezoneId: 'Asia/Dhaka' });

const SHOTS = 'reports/batch-72-screens';
const MOIST = '00000000-0000-4000-8000-0000000072a1';
const CLEAN = '00000000-0000-4000-8000-0000000072a2';

let admin: TestSession;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

interface LiveProduct {
  id: string;
  slug: string;
  name: string;
}

/** Live in-stock products with no options and no stock count. */
async function liveProducts(count: number): Promise<LiveProduct[]> {
  const res = await select<LiveProduct[]>(
    null,
    'products_view?select=id,slug,name&is_active=eq.true&stock_status=eq.in_stock&stock_quantity=is.null&order=name.asc'
  );
  const variants = await select<{ product_id: string }[]>(null, 'product_variants_view?select=product_id');
  const withOptions = new Set((variants.data ?? []).map((v) => v.product_id));
  const plain = (res.data ?? []).filter((p) => !withOptions.has(p.id) && p.slug && !/acne/i.test(p.name));
  expect(plain.length).toBeGreaterThanOrEqual(count);
  return plain.slice(0, count);
}

type Row = Record<string, unknown> & { id: string };

/**
 * The live product list with these changes (this test browser only).
 * `sqlRun`: every row has extra_category_ids (as after migration-064).
 * `clearTags`: every other product loses its skin tags.
 */
async function patchProducts(
  page: Page,
  patch: Record<string, Partial<Row>>,
  opts: { sqlRun?: boolean; clearTags?: boolean } = {}
): Promise<void> {
  await page.route(/\/rest\/v1\/products_view\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) return route.fulfill({ response });
    const rows = (body as Row[]).map((row) => {
      let next: Row = { ...row };
      if (opts.sqlRun && next.extra_category_ids === undefined) next.extra_category_ids = [];
      if (opts.clearTags && !(row.id in patch)) next = { ...next, skin_types: [], skin_conditions: [] };
      return row.id in patch ? { ...next, ...patch[row.id] } : next;
    });
    await route.fulfill({ response, json: rows });
  });
}

/** Two test categories, "Moisturizer" and "Cleanser" (this browser only). */
async function testCategories(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/categories\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const rows = (await response.json()) as Row[];
    const base = rows[0] ?? {};
    rows.push(
      { ...base, id: MOIST, name: 'Moisturizer', slug: 'e2e-b72-moisturizer', image_url: null },
      { ...base, id: CLEAN, name: 'Cleanser', slug: 'e2e-b72-cleanser', image_url: null }
    );
    await route.fulfill({ response, json: rows });
  });
}

/**
 * app_settings answered here: `values` on top of the live rows, and every
 * save (upsert) kept in this browser and recorded.
 */
async function settings(page: Page, values: Record<string, string>): Promise<Record<string, string>[]> {
  const store: Record<string, string> = { ...values };
  const saves: Record<string, string>[] = [];
  await page.route(/\/rest\/v1\/app_settings(\?|$)/, async (route: Route) => {
    const method = route.request().method();
    if (method === 'POST') {
      const rows = route.request().postDataJSON() as { key: string; value: string }[];
      const saved: Record<string, string> = {};
      for (const r of rows) {
        store[r.key] = r.value;
        saved[r.key] = r.value;
      }
      saves.push(saved);
      return route.fulfill({ status: 201, body: '' });
    }
    if (method !== 'GET') return route.fallback();
    const res = await route.fetch();
    const rows = ((await res.json()) as { key: string; value: string }[]).filter((r) => !(r.key in store));
    for (const [key, value] of Object.entries(store)) rows.push({ key, value });
    await route.fulfill({ response: res, json: rows });
  });
  return saves;
}

/** The signed-in customer's own profile row with skin answers (as after
 *  migration-064); a save is recorded and answered here. */
async function skinProfile(
  page: Page,
  skin: { skin_type: string | null; skin_concerns: string[]; skin_wants: string[] }
): Promise<Record<string, unknown>[]> {
  const patches: Record<string, unknown>[] = [];
  await page.route(/\/rest\/v1\/profiles(\?|$)/, async (route: Route) => {
    const method = route.request().method();
    if (method === 'PATCH') {
      patches.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({ status: 204, body: '' });
    }
    if (method !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body: unknown = await response.json().catch(() => null);
    const extra = { ...skin, skin_saved_at: null };
    const merged = Array.isArray(body)
      ? body.map((r: Record<string, unknown>) => ({ ...r, ...extra }))
      : body && typeof body === 'object'
        ? { ...(body as Record<string, unknown>), ...extra }
        : body;
    await route.fulfill({ response, json: merged });
  });
  return patches;
}

/** Any write to the database that no mock above answered fails the test. */
async function noWrites(page: Page): Promise<string[]> {
  const blocked: string[] = [];
  await page.route(/\/rest\/v1\//, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    const isRead = method === 'GET' || method === 'HEAD' || (method === 'POST' && req.url().includes('/rpc/'));
    if (isRead) return route.fallback();
    blocked.push(`${method} ${req.url()}`);
    return route.abort();
  });
  return blocked;
}

/** This visit starts fresh: the first add opens the side cart. */
async function freshVisit(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem('e2e.b72.started')) return;
    window.sessionStorage.setItem('e2e.b72.started', '1');
    window.sessionStorage.setItem('e2e.b70.fresh', '1');
    window.sessionStorage.removeItem('naeems.sideCartShown');
  });
}

async function seedCart(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((list) => {
    window.localStorage.setItem(
      'nph_cart',
      JSON.stringify(list.map((productId) => ({ productId, variantId: null, variantLabel: null, quantity: 1, priceAtAdd: 100 })))
    );
  }, ids);
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, scheme);
  await page.waitForTimeout(250);
}

async function shoot(page: Page, name: string, both: () => Promise<void> = async () => undefined): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await setTheme(page, scheme);
    await both();
    await page.screenshot({ path: `${SHOTS}/${name}-390-${scheme}.png` });
  }
  await setTheme(page, 'light');
}

const sideCart = (page: Page) => page.getByTestId('side-cart');

async function phone(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
}

/* ---------------------------------------------------------------- side cart */

test('side cart: adding a product with a matching rule shows "Complete your routine" (cart items left out); + on a pick adds it and the panel stays open', async ({ page }) => {
  test.setTimeout(90_000);
  const [anchor, pickA, pickB, inCart] = await liveProducts(4);
  await phone(page);
  const blocked = await noWrites(page);
  await testCategories(page);
  await settings(page, { routine_rules: JSON.stringify([{ from: MOIST, to: CLEAN }]), routine_questions: '[]' });
  await patchProducts(
    page,
    {
      [anchor.id]: { category_id: MOIST, skin_conditions: [] },
      [pickA.id]: { extra_category_ids: [CLEAN] },
      [pickB.id]: { category_id: CLEAN },
      [inCart.id]: { category_id: CLEAN },
    },
    { sqlRun: true }
  );
  await freshVisit(page);
  await page.goto('/shop');
  await seedCart(page, [inCart.id]);
  await page.goto(`/product/${anchor.slug}`);
  await expect(page.getByTestId('pdp-buy')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('add-to-cart').click();
  await expect(sideCart(page)).toHaveClass(/b70-cart--open/);
  const routine = page.getByTestId('side-cart-routine');
  await expect(routine).toBeVisible();
  await expect(routine.locator('h5')).toContainText('Complete your routine');
  await expect(routine.locator('h5 small')).toHaveText('for your moisturizer');
  const names = (await routine.locator('.b72-rc__n').allInnerTexts()).map((n) => n.trim());
  expect(names.sort()).toEqual([pickA.name, pickB.name].sort());
  await expect(routine.locator('.b72-rc em').first()).toHaveText(/cleanser/i);

  const card = page.getByTestId('side-cart-routine-card').filter({ hasText: pickA.name });
  await card.getByTestId('side-cart-routine-add').click();
  await expect(page.getByTestId('side-cart-line')).toHaveCount(3);
  await expect(sideCart(page)).toHaveClass(/b70-cart--open/);
  const top = page.getByTestId('side-cart-line').first();
  await expect(top).toContainText(pickA.name);
  await expect(top).toHaveAttribute('data-highlighted', 'true');
  // The row now completes the routine for the line just added, and never
  // suggests anything already in the cart.
  const after = (await page.getByTestId('side-cart-routine').locator('.b72-rc__n').allInnerTexts()).map((n) => n.trim());
  for (const name of [anchor.name, pickA.name, inCart.name]) expect(after).not.toContain(name);
  expect(blocked).toEqual([]);
});

test('side cart: the question shows on the 4th open, "Show me" lands on the Shop filtered by that concern; the next open has no question; the row never stops the list scrolling', async ({ page }) => {
  test.setTimeout(120_000);
  const [first, pickA, pickB, tagged] = await liveProducts(4);
  await phone(page);
  const blocked = await noWrites(page);
  await testCategories(page);
  await settings(page, {
    routine_rules: JSON.stringify([{ from: MOIST, to: CLEAN }]),
    routine_questions: JSON.stringify([{ text: 'Thinking about anti aging?', concern: 'Anti aging' }]),
  });
  await patchProducts(
    page,
    {
      [first.id]: { category_id: MOIST, skin_conditions: [] },
      [pickA.id]: { category_id: CLEAN, skin_conditions: [] },
      [pickB.id]: { category_id: CLEAN, skin_conditions: [] },
      [tagged.id]: { skin_conditions: ['Anti-Aging'] },
    },
    { sqlRun: true, clearTags: true }
  );
  await page.goto('/shop');
  await seedCart(page, [first.id]);
  await page.evaluate(() => window.localStorage.setItem('naeems.cartOpens', '3'));
  await page.reload();
  await expect(page.locator('.product-card').first()).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('glass-cart').click();
  await expect(sideCart(page)).toHaveClass(/b70-cart--open/);
  const ask = page.getByTestId('side-cart-ask');
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('Thinking about anti aging?');
  await expect(ask).toContainText('See what Naeem recommends');
  await expect(page.getByTestId('side-cart-ask-go')).toHaveText('Show me');
  await expect(page.getByTestId('side-cart-routine')).toBeVisible();
  await page.waitForTimeout(400);
  await shoot(page, 'side-cart-routine-question');

  // A finger resting on the routine row still scrolls the list up and down.
  const cdp = await page.context().newCDPSession(page);
  const rowBox = await page.locator('.b72-rcards').boundingBox();
  expect(rowBox).not.toBeNull();
  const list = page.getByTestId('side-cart-list');
  await list.evaluate((el) => {
    el.style.paddingBottom = '900px';
  });
  const y0 = await list.evaluate((el) => el.scrollTop);
  if (rowBox) {
    const x = rowBox.x + 30;
    const y = rowBox.y + rowBox.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - (200 * i) / 12 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await page.waitForTimeout(500);
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(y0 + 40);
  await expect(sideCart(page)).toHaveClass(/b70-cart--open/);
  await list.evaluate((el) => {
    el.style.paddingBottom = '';
    el.scrollTop = 0;
  });

  await page.getByTestId('side-cart-ask-go').click();
  await expect(page).toHaveURL(/\/shop\?concern=Anti%20aging$/);
  await expect(sideCart(page)).not.toHaveClass(/b70-cart--open/);
  await expect(page.getByTestId('shop-query')).toContainText('Results for Anti aging');
  await expect(page.locator('.product-card__name')).toHaveText([tagged.name]);

  await page.getByTestId('glass-cart').click();
  await expect(sideCart(page)).toHaveClass(/b70-cart--open/);
  await expect(page.getByTestId('side-cart-routine')).toBeVisible();
  await expect(page.getByTestId('side-cart-ask')).toHaveCount(0);
  expect(blocked).toEqual([]);
});

/* --------------------------------------------------------- shop and search */

test('Shop: ?concern=Acne and ?skin=Oily show only tagged products; Clear removes it; the Filter sheet has the Concern group; Shop card prices are near-black', async ({ page }) => {
  test.setTimeout(90_000);
  const [acne, oily] = await liveProducts(2);
  await phone(page);
  const blocked = await noWrites(page);
  await patchProducts(
    page,
    { [acne.id]: { skin_conditions: ['Acne'], skin_types: [] }, [oily.id]: { skin_types: ['Oily'], skin_conditions: [] } },
    { clearTags: true }
  );
  await page.goto('/shop?concern=Acne');
  await expect(page.locator('.product-card__name')).toHaveText([acne.name], { timeout: 20_000 });
  await expect(page.getByTestId('shop-query')).toContainText('Results for Acne');

  await page.goto('/shop?skin=Oily');
  await expect(page.locator('.product-card__name')).toHaveText([oily.name], { timeout: 20_000 });
  await expect(page.getByTestId('shop-query')).toContainText('Results for Oily');
  await page.getByTestId('shop-query').getByRole('button', { name: 'Clear' }).click();
  await expect(page).toHaveURL(/\/shop$/);
  await expect(page.getByTestId('shop-query')).toHaveCount(0);
  expect(await page.locator('.product-card').count()).toBeGreaterThan(2);

  // The price on a Shop card is the near-black text colour, not the accent.
  const colours = await page.evaluate(() => {
    const probe = (value: string) => {
      const el = document.createElement('span');
      el.style.color = value;
      document.body.appendChild(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    };
    const price = document.querySelector('.product-card__price:not(.product-card__price--out)');
    return {
      price: price ? getComputedStyle(price).color : 'none',
      text: probe('var(--color-text-primary)'),
      accent: probe('var(--color-accent)'),
    };
  });
  expect(colours.price).toBe(colours.text);
  expect(colours.price).not.toBe(colours.accent);
  await page.locator('.product-card').first().scrollIntoViewIfNeeded();
  const width = await page.locator('.product-card').first().evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(160);
  expect(width).toBeLessThan(190);
  await shoot(page, 'shop-cards');

  await page.getByRole('button', { name: 'Filter products' }).click();
  const sheet = page.getByRole('dialog', { name: 'Filters' });
  await expect(sheet.getByText('Concern', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Anti aging' })).toBeVisible();
  for (const t of ['Normal', 'Oily', 'Combination', 'Dry']) await expect(sheet.getByRole('button', { name: t, exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'All Skin Types' })).toHaveCount(0);
  expect(blocked).toEqual([]);
});

test('Search: "acne" finds an Acne-tagged product whose name has no "acne"', async ({ page }) => {
  test.setTimeout(60_000);
  const [tagged] = await liveProducts(1);
  await phone(page);
  await noWrites(page);
  await patchProducts(page, { [tagged.id]: { skin_conditions: ['Acne'] } });
  await page.goto('/search?q=acne');
  await expect(page.locator('.product-card__name', { hasText: tagged.name }).first()).toBeVisible({ timeout: 20_000 });
});

/* ------------------------------------------------------------ product page */

test('product page: a matching rule makes the row "Complete your routine"; with no rule and the fallback off it is "You may also like"', async ({ page }) => {
  test.setTimeout(90_000);
  const [anchor, pickA, pickB] = await liveProducts(3);
  await phone(page);
  await noWrites(page);
  await testCategories(page);
  await patchProducts(
    page,
    { [anchor.id]: { category_id: MOIST }, [pickA.id]: { category_id: CLEAN }, [pickB.id]: { category_id: CLEAN } },
    { sqlRun: true }
  );
  await settings(page, { routine_rules: JSON.stringify([{ from: MOIST, to: CLEAN }]) });
  await page.goto(`/product/${anchor.slug}`);
  const row = page.getByTestId('related-products');
  await expect(row).toHaveAttribute('data-kind', 'routine', { timeout: 20_000 });
  await expect(row.getByRole('heading', { name: 'Complete your routine' })).toBeVisible();
  expect((await row.locator('.product-card__name').allInnerTexts()).map((n) => n.trim()).sort()).toEqual([pickA.name, pickB.name].sort());
  await expect(row).not.toContainText('for your');

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await noWrites(page);
  await settings(page, { routine_rules: '[]', routine_fallback: '0' });
  await page.goto(`/product/${anchor.slug}`);
  await expect(row).toHaveAttribute('data-kind', 'related', { timeout: 20_000 });
  await expect(row.getByRole('heading', { name: 'You may also like' })).toBeVisible();
});

/* ------------------------------------------------------------------ My skin */

test('My skin: the Account row opens it; the progress fills; a 4th concern is refused; Save is off until changed and sends the 4 fields', async ({ page }) => {
  test.setTimeout(90_000);
  await phone(page);
  const blocked = await noWrites(page);
  const patches = await skinProfile(page, { skin_type: null, skin_concerns: [], skin_wants: [] });
  await signInAsTestCustomer(page);
  await page.goto('/account');
  const row = page.getByTestId('account-my-skin');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText('My skin');
  await expect(row).toContainText('Get products picked for you');
  // The first row of the list.
  await expect(page.getByTestId('account-list').locator('.b68-li').first()).toHaveAttribute('data-testid', 'account-my-skin');
  await row.click();
  await expect(page).toHaveURL(/\/my-skin$/);
  await expect(page.locator('.detail-header__title')).toHaveText('My skin');
  await expect(page.locator('.b71-nav, [data-testid="bottom-nav"]')).toHaveCount(0);

  const save = page.getByTestId('my-skin-save');
  const on = page.locator('[data-testid="my-skin-progress"] i.is-on');
  await expect(save).toHaveText('Save my skin');
  await expect(save).toBeDisabled();
  await expect(on).toHaveCount(0);

  const types = page.getByTestId('my-skin-types');
  await expect(types.locator('button')).toHaveText(['Normal', 'Oily', 'Combination', 'Dry']);
  await types.getByRole('button', { name: 'Combination' }).click();
  await expect(on).toHaveCount(1);
  await expect(save).toBeEnabled();
  // Tapping it again un-picks it.
  await types.getByRole('button', { name: 'Combination' }).click();
  await expect(on).toHaveCount(0);
  await expect(save).toBeDisabled();
  await types.getByRole('button', { name: 'Combination' }).click();

  const concerns = page.getByTestId('my-skin-concerns');
  for (const name of ['Acne', 'Hyperpigmentation', 'Redness']) await concerns.getByRole('button', { name }).click();
  await expect(on).toHaveCount(2);
  await concerns.getByRole('button', { name: 'Dark Spots' }).click();
  await expect(concerns.getByRole('button', { name: 'Dark Spots' })).toHaveAttribute('aria-pressed', 'false');
  await expect(concerns.locator('button[aria-pressed="true"]')).toHaveCount(3);

  await page.getByTestId('my-skin-wants').getByRole('button', { name: 'Glow' }).click();
  await expect(on).toHaveCount(3);
  await page.waitForTimeout(400);
  await shoot(page, 'my-skin');

  await save.click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/account$/);
  expect(patches).toHaveLength(1);
  const sent = patches[0];
  expect(sent.skin_type).toBe('Combination');
  expect(sent.skin_concerns).toEqual(['Acne', 'Hyperpigmentation', 'Redness']);
  expect(sent.skin_wants).toEqual(['Glow']);
  expect(typeof sent.skin_saved_at).toBe('string');
  expect(blocked).toEqual([]);
});

test('My skin: signed out, /my-skin lands on /account; before the SQL (no skin fields) the Account row is hidden', async ({ page }) => {
  test.setTimeout(60_000);
  await phone(page);
  await noWrites(page);
  await page.goto('/my-skin');
  await expect(page).toHaveURL(/\/account$/, { timeout: 20_000 });

  // The live profile row has no skin fields until migration-064 runs: this
  // test removes them to be sure it checks that state either way.
  await page.route(/\/rest\/v1\/profiles(\?|$)/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body: unknown = await response.json().catch(() => null);
    const strip = (r: Record<string, unknown>) => {
      const rest = { ...r };
      for (const key of ['skin_type', 'skin_concerns', 'skin_wants', 'skin_saved_at']) delete rest[key];
      return rest;
    };
    const json = Array.isArray(body) ? body.map(strip) : body && typeof body === 'object' ? strip(body as Record<string, unknown>) : body;
    await route.fulfill({ response, json });
  });
  await signInAsTestCustomer(page);
  await page.goto('/account');
  await expect(page.getByTestId('account-list')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('account-my-skin')).toHaveCount(0);
  await expect(page.getByTestId('home-picked')).toHaveCount(0);
});

/* --------------------------------------------------------------------- Home */

test('Home: a customer with a skin profile sees "Picked for you" (line, green badges) instead of Best sellers; signed out, Best sellers as before', async ({ page }) => {
  test.setTimeout(90_000);
  const picks = await liveProducts(4);
  await phone(page);
  await noWrites(page);
  await patchProducts(
    page,
    Object.fromEntries(picks.map((p, i) => [p.id, { skin_conditions: i < 3 ? ['Acne'] : [], skin_types: i === 3 ? ['Oily'] : [] }])),
    { clearTags: true }
  );
  await page.goto('/');
  await expect(page.getByTestId('home-best')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('home-picked')).toHaveCount(0);

  await skinProfile(page, { skin_type: 'Oily', skin_concerns: ['Acne'], skin_wants: [] });
  await signInAsTestCustomer(page);
  await page.goto('/');
  const picked = page.getByTestId('home-picked');
  await expect(picked).toBeVisible({ timeout: 30_000 });
  await expect(picked.locator('.b71-sec h2')).toHaveText('Picked for you');
  await expect(picked.locator('.b72-pf-line')).toHaveText('For oily skin and acne');
  await expect(picked.getByTestId('picked-card')).toHaveCount(4);
  await expect(picked.locator('.b72-why').first()).toHaveText('Acne');
  await expect(picked.locator('.b72-why').last()).toHaveText('Oily');
  await expect(page.getByTestId('home-best')).toHaveCount(0);
  // The names line up across the row.
  const tops = await picked.locator('.b71-pc__n').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  const badge = await picked.locator('.b72-why').first().evaluate((el) => getComputedStyle(el).color);
  expect(badge).toBe('rgb(31, 138, 71)');
  await picked.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -60));
  await shoot(page, 'home-picked');

  await picked.getByTestId('picked-card').first().click();
  await expect(page).toHaveURL(/\/product\//);
});

/* -------------------------------------------------------------------- Admin */

async function openEditor(page: Page, id: string): Promise<void> {
  await useSessionInPage(page, admin);
  await page.goto(`/admin/products/${id}/edit`);
  await expect(page.locator('#pf-name')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Save changes' }).first()).toBeEnabled({ timeout: 30_000 });
}

/** The product save, answered here (never reaches the shop). */
async function catchProductSave(page: Page): Promise<Record<string, unknown>[]> {
  const saves: Record<string, unknown>[] = [];
  await page.route(/\/rest\/v1\/products\?/, async (route: Route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    saves.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 204, body: '' });
  });
  return saves;
}

test('Edit product: "Where it shows" — two categories (first picked is the main one), 4 skin types, a new concern saved to the list', async ({ page }) => {
  test.setTimeout(120_000);
  const [product] = await liveProducts(1);
  await phone(page);
  const blocked = await noWrites(page);
  const settingSaves = await settings(page, {});
  const saves = await catchProductSave(page);
  await patchProducts(page, { [product.id]: { skin_conditions: ['Acne', 'Old tag'], skin_types: ['All Skin Types'] } }, { sqlRun: true });
  await openEditor(page, product.id);

  const where = page.getByTestId('pf-section-where');
  await expect(where.locator('#pf-section-where')).toHaveText('Where it shows');
  await expect(page.locator('#pf-category')).toHaveCount(0);
  await expect(page.getByTestId('pf-section-search')).toHaveCount(0);
  await expect(page.getByTestId('pf-categories-hint')).toHaveText('Pick every category it belongs to. The first one is the main category.');

  const chips = page.getByTestId('pf-categories').locator('.b72a-chip[data-id]');
  // Clear what is picked, then pick the 2nd chip and then the 1st.
  for (const chip of await chips.all()) if ((await chip.getAttribute('aria-pressed')) === 'true') await chip.click();
  const second = (await chips.nth(1).getAttribute('data-id')) ?? '';
  const first = (await chips.nth(0).getAttribute('data-id')) ?? '';
  await chips.nth(1).click();
  await chips.nth(0).click();
  await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pf-categories').locator('.b72a-chip--add')).toHaveText('+ Category');

  // "All Skin Types" reads as all four.
  const types = page.getByTestId('pf-skin-types').locator('button');
  await expect(types).toHaveText(['Normal', 'Oily', 'Combination', 'Dry']);
  await expect(page.getByTestId('pf-skin-types').locator('button[aria-pressed="true"]')).toHaveCount(4);
  await types.nth(0).click();
  await expect(types.nth(0)).toHaveAttribute('aria-pressed', 'false');

  // An old tag not in the list is kept.
  await expect(page.getByTestId('pf-concerns').locator('.b72a-chip')).toHaveText([/Acne/, /Old tag/]);
  const input = page.getByTestId('pf-concern-input');
  await expect(input).toHaveAttribute('placeholder', 'Type to find or add');
  await input.fill('hyd');
  await expect(page.getByTestId('pf-concern-suggestions').locator('button').first()).toHaveText('Hydration');
  await input.fill('E2E Pores');
  await expect(page.getByTestId('pf-concern-new')).toHaveText('+ Add "E2E Pores" as a new concern');
  await where.scrollIntoViewIfNeeded();
  await shoot(page, 'edit-product-where');
  await page.getByTestId('pf-concern-new').click();
  await expect(page.getByTestId('pf-concerns').locator('.b72a-chip')).toHaveText([/Acne/, /Old tag/, /E2E Pores/]);
  await expect(input).toHaveValue('');
  expect(settingSaves).toHaveLength(1);
  expect(JSON.parse(settingSaves[0].concern_list)).toContain('E2E Pores');

  await page.getByRole('button', { name: 'Save changes' }).first().click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].category_id).toBe(second);
  expect(saves[0].extra_category_ids).toEqual([first]);
  expect(saves[0].skin_types).toEqual(['Oily', 'Combination', 'Dry']);
  expect(saves[0].skin_conditions).toEqual(['Acne', 'Old tag', 'E2E Pores']);
  expect(blocked).toEqual([]);
});

test('Edit product before the SQL: a second category replaces the first, the hint says so, and no extra_category_ids is sent', async ({ page }) => {
  test.setTimeout(90_000);
  const [product] = await liveProducts(1);
  await phone(page);
  const blocked = await noWrites(page);
  const saves = await catchProductSave(page);
  // The live rows have no extra_category_ids until migration-064 runs;
  // removed here too so this checks that state either way.
  await page.route(/\/rest\/v1\/products_view\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) return route.fulfill({ response });
    await route.fulfill({
      response,
      json: (body as Row[]).map((r) => {
        const rest: Record<string, unknown> = { ...r };
        delete rest.extra_category_ids;
        return rest;
      }),
    });
  });
  await openEditor(page, product.id);
  await expect(page.getByTestId('pf-categories-hint')).toHaveText('Run the Batch 72 SQL to pick more than one category.');
  const chips = page.getByTestId('pf-categories').locator('.b72a-chip[data-id]');
  for (const chip of await chips.all()) if ((await chip.getAttribute('aria-pressed')) === 'true') await chip.click();
  await chips.nth(0).click();
  await chips.nth(1).click();
  await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'false');
  await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Save changes' }).first().click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].category_id).toBe(await chips.nth(1).getAttribute('data-id'));
  expect('extra_category_ids' in saves[0]).toBe(false);
  expect(blocked).toEqual([]);
});

test('Admin "Complete your routine": add a rule, a same-to-same rule is refused, save; the fallback switch; add a question', async ({ page }) => {
  test.setTimeout(90_000);
  await phone(page);
  const blocked = await noWrites(page);
  const saves = await settings(page, {});
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=design&dset=routine');
  const panel = page.getByTestId('routine-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const rules = page.getByTestId('routine-rules');
  await expect(rules.locator('h4')).toHaveText('When the cart has…');
  await expect(rules.locator('.b72a-hint')).toHaveText('…suggest products from this category.');
  const saveRules = rules.getByRole('button', { name: 'Save' });
  await expect(saveRules).toBeDisabled();

  const before = await page.getByTestId('routine-rule').count();
  await rules.getByRole('button', { name: '+ Add rule' }).click();
  const row = page.getByTestId('routine-rule').nth(before);
  const from = row.locator('select').nth(0);
  const to = row.locator('select').nth(1);
  await expect(saveRules).toBeEnabled();
  const fromValue = await from.inputValue();
  await to.selectOption(fromValue);
  await saveRules.click();
  await expect(page.getByText('Pick two different categories.')).toBeVisible();
  expect(saves).toHaveLength(0);
  const options = await to.locator('option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));
  await to.selectOption(options.find((v) => v !== fromValue) ?? '');
  expect(await to.inputValue()).not.toBe(fromValue);
  await saveRules.click();
  await expect.poll(() => saves.length).toBe(1);
  const savedRules = JSON.parse(saves[0].routine_rules) as { from: string; to: string }[];
  expect(savedRules[savedRules.length - 1]).toEqual({ from: await from.inputValue(), to: await to.inputValue() });

  const fallback = page.getByTestId('routine-fallback');
  await expect(fallback).toContainText('Same concern or brand');
  await expect(fallback).toContainText('picks similar products by itself');
  const sw = fallback.getByRole('switch', { name: 'Same concern or brand' });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]).toEqual({ routine_fallback: '0' });
  await expect(sw).toHaveAttribute('aria-checked', 'false');

  const questions = page.getByTestId('routine-questions');
  await expect(questions.locator('.b72a-hint')).toHaveText('Shown about once in every 3 to 4 cart opens.');
  await expect(page.getByTestId('routine-question')).toHaveCount(0);
  await questions.getByRole('button', { name: '+ Add question' }).click();
  const q = page.getByTestId('routine-question').first();
  await q.getByRole('textbox', { name: 'Question' }).fill('Thinking about anti aging?');
  await expect(q).toContainText('Concern to show:');
  await q.getByRole('combobox', { name: 'Concern to show' }).selectOption('Anti aging');
  await questions.getByRole('button', { name: '+ Add question' }).click();
  await questions.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => saves.length).toBe(3);
  expect(JSON.parse(saves[2].routine_questions)).toEqual([{ text: 'Thinking about anti aging?', concern: 'Anti aging' }]);
  await page.waitForTimeout(400);
  await panel.scrollIntoViewIfNeeded();
  await shoot(page, 'admin-routine');
  expect(blocked).toEqual([]);
});
