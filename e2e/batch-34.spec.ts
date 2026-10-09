import { mkdirSync } from 'node:fs';
import type { Browser, ElementHandle, Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, SUPABASE_ANON_KEY, SUPABASE_URL } from './helpers/env';
import { passwordSession, rpc, useSessionInPage, type TestSession } from './helpers/api';
import { totpCode, wrongCode } from './helpers/totp';
import { blockAdTracking } from './helpers/tracking';
import { mockSteadfastByDefault } from './helpers/steadfastMock';
import { signInAsTestCustomer } from './helpers/auth';

// Batch 34 (reports/batch-34.txt). Part 1 only ever uses the TEST Super
// Admin (E2E_ADMIN_EMAIL) — never Naeem's own login. Every Authenticator it
// sets up is removed again in afterAll. Telegram/Steadfast are never
// reached (fixtures.ts mocks Steadfast; ad trackers are blocked).

test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD, 'Needs the test Super Admin in .env.e2e.');
test.describe.configure({ mode: 'serial' });

const SHOTS = 'reports/batch-34-screens';
const NEEDS_036 = 'Needs migration-036 (Batch 34 database update) — not applied yet.';
const THEMES = ['light', 'dark'] as const;
const SIZES = [390, 1280] as const;

/** Set-up keys of the test admin's phones, so afterAll can remove them. */
const secrets = new Map<string, string>();
let migrationReady = false;

/* ---------- Supabase Auth calls for the test admin ---------- */

interface AuthUser {
  factors?: { id: string; status: string; friendly_name?: string }[];
}

function authHeaders(token: string): Record<string, string> {
  return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function getFactors(token: string): Promise<{ id: string; status: string }[]> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: authHeaders(token) });
  const user = (await res.json()) as AuthUser;
  return user.factors ?? [];
}

/** Gives the 6-digit code for a phone → a 2-step (aal2) session. */
async function verifyFactor(token: string, factorId: string, code: string): Promise<TestSession | null> {
  const ch = await fetch(`${SUPABASE_URL}/auth/v1/factors/${factorId}/challenge`, { method: 'POST', headers: authHeaders(token) });
  if (!ch.ok) return null;
  const { id } = (await ch.json()) as { id: string };
  const res = await fetch(`${SUPABASE_URL}/auth/v1/factors/${factorId}/verify`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ challenge_id: id, code }),
  });
  if (!res.ok) return null;
  const t = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string; user: { id: string } };
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in, tokenType: t.token_type, userId: t.user.id, user: t.user };
}

/** Password, then the code from any known phone. */
async function aal2Session(): Promise<TestSession> {
  const s = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  for (const f of await getFactors(s.accessToken)) {
    const secret = secrets.get(f.id);
    if (f.status === 'verified' && secret) {
      const up = await verifyFactor(s.accessToken, f.id, totpCode(secret));
      if (up) return up;
    }
  }
  return s;
}

/** Removes every Authenticator on the test admin. */
async function removeAllFactors(): Promise<void> {
  const s = await aal2Session();
  for (const f of await getFactors(s.accessToken)) {
    await fetch(`${SUPABASE_URL}/auth/v1/factors/${f.id}`, { method: 'DELETE', headers: authHeaders(s.accessToken) });
  }
}

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const s = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  // Half-finished set-ups from an earlier interrupted run can go at aal1.
  for (const f of await getFactors(s.accessToken)) {
    if (f.status !== 'verified') {
      await fetch(`${SUPABASE_URL}/auth/v1/factors/${f.id}`, { method: 'DELETE', headers: authHeaders(s.accessToken) });
    }
  }
  const left = (await getFactors(s.accessToken)).filter((f) => f.status === 'verified');
  if (left.length > 0) {
    throw new Error('The test admin still has an Authenticator from an earlier run — remove it in Supabase → Authentication → Users.');
  }
  migrationReady = (await rpc<boolean>(s.accessToken, 'is_mfa_satisfied')).ok;
});

test.afterAll(async () => {
  await removeAllFactors();
});

async function start(page: Page, theme: 'light' | 'dark', width: number, session: TestSession | null): Promise<void> {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  if (session) await useSessionInPage(page, session);
}

/** Blurs the QR and the set-up key in screenshots. */
async function blurSecrets(page: Page): Promise<void> {
  await page.addStyleTag({ content: '[data-testid="two-step-qr"] img, [data-testid="two-step-key"] { filter: blur(7px); }' });
}

/** A second page with the same protections as the fixture's page. */
async function guardedPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ hasTouch: true, isMobile: false });
  await mockSteadfastByDefault(context);
  const page = await context.newPage();
  await blockAdTracking(page);
  return page;
}

const adminShell = (page: Page) => page.locator('.adm-tabbar:visible, .adm-sidebar:visible').first();

/* ======================= PART 1 — two-step login ======================= */

test('Part 1: an account WITHOUT an Authenticator logs in exactly as today (Naeem is never locked out)', async ({ page }) => {
  const s = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  const isAdmin = await rpc<boolean>(s.accessToken, 'is_admin');
  expect(isAdmin.data).toBe(true);
  if (migrationReady) {
    expect((await rpc<boolean>(s.accessToken, 'is_mfa_satisfied')).data).toBe(true);
    expect((await rpc<unknown[]>(s.accessToken, 'admin_list_profiles')).ok).toBe(true);
  }
  await useSessionInPage(page, s);
  await page.goto('/admin?tab=orders');
  await expect(adminShell(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('two-step-screen')).toHaveCount(0);
});

test('Part 1: set up two-step login in Settings → Security (QR + key, code confirms, status On)', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page, 'light', 390, await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD));
  await page.goto('/admin?tab=settings&sset=security');
  const card = page.getByTestId('two-step-card');
  await expect(card.getByTestId('two-step-status')).toHaveText('Off', { timeout: 15_000 });
  await card.getByRole('button', { name: 'Set up' }).click();
  await expect(card.getByTestId('two-step-qr').locator('img')).toBeVisible();
  const key = (await card.getByTestId('two-step-key').textContent())?.trim() ?? '';
  expect(key).toMatch(/^[A-Z2-7]{16,}$/);
  // A wrong code is refused, the set-up stays open.
  await card.locator('#two-step-setup-code').fill(wrongCode(key));
  await card.getByRole('button', { name: 'Confirm' }).click();
  await expect(card.getByRole('alert')).toContainText('not right');
  await card.locator('#two-step-setup-code').fill(totpCode(key));
  await card.getByRole('button', { name: 'Confirm' }).click();
  await expect(card.getByTestId('two-step-status')).toHaveText('On', { timeout: 15_000 });
  await expect(card).toContainText('Phone 1');
  await expect(card).toContainText('Add a second phone as a backup, so you can still log in if you lose this one.');
  const s = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  const verified = (await getFactors(s.accessToken)).filter((f) => f.status === 'verified');
  expect(verified).toHaveLength(1);
  secrets.set(verified[0].id, key);
});

test('Part 1: log in → code screen; wrong code → error; right code → admin', async ({ page }) => {
  test.setTimeout(60_000);
  const [factorId, secret] = [...secrets.entries()][0];
  expect(factorId).toBeTruthy();
  await page.goto('/admin-access');
  await page.locator('#admin-access-email').fill(E2E_ADMIN_EMAIL);
  await page.locator('#admin-access-password').fill(E2E_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  const screen = page.getByTestId('two-step-screen');
  await expect(screen).toBeVisible({ timeout: 15_000 });
  await expect(adminShell(page)).toHaveCount(0);
  const field = page.locator('#two-step-code');
  await expect(field).toHaveAttribute('inputmode', 'numeric');
  await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
  // Paste with a space still works: auto-submits at 6 digits.
  await field.fill(`${wrongCode(secret).slice(0, 3)} ${wrongCode(secret).slice(3)}`);
  await expect(screen.getByRole('alert')).toContainText('not right', { timeout: 15_000 });
  await field.fill(totpCode(secret));
  await expect(adminShell(page)).toBeVisible({ timeout: 15_000 });
  await expect(screen).toHaveCount(0);
});

test('Part 1: a password-only (aal1) session never sees the admin, and the database refuses Super Admin work', async ({ page }) => {
  const s = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  await useSessionInPage(page, s);
  await page.goto('/admin?tab=orders');
  await expect(page.getByTestId('two-step-screen')).toBeVisible({ timeout: 15_000 });
  await expect(adminShell(page)).toHaveCount(0);
  await page.goto('/admin/orders/new');
  await expect(page.getByTestId('two-step-screen')).toBeVisible({ timeout: 15_000 });
  await expect(adminShell(page)).toHaveCount(0);

  test.skip(!migrationReady, NEEDS_036);
  expect((await rpc<boolean>(s.accessToken, 'is_mfa_satisfied')).data).toBe(false);
  expect((await rpc<boolean>(s.accessToken, 'is_admin')).data).toBe(false);
  expect((await rpc<boolean>(s.accessToken, 'staff_can', { p_perm: 'view_orders' })).data).toBe(false);
  const refused = await rpc<unknown[]>(s.accessToken, 'admin_list_profiles');
  expect(refused.ok && Array.isArray(refused.data) && refused.data.length > 0).toBe(false);
  // The same account after the 6-digit code: allowed again.
  const up = await aal2Session();
  expect((await rpc<boolean>(up.accessToken, 'is_admin')).data).toBe(true);
  expect((await rpc<unknown[]>(up.accessToken, 'admin_list_profiles')).ok).toBe(true);
});

test('Part 1: add a second phone; removing a phone needs a current code', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page, 'light', 390, await aal2Session());
  await page.goto('/admin?tab=settings&sset=security');
  const card = page.getByTestId('two-step-card');
  await expect(card.getByTestId('two-step-status')).toHaveText('On', { timeout: 15_000 });
  await card.getByRole('button', { name: 'Add a backup phone' }).click();
  const key2 = (await card.getByTestId('two-step-key').textContent())?.trim() ?? '';
  await card.locator('#two-step-setup-code').fill(totpCode(key2));
  await card.getByRole('button', { name: 'Confirm' }).click();
  await expect(card).toContainText('Phone 2', { timeout: 15_000 });
  const s = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  for (const f of await getFactors(s.accessToken)) if (!secrets.has(f.id)) secrets.set(f.id, key2);
  expect(secrets.size).toBe(2);

  // Remove Phone 2: a wrong code changes nothing; a code from the phone
  // being removed is not enough while another phone is kept.
  const key1 = [...secrets.values()][0];
  const row2 = card.locator('.two-step-card__device', { hasText: 'Phone 2' });
  await row2.getByRole('button', { name: 'Remove' }).click();
  await card.locator('#two-step-remove-code').fill(wrongCode(key2));
  await card.getByRole('button', { name: 'Remove' }).click();
  await expect(card.getByRole('alert')).toContainText('not right', { timeout: 15_000 });
  await expect(card.locator('.two-step-card__device')).toHaveCount(2);
  await card.locator('#two-step-remove-code').fill(totpCode(key1));
  await card.getByRole('button', { name: 'Remove' }).click();
  await expect(card.locator('.two-step-card__device')).toHaveCount(1, { timeout: 15_000 });
  await expect(card.getByTestId('two-step-status')).toHaveText('On');
  // The admin stays open (the session was put back to the 2-step level).
  await expect(page.getByTestId('two-step-screen')).toHaveCount(0);
  await expect(adminShell(page)).toBeVisible();
});

test('Part 1 screens: Security card off / on, QR step (blurred), code screen — 390 + 1280, light + dark', async ({ page, browser }) => {
  test.setTimeout(240_000);
  // "On" (one phone set up from the tests above).
  for (const theme of THEMES) {
    for (const width of SIZES) {
      const p = await guardedPage(browser);
      await start(p, theme, width, await aal2Session());
      await p.goto('/admin?tab=settings&sset=security');
      await expect(p.getByTestId('two-step-status')).toHaveText('On', { timeout: 15_000 });
      await p.waitForTimeout(300);
      await p.screenshot({ path: `${SHOTS}/security-on-${width}-${theme}.png` });
      await p.context().close();

      const c = await guardedPage(browser);
      await start(c, theme, width, await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD));
      await c.goto('/admin?tab=orders');
      await expect(c.getByTestId('two-step-screen')).toBeVisible({ timeout: 15_000 });
      await c.waitForTimeout(300);
      await c.screenshot({ path: `${SHOTS}/code-screen-${width}-${theme}.png` });
      await c.context().close();
    }
  }
  await removeAllFactors();
  secrets.clear();
  // "Off" and the QR step (started, then cancelled — nothing saved).
  for (const theme of THEMES) {
    for (const width of SIZES) {
      const p = await guardedPage(browser);
      await start(p, theme, width, await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD));
      await p.goto('/admin?tab=settings&sset=security');
      const card = p.getByTestId('two-step-card');
      await expect(card.getByTestId('two-step-status')).toHaveText('Off', { timeout: 15_000 });
      await p.waitForTimeout(300);
      await p.screenshot({ path: `${SHOTS}/security-off-${width}-${theme}.png` });
      await card.getByRole('button', { name: 'Set up' }).click();
      await expect(card.getByTestId('two-step-qr').locator('img')).toBeVisible();
      await blurSecrets(p);
      await p.waitForTimeout(300);
      await p.screenshot({ path: `${SHOTS}/security-qr-${width}-${theme}.png`, fullPage: true });
      await card.getByRole('button', { name: 'Cancel' }).click();
      await expect(card.getByRole('button', { name: 'Set up' })).toBeVisible();
      await p.context().close();
    }
  }
  const s = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  expect(await getFactors(s.accessToken)).toHaveLength(0);
});

/* ============== PART 3 — notify-telegram-order refuses strangers ============== */

test('Part 3: notify-telegram-order refuses a call without / with a wrong shared secret (401, nothing done)', async () => {
  const url = `${SUPABASE_URL}/functions/v1/notify-telegram-order`;
  const body = JSON.stringify({ type: 'INSERT', table: 'orders', record: null, old_record: null });
  const wrong = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'x-notify-secret': 'wrong-secret' },
    body,
  });
  const text = await wrong.text();
  test.skip(wrong.status === 200, 'The new notify-telegram-order is not deployed yet (old version answered).');
  expect(wrong.status).toBe(401);
  expect(text).toBe('{"error":"unauthorized"}');
  const none = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  expect(none.status).toBe(401);
  // The anon (public) key is not the service key: refused too.
  const anon = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SUPABASE_ANON_KEY}` }, body });
  expect(anon.status).toBe(401);
});

/* ======================= PART 4 — Pixel PageView ======================= */

const FAKE_PIXEL = '000000000000034';
const FAKE_GA = 'G-E2EBATCH34';

/** Records every fbq() call; the app's own fbq/gtag set-up keeps working
 *  (the real scripts are blocked by fixtures.ts anyway). */
async function stubTrackers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: unknown[][] = [];
    (window as unknown as { __fbCalls: unknown[][] }).__fbCalls = calls;
    const fbq = (...args: unknown[]) => {
      calls.push(args);
    };
    (window as unknown as { fbq: unknown }).fbq = fbq;
  });
  await page.route(/\/rest\/v1\/app_settings\?/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const rows = ((await res.json()) as { key: string; value: string }[]).filter(
      (r) => r.key !== 'fb_pixel_id' && r.key !== 'ga_measurement_id'
    );
    rows.push({ key: 'fb_pixel_id', value: FAKE_PIXEL }, { key: 'ga_measurement_id', value: FAKE_GA });
    await route.fulfill({ response: res, json: rows });
  });
}

async function trackerCounts(page: Page): Promise<{ fbPageViews: number; gaPageViews: number; fbAll: number; fbOther: string[] }> {
  return page.evaluate(() => {
    const fb = (window as unknown as { __fbCalls?: unknown[][] }).__fbCalls ?? [];
    const dl = ((window as unknown as { dataLayer?: unknown[] }).dataLayer ?? []) as ArrayLike<unknown>[];
    return {
      fbPageViews: fb.filter((a) => a[0] === 'track' && a[1] === 'PageView').length,
      gaPageViews: Array.from(dl).filter((a) => a[0] === 'event' && a[1] === 'page_view').length,
      fbAll: fb.length,
      fbOther: fb.filter((a) => a[0] === 'track' && a[1] !== 'PageView').map((a) => String(a[1])),
    };
  });
}

async function expectPageViews(page: Page, n: number): Promise<void> {
  await expect.poll(async () => (await trackerCounts(page)).fbPageViews, { timeout: 10_000 }).toBe(n);
  // Stays at n (no late duplicate).
  await page.waitForTimeout(600);
  const c = await trackerCounts(page);
  expect(c.fbPageViews).toBe(n);
  expect(c.gaPageViews).toBe(n);
}

test('Part 4: exactly one PageView on first load and one per page change (incl. Back); other events unchanged', async ({ page }) => {
  test.setTimeout(90_000);
  // Checkout asks a visitor to sign in first — the test customer does.
  await signInAsTestCustomer(page);
  await stubTrackers(page);
  await page.goto('/');
  await page.waitForSelector('.product-card');
  await expectPageViews(page, 1);

  await page.locator('.product-card').first().click();
  await expect(page).toHaveURL(/\/product\//);
  await expectPageViews(page, 2);
  // ViewContent still fires (unchanged logic).
  await expect.poll(async () => (await trackerCounts(page)).fbOther.includes('ViewContent')).toBe(true);

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expectPageViews(page, 3);

  await page.getByRole('button', { name: /^Add .* to cart$/ }).first().click();
  await expect.poll(async () => (await trackerCounts(page)).fbOther.includes('AddToCart')).toBe(true);
  await page.goto('/cart');
  // A full reload is a fresh page: one PageView again.
  await expectPageViews(page, 1);
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page).toHaveURL(/\/checkout\/delivery/);
  await expectPageViews(page, 2);
  await page.goBack();
  await expect(page).toHaveURL(/\/cart$/);
  await expectPageViews(page, 3);
});

test('Part 4: a page that redirects at once counts once (empty-cart checkout → cart)', async ({ page }) => {
  await stubTrackers(page);
  await page.goto('/checkout/delivery');
  await expect(page).toHaveURL(/\/cart$/);
  await expectPageViews(page, 1);
});

test('Part 4: admin pages never load or fire Pixel / GA', async ({ page }) => {
  await stubTrackers(page);
  await useSessionInPage(page, await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD));
  await page.goto('/admin?tab=orders');
  await expect(adminShell(page)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.goto('/admin?tab=products');
  await page.waitForTimeout(800);
  const c = await trackerCounts(page);
  expect(c.fbAll).toBe(0);
  expect(c.gaPageViews).toBe(0);
  expect(await page.evaluate(() => typeof (window as unknown as { gtag?: unknown }).gtag)).toBe('undefined');
});

/* =============== PART 5 — no square box behind rounded controls =============== */

interface Control {
  name: string;
  /** Opens the page / state, returns the control. */
  open: (page: Page) => Promise<Locator>;
  /** Tap may close or leave the control (sheet close, links): then only
   *  the keyboard check is meaningful after it. */
  leaves?: boolean;
}

interface StyleSnap {
  outline: string;
  shadow: string;
  bg: string;
  radius: number;
}

/** Outline/box-shadow/background of the control and 4 wrappers around it
 *  (null once the control has left the page, e.g. a sheet's Close). */
async function snapshot(handle: ElementHandle<Element>): Promise<StyleSnap[] | null> {
  return handle
    .evaluate((el) => {
      if (!el.isConnected) return null;
      const out: { outline: string; shadow: string; bg: string; radius: number }[] = [];
      let n: Element | null = el;
      for (let i = 0; i < 5 && n && n !== document.body; i++, n = n.parentElement) {
        const c = getComputedStyle(n);
        out.push({
          outline: c.outlineStyle === 'none' || parseFloat(c.outlineWidth) === 0 ? 'none' : `${c.outlineStyle} ${c.outlineWidth}`,
          shadow: c.boxShadow,
          bg: c.backgroundColor,
          radius: parseFloat(c.borderTopLeftRadius) || 0,
        });
      }
      return out;
    })
    .catch(() => null);
}

/** (a) A tap shows no outline anywhere and no new box on a square wrapper. */
async function tapProblems(page: Page, loc: Locator): Promise<string[]> {
  // Middle of the screen, never under a sticky bar.
  await loc.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  await page.waitForTimeout(100);
  const handle = await loc.elementHandle();
  if (!handle) return ['tap: control not found'];
  const before = await snapshot(handle);
  const tapped = await loc
    .tap({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!tapped) return ['tap: could not tap the control'];
  await page.waitForTimeout(150);
  const after = await snapshot(handle);
  if (!before || !after) return [];
  const problems: string[] = [];
  after.forEach((s, i) => {
    if (s.outline !== 'none') problems.push(`tap: outline on ${i === 0 ? 'the control' : `wrapper ${i}`}`);
    if (i > 0 && before[i] && s.radius === 0 && (s.shadow !== before[i].shadow || s.bg !== before[i].bg)) {
      problems.push(`tap: box drawn on square wrapper ${i}`);
    }
  });
  if (after[0].shadow !== 'none' && after[0].radius === 0 && after[0].shadow !== before[0].shadow) {
    problems.push('tap: glow on a square control');
  }
  return problems;
}

/** (b) Keyboard focus shows a ring on the control itself (or the rounded
 *  box around a borderless field), following its rounded corners. */
async function keyboardProblems(page: Page, loc: Locator): Promise<string[]> {
  // A tapped <select> may have its picker open, which would take the Tab.
  if (await loc.evaluate((el) => el.tagName === 'SELECT')) await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await loc.focus();
  await page.waitForTimeout(100);
  const ring = await loc.evaluate((el) => {
    const focused = document.activeElement ?? el;
    const candidates: Element[] = [focused];
    const host = focused.closest('.focus-host');
    if (host) candidates.push(host);
    for (const n of candidates) {
      const c = getComputedStyle(n);
      const outline = c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0;
      const glow = c.boxShadow !== 'none' && /\s(\d+(\.\d+)?)px\)?$|px\s\d/.test(c.boxShadow);
      if (outline || glow) return { found: true, radius: parseFloat(c.borderTopLeftRadius) || 0 };
    }
    return { found: false, radius: 0 };
  });
  if (!ring.found) return ['keyboard: no focus ring'];
  if (ring.radius === 0) return ['keyboard: ring on a square box'];
  return [];
}

async function checkControls(page: Page, controls: Control[]): Promise<string[]> {
  const report: string[] = [];
  for (const c of controls) {
    const loc = await c.open(page);
    const shown = await loc
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!shown) {
      report.push(`FAIL ${c.name} — control not found`);
      continue;
    }
    const tap = await tapProblems(page, loc);
    let key: string[];
    if (c.leaves) {
      const again = await c.open(page);
      key = await keyboardProblems(page, again);
    } else {
      key = await keyboardProblems(page, loc);
    }
    const problems = [...tap, ...key];
    report.push(`${problems.length === 0 ? 'OK  ' : 'FAIL'} ${c.name}${problems.length ? ' — ' + problems.join('; ') : ''}`);
  }
  return report;
}

const goto = (path: string, selector: (p: Page) => Locator) => async (page: Page) => {
  const target = new URL(path, 'http://x');
  const here = new URL(page.url() === 'about:blank' ? 'http://x/blank' : page.url());
  if (here.pathname + here.search !== target.pathname + target.search) await page.goto(path);
  return selector(page);
};

const ADMIN_CONTROLS: Control[] = [
  { name: 'Admin: Orders search', open: goto('/admin?tab=orders', (p) => p.locator('.adm-search__input').first()) },
  { name: 'Admin: Orders filter chip', open: goto('/admin?tab=orders', (p) => p.locator('.adm-chip').first()) },
  { name: 'Admin: Orders source filter', open: goto('/admin?tab=orders', (p) => p.locator('.adm-select').first()) },
  { name: 'Admin: Products search', open: goto('/admin?tab=products', (p) => p.locator('.adm-search__input').first()) },
  { name: 'Admin: Customers search', open: goto('/admin?tab=customers', (p) => p.locator('.adm-search__input').first()) },
  { name: 'Admin: Activity Log person filter', open: goto('/admin?tab=activity', (p) => p.getByLabel('Filter by person')) },
  { name: 'Admin: Activity Log date field', open: goto('/admin?tab=activity', (p) => p.getByLabel('From date')) },
  { name: 'Admin: Team segmented control', open: goto('/admin?tab=team', (p) => p.locator('.adm-segment__tab').first()) },
  { name: 'Admin: New order → product search', open: goto('/admin/orders/new', (p) => p.getByPlaceholder('Search product name...')) },
  { name: 'Admin: New order → customer search', open: goto('/admin/orders/new', (p) => p.locator('#manual-order-customer')) },
  { name: 'Admin: Settings field', open: goto('/admin?tab=settings&sset=order-number', (p) => p.locator('.adm .form-input').first()) },
  { name: 'Admin: Settings → Security Set up button', open: goto('/admin?tab=settings&sset=security', (p) => p.getByTestId('two-step-card').getByRole('button').first()) },
  { name: 'Admin: page menu (kebab) button', open: goto('/admin?tab=orders', (p) => p.locator('.adm-kebab').first()) },
];

test('Part 5: admin — every field and button: tap shows no box, keyboard shows a rounded ring (390 px)', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page, 'light', 390, await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD));
  const controls: Control[] = [
    ...ADMIN_CONTROLS,
    { name: 'Admin: bottom bar', open: goto('/admin?tab=orders', (p) => p.locator('.adm-tabbar__tab--on').first()) },
    {
      // A real order's page is only opened and left — nothing is changed.
      // (Batch 35: the order is a page; its Back button replaces ✕.)
      name: 'Admin: order page Back button',
      leaves: true,
      open: async (p) => {
        await p.goto('/admin?tab=orders');
        await p.locator('.adm-orow__number').first().click();
        return p.getByRole('button', { name: 'Back to orders' }).first();
      },
    },
  ];
  const report = await checkControls(page, controls);
  console.log(report.join('\n'));
  expect(report.filter((l) => l.startsWith('FAIL'))).toEqual([]);
});

test('Part 5: admin sidebar and thana picker search (1280 px + New order)', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, 'light', 1280, await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD));
  const report = await checkControls(page, [
    { name: 'Admin: sidebar item', open: goto('/admin?tab=orders', (p) => p.locator('.adm-sidebar__item--on').first()) },
    { name: 'Admin: Orders search (PC)', open: goto('/admin?tab=orders', (p) => p.locator('.adm-search__input').first()) },
    {
      name: 'Admin: thana picker search',
      open: async (p) => {
        if (await p.getByLabel('Search thana').isVisible().catch(() => false)) return p.getByLabel('Search thana');
        await p.goto('/admin/orders/new');
        const division = p.locator('[id$="-division"]').first();
        await division.waitFor({ timeout: 15_000 });
        const prefix = (await division.getAttribute('id'))!.replace(/-division$/, '');
        await division.click();
        await p.getByPlaceholder('Search division...').fill('Dhaka');
        await p.locator('.picker-sheet__row', { hasText: /^Dhaka$/ }).first().click();
        await p.locator(`#${prefix}-district`).click();
        await p.getByPlaceholder('Search district...').fill('Dhaka');
        await p.locator('.picker-sheet__row', { hasText: /^Dhaka$/ }).first().click();
        await p.locator(`#${prefix}-thana`).click();
        return p.getByLabel('Search thana');
      },
    },
  ]);
  console.log(report.join('\n'));
  expect(report.filter((l) => l.startsWith('FAIL'))).toEqual([]);
});

const CHECKOUT_STATE = {
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

test('Part 5: shop — every field and button: tap shows no box, keyboard shows a rounded ring', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript((state) => window.sessionStorage.setItem('nph_checkout_state', state), JSON.stringify(CHECKOUT_STATE));
  await page.goto('/');
  await page.waitForSelector('.product-card');
  await page.getByRole('button', { name: /^Add .* to cart$/ }).first().click();
  const report = await checkControls(page, [
    { name: 'Shop: Home search', leaves: true, open: goto('/', (p) => p.locator('.search-bar--entry').first()) },
    {
      name: 'Shop: category chip (brand page)',
      open: async (p) => {
        const path = new URL(p.url()).pathname;
        if (!path.startsWith('/brand') || path === '/brands') {
          await p.goto('/brands');
          await p.locator('a[href^="/brand"]:not([href="/brands"])').first().click();
          await p.waitForURL((u) => u.pathname.startsWith('/brand') && u.pathname !== '/brands');
        }
        return p.locator('.chip:visible').nth(1);
      },
    },
    { name: 'Shop: "See all" link', leaves: true, open: goto('/', (p) => p.locator('.brand-row__all').first()) },
    { name: 'Shop: bottom nav', open: goto('/', (p) => p.locator('.bottom-nav__tab').first()) },
    { name: 'Shop: Search page field', open: goto('/search', (p) => p.locator('.search-bar__input').first()) },
    { name: 'Shop: cart quantity stepper', open: goto('/cart', (p) => p.getByRole('button', { name: /^Increase quantity of/ }).first()) },
    { name: 'Shop: checkout field', open: goto('/checkout/delivery', (p) => p.locator('.form-input').first()) },
    { name: 'Shop: promo code field', open: goto('/checkout/summary', (p) => p.locator('.checkout-summary-card__promo-input')) },
    { name: 'Shop: wholesaler login field', open: goto('/wholesaler-access', (p) => p.locator('input.form-input').first()) },
    { name: 'Shop: admin login field', open: goto('/admin-access', (p) => p.locator('#admin-access-email')) },
  ]);
  console.log(report.join('\n'));
  expect(report.filter((l) => l.startsWith('FAIL'))).toEqual([]);
});

test('Part 5: two-step code field — tap shows no box, keyboard shows a rounded ring', async ({ page }) => {
  test.setTimeout(90_000);
  // A phone set up just for this check (removed in afterAll).
  const s = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  const en = await fetch(`${SUPABASE_URL}/auth/v1/factors`, {
    method: 'POST',
    headers: authHeaders(s.accessToken),
    body: JSON.stringify({ factor_type: 'totp', friendly_name: 'E2E focus check' }),
  });
  const factor = (await en.json()) as { id: string; totp: { secret: string } };
  secrets.set(factor.id, factor.totp.secret);
  expect(await verifyFactor(s.accessToken, factor.id, totpCode(factor.totp.secret))).not.toBeNull();
  await useSessionInPage(page, await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD));
  const report = await checkControls(page, [
    { name: 'Two-step code field', open: goto('/admin?tab=orders', (p) => p.locator('#two-step-code')) },
    { name: 'Two-step "Use a different account"', leaves: true, open: goto('/admin?tab=orders', (p) => p.locator('.two-step__other')) },
  ]);
  console.log(report.join('\n'));
  expect(report.filter((l) => l.startsWith('FAIL'))).toEqual([]);
  await removeAllFactors();
  secrets.clear();
});

test('Part 5 screens: each admin search field tapped — 390 + 1280, light + dark', async ({ browser }) => {
  test.setTimeout(240_000);
  const fields: { name: string; path: string; sel: (p: Page) => Locator }[] = [
    { name: 'orders', path: '/admin?tab=orders', sel: (p) => p.locator('.adm-search__input').first() },
    { name: 'products', path: '/admin?tab=products', sel: (p) => p.locator('.adm-search__input').first() },
    { name: 'customers', path: '/admin?tab=customers', sel: (p) => p.locator('.adm-search__input').first() },
    { name: 'new-order-product', path: '/admin/orders/new', sel: (p) => p.getByPlaceholder('Search product name...') },
    { name: 'new-order-customer', path: '/admin/orders/new', sel: (p) => p.locator('#manual-order-customer') },
  ];
  const session = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  for (const theme of THEMES) {
    for (const width of SIZES) {
      const page = await guardedPage(browser);
      await start(page, theme, width, session);
      for (const f of fields) {
        await page.goto(f.path);
        const loc = f.sel(page);
        await loc.waitFor({ timeout: 15_000 });
        await loc.scrollIntoViewIfNeeded();
        await loc.tap();
        await page.waitForTimeout(250);
        const box = await loc.boundingBox();
        const top = Math.max(0, (box?.y ?? 0) - 120);
        await page.screenshot({ path: `${SHOTS}/search-${f.name}-${width}-${theme}.png`, clip: { x: 0, y: top, width, height: 320 } });
      }
      await page.context().close();
    }
  }
});
