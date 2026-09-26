// Shared between supabase/functions/steadfast (the admin-triggered book/
// refresh calls) and supabase/functions/steadfast-refresh-all (the pg_cron-
// triggered background refresh, Batch 20 Part 2 fix). One copy of the
// base URL, headers, and status interpretation so the two functions can
// never quietly drift apart on what a given Steadfast status means.
//
// Everything here is verified against Steadfast's own "API guide" PDF
// (Merchant Dashboard -> API -> API guide), not a third-party client
// library — see reports/fix-steadfast-auto.txt for exactly what that
// verification changed from Batch 20's original (library-sourced) version.

export const STEADFAST_BASE_URL = 'https://portal.packzy.com/api/v1';

export function steadfastHeaders(apiKey: string, secretKey: string): HeadersInit {
  return {
    'Api-Key': apiKey,
    'Secret-Key': secretKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/**
 * Every delivery_status value the API guide documents. The four
 * "_approval_pending" ones are explicitly called out as "the rider's word,
 * not ours yet — do not settle your books on it", so they're deliberately
 * NOT treated as delivered below, only shown to Naeem as-is.
 */
export type SteadfastDeliveryStatus =
  | 'pending'
  | 'in_review'
  | 'hold'
  | 'delivered_approval_pending'
  | 'partial_delivered_approval_pending'
  | 'cancelled_approval_pending'
  | 'unknown_approval_pending'
  | 'delivered'
  | 'partial_delivered'
  | 'cancelled'
  | 'exceptional'
  | 'unknown';

/** Only these two mean "actually delivered, confirmed" per the API guide. */
export function meansDelivered(courierStatus: string): boolean {
  return courierStatus === 'delivered' || courierStatus === 'partial_delivered';
}

/**
 * Needs Naeem's attention rather than just "in progress" — the parcel is
 * coming back (cancelled), stuck (hold), or off the normal path
 * (exceptional). Never auto-cancels the order itself either way; this is
 * only used to decide whether to send a Telegram alert (see
 * notify-telegram-order) and to badge it in the admin UI.
 */
export function needsAttention(courierStatus: string): boolean {
  return courierStatus === 'cancelled' || courierStatus === 'hold' || courierStatus === 'exceptional';
}

export interface SteadfastStatusResponse {
  status?: number;
  delivery_status?: string;
  message?: string;
  errors?: Record<string, string[] | string>;
}

/**
 * Steadfast's validation-failure shape (confirmed from the API guide, POST
 * /create_order): `{"status": 400, "errors": {"field": ["message", ...]}}`
 * — no top-level `message` in that case. Batch 20's original code only ever
 * read `body.message`, so a rejected phone number/address showed Naeem a
 * generic "HTTP 400" instead of which field Steadfast actually rejected.
 */
export function extractSteadfastError(body: SteadfastStatusResponse, httpStatus: number): string {
  if (body.errors && typeof body.errors === 'object') {
    const parts = Object.entries(body.errors).map(([field, messages]) => {
      const text = Array.isArray(messages) ? messages.join(', ') : messages;
      return `${field}: ${text}`;
    });
    if (parts.length > 0) return parts.join(' / ');
  }
  return body.message ?? `Steadfast rejected the request (HTTP ${httpStatus}).`;
}

export interface StatusCheckResult {
  ok: boolean;
  courierStatus?: string;
  markedDelivered?: boolean;
  needsAttention?: boolean;
  error?: string;
}

/**
 * GET /status_by_cid/{consignment_id} — the one call both the admin refresh
 * button and the 3-hourly background refresh make. Answers are cached 60s
 * on Steadfast's side (their own docs note polling faster tells you
 * nothing new), so callers should never hit this more often than that.
 */
export async function checkSteadfastStatus(
  consignmentId: string,
  apiKey: string,
  secretKey: string
): Promise<StatusCheckResult> {
  let res: Response;
  try {
    res = await fetch(`${STEADFAST_BASE_URL}/status_by_cid/${encodeURIComponent(consignmentId)}`, {
      headers: steadfastHeaders(apiKey, secretKey),
    });
  } catch (err) {
    console.error('Steadfast status_by_cid network error:', err);
    return { ok: false, error: 'Could not reach Steadfast. Please try again.' };
  }

  let body: SteadfastStatusResponse;
  try {
    body = (await res.json()) as SteadfastStatusResponse;
  } catch {
    return { ok: false, error: `Steadfast returned an unreadable response (HTTP ${res.status}).` };
  }

  if (!res.ok || !body.delivery_status) {
    return { ok: false, error: extractSteadfastError(body, res.status) };
  }

  const courierStatus = body.delivery_status;
  return {
    ok: true,
    courierStatus,
    markedDelivered: meansDelivered(courierStatus),
    needsAttention: needsAttention(courierStatus),
  };
}
