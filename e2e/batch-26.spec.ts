import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_MOD_PASSWORD, E2E_PASSWORD, SUPABASE_ANON_KEY, SUPABASE_URL } from './helpers/env';
import {
  callFunction,
  insert,
  passwordSession,
  placeTestOrder,
  remove,
  rpc,
  select,
  update,
  useSessionInPage,
  type TestSession,
} from './helpers/api';

// Batch 26: brands (Home row, /brands, /brand/<slug>, admin Brands tab,
// who may change them) and the three admin extras (Restock, the 7-day
// sales chart, private customer notes and tags). Uses the test Super
// Admin, a throwaway staff login with its own role, and the test customer.
// Everything it creates (brands, products, orders, notes, uploads) is
// removed in afterAll.

const STAFF_USERNAME = 'e2e.role26';
const ROLE_NAME = 'E2E Batch26 role';
const PREFIX = 'E2E Brand';
const ALPHA = { name: 'E2E Brand Alpha', slug: 'e2e-brand-alpha' };
const HIDDEN = { name: 'E2E Brand Hidden', slug: 'e2e-brand-hidden' };
const EMPTY = { name: 'E2E Brand Empty', slug: 'e2e-brand-empty' };
const UPLOADED = 'E2E Brand Upload';
const TAG_VIP = 'E2E VIP';
const TAG_FAMILY = 'E2E Family';

const svg = (fill: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect x="20" y="30" width="160" height="40" fill="${fill}"/></svg>`)}`;
const LOGO_LIGHT = svg('#111111');
const LOGO_DARK = svg('#ffffff');
const BANNER = svg('#cccccc');

test.describe.configure({ mode: 'serial' });

test.skip(
  !E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_MOD_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD,
  'Needs the test accounts in .env.e2e (see reports/batch-24.txt).'
);

let admin: TestSession;
let customer: TestSession;
let staffId = '';
let roleId = '';
const brandIds: Record<string, string> = {};
const productIds: string[] = [];
let variantId = '';
let categoryA = { id: '', name: '', slug: '' };
let categoryB = { id: '', name: '', slug: '' };
const orderIds: string[] = [];

async function staffSession(): Promise<TestSession> {
  return passwordSession(`${STAFF_USERNAME}@staff.naeems.internal`, E2E_MOD_PASSWORD);
}

async function setRole(permissions: string[]): Promise<void> {
  const res = await rpc<string>(admin.accessToken, 'admin_role_save', { p_id: roleId, p_name: ROLE_NAME, p_permissions: permissions });
  expect(res.ok, res.error ?? '').toBe(true);
}

async function storageRemove(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await fetch(`${SUPABASE_URL}/storage/v1/object/brand-media`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${admin.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: paths }),
  });
}

async function cleanUp(): Promise<void> {
  // Test products (and their options), then the test brands and their uploads.
  const products = await select<{ id: string }[]>(admin.accessToken, `products?select=id&name=like.${encodeURIComponent(PREFIX)}*`);
  for (const p of products.data ?? []) {
    await remove(admin.accessToken, `product_variants?product_id=eq.${p.id}`);
    await remove(admin.accessToken, `products?id=eq.${p.id}`);
  }
  const brands = await select<{ id: string; logo_url: string | null }[]>(
    admin.accessToken,
    `brands?select=id,logo_url&name=like.${encodeURIComponent(PREFIX)}*`
  );
  const uploads = (brands.data ?? [])
    .map((b) => b.logo_url?.split('/object/public/brand-media/')[1]?.split('?')[0])
    .filter((p): p is string => Boolean(p));
  await storageRemove(uploads);
  await remove(admin.accessToken, `brands?name=like.${encodeURIComponent(PREFIX)}*`);

  const team = await rpc<{ id: string; username: string }[]>(admin.accessToken, 'admin_team_list');
  for (const member of team.data ?? []) {
    if (member.username === STAFF_USERNAME) await callFunction(admin.accessToken, 'admin-team', { action: 'delete', userId: member.id });
  }
  const roles = await rpc<{ id: string; name: string }[]>(admin.accessToken, 'admin_role_list');
  for (const role of roles.data ?? []) {
    if (role.name === ROLE_NAME) await rpc(admin.accessToken, 'admin_role_delete', { p_id: role.id });
  }
  if (customer) await rpc(admin.accessToken, 'admin_set_customer_note', { p_customer_id: customer.userId, p_note: '', p_tags: [] });
}

async function makeProduct(n: number, brandId: string, categoryId: string, stock: number): Promise<string> {
  const sku = `E2E-B26-${n}-${Date.now() % 100000}`;
  // No row back: the wholesale price column can't be read, even by admins.
  const res = await insert(admin.accessToken, 'products', {
    sku,
    slug: `e2e-brand-test-${n}-${Date.now() % 100000}`,
    name: `${PREFIX} Test Product ${n}`,
    category_id: categoryId,
    retail_price: 1000 + n,
    stock_status: 'in_stock',
    stock_quantity: stock,
    brand_id: brandId,
    is_active: true,
  }, false);
  expect(res.ok, res.error ?? '').toBe(true);
  const row = await select<{ id: string }[]>(admin.accessToken, `products?select=id&sku=eq.${sku}`);
  return row.data![0].id;
}

async function adminPage(page: Page, query: string): Promise<void> {
  await useSessionInPage(page, admin);
  await page.goto(`/admin${query}`);
}

/** Dhaka calendar date of a timestamp. */
function dhakaDay(iso: string): string {
  return new Date(new Date(iso).getTime() + 6 * 3600_000).toISOString().slice(0, 10);
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
  await cleanUp();

  const cats = await select<{ id: string; name: string; slug: string }[]>(null, 'categories?select=id,name,slug&order=name');
  expect((cats.data ?? []).length).toBeGreaterThanOrEqual(2);
  [categoryA, categoryB] = cats.data!;

  const brands = await insert<{ id: string; name: string }[]>(admin.accessToken, 'brands', [
    { ...ALPHA, show_on_home: true, display_order: -100, logo_url: LOGO_LIGHT, logo_dark_url: LOGO_DARK, banner_image_url: BANNER },
    { ...HIDDEN, show_on_home: false, display_order: -99, logo_url: null, logo_dark_url: null, banner_image_url: null },
    { ...EMPTY, show_on_home: true, display_order: -98, logo_url: null, logo_dark_url: null, banner_image_url: null },
  ]);
  expect(brands.ok, brands.error ?? '').toBe(true);
  for (const b of brands.data!) brandIds[b.name] = b.id;

  productIds.push(await makeProduct(1, brandIds[ALPHA.name], categoryA.id, 5));
  productIds.push(await makeProduct(2, brandIds[ALPHA.name], categoryB.id, 20));
  productIds.push(await makeProduct(3, brandIds[HIDDEN.name], categoryA.id, 5));
  const variant = await insert(admin.accessToken, 'product_variants', {
    product_id: productIds[0],
    region: 'E2E',
    size: '50ml',
    retail_price: 1500,
    in_stock: true,
    stock_quantity: 3,
    sort_order: 1,
  }, false);
  expect(variant.ok, variant.error ?? '').toBe(true);
  const variantRow = await select<{ id: string }[]>(admin.accessToken, 'product_variants?select=id&product_id=eq.' + productIds[0]);
  variantId = variantRow.data![0].id;

  const role = await rpc<string>(admin.accessToken, 'admin_role_save', { p_id: null, p_name: ROLE_NAME, p_permissions: ['view_orders'] });
  expect(role.ok, role.error ?? '').toBe(true);
  roleId = role.data!;
  const created = await callFunction<{ ok: boolean; userId?: string; error?: string }>(admin.accessToken, 'admin-team', {
    action: 'create',
    username: STAFF_USERNAME,
    fullName: 'E2E Brands Tester',
    phone: '01700000026',
    password: E2E_MOD_PASSWORD,
  });
  expect(created.ok, created.error).toBe(true);
  staffId = created.userId!;
  const assigned = await rpc(admin.accessToken, 'admin_team_set_role', { p_user_id: staffId, p_role_id: roleId });
  expect(assigned.ok, assigned.error ?? '').toBe(true);
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  if (orderIds.length > 0) {
    await rpc(admin.accessToken, 'admin_delete_orders', { p_order_ids: orderIds });
  }
  await cleanUp();
});

/* ---------------- Shop ---------------- */

for (const theme of ['light', 'dark'] as const) {
  test(`Home: "Shop by Brand" sits between the bento and the chips, ${theme} logo (${theme} mode)`, async ({ page }) => {
    await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
    await page.goto('/');
    const card = page.locator(`[data-testid="brand-row"] [data-brand-slug="${ALPHA.slug}"]`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="brand-row"] .brand-row__title')).toHaveText('Shop by Brand');
    await expect(page.locator('[data-testid="brand-row"] .brand-row__all')).toContainText('See all');

    const bento = await page.locator('[data-section="bento"]').boundingBox();
    const row = await page.locator('[data-testid="brand-row"]').boundingBox();
    const chips = await page.locator('[data-section="chips"] .home-chips').boundingBox();
    expect(bento && row && chips).toBeTruthy();
    expect(row!.y).toBeGreaterThanOrEqual(bento!.y + bento!.height - 1);
    expect(chips!.y).toBeGreaterThanOrEqual(row!.y + row!.height - 1);

    const img = card.locator('img');
    await expect(img).toHaveAttribute('src', theme === 'dark' ? LOGO_DARK : LOGO_LIGHT);
    await expect(img).toHaveAttribute('loading', 'lazy');
    await expect(card).toHaveClass(new RegExp(`brand-card--${theme}`));

    // "Show on home" off, or no live products: not in the row.
    await expect(page.locator(`[data-testid="brand-row"] [data-brand-slug="${HIDDEN.slug}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="brand-row"] [data-brand-slug="${EMPTY.slug}"]`)).toHaveCount(0);

    // About 2.5 cards across a phone.
    const cardBox = await card.boundingBox();
    const viewport = page.viewportSize()!;
    expect(viewport.width / cardBox!.width).toBeGreaterThan(2.2);
    expect(viewport.width / cardBox!.width).toBeLessThan(2.9);
  });
}

test('dark mode without a white logo: the normal logo on a light card', async ({ page }) => {
  await update(admin.accessToken, `brands?id=eq.${brandIds[ALPHA.name]}`, { logo_dark_url: null });
  await page.addInitScript(() => window.localStorage.setItem('theme', 'dark'));
  await page.goto('/');
  const card = page.locator(`[data-testid="brand-row"] [data-brand-slug="${ALPHA.slug}"]`);
  await expect(card).toHaveClass(/brand-card--light/, { timeout: 15_000 });
  await expect(card.locator('img')).toHaveAttribute('src', LOGO_LIGHT);
  await update(admin.accessToken, `brands?id=eq.${brandIds[ALPHA.name]}`, { logo_dark_url: LOGO_DARK });
});

test('See all → /brands → a brand → only that brand’s products; unknown brand is friendly', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-testid="brand-row"] .brand-row__all').click();
  await expect(page).toHaveURL(/\/brands$/);
  await expect(page.locator('.detail-header__title')).toHaveText('Brands');
  const item = page.locator('.brands-grid__item', { has: page.locator(`[data-brand-slug="${ALPHA.slug}"]`) });
  await expect(item.locator('.brands-grid__name')).toHaveText(ALPHA.name);
  await expect(item.locator('.brands-grid__count')).toHaveText('2 products');
  // A brand with no live products is not listed.
  await expect(page.locator(`[data-brand-slug="${EMPTY.slug}"]`)).toHaveCount(0);

  await item.locator('[data-testid="brand-card"]').click();
  await expect(page).toHaveURL(new RegExp(`/brand/${ALPHA.slug}$`));
  await expect(page.locator('.brand-page__name')).toHaveText(ALPHA.name);
  await expect(page.locator('[data-testid="brand-count"]')).toHaveText('2 products');
  const names = await page.locator('.product-card .product-card__name').allInnerTexts();
  expect(names.sort()).toEqual([`${PREFIX} Test Product 1`, `${PREFIX} Test Product 2`]);
  await expect(page).toHaveTitle(`${ALPHA.name} — Naeem's`);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', `${ALPHA.name} — Naeem's`);

  // Back returns to /brands, then Home.
  await page.locator('.detail-header__back').click();
  await expect(page).toHaveURL(/\/brands$/);

  await page.goto('/brand/no-such-brand-e2e');
  await expect(page.locator('[data-testid="brand-not-found"]')).toContainText('Brand not found');
  await page.locator('[data-testid="brand-not-found"] a').click();
  await expect(page).toHaveURL(/\/brands$/);
});

test('brand page: chip filters, and chip + scroll come back after opening a product', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 600 });
  await page.goto(`/brand/${ALPHA.slug}`);
  const chips = page.locator('.brand-page__chips .chip');
  await expect(chips).toHaveText(['All', ...[categoryA.name, categoryB.name].sort((a, b) => a.localeCompare(b))]);
  await chips.filter({ hasText: categoryB.name }).click();
  await expect(page).toHaveURL(new RegExp(`cat=${categoryB.slug}`));
  await expect(page.locator('.product-card')).toHaveCount(1);
  await expect(page.locator('.product-card__name')).toHaveText(`${PREFIX} Test Product 2`);

  const card = page.locator('.product-card').first();
  await card.scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(0);
  await card.click();
  await expect(page).toHaveURL(/\/product\//);

  // The small brand name on the product page links to the brand.
  await expect(page.locator('[data-testid="product-brand-link"]')).toHaveAttribute('href', `/brand/${ALPHA.slug}`);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/brand/${ALPHA.slug}\\?cat=${categoryB.slug}`));
  await expect(page.locator('.brand-page__chips .chip--active')).toHaveText(categoryB.name);
  await expect(page.locator('.product-card')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(before - 2);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThanOrEqual(2);

  // The in-app back arrow does the same.
  await page.locator('.product-card').first().click();
  await expect(page).toHaveURL(/\/product\//);
  await page.locator('.detail-header__back').click();
  await expect(page).toHaveURL(new RegExp(`/brand/${ALPHA.slug}\\?cat=${categoryB.slug}`));
  await expect(page.locator('.brand-page__chips .chip--active')).toHaveText(categoryB.name);
});

test('banner video: muted, looping, inline, no controls; picture only under reduce-motion', async ({ page }) => {
  await update(admin.accessToken, `brands?id=eq.${brandIds[ALPHA.name]}`, { banner_video_url: '/e2e-banner-clip.mp4' });
  await page.goto(`/brand/${ALPHA.slug}`);
  const video = page.locator('[data-testid="brand-banner-video"]');
  await expect(video).toHaveCount(1);
  for (const attr of ['muted', 'loop', 'playsinline', 'autoplay']) {
    expect(await video.evaluate((el, a) => el.hasAttribute(a), attr), attr).toBe(true);
  }
  expect(await video.evaluate((el) => el.hasAttribute('controls'))).toBe(false);
  expect(await video.evaluate((el) => (el as HTMLVideoElement).muted)).toBe(true);
  await expect(video).toHaveAttribute('poster', BANNER);
  // Nothing on the banner takes a tap into the video.
  expect(await video.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.locator('[data-testid="brand-banner"] .brand-banner__image')).toHaveAttribute('src', BANNER);
  await expect(page.locator('[data-testid="brand-banner-video"]')).toHaveCount(0);
  await update(admin.accessToken, `brands?id=eq.${brandIds[ALPHA.name]}`, { banner_video_url: null });
});

/* ---------------- Admin: Brands ---------------- */

/** A 200×100 PNG: transparent, with an opaque block at (50,30)–(150,70). */
function borderedLogo(): Buffer {
  const png = new PNG({ width: 200, height: 100 });
  for (let y = 0; y < 100; y += 1) {
    for (let x = 0; x < 200; x += 1) {
      const i = (y * 200 + x) * 4;
      const inside = x >= 50 && x < 150 && y >= 30 && y < 70;
      png.data[i] = 200;
      png.data[i + 1] = 30;
      png.data[i + 2] = 30;
      png.data[i + 3] = inside ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

test('admin: add a brand with a logo — the stored logo has no empty border', async ({ page }) => {
  test.setTimeout(90_000);
  await adminPage(page, '?tab=brands');
  await expect(page.locator('.adm-page-header__title')).toHaveText('Brands', { timeout: 15_000 });
  await page.locator('.adm-page-header').getByRole('button', { name: 'Add brand' }).click();
  await page.locator('#bf-name').fill(UPLOADED);
  await expect(page.locator('[data-testid="brand-link-preview"]')).toContainText('/brand/e2e-brand-upload');
  await page.locator('[data-testid="brand-logo-input"]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: borderedLogo() });
  await expect(page.locator('[data-testid="brand-logo-img"]')).toBeVisible({ timeout: 20_000 });
  // Live preview on a light and a dark card before saving.
  await expect(page.locator('[data-testid="logo-preview-light"] img')).toBeVisible();
  await expect(page.locator('[data-testid="logo-preview-dark"]')).toHaveClass(/card--light/);
  await page.locator('form.adm-brand-form button[type="submit"]').click();
  await expect(page.locator('[data-testid="brand-row-admin"]', { hasText: UPLOADED })).toBeVisible({ timeout: 15_000 });

  const saved = await select<{ logo_url: string; slug: string; show_on_home: boolean }[]>(
    admin.accessToken,
    `brands?select=logo_url,slug,show_on_home&name=eq.${encodeURIComponent(UPLOADED)}`
  );
  const logoUrl = saved.data![0].logo_url;
  expect(logoUrl).toContain('/brand-media/logos/');
  expect(saved.data![0].slug).toBe('e2e-brand-upload');
  const box = await page.evaluate(async (url) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    // A fresh copy: the page already shows this logo without CORS, and a
    // cached non-CORS copy can't be read back from a canvas.
    img.src = url + '?read=1';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const solid = (x: number, y: number) => d[(y * c.width + x) * 4 + 3] > 16;
    let top = false;
    let bottom = false;
    let left = false;
    let right = false;
    for (let x = 0; x < c.width; x += 1) {
      top ||= solid(x, 0);
      bottom ||= solid(x, c.height - 1);
    }
    for (let y = 0; y < c.height; y += 1) {
      left ||= solid(0, y);
      right ||= solid(c.width - 1, y);
    }
    return { width: c.width, height: c.height, top, bottom, left, right };
  }, logoUrl);
  expect(box).toEqual({ width: 100, height: 40, top: true, bottom: true, left: true, right: true });
});

test('admin: rename reaches the products; reorder by drag; delete blocked while products use it', async ({ page }) => {
  test.setTimeout(120_000);
  // Rename (through the editor).
  await adminPage(page, '?tab=brands');
  await page.locator('[data-testid="brand-row-admin"]', { hasText: ALPHA.name }).first().locator('.adm-lrow__open').click();
  await page.locator('#bf-name').fill(`${ALPHA.name} Renamed`);
  await page.locator('form.adm-brand-form button[type="submit"]').click();
  await expect(page.locator('[data-testid="brand-row-admin"]', { hasText: `${ALPHA.name} Renamed` })).toBeVisible({ timeout: 15_000 });
  const renamed = await select<{ brand: string }[]>(admin.accessToken, `products?select=brand&brand_id=eq.${brandIds[ALPHA.name]}`);
  expect(renamed.data!.map((r) => r.brand)).toEqual([`${ALPHA.name} Renamed`, `${ALPHA.name} Renamed`]);
  const slug = await select<{ slug: string }[]>(admin.accessToken, `brands?select=slug&id=eq.${brandIds[ALPHA.name]}`);
  expect(slug.data![0].slug).toBe(ALPHA.slug);

  // The product page shows the new name.
  const shop = await page.context().newPage();
  await shop.goto(`/brand/${ALPHA.slug}`);
  await shop.locator('.product-card').first().click();
  await expect(shop.locator('[data-testid="product-brand-link"]')).toHaveText(`${ALPHA.name} Renamed`);
  await shop.close();

  // Reorder: drag the first brand below the second.
  const order = async () =>
    (await select<{ id: string }[]>(admin.accessToken, 'brands?select=id&order=display_order,name&limit=2')).data!.map((b) => b.id);
  expect(await order()).toEqual([brandIds[ALPHA.name], brandIds[HIDDEN.name]]);
  const rows = page.locator('[data-testid="brand-row-admin"]');
  const handle = rows.nth(0).locator('[data-testid="brand-drag-handle"]');
  const h = (await handle.boundingBox())!;
  const rowHeight = (await rows.nth(0).boundingBox())!.height;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + (rowHeight * 1.2 * i) / 10);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await expect.poll(order, { timeout: 10_000 }).toEqual([brandIds[HIDDEN.name], brandIds[ALPHA.name]]);
  const log = await select<{ action: string }[]>(admin.accessToken, 'activity_log?select=action&action=eq.brand.reordered&actor_username=eq.e2e.admin&order=id.desc&limit=1');
  expect(log.data!.length).toBe(1);

  // Delete is blocked while products use the brand (UI and database).
  await page.reload();
  await page.getByRole('button', { name: `Actions for ${ALPHA.name} Renamed` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Move its products to another brand first');
  await expect(dialog.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'OK' }).click();
  const refused = await remove(admin.accessToken, `brands?id=eq.${brandIds[ALPHA.name]}`);
  expect(refused.ok).toBe(false);

  // A brand with no products can be deleted.
  await page.getByRole('button', { name: `Actions for ${EMPTY.name}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('[data-testid="brand-row-admin"]', { hasText: EMPTY.name })).toHaveCount(0, { timeout: 10_000 });
  const gone = await select<{ id: string }[]>(admin.accessToken, `brands?select=id&id=eq.${brandIds[EMPTY.name]}`);
  expect(gone.data).toEqual([]);
});

test('staff without "Edit brands" are refused (menu and database); with it they can, and it is logged', async ({ page }) => {
  test.setTimeout(90_000);
  await setRole(['view_orders']);
  let staff = await staffSession();
  await page.setViewportSize({ width: 1280, height: 800 });
  await useSessionInPage(page, staff);
  await page.goto('/admin?tab=brands');
  await expect(page.locator('.adm-sidebar')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.adm-sidebar__label', { hasText: 'Brands' })).toHaveCount(0);
  await expect(page.locator('.adm-page-header__title')).not.toHaveText('Brands');

  const target = `brands?id=eq.${brandIds[HIDDEN.name]}`;
  const blockedUpdate = await update<unknown[]>(staff.accessToken, target, { name: `${HIDDEN.name} Hacked` });
  expect(blockedUpdate.ok && (blockedUpdate.data ?? []).length > 0).toBe(false);
  const blockedInsert = await insert(staff.accessToken, 'brands', { name: `${PREFIX} Sneaky`, slug: 'e2e-brand-sneaky' });
  expect(blockedInsert.ok).toBe(false);
  const blockedReorder = await rpc(staff.accessToken, 'admin_brands_reorder', { p_ids: [brandIds[HIDDEN.name]] });
  expect(blockedReorder.ok).toBe(false);
  const blockedUpload = await fetch(`${SUPABASE_URL}/storage/v1/object/brand-media/logos/e2e-sneaky.webp`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${staff.accessToken}`, 'Content-Type': 'image/webp' },
    body: new Uint8Array([1, 2, 3]),
  });
  expect(blockedUpload.ok).toBe(false);
  const unchanged = await select<{ name: string }[]>(admin.accessToken, `${target}&select=name`);
  expect(unchanged.data![0].name).toBe(HIDDEN.name);

  await setRole(['view_orders', 'edit_brands']);
  staff = await staffSession();
  const allowed = await update<unknown[]>(staff.accessToken, target, { show_on_home: true });
  expect(allowed.ok, allowed.error ?? '').toBe(true);
  expect(allowed.data!.length).toBe(1);
  const log = await select<{ actor_username: string; summary: string }[]>(
    admin.accessToken,
    `activity_log?select=actor_username,summary&action=eq.brand.updated&entity_id=eq.${brandIds[HIDDEN.name]}&order=id.desc&limit=1`
  );
  expect(log.data![0].actor_username).toBe(STAFF_USERNAME);
  expect(log.data![0].summary).toContain('show_on_home');
  const by = await select<{ updated_by: string }[]>(admin.accessToken, `${target}&select=updated_by`);
  expect(by.data![0].updated_by).toBe(STAFF_USERNAME);

  await page.reload();
  await expect(page.locator('.adm-sidebar__label', { hasText: 'Brands' })).toHaveCount(1, { timeout: 15_000 });
  await page.goto('/admin?tab=brands');
  await expect(page.locator('.adm-page-header__title')).toHaveText('Brands', { timeout: 15_000 });
  await update(admin.accessToken, target, { show_on_home: false });
});

/* ---------------- Admin extras ---------------- */

test('Restock: Add and Set to, per option, saved and logged; refused without "Edit products and stock"', async ({ page }) => {
  test.setTimeout(90_000);
  await adminPage(page, `?tab=products&pq=${encodeURIComponent(`${PREFIX} Test Product 1`)}`);
  const menu = page.getByRole('button', { name: `Actions for ${PREFIX} Test Product 1` }).first();
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await menu.click();
  const items = await page.getByRole('menuitem').allInnerTexts();
  expect(items.map((t) => t.trim()).slice(0, 2)).toEqual(['Edit', 'Restock']);
  await page.getByRole('menuitem', { name: 'Restock' }).click();

  const sheet = page.locator('[data-testid="restock-sheet"]');
  await expect(sheet.locator('[data-testid="restock-row"]')).toHaveCount(2);
  await sheet.locator('[data-testid="restock-row"]').nth(0).locator('input').fill('24');
  await expect(sheet.locator('[data-testid="restock-preview"]')).toHaveText('29');
  await sheet.getByRole('button', { name: 'Save stock' }).click();
  await expect(sheet).toBeHidden({ timeout: 10_000 });
  const base = await select<{ stock_quantity: number }[]>(admin.accessToken, `products?select=stock_quantity&id=eq.${productIds[0]}`);
  expect(base.data![0].stock_quantity).toBe(29);
  // "Last updated by" (read the way the admin's Products page reads it).
  const edited = await rpc<{ id: string; last_edited_by: string }[]>(admin.accessToken, 'admin_product_edit_info');
  expect(edited.data!.find((r) => r.id === productIds[0])?.last_edited_by).toBe('e2e.admin');

  await page.getByRole('button', { name: `Actions for ${PREFIX} Test Product 1` }).first().click();
  await page.getByRole('menuitem', { name: 'Restock' }).click();
  await sheet.getByRole('radio', { name: 'Set to' }).click();
  await sheet.locator('[data-testid="restock-row"]').nth(1).locator('input').fill('7');
  await sheet.getByRole('button', { name: 'Save stock' }).click();
  await expect(sheet).toBeHidden({ timeout: 10_000 });
  const variant = await select<{ stock_quantity: number }[]>(admin.accessToken, `product_variants?select=stock_quantity&id=eq.${variantId}`);
  expect(variant.data![0].stock_quantity).toBe(7);

  const log = await select<{ summary: string; actor_username: string }[]>(
    admin.accessToken,
    `activity_log?select=summary,actor_username&action=eq.product.restock&entity_id=eq.${productIds[0]}&order=id.asc`
  );
  expect(log.data!.map((l) => l.summary)).toEqual(['Restock: 5 → 29', 'Restock (E2E · 50ml): 3 → 7']);
  expect(log.data!.every((l) => l.actor_username === 'e2e.admin')).toBe(true);

  // Without "Edit products and stock": no Products page, and the database refuses.
  await setRole(['view_orders']);
  const staff = await staffSession();
  const refused = await rpc(staff.accessToken, 'admin_restock', { p_product_id: productIds[0], p_variant_id: null, p_mode: 'add', p_amount: 5 });
  expect(refused.ok).toBe(false);
  const still = await select<{ stock_quantity: number }[]>(admin.accessToken, `products?select=stock_quantity&id=eq.${productIds[0]}`);
  expect(still.data![0].stock_quantity).toBe(29);
  const staffPage = await page.context().browser()!.newPage({ viewport: { width: 1280, height: 800 } });
  await useSessionInPage(staffPage, staff);
  await staffPage.goto('/admin?tab=products');
  await expect(staffPage.locator('.adm-sidebar')).toBeVisible({ timeout: 15_000 });
  await expect(staffPage.locator('.adm-sidebar__label', { hasText: 'Products' })).toHaveCount(0);
  await expect(staffPage.locator('[data-testid="product-row"]')).toHaveCount(0);
  await staffPage.close();
});

test('7-day chart: bars equal the database; hidden and refused without "See sales figures"', async ({ page }) => {
  test.setTimeout(90_000);
  orderIds.push((await placeTestOrder(customer.accessToken, productIds[1], 1)).id);
  orderIds.push((await placeTestOrder(customer.accessToken, productIds[1], 2)).id);

  const sales = await rpc<{ day: string; total: number; order_count: number }[]>(admin.accessToken, 'admin_sales_7d');
  expect(sales.ok, sales.error ?? '').toBe(true);
  expect(sales.data!.length).toBe(7);

  // Same totals worked out here from the orders themselves.
  const since = new Date(Date.now() - 8 * 86400_000).toISOString();
  const orders = await select<{ total: number; created_at: string; status: string }[]>(
    admin.accessToken,
    `orders?select=total,created_at,status&created_at=gte.${since}`
  );
  const expected = new Map<string, number>();
  for (const o of orders.data!) {
    if (o.status === 'cancelled') continue;
    const day = dhakaDay(o.created_at);
    expected.set(day, (expected.get(day) ?? 0) + Number(o.total));
  }
  for (const d of sales.data!) expect(Number(d.total), d.day).toBe(expected.get(d.day) ?? 0);
  const today = sales.data![6];
  expect(today.day).toBe(dhakaDay(new Date().toISOString()));
  expect(Number(today.total)).toBeGreaterThanOrEqual(1002 * 3);

  await adminPage(page, '');
  const bars = page.locator('[data-testid="sales-bar"]');
  await expect(bars).toHaveCount(7, { timeout: 15_000 });
  for (let i = 0; i < 7; i += 1) {
    await expect(bars.nth(i)).toHaveAttribute('data-day', sales.data![i].day);
    await expect(bars.nth(i)).toHaveAttribute('data-total', String(Number(sales.data![i].total)));
  }
  await expect(page.locator('.adm-sales__bar--today')).toHaveCount(1);
  await expect(bars.nth(6).locator('.adm-sales__bar--today')).toHaveCount(1);
  await bars.nth(6).click();
  await expect(page.locator('[data-testid="sales-readout"]')).toContainText('Today');

  await setRole(['view_orders']);
  const staff = await staffSession();
  const refused = await rpc(staff.accessToken, 'admin_sales_7d');
  expect(refused.ok).toBe(false);
  const staffPage = await page.context().browser()!.newPage({ viewport: { width: 390, height: 800 } });
  await useSessionInPage(staffPage, staff);
  await staffPage.goto('/admin');
  await expect(staffPage.locator('[data-testid="kpi-today"]')).toBeVisible({ timeout: 15_000 });
  await expect(staffPage.locator('[data-testid="sales-chart"]')).toHaveCount(0);
  await setRole(['view_orders', 'see_sales']);
  await staffPage.reload();
  await expect(staffPage.locator('[data-testid="sales-chart"]')).toBeVisible({ timeout: 15_000 });
  await staffPage.close();
});

test('customer notes and tags: save, chips, filter; private from the customer; editing needs its switch', async ({ page }) => {
  test.setTimeout(120_000);
  await adminPage(page, `?tab=customers&cq=${encodeURIComponent(E2E_EMAIL)}`);
  const row = page.locator('[data-testid="customer-row"]').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('.adm-lrow__open').click();
  await page.locator('[data-testid="customer-note-text"]').fill('E2E: prefers evening delivery');
  await page.locator('[data-testid="customer-tag-input"]').fill(TAG_VIP);
  await page.locator('[data-testid="customer-tag-input"]').press('Enter');
  await page.locator('[data-testid="customer-tag-input"]').fill(TAG_FAMILY);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('[data-testid="customer-note-save"]').click();
  await expect(page.locator('[data-testid="customer-note-save"]')).toBeDisabled({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(row.locator('[data-testid="customer-tags"]')).toHaveText(`${TAG_VIP}${TAG_FAMILY}`);

  // Tag filter: only customers with that tag.
  await page.goto('/admin?tab=customers');
  await page.locator('[data-testid="customer-tag-filter"]').selectOption(TAG_VIP);
  await expect(page).toHaveURL(/ctag=/);
  const rows = page.locator('[data-testid="customer-row"]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(E2E_EMAIL);

  const stored = await select<{ note: string; tags: string[]; updated_by: string }[]>(
    admin.accessToken,
    `customer_notes?select=note,tags,updated_by&customer_id=eq.${customer.userId}`
  );
  expect(stored.data![0]).toEqual({ note: 'E2E: prefers evening delivery', tags: [TAG_VIP, TAG_FAMILY], updated_by: 'e2e.admin' });
  const log = await select<{ actor_username: string }[]>(
    admin.accessToken,
    `activity_log?select=actor_username&action=eq.customer.note_updated&entity_id=eq.${customer.userId}&order=id.desc&limit=1`
  );
  expect(log.data![0].actor_username).toBe('e2e.admin');

  // The customer can never read or change their own note, by any route.
  const own = await select<unknown[]>(customer.accessToken, `customer_notes?select=*&customer_id=eq.${customer.userId}`);
  expect(own.ok && (own.data ?? []).length === 0).toBe(true);
  const ownAll = await select<unknown[]>(customer.accessToken, 'customer_notes?select=*');
  expect((ownAll.data ?? []).length).toBe(0);
  const ownWrite = await rpc(customer.accessToken, 'admin_set_customer_note', { p_customer_id: customer.userId, p_note: 'mine', p_tags: [] });
  expect(ownWrite.ok).toBe(false);
  const anon = await select<unknown[]>(null, 'customer_notes?select=*');
  expect((anon.data ?? []).length).toBe(0);

  // Staff with "View customers" only: can read, can't change.
  await setRole(['view_customers']);
  const staff = await staffSession();
  const readable = await select<{ note: string }[]>(staff.accessToken, `customer_notes?select=note&customer_id=eq.${customer.userId}`);
  expect(readable.data![0].note).toBe('E2E: prefers evening delivery');
  const staffWrite = await rpc(staff.accessToken, 'admin_set_customer_note', { p_customer_id: customer.userId, p_note: 'changed', p_tags: [] });
  expect(staffWrite.ok).toBe(false);
  const staffPage = await page.context().browser()!.newPage({ viewport: { width: 390, height: 800 } });
  await useSessionInPage(staffPage, staff);
  await staffPage.goto(`/admin?tab=customers&cq=${encodeURIComponent(E2E_EMAIL)}`);
  await staffPage.locator('[data-testid="customer-row"] .adm-lrow__open').first().click({ timeout: 15_000 });
  await expect(staffPage.locator('[data-testid="customer-note"]')).toContainText('prefers evening delivery');
  await expect(staffPage.locator('[data-testid="customer-note-text"]')).toHaveCount(0);
  await staffPage.close();

  // With "Edit customer notes" they can.
  await setRole(['view_customers', 'edit_customer_notes']);
  const editor = await staffSession();
  const ok = await rpc(editor.accessToken, 'admin_set_customer_note', {
    p_customer_id: customer.userId,
    p_note: 'E2E: changed by staff',
    p_tags: ['e2e vip'],
  });
  expect(ok.ok, ok.error ?? '').toBe(true);
  // A tag already used keeps its first spelling.
  const after = await select<{ tags: string[] }[]>(admin.accessToken, `customer_notes?select=tags&customer_id=eq.${customer.userId}`);
  expect(after.data![0].tags).toEqual([TAG_VIP]);
});
