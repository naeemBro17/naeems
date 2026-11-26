import { mkdirSync, readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, useSessionInPage, type TestSession } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';

// Batch 53: the glass clock that always fits, honest courier + COD fees in
// profit, and the glass Account page.
//
// The live shop is never changed. The database rules run in
// e2e/sql/batch-53.sql against today's live functions (Batch 61: no old migration is replayed) inside
// ONE transaction that is always rolled back. The screens answer the one
// new database answer they need (order_profit's courier label) in the
// browser, with the numbers the migration gives (checked in that
// transaction), so nothing needs the SQL to have been run.

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-53-screens';

let admin: TestSession;
let customer: TestSession;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  customer = await passwordSession(E2E_EMAIL, E2E_PASSWORD);
});

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function open(page: Page, theme: 'light' | 'dark', width: number, session: TestSession, path: string): Promise<void> {
  await page.setViewportSize({ width, height: width > 1000 ? 900 : 844 });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  await useSessionInPage(page, session);
  await page.goto(path);
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
}

/* ------------------------------------------------------ the database rules */

test('database: payout split, labels, expected fee, guard, Money unchanged (one rolled-back transaction)', async () => {
  test.setTimeout(300_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  const fill = (s: string) => s.replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL);
  const before = fill(readFileSync('e2e/sql/batch-53-before.sql', 'utf8'));
  const tests = fill(readFileSync('e2e/sql/batch-53.sql', 'utf8'));
  const output = await runSql(`BEGIN;\n${before}\n${tests}`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(21);
});

/* ------------------------------------------------------- Part 1: the clock */

/** Dhaka is UTC+6: 10:00:00 in Dhaka is 04:00:00 UTC. */
const TIMES: { label: string; utc: string; shot: boolean }[] = [
  { label: '10:00', utc: '2026-11-19T04:00:00Z', shot: true },
  { label: '12:59', utc: '2026-11-19T06:59:59Z', shot: true },
  { label: '12:08', utc: '2026-11-19T06:08:08Z', shot: false },
  { label: '4:59', utc: '2026-11-19T10:59:59Z', shot: true },
];
const CLOCK_WIDTHS = [320, 360, 390, 430, 1280];

for (const theme of ['light', 'dark'] as const) {
  test(`admin home clock (${theme}): fits the card at 320–430 px and 1280 px for 10:00, 12:59, 12:08 and 4:59`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.clock.setFixedTime(new Date(TIMES[0].utc));
    await open(page, theme, CLOCK_WIDTHS[0], admin, '/admin');
    const clock = page.getByTestId('admin-clock');
    await expect(clock).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    for (const width of CLOCK_WIDTHS) {
      await page.setViewportSize({ width, height: width > 1000 ? 900 : 844 });
      for (const t of TIMES) {
        await page.clock.setFixedTime(new Date(t.utc));
        // The clock reads the time again when the page becomes visible.
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await expect(clock).toHaveAttribute('aria-label', t.label);
        const fit = await page.evaluate(() => {
          const hero = document.querySelector('[data-testid="admin-hero"]') as HTMLElement;
          const box = hero.getBoundingClientRect();
          const pad = parseFloat(getComputedStyle(hero).paddingRight);
          const digits = (document.querySelector('.adm-clock__t') as HTMLElement).getBoundingClientRect();
          const seconds = (document.querySelector('[data-testid="admin-clock-seconds"]') as HTMLElement).getBoundingClientRect();
          return { right: Math.max(digits.right, seconds.right), limit: box.right - pad, left: digits.left, start: box.left };
        });
        expect(fit.right, `${t.label} at ${width} px: the seconds are not cut off`).toBeLessThanOrEqual(fit.limit + 0.5);
        expect(fit.left).toBeGreaterThanOrEqual(fit.start);
        if (width < 1000) await noSidewaysScroll(page);
        if (t.shot) {
          const hero = page.getByTestId('admin-hero');
          await hero.screenshot({ path: `${SHOTS}/${theme}-clock-${width}-${t.label.replace(':', '')}.png` });
        }
      }
    }
  });
}

test('admin home clock: only the seconds change every second, without moving sideways', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, 'light', 390, admin, '/admin');
  const seconds = page.getByTestId('admin-clock-seconds');
  await expect(seconds).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const minutesEl = page.locator('.adm-clock__t > .adm-clock__d').nth(1);
  // Count how often the hours / minutes and the seconds are rewritten.
  await page.evaluate(() => {
    const w = window as unknown as { hmChanges: number; sChanges: number };
    w.hmChanges = 0;
    w.sChanges = 0;
    const digits = document.querySelectorAll('.adm-clock__t > .adm-clock__d');
    const s = document.querySelector('[data-testid="admin-clock-seconds"]') as HTMLElement;
    const watch = (el: Element, key: 'hmChanges' | 'sChanges') =>
      new MutationObserver(() => (w[key] += 1)).observe(el, { childList: true, characterData: true, subtree: true });
    digits.forEach((d) => watch(d, 'hmChanges'));
    watch(s, 'sChanges');
  });
  const x0 = (await seconds.boundingBox())?.x ?? 0;
  const m0 = (await minutesEl.boundingBox())?.x ?? 0;
  await page.waitForTimeout(3200);
  const counts = await page.evaluate(() => {
    const w = window as unknown as { hmChanges: number; sChanges: number };
    return { hm: w.hmChanges, s: w.sChanges };
  });
  expect(counts.s, 'the seconds ticked').toBeGreaterThanOrEqual(2);
  expect(counts.hm, 'hours / minutes untouched (at most one minute change)').toBeLessThanOrEqual(2);
  expect(Math.abs(((await seconds.boundingBox())?.x ?? 0) - x0), 'the seconds do not jump sideways').toBeLessThanOrEqual(0.5);
  expect(Math.abs(((await minutesEl.boundingBox())?.x ?? 0) - m0)).toBeLessThanOrEqual(0.5);
  await expect(page.locator('.adm-clock__d').first()).toHaveCSS('transition-duration', '0s');
});

/* ---------------------------------------------- Part 2: the Profit card */

/** order_profit as the Batch 53 SQL answers it (the same numbers the
 *  rolled-back database test checks; NM-3324's payout held one parcel). */
const PROFIT: Record<string, Record<string, unknown>> = {
  'NM-3917': { status: 'delivered', costed: true, sale: 870, cost: 575, provisional: 0, delivery: 130, courier: 114, courier_known: true, courier_kind: 'share', courier_charge: 105, cod_fee: 9, bill_paid_separately: 0, profit: 311, margin: 35.7, counted_at: '2026-11-18T20:35:12Z', filled_adjustments: 0 },
  'NM-3319': { status: 'delivered', costed: true, sale: 2050, cost: 1590, provisional: 0, delivery: 0, courier: 64, courier_known: false, courier_kind: 'expected', courier_charge: 64, cod_fee: 0, bill_paid_separately: 0, profit: 396, margin: 19.3, counted_at: '2026-11-04T14:37:56Z', filled_adjustments: 0 },
  'NM-1639': { status: 'delivered', costed: true, sale: 1300, cost: 860, provisional: 0, delivery: 0, courier: 0, courier_known: true, courier_kind: 'none', courier_charge: 0, cod_fee: 0, bill_paid_separately: 0, profit: 440, margin: 33.8, counted_at: '2026-10-06T09:52:51Z', filled_adjustments: 0 },
};
const LABELS: [string, string, string | null][] = [
  ['NM-3324', 'From Steadfast', null],
  ['NM-3917', 'Share of payout', null],
  ['NM-3319', 'Expected', 'Waiting for Steadfast payout'],
  ['NM-1639', 'No courier', null],
];

for (const [orderNumber, label, note] of LABELS) {
  test(`order ${orderNumber}: the courier + COD fee says "${label}" (small, grey, not orange)`, async ({ page }) => {
    test.setTimeout(90_000);
    let calls = 0;
    await page.route(/\/rest\/v1\/rpc\/order_profit/, async (route) => {
      calls += 1;
      const fixed = PROFIT[orderNumber];
      if (fixed) return json(route, fixed);
      // A payout with one parcel: the live numbers, plus the label.
      const res = await route.fetch();
      return json(route, { ...((await res.json()) as Record<string, unknown>), courier_kind: 'exact' });
    });
    await open(page, 'light', 390, admin, `/admin/orders/${orderNumber}`);
    const tag = page.getByTestId('order-profit-courier-tag');
    await expect(tag).toHaveText(label, { timeout: 30_000 });
    if (note) await expect(page.getByTestId('order-profit-courier')).toContainText(note);
    const colour = await tag.evaluate((el) => getComputedStyle(el).color);
    const [r, g, b] = (colour.match(/\d+/g) ?? []).map(Number);
    expect(Math.max(r, g, b) - Math.min(r, g, b), 'grey, not a colour').toBeLessThanOrEqual(12);
    if (orderNumber === 'NM-3917') {
      await expect(page.getByTestId('order-profit-courier')).toContainText('114');
      await expect(page.getByTestId('order-profit-total')).toContainText('311');
    }
    await page.getByTestId('order-profit').scrollIntoViewIfNeeded();
    await page.getByTestId('order-profit').screenshot({ path: `${SHOTS}/light-profit-${label.toLowerCase().replaceAll(' ', '-')}.png` });
    await noSidewaysScroll(page);

    if (orderNumber === 'NM-3917') {
      // 2.5: it reads the profit again when the page comes back into view…
      const before = calls;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect.poll(() => calls).toBeGreaterThan(before);
      // …and when the Payouts page is refreshed in another tab.
      const after = calls;
      const other = await page.context().newPage();
      await other.goto('/');
      await other.evaluate(() => {
        const channel = new BroadcastChannel('naeems-courier-costs');
        channel.postMessage('changed');
        channel.close();
      });
      await expect.poll(() => calls).toBeGreaterThan(after);
      await other.close();
      // No timer: nothing is read while the page just sits there.
      const idle = calls;
      await page.waitForTimeout(4000);
      expect(calls, 'no polling').toBe(idle);
    }
  });
}

/* ------------------------------------------------- Part 3: the Account page */

for (const theme of ['light', 'dark'] as const) {
  for (const width of [360, 390, 430]) {
    test(`account page at ${width} px (${theme}): soft glow background (Batch 68 layout), the list, the Pre-orders sheet`, async ({ page }) => {
      test.setTimeout(90_000);
      await open(page, theme, width, customer, '/account');
      const list = page.getByTestId('account-list');
      await expect(list).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('account-preorders')).toContainText('COMING SOON');
      await expect(page.getByText('Delivery details')).toBeVisible();
      await expect(page.getByText('My Orders')).toBeVisible();
      await expect(page.getByText('Need help?')).toBeVisible();
      await expect(page.getByText(/Welcome back|Hi, /)).toHaveCount(0);
      await page.waitForTimeout(300);
      // Glass: Batch 68 keeps blur to the two small chips at the top (Back
      // and Member since), plus the sheet while it is open.
      const blurred = () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('body *')).filter((el) => {
            const s = getComputedStyle(el);
            const f = s.backdropFilter || s.getPropertyValue('-webkit-backdrop-filter');
            const r = el.getBoundingClientRect();
            return f && f !== 'none' && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
          }).length
        );
      expect(await blurred(), 'two small blurred chips').toBeLessThanOrEqual(2);
      // Readable text: near-black / near-white on the glass.
      const label = await page.locator('.b68-li b').first().evaluate((el) => getComputedStyle(el).color);
      const lum = (label.match(/\d+/g) ?? []).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
      expect(theme === 'light' ? lum < 60 : lum > 200, `row text ${label}`).toBe(true);
      await noSidewaysScroll(page);
      await page.screenshot({ path: `${SHOTS}/${theme}-account-${width}.png` });

      await page.getByTestId('account-preorders').click();
      await expect(page.getByTestId('preorders-sheet')).toBeVisible();
      await page.waitForTimeout(450);
      expect(await blurred(), 'the two chips and the sheet').toBeLessThanOrEqual(3);
      await page.screenshot({ path: `${SHOTS}/${theme}-account-${width}-preorders-sheet.png` });
      await page.getByRole('button', { name: 'Got it' }).click();
      await expect(page.getByTestId('preorders-sheet')).toHaveCount(0);
    });
  }
}
