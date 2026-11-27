import { mkdirSync, readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_EMAIL, E2E_PASSWORD } from './helpers/env';
import { passwordSession, select, useSessionInPage, type TestSession } from './helpers/api';
import { rowResult, runSql, sqlError, supabaseCli } from './helpers/sqlRunner';
import { signInAsTestCustomer } from './helpers/auth';

// Batch 48: checkout finish — the slim stepper, Nagad next to bKash, the
// advance-payment discount and the new Order placed screen.
//
// The live shop is never changed. The checkout is driven at phone width
// with a real cart, but place_order is answered in the browser (no order is
// placed), and the three advance-discount settings are added to the
// settings the page loads (so this works before migration-049 is run).
// The real database rules — the discount worked out by the server, Nagad,
// Edit order — run in e2e/sql/batch-48.sql against today's live functions (Batch 61: no old
// migration is replayed), inside ONE transaction that is always rolled back.
// No real Storage file is downloaded (./fixtures).

test.describe.configure({ mode: 'serial' });
test.skip(!E2E_ADMIN_EMAIL || !E2E_ADMIN_PASSWORD || !E2E_EMAIL || !E2E_PASSWORD, 'Needs the test accounts in .env.e2e.');
test.use({ serviceWorkers: 'block' });

const SHOTS = 'reports/batch-48-screens';
const SHOTS69 = 'reports/batch-69-screens';
const SHOTS691 = 'reports/batch-69-1-screens';
const WIDTH = 360;

let admin: TestSession;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(SHOTS69, { recursive: true });
  mkdirSync(SHOTS691, { recursive: true });
  admin = await passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
});

/* ------------------------------------------------------ the database rules */

test('database: Nagad, the advance discount worked out by the server (percent, fixed, promo + discount, Off, 0, COD), Edit order payment method (one rolled-back transaction)', async () => {
  test.setTimeout(300_000);
  test.skip(supabaseCli() === null, 'The Supabase command line is not on this computer.');
  const tests = readFileSync('e2e/sql/batch-48.sql', 'utf8')
    .replaceAll('{{ADMIN_EMAIL}}', E2E_ADMIN_EMAIL)
    .replaceAll('{{CUSTOMER_EMAIL}}', E2E_EMAIL);
  const output = await runSql(`BEGIN;\n${tests}`);
  const results = rowResult<{ name: string; ok: boolean; detail: string }[]>(output);
  expect(results, sqlError(output) ?? 'no result').not.toBeNull();
  const failed = (results ?? []).filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);
  expect(failed).toEqual([]);
  expect((results ?? []).length).toBeGreaterThanOrEqual(24);
  // Nothing of it stayed.
  const left = await select<unknown[]>(admin.accessToken, 'products?select=id&sku=like.E2E-B48-*');
  expect(left.data).toHaveLength(0);
});

/* ------------------------------------------------------------ the checkout */

const ADDRESS = {
  fullName: 'Ashraful Islam',
  phone: '01712345678',
  division: 'Dhaka',
  district: 'Dhaka',
  thana: 'Gulshan',
  fullAddress: '123 Test Road (e2e)',
};

type Rule = { enabled: boolean; type: 'percent' | 'fixed'; value: number };
const HALF_PERCENT: Rule = { enabled: true, type: 'percent', value: 0.5 };

/** The settings the page loads, plus the three Batch 48 rows. */
async function withAdvanceSettings(page: Page, rule: Rule): Promise<void> {
  await page.route(/\/rest\/v1\/app_settings\?/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    // Batch 62: a page that has already moved on drops the background
    // refresh's answer (nothing to change then).
    let response: Awaited<ReturnType<Route['fetch']>>;
    let all: { key: string; value: string }[];
    try {
      response = await route.fetch();
      all = (await response.json()) as { key: string; value: string }[];
    } catch {
      return;
    }
    const rows = all.filter((r) => !r.key.startsWith('advance_discount_'));
    rows.push(
      { key: 'advance_discount_enabled', value: rule.enabled ? 'true' : 'false' },
      { key: 'advance_discount_type', value: rule.type },
      { key: 'advance_discount_value', value: String(rule.value) }
    );
    await route.fulfill({ response, json: rows }).catch(() => undefined);
  });
}

interface Product {
  id: string;
  name: string;
  price: number;
}

let product: Product | null = null;
let insideFee = 70;

async function shopProduct(): Promise<Product | null> {
  if (product) return product;
  const list = await select<{ id: string; name: string; retail_price: number; offer_price: number | null }[]>(
    null,
    'products_view?select=id,name,retail_price,offer_price&is_active=eq.true&stock_quantity=gte.3&limit=50'
  );
  // Batch 60: the advance discount needs ৳1,000 or more paid in advance, so
  // the cart (2 of it) must reach that: a product selling at ৳500 or more.
  const first = (list.data ?? []).find((p) => (p.offer_price !== null && p.offer_price < p.retail_price ? p.offer_price : p.retail_price) >= 500);
  const fee = await select<{ value: string }[]>(null, 'app_settings?select=value&key=eq.delivery_fee_inside_dhaka');
  const feeValue = Number(fee.data?.[0]?.value);
  if (Number.isFinite(feeValue) && feeValue >= 0) insideFee = feeValue;
  if (!first) return null;
  const price = first.offer_price !== null && first.offer_price < first.retail_price ? first.offer_price : first.retail_price;
  product = { id: first.id, name: first.name, price: Number(price) };
  return product;
}

interface PlacedCall {
  body: Record<string, unknown>;
}

/** Signs in, puts one product (×2) in the cart with a delivery address and
 *  answers place_order in the browser with the totals the database would
 *  save. Returns the calls made. */
async function openPaymentStep(page: Page, p: Product, rule: Rule, orderNumber: string): Promise<PlacedCall[]> {
  await page.setViewportSize({ width: WIDTH, height: 780 });
  await signInAsTestCustomer(page);
  await withAdvanceSettings(page, rule);
  const cart = [{ productId: p.id, variantId: null, variantLabel: null, quantity: 2, priceAtAdd: p.price }];
  await page.addInitScript(
    ([c, s]) => {
      if (window.sessionStorage.getItem('e2e-b48-seeded')) return;
      window.sessionStorage.setItem('e2e-b48-seeded', '1');
      window.localStorage.setItem('nph_cart', c);
      window.sessionStorage.setItem('nph_checkout_state', s);
    },
    [JSON.stringify(cart), JSON.stringify({ zoneId: 'inside_dhaka', address: ADDRESS, promo: null, lastOrder: null })]
  );
  // The Android buzz is recorded, never felt.
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    (window as unknown as { __vibrations: unknown[] }).__vibrations = calls;
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (pattern: unknown) => {
        calls.push(pattern);
        return true;
      },
    });
  });
  const calls: PlacedCall[] = [];
  await page.route(/\/rest\/v1\/rpc\/place_order/, async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push({ body });
    const subtotal = p.price * 2;
    const wallet = body.p_payment_method === 'bkash' || body.p_payment_method === 'nagad';
    const advance = wallet && rule.enabled ? (rule.type === 'percent' ? Math.round((subtotal * rule.value) / 100) : Math.min(rule.value, subtotal)) : 0;
    await route.fulfill({
      json: [
        {
          order_id: '00000000-0000-4000-8000-000000004848',
          order_number: orderNumber,
          total: subtotal + insideFee - advance,
          discount: advance,
          advance_discount: advance,
        },
      ],
    });
  });
  await page.goto('/checkout/summary');
  await expect(page.getByRole('button', { name: /Place order/i })).toBeVisible({ timeout: 20_000 });
  return calls;
}

function expectedAdvance(p: Product, rule: Rule): number {
  const subtotal = p.price * 2;
  return rule.type === 'percent' ? Math.round((subtotal * rule.value) / 100) : Math.min(rule.value, subtotal);
}

const taka = (n: number) => `৳ ${n.toLocaleString('en-US')}`;

async function totalTarget(page: Page): Promise<number> {
  return Number(await page.getByTestId('summary-total').locator('[data-total]').getAttribute('data-total'));
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at phone width').toBeLessThanOrEqual(0);
}

async function payWithWallet(page: Page, wallet: 'bkash' | 'nagad', p: Product): Promise<void> {
  const name = wallet === 'bkash' ? 'bKash' : 'Nagad';
  await page.getByTestId(`pay-option-${wallet}`).click();
  await expect(page.getByTestId(`pay-option-${wallet}`)).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('pay-option-cod')).toHaveAttribute('aria-checked', 'false');
  const advance = expectedAdvance(p, HALF_PERCENT);
  const line = page.getByTestId('summary-advance');
  await expect(line).toContainText('Advance payment 0.5%');
  await expect(line).toContainText(taka(advance));
  const total = p.price * 2 + insideFee - advance;
  expect(await totalTarget(page)).toBe(total);
  // The count-down lands on the new total.
  await expect(page.getByTestId('summary-total')).toContainText(taka(total));
  await expect(page.getByTestId('summary-total')).toContainText('Total payment');
  const box = page.getByTestId('wallet-box');
  await expect(box).toContainText(`Pay with ${name}`);
  await expect(page.getByTestId('wallet-amount')).toHaveText(taka(total));
  await expect(box.getByLabel(new RegExp(`Your ${name} number`))).toBeVisible();
  // Batch 67: the steps open right under the chosen wallet, inside the group.
  await expect(page.getByTestId('pay-advance-group').getByTestId('wallet-box')).toBeVisible();
  const [optBox, stepsBox] = await Promise.all([
    page.getByTestId(`pay-option-${wallet}`).boundingBox(),
    box.boundingBox(),
  ]);
  expect(optBox && stepsBox && stepsBox.y >= optBox.y + optBox.height).toBe(true);
  if (wallet === 'bkash') {
    const nagadBox = await page.getByTestId('pay-option-nagad').boundingBox();
    expect(stepsBox && nagadBox && stepsBox.y + stepsBox.height <= nagadBox.y).toBe(true);
  }
}

test('Task 2 + 5: Payment step at 360 px — slim stepper on one line, Cash on Delivery first, Pay in advance group with the offer badge, bKash and Nagad boxes in their own colours, the discount line and the Total count down', async ({ page }) => {
  test.setTimeout(120_000);
  const p = await shopProduct();
  test.skip(!p, 'No product in stock.');
  if (!p) return;
  const calls = await openPaymentStep(page, p, HALF_PERCENT, 'NM-4801');

  // The stepper: Cart and Delivery done, Payment current, one line.
  const stepper = page.getByTestId('checkout-stepper');
  await expect(stepper).toBeVisible();
  await expect(stepper.locator('.checkout-stepper__step--done')).toHaveCount(2);
  await expect(stepper.locator('[aria-current="step"]')).toHaveText('Payment');
  const fits = await stepper.evaluate((el) => {
    const tops = new Set([...el.querySelectorAll('.checkout-stepper__step')].map((s) => Math.round(s.getBoundingClientRect().top)));
    return el.scrollWidth <= el.clientWidth && tops.size === 1;
  });
  expect(fits, 'the stepper fits on one line at 360 px').toBe(true);
  const labelSize = await stepper.locator('.checkout-stepper__step').first().evaluate((el) => getComputedStyle(el).fontSize);
  expect(labelSize).toBe('12px');

  // Cash on Delivery first and picked; the offer waits in its green group.
  const options = page.locator('[role="radiogroup"] [role="radio"]');
  await expect(options.first()).toHaveAttribute('data-testid', 'pay-option-cod');
  await expect(page.getByTestId('pay-option-cod')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('advance-badge')).toHaveText('0.5% OFF');
  await expect(page.getByTestId('wallet-box')).toHaveCount(0);
  await expect(page.getByTestId('pay-option-bkash').locator('img')).toHaveAttribute('src', '/payment/bkash.png');
  await expect(page.getByTestId('pay-option-nagad').locator('img')).toHaveAttribute('src', '/payment/nagad.png');
  await expect(page.getByTestId('summary-advance')).toHaveCount(0);
  await expect(page.getByTestId('summary-total')).toContainText('Pay on delivery');
  // The select button sits on the RIGHT of the row.
  const cod = page.getByTestId('pay-option-cod');
  const [rowBox, radioBox] = await Promise.all([cod.boundingBox(), cod.locator('.b67-opt__radio').boundingBox()]);
  expect(rowBox && radioBox && radioBox.x > rowBox.x + rowBox.width / 2).toBe(true);
  await noSidewaysScroll(page);
  await page.screenshot({ path: `${SHOTS}/01-payment-cod.png`, fullPage: true });

  // bKash: its box in its own colours.
  await payWithWallet(page, 'bkash', p);
  // Batch 67: the numbered steps in bKash pink.
  const bkStep = await page.getByTestId('wallet-box').locator('.b67-pay__step i').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bkStep).toBe('rgb(226, 19, 110)');
  // Required fields still checked.
  await page.getByRole('button', { name: /Place order/i }).click();
  await expect(page.getByText('Transaction ID is required')).toBeVisible();
  await expect(page.getByText('Your bKash number is required')).toBeVisible();
  expect(calls).toHaveLength(0);
  await noSidewaysScroll(page);
  await page.getByTestId('wallet-box').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/02-payment-bkash-open.png`, fullPage: true });

  // Nagad: the same box, Nagad's colours and words.
  await payWithWallet(page, 'nagad', p);
  const ngStep = await page.getByTestId('wallet-box').locator('.b67-pay__step i').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(ngStep).toBe('rgb(236, 28, 36)');
  await page.getByTestId('wallet-box').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/03-payment-nagad-open.png`, fullPage: true });

  // Back to Cash on Delivery: the discount goes, the group waits again.
  await page.getByTestId('pay-option-cod').click();
  await expect(page.getByTestId('summary-advance')).toHaveCount(0);
  await expect(page.getByTestId('wallet-box')).toHaveCount(0);
  await expect(page.getByTestId('summary-total')).toContainText(taka(p.price * 2 + insideFee));

  // "Place order" is the one orange button.
  const orange = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
    const place = buttons.find((b) => /Place order/i.test(b.textContent ?? ''));
    const bg = place ? getComputedStyle(place).backgroundColor : '';
    return buttons.filter((b) => getComputedStyle(b).backgroundColor === bg).length;
  });
  expect(orange).toBe(1);
});

async function placeAndCheck(page: Page, calls: PlacedCall[], method: 'cod' | 'bkash' | 'nagad', p: Product, orderNumber: string) {
  if (method !== 'cod') {
    await payWithWallet(page, method, p);
    await page.locator('#wallet-trx-id').fill('9ak2xyz1ab');
    await page.locator('#wallet-sender').fill('01812345678');
  }
  await page.getByRole('button', { name: /Place order/i }).click();
  await expect(page).toHaveURL(/\/checkout\/success/, { timeout: 15_000 });
  expect(calls).toHaveLength(1);
  const body = calls[0].body;
  expect(body.p_payment_method).toBe(method);
  // The browser never sends an amount: the database works it out.
  expect(Object.keys(body).filter((k) => /total|discount|amount|advance/i.test(k))).toEqual([]);
  if (method === 'cod') {
    expect(body.p_bkash_trx_id).toBeNull();
  } else {
    expect(body.p_bkash_trx_id).toBe('9AK2XYZ1AB');
    expect(body.p_bkash_sender).toBe('01812345678');
  }

  const placed = page.getByTestId('order-placed');
  await expect(placed).toBeVisible();
  await expect(page.getByTestId('checkout-stepper')).toHaveCount(0);
  await expect(page.getByText('Thank you,')).toBeVisible();
  await expect(page.getByTestId('placed-name')).toHaveAttribute('aria-label', `${ADDRESS.fullName}!`);
  // Fix 69.1: the order number inside the one line.
  await expect(page.getByTestId('placed-text')).toHaveText(`Your order ${orderNumber} has been placed.`);
  await expect(page.getByTestId('placed-order-number')).toHaveText(orderNumber);
  const subtotal = p.price * 2;
  if (method === 'cod') {
    // Fix 69.1: no Payment row; the total row already says Pay on delivery.
    await expect(page.getByTestId('placed-payment')).toHaveCount(0);
    await expect(page.getByTestId('placed-saved')).toHaveCount(0);
    await expect(page.getByTestId('placed-total')).toHaveText(/^Pay on delivery/);
    await expect(page.getByTestId('placed-total')).toContainText(taka(subtotal + insideFee));
  } else {
    const advance = expectedAdvance(p, HALF_PERCENT);
    await expect(page.getByTestId('placed-payment')).toHaveText(`${method === 'bkash' ? 'bKash' : 'Nagad'} (paid in advance)`);
    await expect(page.getByTestId('placed-saved')).toContainText(`You saved${taka(advance)}`);
    await expect(page.getByTestId('placed-total')).toContainText('Total paid');
    await expect(page.getByTestId('placed-total')).toContainText(taka(subtotal + insideFee - advance));
  }
  await expect(page.getByRole('link', { name: 'View my order' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invoice' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Keep shopping' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Keep shopping' })).toHaveAttribute('href', '/shop');
  await expect(page.getByRole('link', { name: 'Continue shopping' })).toHaveCount(0);
  await noSidewaysScroll(page);
}

test('Task 5 + 6: a Cash on Delivery order at 360 px — Order placed says Pay on delivery, no saving, no stepper (place_order answered in the browser)', async ({ page }) => {
  test.setTimeout(120_000);
  const p = await shopProduct();
  test.skip(!p, 'No product in stock.');
  if (!p) return;
  const calls = await openPaymentStep(page, p, HALF_PERCENT, 'NM-4802');
  await placeAndCheck(page, calls, 'cod', p, 'NM-4802');
  await expect(page.getByTestId('order-placed')).toHaveAttribute('data-played', 'yes');
  await page.waitForTimeout(3600);
  await page.screenshot({ path: `${SHOTS}/04-order-placed-cod.png`, fullPage: true });
});

test('Task 5 + 6: a bKash order at 360 px — totals with the advance discount, Order placed with You saved, the Batch 69 shop-to-home van scene (frames) and its two buzzes; a reload shows the still picture', async ({ page }) => {
  test.setTimeout(120_000);
  const p = await shopProduct();
  test.skip(!p, 'No product in stock.');
  if (!p) return;
  const calls = await openPaymentStep(page, p, HALF_PERCENT, 'NM-4803');
  await placeAndCheck(page, calls, 'bkash', p, 'NM-4803');
  await expect(page.getByTestId('order-placed')).toHaveAttribute('data-played', 'yes');
  const scene = page.getByTestId('placed-scene');
  await expect(scene).toHaveClass(/\bb69--play\b/);

  // Exact frames: every CSS animation paused at the same moment.
  const frames: [number, string][] = [
    [300, '01-anim-0300-shop-and-home'],
    [700, '02-anim-0700-parcel-out'],
    [1150, '03-anim-1150-parcel-hop'],
    [1900, '04-anim-1900-van-leaving'],
    [2600, '05-anim-2600-window-lit-text'],
    [3400, '06-anim-3400-driving'],
  ];
  for (const [ms, name] of frames) {
    await page.evaluate((t) => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = t;
      }
    }, ms);
    await page.screenshot({ path: `${SHOTS69}/${name}.png`, clip: { x: 0, y: 0, width: WIDTH, height: 520 } });
  }
  // Only transform and opacity are animated (Fix 69.1: the sun too).
  await onlyTransformAndOpacity(page);
  // The van keeps driving: wheels, lane marks, bob and speed lines loop.
  const endless = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length);
  expect(endless).toBeGreaterThanOrEqual(4);
  await expect(scene).toBeVisible();
  // finish() throws on an endless animation, so those are only paused.
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      if (a.effect?.getComputedTiming().iterations === Infinity) a.pause();
      else a.finish();
    }
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __vibrations: unknown[] }).__vibrations))
    .toEqual([12, [14, 60, 20]]);

  // A reload later: the still final picture at once, no replay, no loops.
  await page.reload();
  await expect(page.getByTestId('order-placed')).toHaveAttribute('data-played', 'no');
  await expect(scene).toBeVisible();
  await expect(scene).not.toHaveClass(/\bb69--play\b/);
  await expect(page.getByTestId('placed-van')).toBeVisible();
  await expect(page.getByTestId('placed-saved')).toBeVisible();
  const loops = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length);
  expect(loops).toBe(0);
});

/** Every running animation changes only transform and opacity. */
async function onlyTransformAndOpacity(page: Page): Promise<void> {
  const animated = await page.evaluate(() => {
    const props = new Set<string>();
    for (const a of document.getAnimations()) {
      const effect = a.effect as KeyframeEffect | null;
      for (const frame of effect?.getKeyframes() ?? []) {
        for (const key of Object.keys(frame)) {
          if (!['offset', 'computedOffset', 'easing', 'composite'].includes(key)) props.add(key);
        }
      }
    }
    return [...props];
  });
  expect(animated.filter((prop) => !['transform', 'opacity'].includes(prop))).toEqual([]);
}

/** NAEEM'S on the van ends before its window; the van stays clear of the home. */
async function sceneFits(page: Page): Promise<void> {
  const fit = await page.evaluate(() => {
    const name = document.querySelector<SVGTextElement>('.b69-vanname');
    const glass = document.querySelector<SVGPathElement>('.b69-f-glass');
    const van = document.querySelector('.b69-van__body');
    const house = document.querySelector('.b69-house');
    if (!name || !glass || !van || !house) return null;
    const text = name.getBBox();
    return {
      nameEnd: text.x + text.width,
      glassStart: glass.getBBox().x,
      vanRight: van.getBoundingClientRect().right,
      houseLeft: house.getBoundingClientRect().left,
    };
  });
  expect(fit).not.toBeNull();
  if (!fit) return;
  expect(fit.nameEnd, 'the van name ends before its window').toBeLessThanOrEqual(fit.glassStart);
  expect(fit.vanRight, 'the van does not overlap the home').toBeLessThanOrEqual(fit.houseLeft);
}

/** An order just placed (not yet celebrated), so the scene plays on arrival. */
const PLACED_SNAPSHOT = {
  zoneId: 'inside_dhaka',
  address: ADDRESS,
  promo: null,
  lastOrder: {
    orderId: '00000000-0000-4000-8000-000000006901',
    orderNumber: 'NM-6901',
    items: [{ product: { id: 'p', name: 'E2E B69 Serum' }, variantId: null, variantLabel: null, variantImage: null, quantity: 1, unitPrice: 950 }],
    zone: { id: 'inside_dhaka', label: 'Inside Dhaka', fee: 70 },
    address: ADDRESS,
    promo: null,
    subtotal: 950,
    discount: 0,
    total: 1020,
    paymentMethod: 'cod',
    bkashTrxId: null,
    placedAt: new Date().toISOString(),
    advanceDiscount: 0,
    advanceRule: null,
    celebrated: false,
  },
};

for (const [width, theme] of [
  [390, 'light'],
  [390, 'dark'],
  [360, 'light'],
] as const) {
  test(`Batch 69: Order placed at ${width} px ${theme} — the scene plays and keeps driving, the van name readable, the van clear of the home, no sideways scroll`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript((state) => {
      if (window.sessionStorage.getItem('e2e-b69-seeded')) return;
      window.sessionStorage.setItem('e2e-b69-seeded', '1');
      window.sessionStorage.setItem('nph_checkout_state', state);
    }, JSON.stringify(PLACED_SNAPSHOT));
    await page.goto('/checkout/success');
    await expect(page.getByTestId('order-placed')).toHaveAttribute('data-played', 'yes', { timeout: 20_000 });
    await expect(page.getByTestId('placed-scene')).toHaveClass(/\bb69--play\b/);
    await page.waitForTimeout(3600);
    // Still driving long after the scene: the wheels keep turning.
    const turning = await page.locator('.b69-wheel').first().evaluate((el) => el.getAnimations().some((a) => a.playState === 'running'));
    expect(turning).toBe(true);
    await sceneFits(page);
    await noSidewaysScroll(page);
    // Fix 69.1: the sun (light) or the moon and stars (dark) animate only
    // transform and opacity too.
    await onlyTransformAndOpacity(page);
    await expect(page.locator(theme === 'dark' ? '.b69-moon' : '.b69-sun')).toBeVisible();
    // Batch 70 (option C): two dates on a little route, and the buttons.
    await expect(page.getByTestId('placed-arriving').locator('.b70-d')).toHaveCount(2);
    const fit = await page.evaluate(() => {
      const box = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
      const keep = document.querySelector<HTMLElement>('.b69-keep');
      const days = [...document.querySelectorAll('.b70-d')].map((el) => el.getBoundingClientRect().top);
      const invoice = box([...document.querySelectorAll('.cf-ghost')].pop() ?? null);
      return {
        keepOneLine: keep ? keep.scrollWidth <= keep.clientWidth && keep.getBoundingClientRect().height <= 56 : false,
        chipsOneLine: days.length === 2 && Math.abs(days[0] - days[1]) < 1,
        lastBottom: invoice ? invoice.bottom + window.scrollY : Infinity,
      };
    });
    expect(fit.keepOneLine, 'Keep shopping stays on one line').toBe(true);
    expect(fit.chipsOneLine, 'the two dates sit on one line').toBe(true);
    if (width === 390) expect(fit.lastBottom, 'the whole page fits at 390 x 844 without scrolling').toBeLessThanOrEqual(844);
    await page.screenshot({ path: `${SHOTS69}/07-final-${width}-${theme}.png`, fullPage: true });
    await page.screenshot({ path: `${SHOTS691}/final-${width}-${theme}.png`, fullPage: true });
  });
}

test('Fix 69.1: the sound switch (on by default, a tap turns it off, remembered after a reload); the sun by day, the moon and stars by night', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((state) => {
    if (window.sessionStorage.getItem('e2e-b691-seeded')) return;
    window.sessionStorage.setItem('e2e-b691-seeded', '1');
    window.sessionStorage.setItem('nph_checkout_state', state);
  }, JSON.stringify(PLACED_SNAPSHOT));
  await page.goto('/checkout/success');
  await expect(page.getByTestId('order-placed')).toHaveAttribute('data-played', 'yes', { timeout: 20_000 });

  const sound = page.getByTestId('placed-sound');
  await expect(sound).toBeVisible();
  await expect(sound).toHaveAttribute('aria-pressed', 'true');
  await expect(sound).toHaveAttribute('aria-label', 'Sound on');
  await expect(sound).toHaveText('');
  await sound.click();
  await expect(sound).toHaveAttribute('aria-pressed', 'false');
  await expect(sound).toHaveAttribute('aria-label', 'Sound off');
  await page.reload();
  await expect(page.getByTestId('order-placed')).toHaveAttribute('data-played', 'no', { timeout: 20_000 });
  await expect(sound).toHaveAttribute('aria-pressed', 'false');
  await expect(sound).toHaveAttribute('aria-label', 'Sound off');

  // Light: the sun, no moon or stars. (The shop reads the phone's theme
  // once on load, so the switch is made the way the theme button makes it.)
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await expect(page.locator('.b69-sun')).toBeVisible();
  await expect(page.locator('.b69-moon')).toBeHidden();
  await expect(page.locator('.b69-star').first()).toBeHidden();
  // Dark: the moon and stars, no sun.
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await expect(page.locator('.b69-moon')).toBeVisible();
  await expect(page.locator('.b69-star')).toHaveCount(5);
  for (const star of await page.locator('.b69-star').all()) await expect(star).toBeVisible();
  await expect(page.locator('.b69-sun')).toBeHidden();
});

test('Fix 69.1: the scene at 1.9 s in dark (moon and stars)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((state) => {
    if (window.sessionStorage.getItem('e2e-b691-dark')) return;
    window.sessionStorage.setItem('e2e-b691-dark', '1');
    window.sessionStorage.setItem('nph_checkout_state', state);
  }, JSON.stringify(PLACED_SNAPSHOT));
  await page.goto('/checkout/success');
  await expect(page.getByTestId('placed-scene')).toHaveClass(/\bb69--play\b/, { timeout: 20_000 });
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = 1900;
    }
  });
  await expect(page.locator('.b69-moon')).toBeVisible();
  await onlyTransformAndOpacity(page);
  await page.screenshot({ path: `${SHOTS691}/scene-1900-dark.png`, clip: { x: 0, y: 0, width: 390, height: 520 } });
});

test('Task 5 + 6: a Nagad order at 360 px — Nagad (paid in advance), You saved, Total paid', async ({ page }) => {
  test.setTimeout(120_000);
  const p = await shopProduct();
  test.skip(!p, 'No product in stock.');
  if (!p) return;
  const calls = await openPaymentStep(page, p, HALF_PERCENT, 'NM-4804');
  await placeAndCheck(page, calls, 'nagad', p, 'NM-4804');
  await page.waitForTimeout(3600);
  await page.screenshot({ path: `${SHOTS}/12-order-placed-nagad.png`, fullPage: true });
});

test('Task 4: offer Off — no badge, no green group, no discount line; bKash and Nagad still work. Fixed amount shows "৳50 OFF"', async ({ page }) => {
  test.setTimeout(120_000);
  const p = await shopProduct();
  test.skip(!p, 'No product in stock.');
  if (!p) return;
  await openPaymentStep(page, p, { enabled: false, type: 'percent', value: 0.5 }, 'NM-4805');
  await expect(page.getByTestId('advance-badge')).toHaveCount(0);
  // Batch 67: the group keeps its "Pay in advance" heading, with no badge.
  await expect(page.getByTestId('pay-advance-group')).toContainText('Pay in advance');
  await page.getByTestId('pay-option-nagad').click();
  await expect(page.getByTestId('wallet-box')).toContainText('Pay with Nagad');
  await expect(page.getByTestId('summary-advance')).toHaveCount(0);
  expect(await totalTarget(page)).toBe(p.price * 2 + insideFee);

  const fixed = await page.context().newPage();
  await openPaymentStep(fixed, p, { enabled: true, type: 'fixed', value: 50 }, 'NM-4806');
  await expect(fixed.getByTestId('advance-badge')).toHaveText('৳50 OFF');
  await fixed.getByTestId('pay-option-bkash').click();
  await expect(fixed.getByTestId('summary-advance')).toContainText('Advance payment discount');
  expect(await totalTarget(fixed)).toBe(p.price * 2 + insideFee - Math.min(50, p.price * 2));
  await fixed.close();
});

test('Task 6: reduced motion — Order placed shows the still van scene at once, no buzz', async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: WIDTH, height: 780 });
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    (window as unknown as { __vibrations: unknown[] }).__vibrations = calls;
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (x: unknown) => calls.push(x) > 0 });
  });
  const snapshot = {
    zoneId: 'inside_dhaka',
    address: { ...ADDRESS, fullName: 'Mohammad Ashraful Islam Chowdhury' },
    promo: null,
    lastOrder: {
      orderId: '00000000-0000-4000-8000-000000004807',
      orderNumber: 'NM-4807',
      items: [{ product: { id: 'p', name: 'E2E B48 Serum' }, variantId: null, variantLabel: null, variantImage: null, quantity: 1, unitPrice: 950 }],
      zone: { id: 'inside_dhaka', label: 'Inside Dhaka', fee: 70 },
      address: { ...ADDRESS, fullName: 'Mohammad Ashraful Islam Chowdhury' },
      promo: null,
      subtotal: 950,
      discount: 0,
      total: 1015,
      paymentMethod: 'nagad',
      bkashTrxId: 'TRX48',
      placedAt: new Date().toISOString(),
      advanceDiscount: 5,
      advanceRule: { type: 'percent', value: 0.5 },
      celebrated: false,
    },
  };
  await page.addInitScript((state) => window.sessionStorage.setItem('nph_checkout_state', state), JSON.stringify(snapshot));
  await page.goto('/checkout/success');
  await expect(page.getByTestId('order-placed')).toHaveAttribute('data-played', 'no', { timeout: 20_000 });
  // Batch 69: the still picture (van halfway, window lit), nothing plays.
  await expect(page.getByTestId('placed-scene')).toBeVisible();
  await expect(page.getByTestId('placed-scene')).not.toHaveClass(/\bb69--play\b/);
  await expect(page.getByTestId('placed-van')).toBeVisible();
  // A long name (over 16 letters) uses the smaller hero size and wraps.
  const name = page.getByTestId('placed-name');
  // Fix 69.1: the approved mockup's long-name size (was 20px).
  expect(await name.evaluate((el) => getComputedStyle(el).fontSize)).toBe('32px');
  await expect(page.getByTestId('placed-payment')).toHaveText('Nagad (paid in advance)');
  await page.waitForTimeout(1600);
  const buzz = await page.evaluate(() => (window as unknown as { __vibrations: unknown[] }).__vibrations);
  expect(buzz).toEqual([]);
  await noSidewaysScroll(page);
  await page.screenshot({ path: `${SHOTS}/13-order-placed-reduced-motion-long-name.png`, fullPage: true });
});

test('Task 4: the admin card "Advance payment discount" — On, Percent, 0.5 and its preview (nothing saved)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await useSessionInPage(page, admin);
  await withAdvanceSettings(page, HALF_PERCENT);
  // Saving is refused in the browser, in case anything clicks it.
  await page.route(/\/rest\/v1\/app_settings/, (route) => (route.request().method() === 'GET' ? route.fallback() : route.abort()));
  await page.goto('/admin?tab=settings&sset=payment');
  const card = page.getByTestId('advance-discount-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('heading', { name: 'Advance payment discount' })).toBeVisible();
  await expect(card).toContainText('Customers who pay in advance (bKash or Nagad) get this off their products. Delivery is not discounted.');
  await expect(card.getByTestId('advance-discount-switch')).toHaveAttribute('aria-checked', 'true');
  await expect(card.getByRole('button', { name: 'Percent (%)' })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('#settings-advance-value')).toHaveValue('0.5');
  await expect(card.getByTestId('advance-discount-preview')).toHaveText('On a ৳1,000 order the customer saves ৳5.');
  await card.getByRole('button', { name: 'Fixed amount (৳)' }).click();
  await card.locator('#settings-advance-value').fill('50');
  await expect(card.getByTestId('advance-discount-preview')).toHaveText('The customer saves ৳50 when ৳1,000 or more is paid by bKash or Nagad.'); // Batch 60: the ৳1,000 rule
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/14-admin-advance-discount-card.png` });
});
