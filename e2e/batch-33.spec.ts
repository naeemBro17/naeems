import { mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import type { Browser, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD, SUPABASE_ANON_KEY, SUPABASE_URL } from './helpers/env';
import {
  insert,
  passwordSession,
  placeTestOrder,
  remove,
  rpc,
  select,
  useSessionInPage,
  type TestSession,
} from './helpers/api';
import { signInAsTestCustomer } from './helpers/auth';

// Batch 33 (reports/batch-33.txt). Everything here uses its own test
// products (names start with PREFIX): created in beforeAll, deleted in
// afterAll with their uploaded photos and the test orders. Real products,
// orders and photos are never touched.

test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.describe.configure({ mode: 'serial' });

const PREFIX = 'E2E B33';
const SHOTS = 'reports/batch-33-screens';
const BUCKET = 'product-images';

let admin: TestSession;
let customer: TestSession;
let categoryId = '';
const createdOrderIds: string[] = [];
/** Test product id → its photos as saved (full URLs). */
let imageProductId = '';
let savedUrls: string[] = [];

const ADDRESS = {
  zoneId: 'inside_dhaka',
  address: {
    fullName: 'E2E Test Customer',
    phone: '01712345678',
    division: 'Dhaka',
    district: 'Dhaka',
    thana: 'Gulshan',
    fullAddress: '123 Test Road (e2e)',
  },
  promo: null,
  lastOrder: null,
};

function png(r: number, g: number, b: number): Buffer {
  const img = new PNG({ width: 64, height: 64 });
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = r;
    img.data[i + 1] = g;
    img.data[i + 2] = b;
    img.data[i + 3] = 255;
  }
  return PNG.sync.write(img);
}

const file = (name: string, buf: Buffer) => ({ name, mimeType: 'image/png', buffer: buf });

async function makeProduct(n: number, stock: number, active: boolean, price = 1000): Promise<{ id: string; name: string }> {
  const stamp = `${n}-${Date.now() % 1_000_000}`;
  const name = `${PREFIX} Product ${stamp}`;
  const res = await insert(
    admin.accessToken,
    'products',
    {
      sku: `E2E-B33-${stamp}`,
      slug: `e2e-b33-${stamp}`,
      name,
      category_id: categoryId,
      retail_price: price,
      stock_status: 'in_stock',
      stock_quantity: stock,
      is_active: active,
    },
    false
  );
  expect(res.ok, res.error ?? '').toBe(true);
  const row = await select<{ id: string }[]>(admin.accessToken, `products?select=id&sku=eq.E2E-B33-${stamp}`);
  return { id: row.data![0].id, name };
}

/** Sets the test product's photo list (no row back: the wholesale price
 *  column cannot be read, even by admins). */
async function setImages(patch: { image_urls: string[] }): Promise<{ ok: boolean; error: string | null }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${imageProductId}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${admin.accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  return { ok: res.ok, error: res.ok ? null : await res.text() };
}

function storagePath(url: string | null): string | null {
  return url?.split(`/object/public/${BUCKET}/`)[1]?.split('?')[0] ?? null;
}

async function cleanUp(): Promise<void> {
  if (createdOrderIds.length > 0) {
    await rpc(admin.accessToken, 'admin_open_delete_lock', { p_seconds: 60 });
    await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: createdOrderIds });
    await rpc(admin.accessToken, 'admin_close_delete_lock');
    createdOrderIds.length = 0;
  }
  const rows = await select<{ id: string; image_urls: string[] | null; image_urls_thumb: string[] | null }[]>(
    admin.accessToken,
    `products?select=id,image_urls,image_urls_thumb&name=like.${encodeURIComponent(PREFIX)}*`
  );
  const paths: string[] = [];
  for (const p of rows.data ?? []) {
    for (const u of [...(p.image_urls ?? []), ...(p.image_urls_thumb ?? [])]) {
      const path = storagePath(u);
      if (path && path.startsWith('products/')) paths.push(path);
    }
    await remove(admin.accessToken, `products?id=eq.${p.id}`);
  }
  if (paths.length > 0) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${admin.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths }),
    });
  }
}

test.beforeAll(async () => {
  test.setTimeout(60_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  const cats = await select<{ id: string }[]>(null, 'categories?select=id&limit=1');
  categoryId = cats.data![0].id;
  await cleanUp();
  mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  await cleanUp();
});

/* ---------------------------------------------------------------- Part 1 */

const items = (page: Page) => page.getByTestId('image-uploader-item');

/** The storage file id (uuid) each thumbnail shows, in row order. */
async function rowOrder(page: Page): Promise<string[]> {
  return items(page).evaluateAll((lis) =>
    lis.map((li) => {
      const src = li.querySelector('img')?.getAttribute('src') ?? '';
      return src.match(/([0-9a-f-]{36})\.webp/)?.[1] ?? src;
    })
  );
}

const uuidOf = (url: string) => url.match(/([0-9a-f-]{36})\.webp/)![1];

async function openEditor(page: Page): Promise<void> {
  await useSessionInPage(page, admin);
  await page.goto(`/admin/products/${imageProductId}/edit`);
  await expect(page.getByTestId('product-page')).toBeVisible({ timeout: 20_000 });
}

async function expectAllLoaded(page: Page, count: number): Promise<void> {
  await expect(items(page)).toHaveCount(count);
  await expect
    .poll(
      () =>
        items(page)
          .locator('img')
          .evaluateAll((imgs) => (imgs as HTMLImageElement[]).filter((i) => i.complete && i.naturalWidth > 0).length),
      { timeout: 15_000 }
    )
    .toBe(count);
  await expect(page.getByTestId('image-uploader-placeholder')).toHaveCount(0);
  // Pointer and touch input only reach what is on screen.
  await items(page).first().scrollIntoViewIfNeeded();
}

async function saveAndRead(page: Page): Promise<{ urls: string[]; thumbs: string[] }> {
  await page.getByRole('button', { name: 'Save changes' }).click();
  // Rich-text editor fix Part 3: Save now stays on the Edit page and says
  // "Saved ✓" (it used to go back to the list).
  await expect(page.getByText('Saved ✓')).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/edit$/);
  const row = await select<{ image_urls: string[]; image_urls_thumb: string[] }[]>(
    admin.accessToken,
    `products?select=image_urls,image_urls_thumb&id=eq.${imageProductId}`
  );
  return { urls: row.data![0].image_urls, thumbs: row.data![0].image_urls_thumb ?? [] };
}

function expectThumbsLinked(saved: { urls: string[]; thumbs: string[] }): void {
  expect(saved.thumbs).toHaveLength(saved.urls.length);
  saved.urls.forEach((u, i) => {
    expect(storagePath(saved.thumbs[i])).toBe(`products/thumb/${uuidOf(u)}.webp`);
  });
}

test('Part 1: add 2 photos, then a 3rd — all three previews are real images, "Main" on the first, saved in order', async ({ page }) => {
  test.setTimeout(90_000);
  imageProductId = (await makeProduct(1, 5, false)).id;
  await openEditor(page);
  const input = page.getByLabel('Choose product image files');
  await input.setInputFiles([file('red.png', png(220, 40, 40)), file('green.png', png(40, 180, 60))]);
  await expectAllLoaded(page, 2);
  await input.setInputFiles([file('blue.png', png(40, 70, 220))]);
  await expectAllLoaded(page, 3);
  await expect(items(page).first().getByText('Main', { exact: true })).toBeVisible();
  await expect(page.getByText('Main', { exact: true })).toHaveCount(1);
  // Never the browser's broken-image icon.
  const broken = await page.locator('.image-uploader img').evaluateAll(
    (imgs) => (imgs as HTMLImageElement[]).filter((i) => i.complete && i.naturalWidth === 0).length
  );
  expect(broken).toBe(0);

  const saved = await saveAndRead(page);
  expect(saved.urls).toHaveLength(3);
  expectThumbsLinked(saved);
  savedUrls = saved.urls;
});

test.describe('Part 1 on PC (mouse)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('drag with the mouse reorders the photos and the order is saved', async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(savedUrls.length !== 3, 'Needs the photos saved by the first Part 1 test.');
    await openEditor(page);
    await expectAllLoaded(page, 3);
    const [r, g, b] = savedUrls.map(uuidOf);
    expect(await rowOrder(page)).toEqual([r, g, b]);

    const from = (await items(page).nth(2).boundingBox())!;
    const to = (await items(page).nth(0).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 - 12, from.y + from.height / 2, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2 - 10, to.y + to.height / 2, { steps: 15 });
    await page.waitForTimeout(250);
    await page.mouse.up();
    await expect.poll(() => rowOrder(page)).toEqual([b, r, g]);
    await expect(items(page).first().getByText('Main', { exact: true })).toBeVisible();

    const saved = await saveAndRead(page);
    expect(saved.urls.map(uuidOf)).toEqual([b, r, g]);
    expectThumbsLinked(saved);
    savedUrls = saved.urls;
  });

  test('keyboard: space, arrow, space moves a photo', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(savedUrls.length !== 3, 'Needs the photos saved by the first Part 1 test.');
    await openEditor(page);
    await expectAllLoaded(page, 3);
    const [x, y, z] = savedUrls.map(uuidOf);
    await items(page).first().focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    await page.keyboard.press('Space');
    await expect.poll(() => rowOrder(page)).toEqual([y, x, z]);
  });
});

test('Part 1 on a phone (touch): long-press and drag reorders; a quick swipe does not', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(savedUrls.length !== 3, 'Needs the photos saved by the first Part 1 test.');
  await openEditor(page);
  await expectAllLoaded(page, 3);
  const [first, second, third] = savedUrls.map(uuidOf);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });

  const a = (await items(page).nth(0).boundingBox())!;
  const c = (await items(page).nth(2).boundingBox())!;
  const ay = a.y + a.height / 2;

  // A quick swipe (no hold) never lifts a photo.
  await touch('touchStart', a.x + a.width / 2, ay);
  for (let i = 1; i <= 6; i += 1) await touch('touchMove', a.x + a.width / 2 + i * 15, ay);
  await touch('touchEnd', 0, 0);
  await page.waitForTimeout(300);
  expect(await rowOrder(page)).toEqual([first, second, third]);

  // Hold ~300 ms, then drag the first photo to the end.
  await touch('touchStart', a.x + a.width / 2, ay);
  await page.waitForTimeout(350);
  const steps = 15;
  const endX = c.x + c.width / 2 + 10;
  for (let i = 1; i <= steps; i += 1) {
    await touch('touchMove', a.x + a.width / 2 + ((endX - (a.x + a.width / 2)) * i) / steps, ay);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(250);
  await touch('touchEnd', 0, 0);
  await expect.poll(() => rowOrder(page)).toEqual([second, third, first]);

  const saved = await saveAndRead(page);
  expect(saved.urls.map(uuidOf)).toEqual([second, third, first]);
  expectThumbsLinked(saved);
  savedUrls = saved.urls;
});

test('Part 1: a photo that cannot load shows a placeholder with Retry, never a broken image', async ({ page }) => {
  test.setTimeout(60_000);
  test.skip(savedUrls.length !== 3, 'Needs the photos saved by the first Part 1 test.');
  const missing = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/products/e2e-b33-missing-${Date.now()}.webp`;
  const res = await setImages({
    image_urls: [...savedUrls, missing],
  });
  expect(res.ok, res.error ?? '').toBe(true);
  await openEditor(page);
  await expect(items(page)).toHaveCount(4);
  const placeholder = page.getByTestId('image-uploader-placeholder');
  await expect(placeholder).toHaveCount(1, { timeout: 15_000 });
  await expect(placeholder.getByRole('button', { name: /did not load — retry/ })).toBeVisible();
  const broken = await page.locator('.image-uploader img').evaluateAll(
    (imgs) => (imgs as HTMLImageElement[]).filter((i) => i.complete && i.naturalWidth === 0).length
  );
  expect(broken).toBe(0);
  // Retry asks again (still missing here) and comes back to the placeholder.
  await placeholder.getByRole('button', { name: /retry/ }).click();
  await expect(page.getByTestId('image-uploader-placeholder')).toHaveCount(1, { timeout: 15_000 });
  // Put the saved photos back as they were.
  await setImages({ image_urls: savedUrls });
});

/* ---------------------------------------------------------------- Part 2 */

test('Part 2: the search ring follows the rounded field; a tap draws no square box; tap highlight transparent', async ({ page }) => {
  await page.goto('/search');
  const input = page.locator('.search-bar__input').first();
  await expect(input).toBeVisible({ timeout: 15_000 });

  const look = () =>
    input.evaluate((el) => {
      const s = getComputedStyle(el);
      const wrap = getComputedStyle(el.closest('.search-bar') as HTMLElement);
      return {
        ring: s.boxShadow,
        radius: s.borderTopLeftRadius,
        outline: s.outlineStyle,
        wrapShadow: wrap.boxShadow,
        wrapRadius: wrap.borderTopLeftRadius,
      };
    });

  // Keyboard focus: the ring is drawn by the field itself, so its corners
  // are the field's own; the square wrapper draws nothing.
  await page.keyboard.press('Shift');
  await input.focus();
  const kb = await look();
  expect(kb.ring).toContain('rgba(255, 122, 69');
  expect(kb.radius).toBe('13px');
  expect(kb.wrapShadow).toBe('none');

  // Tap: still no square box.
  await input.blur();
  await input.tap();
  const tapped = await look();
  expect(tapped.wrapShadow).toBe('none');
  expect(tapped.outline).toBe('none');

  const tap = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('-webkit-tap-highlight-color'));
  expect(tap.replace(/\s/g, '')).toMatch(/^(transparent|rgba\(0,0,0,0\))$/);
});

test.describe('Part 2 with a mouse', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('a click shows no outline; the keyboard ring is rounded on plain links', async ({ page }) => {
    await page.goto('/search');
    const input = page.locator('.search-bar__input').first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    // A plain button clicked with the mouse: focused, but no outline.
    const button = page.locator('main button, header button').first();
    await button.evaluate((el) => el.addEventListener('click', (e) => e.preventDefault(), { capture: true }));
    await page.mouse.click(1, 1);
    const box = (await button.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const clicked = await button.evaluate((el) => ({
      focusVisible: el.matches(':focus-visible'),
      outline: getComputedStyle(el).outlineStyle,
    }));
    await page.mouse.up();
    if (!clicked.focusVisible) expect(clicked.outline).toBe('none');

    // Keyboard on a plain text link with no corners of its own: rounded ring.
    await page.goto('/');
    const link = page.locator('.brand-row__all').first();
    if ((await link.count()) > 0) {
      // Batch 34: the ring follows real focus-moving keys (Tab), not Shift.
      await page.keyboard.press('Tab');
      await link.focus();
      const ring = await link.evaluate((el) => ({
        outline: getComputedStyle(el).outlineStyle,
        radius: getComputedStyle(el).borderTopLeftRadius,
      }));
      expect(ring.outline).toBe('solid');
      expect(ring.radius).toBe('8px');
    }
  });
});

/* ---------------------------------------------------------------- Part 3 */

async function seedCart(page: Page, lines: { id: string; quantity: number; price: number }[]): Promise<void> {
  const cart = lines.map((l) => ({ productId: l.id, variantId: null, variantLabel: null, quantity: l.quantity, priceAtAdd: l.price }));
  await page.addInitScript(
    ([c, s]) => {
      if (window.sessionStorage.getItem('e2e-b33-seeded')) return;
      window.sessionStorage.setItem('e2e-b33-seeded', '1');
      window.localStorage.setItem('nph_cart', c);
      window.sessionStorage.setItem('nph_checkout_state', s);
    },
    [JSON.stringify(cart), JSON.stringify(ADDRESS)]
  );
}

async function totalShown(page: Page): Promise<number> {
  const text = await page.locator('.checkout-summary-card__row--total span').last().innerText();
  return Number(text.replace(/[^0-9.]/g, ''));
}

test('Part 3: two carts, one last unit — the second gets "just sold out", the line goes, totals follow', async ({ page }) => {
  test.setTimeout(90_000);
  const last = await makeProduct(31, 1, true, 1500);
  const other = await makeProduct(32, 5, true, 700);
  await signInAsTestCustomer(page);
  await seedCart(page, [
    { id: last.id, quantity: 1, price: 1500 },
    { id: other.id, quantity: 1, price: 700 },
  ]);
  await page.goto('/checkout/summary');
  await expect(page.getByRole('button', { name: /Place order/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('stock-notice')).toHaveCount(0);
  const before = await totalShown(page);

  // Someone else buys the last unit first.
  const first = await placeTestOrder(customer.accessToken, last.id, 1);
  createdOrderIds.push(first.id);

  await page.getByRole('button', { name: /Place order/i }).click();
  const notice = page.getByTestId('stock-notice');
  await expect(notice).toContainText(`Sorry, ${last.name} just sold out.`, { timeout: 15_000 });
  await expect(notice).toContainText("We've updated your cart.");
  await expect(page.locator('.checkout-summary-page__error')).toHaveCount(0);
  const lines = page.locator('.checkout-summary-card__item');
  await expect(lines.filter({ hasText: last.name })).toHaveCount(0);
  await expect(lines.filter({ hasText: other.name })).toHaveCount(1);
  await expect.poll(() => totalShown(page)).toBe(before - 1500);
  await expect(page.getByText(/left in stock|out of stock/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Place order/i })).toBeEnabled();
});

test('Part 3: fewer left than in the cart — "Only 1 left", quantity lowered (cart page check on open)', async ({ page }) => {
  test.setTimeout(60_000);
  const few = await makeProduct(33, 3, true, 900);
  await signInAsTestCustomer(page);
  await seedCart(page, [{ id: few.id, quantity: 3, price: 900 }]);
  const order = await placeTestOrder(customer.accessToken, few.id, 2);
  createdOrderIds.push(order.id);

  await page.goto('/cart');
  const notice = page.getByTestId('stock-notice');
  await expect(notice).toContainText(`Only 1 left of ${few.name}`, { timeout: 20_000 });
  await expect(notice).toContainText("we've updated the quantity");
  await expect(page.locator('.checkout-cart__step-count').first()).toHaveText('1');
  await notice.getByRole('button', { name: 'Close message' }).click();
  await expect(notice).toHaveCount(0);
});

test('Part 3: admin New order — the line itself says it sold out', async ({ page }) => {
  test.setTimeout(90_000);
  const one = await makeProduct(34, 1, true, 1200);
  await useSessionInPage(page, admin);
  await page.goto('/admin/orders/new');
  const form = page.getByTestId('new-order-page');
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.getByRole('button', { name: 'Phone call', exact: true }).click();
  await page.locator('#manual-order-name').fill('E2E B33 Stock Race');
  await page.locator('#manual-order-phone').fill('01799990033');
  await page.locator('#manual-order-division').click();
  await page.getByPlaceholder('Search division...').fill('Dhaka');
  await page.locator('.picker-sheet__row', { hasText: /^Dhaka$/ }).first().click();
  await page.locator('#manual-order-district').click();
  await page.getByPlaceholder('Search district...').fill('Dhaka');
  await page.locator('.picker-sheet__row', { hasText: /^Dhaka$/ }).first().click();
  await page.locator('#manual-order-address').fill('House 33, Road 3 (e2e)');
  await page.getByPlaceholder('Search product name...').fill(one.name);
  await page.locator('.picker-sheet__row').filter({ hasText: one.name }).first().click();
  await expect(page.getByTestId('line-stock-error')).toHaveCount(0);

  // A website customer buys the last one while the form is open.
  const order = await placeTestOrder(customer.accessToken, one.id, 1);
  createdOrderIds.push(order.id);

  await form.getByRole('button', { name: 'Create order' }).click();
  await expect(page.getByText('Low stock')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByTestId('line-stock-error')).toHaveText('Sold out — none left in stock');
});

/* ----------------------------------------------------------- Screenshots */

async function shotContext(browser: Browser, width: number, theme: 'light' | 'dark') {
  const phone = width < 600;
  const context = await browser.newContext({
    viewport: { width, height: phone ? 844 : 900 },
    deviceScaleFactor: phone ? 2 : 1,
    isMobile: phone,
    hasTouch: phone,
    colorScheme: theme,
  });
  const page = await context.newPage();
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  return { context, page };
}

test('Screenshots: photos row (Main, dragging), search focus (keyboard, tap), "just sold out"', async ({ browser }) => {
  test.setTimeout(240_000);
  test.skip(savedUrls.length !== 3, 'Needs the photos saved by the first Part 1 test.');
  const sold = await makeProduct(35, 1, true, 1100);
  const keep = await makeProduct(36, 5, true, 600);
  const order = await placeTestOrder(customer.accessToken, sold.id, 1);
  createdOrderIds.push(order.id);

  for (const width of [390, 1280]) {
    for (const theme of ['light', 'dark'] as const) {
      const tag = `${width}-${theme}`;
      const { context, page } = await shotContext(browser, width, theme);

      await openEditor(page);
      await expectAllLoaded(page, 3);
      const row = page.locator('.image-uploader');
      await row.scrollIntoViewIfNeeded();
      await row.screenshot({ path: `${SHOTS}/images-row-main-${tag}.png` });
      // Mid-drag (mouse on PC; the phone uses the same lifted look).
      const a = (await items(page).nth(0).boundingBox())!;
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(a.x + a.width / 2 + 60, a.y + a.height / 2, { steps: 8 });
      await page.waitForTimeout(300);
      await row.screenshot({ path: `${SHOTS}/images-row-dragging-${tag}.png` });
      await page.keyboard.press('Escape');
      await page.mouse.up();

      await page.goto('/search');
      const input = page.locator('.search-bar__input').first();
      await expect(input).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press('Shift');
      await input.focus();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}/search-focus-keyboard-${tag}.png` });
      await input.blur();
      if (width < 600) await input.tap();
      else await input.click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}/search-focus-tapped-${tag}.png` });

      await context.close();

      const shop = await shotContext(browser, width, theme);
      await signInAsTestCustomer(shop.page);
      await seedCart(shop.page, [
        { id: sold.id, quantity: 1, price: 1100 },
        { id: keep.id, quantity: 1, price: 600 },
      ]);
      await shop.page.goto('/cart');
      await expect(shop.page.getByTestId('stock-notice')).toBeVisible({ timeout: 20_000 });
      await shop.page.waitForTimeout(300);
      await shop.page.screenshot({ path: `${SHOTS}/just-sold-out-${tag}.png` });
      await shop.context.close();
    }
  }
});
