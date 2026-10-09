import { mkdirSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './helpers/env';
import { insert, passwordSession, remove, select, useSessionInPage, type TestSession } from './helpers/api';

// Fix (rich-text editor): saved text shows without a refresh, boxes wrap
// one line, Save stays on the page, Justify, no gap on Enter, Noto Sans
// Bengali. Only two test products ("E2E RTE …") are made and edited; they
// are deleted afterwards. Real products are never changed.

test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD, 'Needs the admin test account in .env.e2e.');
test.describe.configure({ mode: 'serial' });
// The slow-editor check delays the editor's file; the offline cache must not
// hand it over first.
test.use({ serviceWorkers: 'block' });

const PREFIX = 'E2E RTE';
const SHOTS = 'reports/fix-rich-text-editor-screens';
const A_TEXT = 'Line A1\nLine A2\n\nLine A3 after a blank line';
const B_TEXT = 'Product B text';

let admin: TestSession;
let a = { id: '', name: '', slug: '' };
let b = { id: '', name: '', slug: '' };

async function makeProduct(tag: string, description: string): Promise<{ id: string; name: string; slug: string }> {
  const stamp = `${tag}-${Date.now() % 1_000_000}`;
  const name = `${PREFIX} ${stamp}`;
  const cats = await select<{ id: string }[]>(null, 'categories?select=id&limit=1');
  const res = await insert(
    admin.accessToken,
    'products',
    {
      sku: `E2E-RTE-${stamp}`,
      slug: `e2e-rte-${stamp.toLowerCase()}`,
      name,
      category_id: cats.data![0].id,
      retail_price: 1290,
      stock_status: 'in_stock',
      stock_quantity: 5,
      is_active: true,
      description,
    },
    false
  );
  expect(res.ok, res.error ?? '').toBe(true);
  const row = await select<{ id: string; slug: string }[]>(admin.accessToken, `products?select=id,slug&sku=eq.E2E-RTE-${stamp}`);
  return { id: row.data![0].id, name, slug: row.data![0].slug };
}

async function cleanUp(): Promise<void> {
  const rows = await select<{ id: string }[]>(admin.accessToken, `products?select=id&name=like.${encodeURIComponent(PREFIX)}*`);
  for (const p of rows.data ?? []) await remove(admin.accessToken, `products?id=eq.${p.id}`);
}

async function savedDescription(id: string): Promise<string | null> {
  const row = await select<{ description: string | null }[]>(admin.accessToken, `products?select=description&id=eq.${id}`);
  return row.data?.[0]?.description ?? null;
}

/** Light or dark, the way the theme button sets it. */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
}

/** In-app navigation (no reload), as the app's own links do. */
async function goInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

function description(page: Page): { editor: Locator; content: Locator } {
  const editor = page.getByTestId('rt-editor-pf-description');
  return { editor, content: editor.locator('.rt-editor__content') };
}

/** The fonts the browser really drew a node's text with, and how many
 *  glyphs each (Chrome DevTools). */
async function renderedFonts(page: Page, selector: string): Promise<Record<string, number>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  await cdp.detach();
  return Object.fromEntries(fonts.map((f) => [f.familyName, f.glyphCount]));
}

test.beforeAll(async () => {
  test.setTimeout(60_000);
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  await cleanUp();
  a = await makeProduct('a', A_TEXT);
  b = await makeProduct('b', B_TEXT);
  mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  await cleanUp();
});

test('Part 1: Edit from the list shows the saved text without a refresh; another product shows its own; Save waits; emptying asks', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  // The editor arrives late (slow phone): Save must wait for it.
  let release: () => void = () => undefined;
  const editorArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/RichTextEditor-[^/]*\.js$/, async (route) => {
    await editorArrived;
    await route.continue();
  });

  await page.goto('/admin?tab=products');
  await page.getByPlaceholder('Search name or SKU').fill(a.name);
  await page.getByTestId('product-row').filter({ hasText: a.name }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/products/${a.id}/edit$`));
  const waiting = page.getByRole('button', { name: 'Loading text…' });
  await expect(waiting).toBeVisible({ timeout: 15_000 });
  await expect(waiting).toBeDisabled();
  release();

  const { content } = description(page);
  await expect(content).toContainText('Line A1', { timeout: 15_000 });
  await expect(content).toContainText('Line A3 after a blank line');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  for (const scheme of ['light', 'dark'] as const) {
    await setTheme(page, scheme);
    await description(page).editor.screenshot({ path: `${SHOTS}/editor-loaded-${scheme}.png` });
  }
  await setTheme(page, 'light');

  // Straight to another product's Edit page (no reload): its own text.
  await goInApp(page, `/admin/products/${b.id}/edit`);
  await expect(description(page).content).toHaveText(B_TEXT, { timeout: 15_000 });
  await expect(description(page).content).not.toContainText('Line A1');

  // Emptying a text that had words asks first; "Keep text" saves nothing.
  await description(page).content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('This will delete the Description text. Save anyway?')).toBeVisible();
  await page.getByRole('button', { name: 'Keep text' }).click();
  await expect(page.getByText('This will delete the Description text. Save anyway?')).toBeHidden();
  expect(await savedDescription(b.id)).toBe(B_TEXT);
});

test('Parts 2 and 3: a box wraps only the line; Save stays on the Edit page with "Saved ✓"; Remove box', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  await page.goto(`/admin/products/${a.id}/edit`);
  const { editor, content } = description(page);
  await expect(content).toContainText('Line A2', { timeout: 20_000 });

  await content.locator('p', { hasText: 'Line A2' }).click();
  await editor.getByTestId('rt-warning').click();
  await expect(content.locator('div[data-box="warning"] p')).toHaveCount(1);
  await expect(content.locator('div[data-box="warning"]')).toHaveText('Line A2');
  for (const scheme of ['light', 'dark'] as const) {
    await setTheme(page, scheme);
    await editor.screenshot({ path: `${SHOTS}/editor-one-line-warning-${scheme}.png` });
  }
  await setTheme(page, 'light');

  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved ✓')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`/admin/products/${a.id}/edit$`));
  expect(await savedDescription(a.id)).toBe(
    '<p>Line A1</p><div data-box="warning"><p>Line A2</p></div><p></p><p>Line A3 after a blank line</p>'
  );
  await expect(page.getByRole('link', { name: /View on site/ })).toHaveAttribute('href', `/product/${a.slug}`);
  await expect(page.getByRole('link', { name: /View on site/ })).toHaveAttribute('target', '_blank');

  await content.locator('div[data-box="warning"] p').click();
  await editor.getByTestId('rt-unbox').click();
  await expect(content.locator('div[data-box]')).toHaveCount(0);
  await expect(content.locator('p', { hasText: 'Line A2' })).toHaveCount(1);
  await editor.getByTestId('rt-undo').click();
  await expect(content.locator('div[data-box="warning"]')).toHaveText('Line A2');
  // Changed again after the save: leaving asks first.
  await page.getByRole('button', { name: 'Back to products' }).click();
  await expect(page.getByText('Discard changes?')).toBeVisible();
});

test('Parts 4 and 5: Enter adds no gap, Enter twice keeps one empty line, Justify — the same on the product page', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  await page.goto(`/admin/products/${a.id}/edit`);
  const { editor, content } = description(page);
  await expect(content).toContainText('Line A1', { timeout: 20_000 });

  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('First line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second line, justified so the words spread out to both edges of the box');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('বাংলা লেখা ১২৩');
  const lines = content.locator('p');
  await expect(lines).toHaveCount(4);
  const editorGap = await lines.evaluateAll((ps) => {
    const r = ps.map((p) => p.getBoundingClientRect());
    return { margin: getComputedStyle(ps[0]).marginBottom, gap: r[1].top - r[0].bottom, empty: r[2].height, line: r[0].height };
  });
  expect(editorGap.margin).toBe('0px');
  expect(Math.abs(editorGap.gap)).toBeLessThan(0.5);
  expect(Math.abs(editorGap.empty - editorGap.line)).toBeLessThan(1);

  await lines.nth(1).click();
  await editor.getByTestId('rt-justify').click();
  await expect(content.locator('p[data-align="justify"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved ✓')).toBeVisible({ timeout: 20_000 });
  expect(await savedDescription(a.id)).toBe(
    '<p>First line</p><p data-align="justify">Second line, justified so the words spread out to both edges of the box</p><p></p><p>বাংলা লেখা ১২৩</p>'
  );

  // The customer's product page: no gaps, the empty line is there, justified.
  await page.goto(`/product/${a.slug}`);
  const about = page.getByTestId('pdp-about');
  await expect(about.locator('p')).toHaveCount(4, { timeout: 20_000 });
  const shop = await about.locator('p').evaluateAll((ps) => {
    const r = ps.map((p) => p.getBoundingClientRect());
    return {
      margin: getComputedStyle(ps[0]).marginBottom,
      gap: r[1].top - r[0].bottom,
      empty: r[2].height,
      line: r[0].height,
      align: getComputedStyle(ps[1]).textAlign,
      lineHeight: getComputedStyle(ps[0]).lineHeight,
    };
  });
  expect(shop.margin).toBe('0px');
  expect(Math.abs(shop.gap)).toBeLessThan(0.5);
  expect(shop.empty).toBeGreaterThan(20);
  expect(Math.abs(shop.empty - shop.line)).toBeLessThan(1);
  expect(shop.align).toBe('justify');
  // The old plain text's line height (13.5px × 1.7).
  expect(shop.lineHeight).toBe('22.95px');
});

test('Part 6: ৳ and Bengali text are drawn with Noto Sans Bengali; Latin stays Plus Jakarta Sans', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/product/${a.slug}`);
  const about = page.getByTestId('pdp-about');
  await expect(about.locator('p')).toHaveCount(4, { timeout: 20_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect
    .poll(() => page.evaluate(() => document.fonts.check('16px "Noto Sans Bengali"', '৳১')), { timeout: 15_000 })
    .toBe(true);

  const priceFonts = await renderedFonts(page, '[data-testid="buy-bar-price"]');
  // "৳1,290": the ৳ from Noto Sans Bengali, the digits Plus Jakarta Sans.
  expect(priceFonts['Noto Sans Bengali']).toBe(1);
  expect(priceFonts['Plus Jakarta Sans']).toBeGreaterThan(0);
  expect(Object.keys(priceFonts).some((f) => /Hind/i.test(f))).toBe(false);
  // "বাংলা লেখা ১২৩": every Bengali letter and digit in Noto Sans Bengali;
  // only the two spaces come from Plus Jakarta Sans.
  const bengaliFonts = await renderedFonts(page, '[data-testid="pdp-about"] p:nth-of-type(4)');
  expect(bengaliFonts['Noto Sans Bengali']).toBeGreaterThan(0);
  expect(bengaliFonts['Plus Jakarta Sans'] ?? 0).toBe(2);
  expect(Object.keys(bengaliFonts).sort()).toEqual(['Noto Sans Bengali', 'Plus Jakarta Sans']);
  const latinFonts = await renderedFonts(page, '[data-testid="pdp-about"] p:nth-of-type(1)');
  expect(Object.keys(latinFonts)).toEqual(['Plus Jakarta Sans']);

  for (const scheme of ['light', 'dark'] as const) {
    await setTheme(page, scheme);
    await about.scrollIntoViewIfNeeded();
    await about.screenshot({ path: `${SHOTS}/customer-bengali-text-${scheme}.png` });
    await page.getByTestId('buy-bar-price').screenshot({ path: `${SHOTS}/customer-bengali-price-${scheme}.png` });
  }
});
