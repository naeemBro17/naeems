import type { Page, Route } from '@playwright/test';
import { STEADFAST_FUNCTION } from './steadfastMock';

// Batch 36: mocks shared by e2e/batch-36.spec.ts and the screenshots spec.
// Every payout number is made up here — nothing is read from Steadfast.


export const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };

/** Answers a PostgREST read the way supabase-js expects (one object for
 *  .single()/.maybeSingle(), else a list). */
export function restAnswer(route: Route, rows: unknown[]): Promise<void> {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  const wantsObject = (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object');
  if (wantsObject) {
    return rows.length === 0
      ? route.fulfill({ status: 406, headers: CORS, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST116', message: 'no rows' }) })
      : route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(rows[0]) });
  }
  return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(rows) });
}

export const DAY = 24 * 60 * 60 * 1000;

function item(id: string, invoice: string, cod: number, charge: number, fee: number, extra: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    payout_id: 'p-48213',
    consignment_id: `c-${id}`,
    invoice,
    order_id: `o-${id}`,
    cod_collected: cod,
    delivery_charge: charge,
    cod_fee: fee,
    other_deduction: 0,
    net_paid: Math.round((cod - charge - fee) * 100) / 100,
    expected_cod: cod,
    match_status: 'matched',
    match_reason: null,
    note: null,
    ...extra,
  };
}

export const PAYOUTS = [
  {
    id: 'p-48213',
    steadfast_payment_id: '48213',
    paid_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    total_amount: 6835.02,
    parcel_count: 3,
    steadfast_payout_items: [
      item('1', 'NM-1722', 2299, 130, 22.99),
      item('2', 'NM-1639', 1300, 130, 13),
      item('3', 'NM-1450', 3699, 130, 36.99, {
        match_status: 'to_check',
        match_reason: 'cod_differs',
        note: 'Expected ৳3,799.00, Steadfast collected ৳3,699.00',
      }),
    ],
  },
];

export async function mockPayouts(page: Page, options: { unpaid?: { order_id: string; order_number: string; delivered_at: string }[] } = {}): Promise<string[]> {
  const syncCalls: string[] = [];
  await page.route(/\/rest\/v1\/steadfast_payouts\?/, (route) => {
    const url = route.request().url();
    const id = /id=eq\.([^&]+)/.exec(url)?.[1];
    return restAnswer(route, id ? PAYOUTS.filter((p) => p.id === decodeURIComponent(id)) : PAYOUTS);
  });
  await page.route(/\/rest\/v1\/steadfast_sync_state\?/, (route) =>
    restAnswer(route, [{ current_balance: 12480.5, balance_at: new Date(Date.now() - 10 * 60000).toISOString(), last_sync_at: null, last_sync_error: null }])
  );
  await page.route(/\/rest\/v1\/rpc\/steadfast_unpaid_orders/, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(options.unpaid ?? []) });
  });
  await page.route(STEADFAST_FUNCTION, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    syncCalls.push(String(body.action));
    const answer = body.action === 'payouts_sync' ? { ok: true, payoutsSeen: 1 } : { ok: false, error: 'Steadfast is mocked in tests.' };
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(answer) });
  });
  return syncCalls;
}


export const RICH =
  '<div data-box="benefits"><ul><li><p>খুশকির <strong>মূল কারণ</strong> দূর করে</p></li><li><p>চুলকানি কমায়</p></li></ul></div>' +
  '<p>ড্যানড্রাফ মূলত <mark data-hl="peach">ম্যালাসেজিয়া</mark> নামক <span data-color="teal">ফাঙ্গাস</span>।</p>' +
  '<div data-box="warning"><p><strong>প্রতিদিন ব্যবহার করবেন না।</strong></p></div>' +
  '<ol><li><p>ভিজিয়ে নিন</p></li><li><p>৩–৫ মিনিট রাখুন</p></li></ol>' +
  '<div data-box="tip"><p>গরমের দিনে টিপ</p></div>' +
  '<p><a href="https://naeems.com">naeems.com</a> <a href="javascript:alert(1)">bad</a></p>' +
  '<p onclick="window.__xss=1">x<script>window.__xss=1</script><img src=x onerror="window.__xss=1"></p>';
export const OLD_PLAIN = 'Line one of the old text.\nLine two, kept as it was.';

/** The product page sees this product with a rich description and old
 *  plain How to use (the response is changed in the browser only). */
export async function withRichProduct(page: Page, productId: string): Promise<void> {
  await page.route(/\/rest\/v1\/products_view\?/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return route.fulfill({ response });
    }
    const patch = (row: Record<string, unknown>) =>
      row.id === productId ? { ...row, description: RICH, how_to_use: OLD_PLAIN } : row;
    const changed = Array.isArray(body) ? body.map((r) => patch(r as Record<string, unknown>)) : patch(body as Record<string, unknown>);
    return route.fulfill({ response, body: JSON.stringify(changed) });
  });
}
