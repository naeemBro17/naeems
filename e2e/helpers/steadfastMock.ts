import type { BrowserContext, Page, Route } from '@playwright/test';

/**
 * Batch 30: tests never reach the real Steadfast API (CLAUDE.md, the
 * Batch 30 brief). The website only talks to Steadfast through the
 * `steadfast` Supabase function, so that one URL is answered here.
 */
export const STEADFAST_FUNCTION = '**/functions/v1/steadfast';

/** Default for every test: the function "isn't there" — the site falls
 *  back to what is saved on the order, exactly as before Batch 30. */
export async function mockSteadfastByDefault(context: BrowserContext): Promise<void> {
  await context.route(STEADFAST_FUNCTION, (route) => answer(route, { ok: false, error: 'Steadfast is mocked in tests.' }));
}

function answer(route: Route, body: Record<string, unknown>): Promise<void> {
  if (route.request().method() === 'OPTIONS') {
    return route.fulfill({
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  });
}

export interface MockTracking {
  courierStatus: string | null;
  events: { text: string; at: string | null }[];
}

/**
 * A page-level steadfast function: `tracking` answers with the given steps
 * (as the real function would for this audience), `police_stations` with
 * the given list (or a failure), `status` with the courier status, and
 * `create` is refused — no test books a parcel. Every request body is
 * recorded for assertions.
 */
export async function mockSteadfast(
  page: Page,
  options: {
    tracking?: MockTracking | null;
    policeStations?: { name: string; district: string }[] | null;
    status?: string;
  }
): Promise<Record<string, unknown>[]> {
  const calls: Record<string, unknown>[] = [];
  await page.route(STEADFAST_FUNCTION, async (route) => {
    if (route.request().method() === 'OPTIONS') return answer(route, {});
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push(body);
    if (body.action === 'tracking') {
      return options.tracking
        ? answer(route, { ok: true, courierStatus: options.tracking.courierStatus, events: options.tracking.events, fetchedAt: new Date().toISOString() })
        : answer(route, { ok: false, error: 'Invalid request.' });
    }
    if (body.action === 'police_stations') {
      return options.policeStations
        ? answer(route, { ok: true, stations: options.policeStations })
        : answer(route, { ok: false, error: 'Could not reach Steadfast.' });
    }
    if (body.action === 'status' && options.status) {
      return answer(route, { ok: true, courierStatus: options.status, markedDelivered: false, needsAttention: false });
    }
    return answer(route, { ok: false, error: 'Steadfast is mocked in tests.' });
  });
  return calls;
}
