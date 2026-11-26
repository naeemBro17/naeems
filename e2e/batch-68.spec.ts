import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Browser, Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, useSessionInPage } from './helpers/api';
import { signInAsTestCustomer } from './helpers/auth';

// Batch 68: the Account tab. Not signed in: Intro (orange poster, "Slide to
// start") -> Sign in. Signed in (customer): the new Account layout.
//
// Nothing is written to Supabase. The customer's name, "member since" date
// and orders are answered in the test browser (made up), Google is never
// opened (the sign-in request is caught on its way out), and Log out is
// only opened and cancelled (a real log-out would end the test account's
// other sessions). No real Storage file is downloaded (./fixtures).

test.use({ serviceWorkers: 'block', timezoneId: 'Asia/Dhaka' });

const SHOTS = 'reports/batch-68-screens';

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) };
}

/** Theme before the page loads (system setting) and after (the shop's own switch). */
async function setTheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, scheme);
}

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
}

async function knobLeft(page: Page): Promise<number> {
  const box = await page.getByTestId('intro-slide').boundingBox();
  return box ? box.x : -1;
}

/** Drags the knob sideways by `dx` (and down by `dy`) with a pointer, in small steps. */
async function dragKnob(page: Page, dx: number, dy = 0, release = true): Promise<void> {
  const box = await page.getByTestId('intro-slide').boundingBox();
  if (!box) throw new Error('no knob');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  if (release) await page.mouse.up();
}

async function openIntro(page: Page, width: number, height = 844, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto('/account');
  await expect(page.getByTestId('account-intro')).toBeVisible({ timeout: 20_000 });
  await setTheme(page, theme);
  await expect(page.getByTestId('account-intro')).toHaveAttribute('data-step', 'intro');
}

/* ------------------------------------------------------------- Intro */

for (const width of [390, 360]) {
  test(`Intro at ${width} px: the words, slide past 80% opens Sign in, a short drag snaps back, Back resets the knob`, async ({ page }) => {
    test.setTimeout(60_000);
    await openIntro(page, width);
    const intro = page.getByTestId('account-intro');
    for (const text of ["NAEEM'S", '100% authentic imports', 'Delivery all over Bangladesh', 'Expert advice when you need it', 'Slide to start']) {
      await expect(intro.getByText(text, { exact: true }).first()).toBeVisible();
    }
    await expect(intro.locator('.b68-big')).toHaveText(/Skincare\s*you can\s*trust/);
    expect(await intro.locator('.b68-big').evaluate((el) => getComputedStyle(el).textTransform)).toBe('uppercase');
    // No page header and no footer on the Intro.
    await expect(page.locator('.detail-header')).toHaveCount(0);
    await expect(page.locator('footer')).toHaveCount(0);
    await noSideScroll(page);
    await page.waitForTimeout(300);
    if (width === 390) await page.screenshot({ path: `${SHOTS}/01-intro-light-390.png` });

    // A short drag snaps back.
    const start = await knobLeft(page);
    await dragKnob(page, 60);
    await page.waitForTimeout(450);
    await expect(intro).toHaveAttribute('data-step', 'intro');
    // Back at rest (the idle nudge moves it at most 14 px).
    await expect(page.getByTestId('intro-slide')).toHaveClass(/is-idle/);
    expect(Math.abs((await knobLeft(page)) - start)).toBeLessThan(16);

    // Past 80% opens Sign in.
    const slide = await page.locator('.b68-slide').boundingBox();
    if (!slide) throw new Error('no slide');
    await dragKnob(page, slide.width * 0.55, 0, false);
    if (width === 390) await page.screenshot({ path: `${SHOTS}/02-intro-mid-drag-390.png` });
    const box = await page.getByTestId('intro-slide').boundingBox();
    if (!box) throw new Error('no knob');
    await page.mouse.move(slide.x + slide.width - 10, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(intro).toHaveAttribute('data-step', 'signin');
    await expect(page.getByText('Sign in to continue.')).toBeVisible();
    await noSideScroll(page);

    // Back on Sign in returns to the Intro with the knob reset.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(intro).toHaveAttribute('data-step', 'intro');
    await page.waitForTimeout(450);
    await expect(page.getByTestId('intro-slide')).toHaveClass(/is-idle/);
    expect(Math.abs((await knobLeft(page)) - start)).toBeLessThan(16);

    // A plain tap also opens Sign in.
    await page.getByTestId('intro-slide').click();
    await expect(intro).toHaveAttribute('data-step', 'signin');
  });
}

test('Intro: a vertical drag on the knob does not move it or open Sign in; only the knob takes the gesture', async ({ page }) => {
  await openIntro(page, 390);
  const before = await page.getByTestId('intro-slide').boundingBox();
  await dragKnob(page, 6, -120);
  await page.waitForTimeout(400);
  const after = await page.getByTestId('intro-slide').boundingBox();
  expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(16);
  await expect(page.getByTestId('intro-slide')).toHaveClass(/is-idle/);
  // Lifting the finger after a vertical drag is not a tap.
  await expect(page.getByTestId('account-intro')).toHaveAttribute('data-step', 'intro');
  // The knob alone takes touch gestures; the rest of the screen leaves them to the browser.
  expect(await page.locator('.b68-slide').evaluate((el) => getComputedStyle(el).touchAction)).toBe('auto');
  expect(await page.getByTestId('intro-slide').evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
});

test('Intro: the picture hides on a short screen (360 x 600)', async ({ page }) => {
  await openIntro(page, 360, 600);
  await expect(page.locator('.b68-hero')).toBeHidden();
  await expect(page.getByTestId('intro-slide')).toBeVisible();
  await noSideScroll(page);
});

test('Intro: stays orange in dark mode (capture)', async ({ page }) => {
  await openIntro(page, 390, 844, 'dark');
  const bg = await page.locator('.b68-intro').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(255, 122, 69)');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/03-intro-dark-390.png` });
});

test('Intro: reduced motion leaves no running animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openIntro(page, 390);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(400);
  const running = await page.evaluate(() =>
    document.getAnimations().filter((a) => {
      const t = (a.effect as KeyframeEffect | null)?.target;
      return a.playState === 'running' && t instanceof Element && t.closest('.b68-auth');
    }).length
  );
  expect(running).toBe(0);
  await page.getByTestId('intro-slide').click();
  await expect(page.getByTestId('account-intro')).toHaveAttribute('data-step', 'signin');
});

/* ------------------------------------------------------------- Sign in */

test('Sign in: Continue with Google starts Google sign-in, back to the shop home', async ({ page }) => {
  test.setTimeout(60_000);
  let redirectTo = '';
  await page.route(/\/auth\/v1\/authorize/, async (route) => {
    redirectTo = new URL(route.request().url()).searchParams.get('redirect_to') ?? '';
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Google</title><p>google</p>' });
  });
  await openIntro(page, 390);
  await page.getByTestId('intro-slide').click();
  const google = page.getByRole('button', { name: 'Continue with Google' });
  await expect(google).toBeVisible();
  for (const text of ['Sign in to continue.', 'No password needed']) await expect(page.getByText(text)).toBeVisible();
  await expect(page.locator('.b68-sin h1')).toHaveText(/Welcome to\s*NAEEM'S/);
  await expect(page.locator('.b68-legal')).toHaveText('By continuing you agree to our Terms and Privacy policy.');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/04-signin-light-390.png` });
  await google.click();
  const origin = new URL(String(test.info().project.use.baseURL)).origin;
  await expect.poll(() => redirectTo, { timeout: 15_000 }).toBe(`${origin}/`);
});

test('Sign in: dark mode is near-black with white Google text', async ({ page }) => {
  await openIntro(page, 390, 844, 'dark');
  await page.getByTestId('intro-slide').click();
  await expect(page.getByTestId('account-intro')).toHaveAttribute('data-step', 'signin');
  expect(await page.locator('.b68-signin').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(11, 10, 9)');
  expect(await page.getByTestId('account-google').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/05-signin-dark-390.png` });
});

const FB_IN_APP =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/478.0.0.41.105;FBBV/641035718;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.6;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]';

async function inAppPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ userAgent: FB_IN_APP, viewport: { width: 390, height: 844 }, serviceWorkers: 'block', timezoneId: 'Asia/Dhaka' });
  return ctx.newPage();
}

test('Sign in: a failed start shows the error text (Facebook in-app browser)', async ({ browser }) => {
  test.setTimeout(60_000);
  const page = await inAppPage(browser);
  try {
    await page.goto('/account');
    await expect(page.getByTestId('account-intro')).toBeVisible({ timeout: 20_000 });
    // The in-app bar would cover the bottom of the screen; close it first.
    const close = page.getByTestId('inapp-close');
    if (await close.isVisible().catch(() => false)) await close.click();
    await page.getByTestId('intro-slide').click();
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    const err = page.locator('.b68-err');
    await expect(err).toHaveText('Google login does not work inside this app. Open this page in your browser to log in.');
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
    // The in-app help sheet opens over it; close it for the capture.
    const sheetClose = page.getByRole('button', { name: 'Close' }).last();
    if (await sheetClose.isVisible().catch(() => false)) await sheetClose.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/06-signin-error-390.png` });
  } finally {
    await page.context().close();
  }
});

/* ------------------------------------------------------------- Account (signed in) */

test.describe('Account, signed in', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!E2E_EMAIL || !E2E_PASSWORD, 'Needs the test customer in .env.e2e.');

  type Status = 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';
  const orderRow = (number: string, status: Status, createdAt: string, total: number) => ({
    id: randomUUID(),
    order_number: number,
    user_id: null,
    status,
    payment_status: 'unpaid',
    subtotal: total - 70,
    delivery_fee: 70,
    discount: 0,
    total,
    created_at: createdAt,
    updated_at: createdAt,
    full_name: 'Sadia Rahman',
    phone: '01712345678',
    division: 'Dhaka',
    district: 'Dhaka',
    thana: 'Dhanmondi',
    address_line: 'House 32, Road 7',
    delivery_zone: 'inside_dhaka',
  });

  /** The test customer's own profile row, with a made-up name and join date. */
  async function fakeProfile(page: Page): Promise<void> {
    await page.route(/\/rest\/v1\/profiles(\?|$)/, async (route: Route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      let response: Awaited<ReturnType<Route['fetch']>>;
      let body: unknown;
      try {
        response = await route.fetch();
        body = await response.json();
      } catch {
        return;
      }
      const extra = { full_name: 'Sadia Rahman', created_at: '2026-10-05T09:00:00Z', photo_url: null, phone: '01712345678', thana: 'Dhanmondi', district: 'Dhaka' };
      const merged = Array.isArray(body)
        ? body.map((r: Record<string, unknown>) => ({ ...r, ...extra }))
        : body && typeof body === 'object'
          ? { ...(body as Record<string, unknown>), ...extra }
          : body;
      await route.fulfill({ response, json: merged }).catch(() => undefined);
    });
  }

  /** My orders (newest first), each order's own read, and the newest one's items. */
  async function fakeOrders(page: Page, orders: ReturnType<typeof orderRow>[], items = 3): Promise<void> {
    await page.route(/\/rest\/v1\/orders(\?|$)/, async (route: Route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const id = new URL(route.request().url()).searchParams.get('id');
      if (id) {
        const one = orders.find((o) => `eq.${o.id}` === id) ?? null;
        const wantsObject = (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object');
        return route.fulfill(json(wantsObject ? one : one ? [one] : []));
      }
      return route.fulfill(json(orders));
    });
    await page.route(/\/rest\/v1\/order_items(\?|$)/, async (route: Route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const orderId = (new URL(route.request().url()).searchParams.get('order_id') ?? '').replace('eq.', '');
      const rows = Array.from({ length: items }, (_, i) => ({
        id: randomUUID(),
        order_id: orderId,
        product_id: null,
        product_name: `B68 Product ${i + 1}`,
        image_url: null,
        unit_price: 500,
        list_price: 500,
        quantity: i === 0 ? 2 : 1,
        line_total: i === 0 ? 1000 : 500,
      }));
      return route.fulfill(json(rows));
    });
    await page.route(/\/rest\/v1\/order_status_history(\?|$)/, (route: Route) =>
      route.request().method() === 'GET' ? route.fulfill(json([])) : route.fallback()
    );
  }

  const SHIPPED = [
    orderRow('NM-26-1042', 'shipped', '2026-11-24T10:00:00Z', 2070),
    orderRow('NM-26-0991', 'delivered', '2026-11-10T10:00:00Z', 1570),
    orderRow('NM-26-0950', 'cancelled', '2026-11-01T10:00:00Z', 870),
  ];

  async function openAccount(page: Page, opts: { width?: number; theme?: 'light' | 'dark'; at?: string; orders?: ReturnType<typeof orderRow>[] } = {}): Promise<void> {
    const width = opts.width ?? 390;
    const theme = opts.theme ?? 'light';
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    if (opts.at) await page.clock.setFixedTime(new Date(opts.at));
    await signInAsTestCustomer(page);
    await fakeProfile(page);
    await fakeOrders(page, opts.orders ?? SHIPPED);
    await page.goto('/account');
    await expect(page.getByTestId('account-home')).toBeVisible({ timeout: 30_000 });
    await setTheme(page, theme);
  }

  test('HI + first name, member since, the latest order card, the tiles (light, 390 px)', async ({ page }) => {
    test.setTimeout(90_000);
    await openAccount(page, { at: '2026-11-25T10:00:00+06:00' });
    await expect(page.getByTestId('account-hi')).toHaveText('HI SADIA');
    await expect(page.getByTestId('account-greeting')).toHaveText('Good Morning');
    await expect(page.getByTestId('account-member-since')).toHaveText('Member since Oct 2026');
    const latest = page.getByTestId('account-latest-order');
    await expect(latest).toContainText('Latest order');
    await expect(latest).toContainText('Track');
    await expect(latest).toContainText('NM-26-1042');
    await expect(latest.locator('.b68-pill')).toHaveText('On the way');
    await expect(latest.locator('.b68-trk i.on')).toHaveCount(3);
    await expect(latest.locator('.b68-tl')).toHaveText(/Placed\s*Confirmed\s*Shipped\s*Delivered/);
    await expect(latest).toContainText('4 items · ');
    await expect(latest).toHaveAttribute('href', `/orders/${SHIPPED[0].id}`);
    // Cancelled orders are not counted.
    await expect(page.getByTestId('account-orders').locator('.b68-tile__n')).toHaveText('2');
    await expect(page.getByTestId('account-orders')).toContainText('Track and manage');
    await expect(page.getByTestId('account-wishlist-count')).toHaveText(/^\d+$/);
    await expect(page.getByTestId('account-wishlist')).toContainText('Saved for later');
    await expect(page.getByTestId('account-delivery')).toContainText('01712345678 · Dhanmondi, Dhaka');
    await expect(page.getByTestId('account-preorders')).toContainText('COMING SOON');
    // No orange on the Account screen.
    const orange = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="account-home"] *')).filter((el) => {
        const s = getComputedStyle(el);
        return s.backgroundColor === 'rgb(255, 122, 69)' || s.color === 'rgb(255, 122, 69)';
      }).length
    );
    expect(orange, 'no orange on Account').toBe(0);
    await noSideScroll(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/07-account-light-390.png`, fullPage: true });
  });

  test('dark mode: no white band above the footer (390 px)', async ({ page }) => {
    test.setTimeout(90_000);
    await openAccount(page, { theme: 'dark', at: '2026-11-25T14:00:00+06:00' });
    await expect(page.getByTestId('account-greeting')).toHaveText('Good Afternoon');
    expect(await page.getByTestId('account-home').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 0, 0)');
    expect(await page.locator('.b68-acct--footer').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 0, 0)');
    await noSideScroll(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/08-account-dark-390.png`, fullPage: true });
  });

  for (const [at, text, icon] of [
    ['2026-11-25T05:00:00+06:00', 'Good Morning', 'sun'],
    ['2026-11-25T12:00:00+06:00', 'Good Afternoon', 'sun'],
    ['2026-11-25T17:00:00+06:00', 'Good Evening', 'moon'],
    ['2026-11-25T02:00:00+06:00', 'Good Evening', 'moon'],
  ] as const) {
    test(`greeting at ${at.slice(11, 16)}: ${text} (${icon})`, async ({ page }) => {
      test.setTimeout(90_000);
      await openAccount(page, { at });
      const greeting = page.getByTestId('account-greeting');
      await expect(greeting).toHaveText(text);
      // The moon icon is the crescent path; the sun has a circle.
      expect(await greeting.locator('svg circle').count()).toBe(icon === 'sun' ? 1 : 0);
      if (at.includes('T02:00')) {
        await page.waitForTimeout(300);
        await page.locator('.b68-me').screenshot({ path: `${SHOTS}/09-greeting-night-moon.png` });
      }
    });
  }

  test('no orders yet: no Latest order card; 360 px fits', async ({ page }) => {
    test.setTimeout(90_000);
    await openAccount(page, { orders: [], width: 360 });
    await expect(page.getByTestId('account-orders').locator('.b68-tile__n')).toHaveText('0');
    await expect(page.getByTestId('account-latest-order')).toHaveCount(0);
    await noSideScroll(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/10-account-no-orders-360.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/11-account-no-orders-390.png` });
  });

  test('Delivery details, Pre-orders and the Log out modal open (Log out is cancelled)', async ({ page }) => {
    test.setTimeout(90_000);
    await openAccount(page);
    await page.getByTestId('account-delivery').click();
    await expect(page.getByRole('dialog', { name: 'Delivery details' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Delivery details' })).toHaveCount(0);

    await page.getByTestId('account-preorders').click();
    await expect(page.getByTestId('preorders-sheet')).toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click();
    await expect(page.getByTestId('preorders-sheet')).toHaveCount(0);

    await page.locator('.b68-out').click();
    const modal = page.getByRole('dialog', { name: 'Log out?' });
    await expect(modal).toContainText('You can sign back in with Google any time.');
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId('account-home')).toBeVisible();
  });
});

/* ------------------------------------------------------------- Admin field */

test('Admin: the Account intro picture field (capture)', async ({ page }) => {
  test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD, 'Needs the test admin in .env.e2e.');
  test.setTimeout(90_000);
  const admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  await page.goto('/admin?tab=design&dset=account-intro');
  const panel = page.getByTestId('account-intro-picture');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText('Account intro picture');
  await expect(panel).toContainText('Shown on the Account tab before a customer signs in. Use a picture with the same orange background (#FF7A45).');
  await expect(panel.getByRole('button', { name: 'Change picture' })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/12-admin-intro-picture.png` });
});
