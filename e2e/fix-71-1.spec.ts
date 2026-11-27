import { mkdirSync } from 'node:fs';
import type { CDPSession, Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { select } from './helpers/api';

// Fix 71.1: the Home theme button, the liquid glass pill of the bottom bar,
// the bar's own tab transition, the Search keyboard rule and the cart
// bubble's taps. Nothing is written to Supabase, and no real Storage file is
// downloaded (./fixtures).

test.use({ serviceWorkers: 'block', timezoneId: 'Asia/Dhaka' });

const SHOTS = 'reports/fix-71-1-screens';

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

async function box(el: Locator) {
  const b = await el.boundingBox();
  expect(b).not.toBeNull();
  return b as { x: number; y: number; width: number; height: number };
}

async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, scheme);
}

async function openHome(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('home-page')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('bottom-nav-pill')).toBeVisible();
}

const navLink = (page: Page, tab: string) => page.getByTestId('bottom-nav').locator(`a[data-tab="${tab}"]`);

/** A real finger (CDP touch events): after a long move no click follows. */
async function swipe(cdp: CDPSession, x: number, y: number, dx: number, dy: number): Promise<void> {
  const steps = 12;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('Home theme button: a small icon, which turns in only on a tap', async ({ page }) => {
  await openHome(page);
  await setTheme(page, 'dark');
  const button = page.getByTestId('home-theme');
  const icon = button.locator('svg');
  expect((await box(icon)).width).toBeLessThanOrEqual(20);
  await expect(button.locator('.b71-theme-spin')).toHaveCount(0);
  await button.screenshot({ path: `${SHOTS}/theme-button-dark-before.png` });
  await button.click();
  await expect(button.locator('.b71-theme-spin')).toHaveCount(1);
  // Measured once the turn is over (mid-turn the rotated box is wider).
  await page.waitForTimeout(400);
  expect((await box(button.locator('svg'))).width).toBeLessThanOrEqual(20);
  await button.screenshot({ path: `${SHOTS}/theme-button-after-tap.png` });
});

test('bottom bar: the pill slides to Shop and the bar keeps its width', async ({ page }) => {
  await openHome(page);
  const nav = page.getByTestId('bottom-nav');
  const widthBefore = (await box(nav)).width;
  await navLink(page, 'shop').click();
  await expect(page).toHaveURL(/\/shop$/);
  await page.waitForTimeout(600);
  const pill = await box(page.getByTestId('bottom-nav-pill'));
  const shop = await box(navLink(page, 'shop'));
  expect(Math.abs(pill.x - shop.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(pill.width - shop.width)).toBeLessThanOrEqual(1);
  expect(Math.abs((await box(nav)).width - widthBefore)).toBeLessThanOrEqual(1);
});

for (const scheme of ['dark', 'light'] as const) {
  test(`bottom bar frames, ${scheme}: the pill is seen moving between Home and Shop`, async ({ page }) => {
    await openHome(page);
    await setTheme(page, scheme);
    const start = (await box(navLink(page, 'home'))).x;
    const end = (await box(navLink(page, 'shop'))).x;
    // Pill positions on every frame for 400 ms after the tap.
    const sampling = page.evaluate(
      () =>
        new Promise<{ left: number; vt: boolean; blur: string }[]>((resolve) => {
          const out: { left: number; vt: boolean; blur: string }[] = [];
          const t0 = performance.now();
          const pill = document.querySelector<HTMLElement>('[data-testid="bottom-nav-pill"]');
          const nav = document.querySelector<HTMLElement>('[data-testid="bottom-nav"]');
          const tick = () => {
            if (pill && nav) {
              const s = getComputedStyle(nav);
              out.push({
                left: pill.getBoundingClientRect().left,
                vt: document.documentElement.classList.contains('vt-tab'),
                blur: s.backdropFilter || s.getPropertyValue('-webkit-backdrop-filter'),
              });
            }
            if (performance.now() - t0 < 400) requestAnimationFrame(tick);
            else resolve(out);
          };
          document.querySelector<HTMLElement>('[data-testid="bottom-nav"] a[data-tab="shop"]')?.click();
          requestAnimationFrame(tick);
        })
    );
    const frames = await sampling;
    const between = new Set(
      frames.filter((f) => f.left > Math.min(start, end) + 2 && f.left < Math.max(start, end) - 2).map((f) => Math.round(f.left))
    );
    expect(between.size, JSON.stringify(frames.map((f) => Math.round(f.left)))).toBeGreaterThanOrEqual(3);
    for (const f of frames) expect(f.blur).toContain('blur');
    // Mid-slide pictures for the report (Shop -> Home, the same slide back),
    // with every animation slowed 10x so a screenshot lands mid-slide.
    await page.waitForTimeout(300);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
    void navLink(page, 'home').click();
    for (const step of [1, 2, 3, 4]) {
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${SHOTS}/pill-${scheme}-step${step}.png`, clip: { x: 0, y: 740, width: 390, height: 104 }, animations: 'allow' });
    }
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
  });
}

test('Search: the bar tab keeps the keyboard down; a search box tap opens it', async ({ page }) => {
  await openHome(page);
  await navLink(page, 'search').click();
  await expect(page).toHaveURL(/\/search$/);
  const input = page.getByRole('combobox', { name: 'Search products' });
  await expect(input).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(400);
  await expect(input).not.toBeFocused();
  await navLink(page, 'home').click();
  await expect(page.getByTestId('home-page')).toBeVisible();
  await page.getByTestId('home-search').click();
  await expect(page).toHaveURL(/\/search$/);
  await expect(input).toBeFocused();
});

test('cart bubble: above the bar, a wobbly tap opens the cart, no tap is swallowed after a drag, stays clear of the bar', async ({ page }) => {
  test.setTimeout(60_000);
  const res = await select<{ id: string }[]>(null, 'products_view?select=id&is_active=eq.true&stock_status=eq.in_stock&order=name.asc&limit=1');
  const productId = (res.data ?? [])[0]?.id;
  expect(productId).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/shop');
  await page.evaluate((id) => {
    window.localStorage.removeItem('naeems.cartBubble');
    window.localStorage.setItem(
      'nph_cart',
      JSON.stringify([{ productId: id, variantId: null, variantLabel: null, quantity: 1, priceAtAdd: 100 }])
    );
  }, productId);
  await page.reload();
  const bubble = page.getByTestId('glass-cart');
  const nav = page.getByTestId('bottom-nav');
  const sideCart = page.getByTestId('side-cart');
  await expect(bubble).toBeVisible({ timeout: 20_000 });

  const z = await page.evaluate(() => {
    const zOf = (id: string) => Number(getComputedStyle(document.querySelector(`[data-testid="${id}"]`) as Element).zIndex);
    return { bubble: zOf('glass-cart'), nav: zOf('bottom-nav') };
  });
  expect(z.bubble).toBeGreaterThan(z.nav);

  // A press that wobbles 8 px is still a tap.
  let b = await box(bubble);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 8, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(sideCart).toHaveClass(/b70-cart--open/);
  await page.getByTestId('side-cart-close').click();
  await expect(sideCart).not.toHaveClass(/b70-cart--open/);
  await page.waitForTimeout(400);

  // A real finger drag of 60 px (no click follows it), then one plain tap.
  const cdp = await page.context().newCDPSession(page);
  b = await box(bubble);
  await swipe(cdp, b.x + b.width / 2, b.y + b.height / 2, 0, -60);
  await page.waitForTimeout(500);
  await expect(sideCart).not.toHaveClass(/b70-cart--open/);
  await bubble.click();
  await expect(sideCart).toHaveClass(/b70-cart--open/);
  await page.getByTestId('side-cart-close').click();
  await expect(sideCart).not.toHaveClass(/b70-cart--open/);
  await page.waitForTimeout(400);

  // Dragged to the bottom-left as low as it goes: it stops above the bar.
  b = await box(bubble);
  await swipe(cdp, b.x + b.width / 2, b.y + b.height / 2, 30 - (b.x + b.width / 2), 838 - (b.y + b.height / 2));
  await page.waitForTimeout(500);
  await expect(bubble).toHaveAttribute('data-side', 'left');
  const low = await box(bubble);
  expect(low.y + low.height).toBeLessThan((await box(nav)).y);
  await page.screenshot({ path: `${SHOTS}/bubble-above-bar.png` });

  // The bar hides on a scroll down (the bubble may go lower) and comes back
  // on a scroll up (the bubble moves back above it).
  await page.mouse.move(200, 400);
  await page.mouse.wheel(0, 600);
  await expect(nav).toHaveClass(/b71-nav--away/);
  await page.waitForTimeout(500);
  const hidden = await box(bubble);
  expect(hidden.y).toBeGreaterThanOrEqual(low.y);
  await page.mouse.wheel(0, -200);
  await expect(nav).not.toHaveClass(/b71-nav--away/);
  await page.waitForTimeout(500);
  const back = await box(bubble);
  expect(back.y + back.height).toBeLessThan((await box(nav)).y);
});
