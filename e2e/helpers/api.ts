import type { Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, SUPABASE_ANON_KEY, SUPABASE_URL, supabaseProjectRef } from './env';

/**
 * Direct calls to Supabase, as a given test account (Batch 24). Used to
 * set up orders quickly and — more importantly — to prove the database
 * itself refuses what a moderator isn't allowed to do, not just the UI.
 */
export interface TestSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  userId: string;
  user: unknown;
}

export async function passwordSession(email: string, password: string): Promise<TestSession> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Test sign-in failed for ${email.replace(/@.*/, '@…')}: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    user: { id: string };
  };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    tokenType: body.token_type,
    userId: body.user.id,
    user: body.user,
  };
}

/** Puts the session where supabase-js reads it on boot, before any page
 *  script runs — the same trick signInAsTestCustomer uses. */
export async function useSessionInPage(page: Page, session: TestSession): Promise<void> {
  const storageKey = `sb-${supabaseProjectRef()}-auth-token`;
  const value = JSON.stringify({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expires_in: session.expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + session.expiresIn,
    token_type: session.tokenType,
    user: session.user,
  });
  await page.addInitScript(
    ([key, v]) => {
      window.localStorage.setItem(key, v);
    },
    [storageKey, value]
  );
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

async function call<T>(token: string | null, path: string, init: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token ?? SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `HTTP ${res.status}`;
    return { ok: false, status: res.status, data: null, error: message };
  }
  return { ok: true, status: res.status, data: parsed as T, error: null };
}

export function rpc<T>(token: string | null, fn: string, args: Record<string, unknown> = {}): Promise<ApiResult<T>> {
  return call<T>(token, `/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
}

export function select<T>(token: string | null, pathAndQuery: string): Promise<ApiResult<T>> {
  return call<T>(token, `/rest/v1/${pathAndQuery}`, { method: 'GET' });
}

export function update<T>(token: string | null, pathAndQuery: string, patch: Record<string, unknown>): Promise<ApiResult<T>> {
  return call<T>(token, `/rest/v1/${pathAndQuery}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    headers: { Prefer: 'return=representation' },
  });
}

export function upsertSettings(token: string, rows: { key: string; value: string }[]): Promise<ApiResult<unknown>> {
  return call(token, '/rest/v1/app_settings?on_conflict=key', {
    method: 'POST',
    body: JSON.stringify(rows),
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  });
}

export async function callFunction<T>(token: string, name: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/* Batch 61: test orders never use a real product any more. The live shop
 * runs Inventory mode, so an order of a real product took units from its
 * real lots, and the tests failed whenever the shop ran low. Instead each
 * test file makes its own product: hidden, no lots, "keep selling" on (so
 * an order of it is accepted as "buy after order" and takes nothing from
 * any lot). It is shown in the shop only for the instant place_order
 * needs it (see placeTestOrder), and deleted again by removeTestProducts()
 * (global teardown). An order line keeps working once its product is gone
 * (order_items.product_id is set to null). */
export const TEST_PRODUCT_SKU = 'E2E-ORD-';
const madeUpProducts = new Set<string>();
let testAdmin: Promise<TestSession> | null = null;

function testAdminSession(): Promise<TestSession> {
  testAdmin ??= passwordSession(E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD);
  return testAdmin;
}

/** Shows or hides a made-up product (no row back: admins cannot read the
 *  wholesale price column). */
async function setTestProductActive(productId: string, active: boolean): Promise<void> {
  const admin = await testAdminSession();
  const res = await call(admin.accessToken, `/rest/v1/products?id=eq.${productId}&sku=like.${TEST_PRODUCT_SKU}*`, {
    method: 'PATCH',
    body: JSON.stringify({ is_active: active }),
    headers: { Prefer: 'return=minimal' },
  });
  if (!res.ok) throw new Error(`could not ${active ? 'show' : 'hide'} the test product: ${res.error}`);
}

/** Places a real website order as the test customer (the Telegram
 *  notifier skips this account — see checkout.spec.ts). A made-up product
 *  (makeTestProduct) is shown only while the order is placed. */
export async function placeTestOrder(
  customerToken: string,
  productId: string,
  quantity = 1
): Promise<{ id: string; orderNumber: string }> {
  const madeUp = madeUpProducts.has(productId);
  if (madeUp) await setTestProductActive(productId, true);
  let result: ApiResult<{ order_id: string; order_number: string }[]>;
  try {
    result = await rpc<{ order_id: string; order_number: string }[]>(customerToken, 'place_order', {
      p_items: [{ product_id: productId, variant_id: null, quantity }],
      p_full_name: 'E2E Test Customer',
      p_phone: '01712345678',
      p_division: 'Dhaka',
      p_district: 'Dhaka',
      p_thana: 'Gulshan',
      p_address_line: '123 Test Road (e2e)',
      p_delivery_zone: 'inside_dhaka',
      p_payment_method: 'cod',
    });
  } finally {
    if (madeUp) await setTestProductActive(productId, false);
  }
  if (!result.ok || !result.data?.[0]) {
    throw new Error(`place_order failed: ${result.error}`);
  }
  return { id: result.data[0].order_id, orderNumber: result.data[0].order_number };
}

/** A made-up product for test orders (see the note above): hidden, no
 *  options, no lots, keeps selling at stock 0. Nothing real is touched. */
export async function makeTestProduct(price = 1000): Promise<{ id: string; name: string }> {
  const admin = await testAdminSession();
  const stamp = `${Date.now() % 100_000_000}-${Math.floor(Math.random() * 1000)}`;
  const sku = `${TEST_PRODUCT_SKU}${stamp}`;
  const name = `E2E Order Product ${stamp}`;
  const res = await call(admin.accessToken, '/rest/v1/products', {
    method: 'POST',
    body: JSON.stringify({
      sku,
      slug: `e2e-order-product-${stamp}`,
      name,
      retail_price: price,
      stock_status: 'in_stock',
      stock_quantity: 0,
      is_active: false,
      keep_selling: true,
    }),
    headers: { Prefer: 'return=minimal' },
  });
  if (!res.ok) throw new Error(`could not make the test product: ${res.error}`);
  const row = await select<{ id: string }[]>(admin.accessToken, `products?select=id&sku=eq.${sku}`);
  const id = row.data?.[0]?.id;
  if (!id) throw new Error('the test product was not found after it was made');
  madeUpProducts.add(id);
  return { id, name };
}

/** Deletes every made-up test product (global teardown; any run's). */
export async function removeTestProducts(adminToken: string): Promise<void> {
  await remove(adminToken, `products?sku=like.${TEST_PRODUCT_SKU}*`);
}

export async function productStock(productId: string): Promise<number> {
  // A made-up product is hidden, so only staff can read it.
  const result = madeUpProducts.has(productId)
    ? await select<{ stock_quantity: number }[]>((await testAdminSession()).accessToken, `products?select=stock_quantity&id=eq.${productId}`)
    : await select<{ stock_quantity: number }[]>(null, `products_view?select=stock_quantity&id=eq.${productId}`);
  return result.data?.[0]?.stock_quantity ?? Number.NaN;
}

/** Inserts rows and returns them (Batch 26: test brands and products). */
export function insert<T>(
  token: string,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
  returning = true
): Promise<ApiResult<T>> {
  return call<T>(token, `/rest/v1/${table}`, {
    method: 'POST',
    body: JSON.stringify(rows),
    headers: { Prefer: returning ? 'return=representation' : 'return=minimal' },
  });
}

/** Deletes the rows a filter matches (nothing is read back). */
export function remove<T>(token: string, pathAndQuery: string): Promise<ApiResult<T>> {
  return call<T>(token, `/rest/v1/${pathAndQuery}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
}
