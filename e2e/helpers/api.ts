import type { Page } from '@playwright/test';
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabaseProjectRef } from './env';

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

/** Places a real website order as the test customer (the Telegram
 *  notifier skips this account — see checkout.spec.ts). */
export async function placeTestOrder(
  customerToken: string,
  productId: string,
  quantity = 1
): Promise<{ id: string; orderNumber: string }> {
  const result = await rpc<{ order_id: string; order_number: string }[]>(customerToken, 'place_order', {
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
  if (!result.ok || !result.data?.[0]) {
    throw new Error(`place_order failed: ${result.error}`);
  }
  return { id: result.data[0].order_id, orderNumber: result.data[0].order_number };
}

/** An active product with tracked stock to spare — orders here change it. */
export async function pickStockedProduct(minStock = 5): Promise<{ id: string; name: string; stock: number }> {
  const result = await select<{ id: string; name: string; stock_quantity: number }[]>(
    null,
    `products_view?select=id,name,stock_quantity&is_active=eq.true&stock_quantity=gte.${minStock}&order=stock_quantity.desc&limit=1`
  );
  const row = result.data?.[0];
  if (!row) throw new Error('No active product with enough tracked stock for the test.');
  return { id: row.id, name: row.name, stock: row.stock_quantity };
}

export async function productStock(productId: string): Promise<number> {
  const result = await select<{ stock_quantity: number }[]>(
    null,
    `products_view?select=stock_quantity&id=eq.${productId}`
  );
  return result.data?.[0]?.stock_quantity ?? Number.NaN;
}
