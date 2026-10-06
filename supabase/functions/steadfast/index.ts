// Supabase Edge Function: books an order's parcel with Steadfast Courier,
// or refreshes its delivery status. Called directly from the admin order
// detail screen (src/lib/orders.ts bookSteadfastShipment/
// refreshSteadfastStatus), never automatically — see steadfast-refresh-all
// for the automatic 3-hourly background refresh (Batch 20 Part 2 fix).
//
// SECURITY: the caller's own session JWT is forwarded (Supabase's client
// does this automatically for supabase.functions.invoke) and used to build
// a Postgres client that respects RLS — is_admin() is called through that
// same client first; every other admin-only project in this codebase
// (place_order, cancel_order, admin_set_order_status,
// admin_update_order_delivery_fee) also does its real authorization/writes
// inside a SECURITY DEFINER database function rather than trusting the
// Edge Function's own checks, and this follows the same pattern — the
// actual order read and every write below goes through RLS or a SECURITY
// DEFINER RPC (migration-025/026), never a service-role bypass. The order
// itself is always read fresh from the database by id; nothing about a
// customer's name/phone/address/total is ever trusted from the request
// body — the request body only ever carries an orderId and which action to
// run.
//
// STEADFAST_API_KEY and STEADFAST_SECRET_KEY are Naeem's own secrets, set
// in Supabase Edge Function secrets (see reports/batch-20.txt) — never in
// this repo, the frontend, or written to any log line below.
//
// Every endpoint, header, field name, response shape, status value and
// error rule below is verified against Steadfast's own "API guide" PDF
// (Merchant Dashboard -> API -> API guide) — Batch 20 originally built this
// from a third-party open-source client's source code instead, which the
// official guide confirmed was right on the basics (base URL, header
// names, the main field names) but wrong or incomplete on: the full
// delivery_status list (missed the four "_approval_pending" values and
// "exceptional"), the create_order validation-error shape (`errors`, not
// always `message`), and a real per-parcel tracking link
// (`consignment.tracking_link`) that didn't exist in the assumed response
// at all. See reports/fix-steadfast-auto.txt for the full diff against the
// original assumptions.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  STEADFAST_BASE_URL,
  steadfastHeaders,
  extractSteadfastError,
  checkSteadfastStatus,
  meansDelivered,
  type SteadfastStatusResponse,
} from '../_shared/steadfast.ts';
import { customerSafeText, parseTrackingResponse, type TrackingEvent } from '../_shared/steadfastSteps.ts';
import { parsePoliceStations, type PoliceStation } from '../_shared/policeStations.ts';
import { codAmountFor } from '../_shared/cod.ts';
import { parseFraudCheck, type FraudCheckResult } from '../_shared/fraudCheck.ts';

// Unlike notify-telegram-order (only ever invoked server-side by a database
// webhook), this function is called directly from the admin's browser via
// supabase.functions.invoke — a real cross-origin request from
// naeems-all.vercel.app to Supabase's own domain, so the browser sends a
// CORS preflight (OPTIONS) first and checks these headers on every
// response. Supabase Edge Functions don't add these automatically.
const CORS_HEADERS: HeadersInit = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Steadfast caches status answers for 60 seconds (API guide), so a parcel
 *  is never asked about more often than this (Batch 30 Part 5). */
const TRACKING_CACHE_MS = 60_000;
/** The thana list changes rarely (API guide: "fetch it occasionally and
 *  keep it"). Kept in memory for a day per function instance. */
const POLICE_STATIONS_CACHE_MS = 24 * 60 * 60 * 1000;
let policeStationsCache: { at: number; list: PoliceStation[] } | null = null;
/** Fallback rate limit while migration-033's cache table isn't there yet. */
const trackingMemory = new Map<string, { at: number; courierStatus: string | null; events: TrackingEvent[] }>();
/** Batch 31 Part 2: one Steadfast customer check per number per day at
 *  most (their limit is shared with booking volume). "Refresh" may ask
 *  again, but never within a minute of the last answer. */
const FRAUD_CACHE_MS = 24 * 60 * 60 * 1000;
const FRAUD_REFRESH_MIN_MS = 60_000;
/** Fallback while migration-034's steadfast_fraud_cache isn't there yet. */
const fraudMemory = new Map<string, { at: number; result: FraudCheckResult }>();

/** Confirmed from the API guide's "Booking parcels" section — sending more
 *  than this is rejected outright rather than truncated (unlike the text
 *  fields, which Steadfast just cuts to fit). Checked here so a mispriced
 *  bulk/wholesale order gets a clear message instead of a raw Steadfast
 *  rejection. */
const MAX_COD_AMOUNT = 1_000_000;

interface OrderRow {
  id: string;
  order_number: string;
  customer_name: string;
  customer_phone: string;
  division: string;
  district: string;
  thana: string;
  address_line: string;
  total: number;
  payment_method: 'cod' | 'bkash' | 'cash' | 'due';
  payment_status: 'unpaid' | 'pending_verification' | 'paid';
  status: string;
  customer_note: string | null;
  steadfast_consignment_id: string | null;
  steadfast_tracking_code: string | null;
  steadfast_tracking_link: string | null;
  steadfast_status: string | null;
  /** Batch 30 (migration-033) — absent until it is run. */
  alt_phone?: string | null;
  courier_note?: string | null;
}

interface RequestBody {
  action?: 'create' | 'status' | 'tracking' | 'police_stations' | 'fraud_check';
  orderId?: string;
  /** fraud_check only */
  phone?: string;
  refresh?: boolean;
}

const ORDER_COLUMNS =
  'id, order_number, customer_name, customer_phone, division, district, thana, address_line, total, payment_method, payment_status, status, customer_note, steadfast_consignment_id, steadfast_tracking_code, steadfast_tracking_link, steadfast_status';

interface SteadfastCreateResponse {
  status?: number;
  message?: string;
  errors?: Record<string, string[] | string>;
  consignment?: {
    consignment_id: number | string;
    tracking_code?: string;
    tracking_link?: string;
    status?: string;
  };
}

/** A client that acts as the caller (their own session, so RLS applies). */
function userClientFor(supabaseUrl: string, anonKey: string, authHeader: string) {
  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
}

type SupabaseUserClient = ReturnType<typeof userClientFor>;

function json(body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

/** "+880 1712-345678" → "01712345678"; null unless it is a valid
 *  Bangladeshi mobile number (Steadfast refuses anything else). */
function steadfastPhone(raw: string | null | undefined): string | null {
  let digits = (raw ?? '').replace(/\D/g, '').replace(/^(00)?880/, '0');
  if (/^1[3-9]\d{8}$/.test(digits)) digits = `0${digits}`;
  return /^01[3-9]\d{8}$/.test(digits) ? digits : null;
}

async function handleCreate(
  order: OrderRow,
  userClient: SupabaseUserClient,
  apiKey: string,
  secretKey: string
): Promise<Response> {
  // Never book twice — show what's already there instead of calling
  // Steadfast again.
  if (order.steadfast_consignment_id) {
    return json({
      ok: true,
      consignmentId: order.steadfast_consignment_id,
      trackingCode: order.steadfast_tracking_code ?? undefined,
      trackingLink: order.steadfast_tracking_link ?? undefined,
      courierStatus: order.steadfast_status ?? undefined,
    });
  }

  if (order.status !== 'confirmed') {
    return json({ ok: false, error: 'Only a confirmed order can be booked with Steadfast.' });
  }

  // Batch 22: 'cash' and 'due' (manual orders only) join 'cod' here — the
  // real question is never the payment METHOD, it's whether payment_status
  // is already 'paid' (nothing left to collect on delivery). bKash keeps
  // its own extra guard: 'pending_verification' must never fall through to
  // "already paid" just because it isn't 'unpaid' either.
  if (order.payment_method === 'bkash' && order.payment_status !== 'paid') {
    return json({
      ok: false,
      error: 'This bKash payment has not been verified yet — mark it as paid before booking with Steadfast.',
    });
  }
  // Batch 30: COD = what is still due (total minus every payment recorded
  // on the order), never the full total once money was paid. Before
  // migration-033 there are no payments to read, so the old rule stays.
  const { data: summary, error: summaryErr } = await userClient.rpc('order_payment_summary', { p_order_id: order.id });
  const summaryRow = (summary as { due: number | string }[] | null)?.[0];
  const codAmount = codAmountFor(order, !summaryErr && summaryRow ? Number(summaryRow.due) : null);

  if (codAmount > MAX_COD_AMOUNT) {
    return json({
      ok: false,
      error: `Steadfast's COD amount limit is ৳${MAX_COD_AMOUNT.toLocaleString('en-BD')} — this order's total is over that. Book it with Steadfast support directly, or split the order.`,
    });
  }

  const recipientAddress = `${order.address_line}, ${order.thana}, ${order.district}`;

  let steadfastRes: Response;
  try {
    steadfastRes = await fetch(`${STEADFAST_BASE_URL}/create_order`, {
      method: 'POST',
      headers: steadfastHeaders(apiKey, secretKey),
      body: JSON.stringify({
        invoice: order.order_number,
        recipient_name: order.customer_name,
        recipient_phone: order.customer_phone,
        recipient_address: recipientAddress,
        cod_amount: codAmount,
        ...(order.courier_note || order.customer_note ? { note: order.courier_note || order.customer_note } : {}),
        ...(steadfastPhone(order.alt_phone) ? { alternative_phone: steadfastPhone(order.alt_phone) } : {}),
      }),
    });
  } catch (err) {
    console.error('Steadfast create_order network error:', err);
    return json({ ok: false, error: 'Could not reach Steadfast. Please try again.' });
  }

  let body: SteadfastCreateResponse;
  try {
    body = (await steadfastRes.json()) as SteadfastCreateResponse;
  } catch {
    return json({ ok: false, error: `Steadfast returned an unreadable response (HTTP ${steadfastRes.status}).` });
  }

  if (!steadfastRes.ok || !body.consignment) {
    return json({ ok: false, error: extractSteadfastError(body as SteadfastStatusResponse, steadfastRes.status) });
  }

  const consignmentId = String(body.consignment.consignment_id);
  const trackingCode = body.consignment.tracking_code ?? '';
  const trackingLink = body.consignment.tracking_link ?? '';
  const courierStatus = body.consignment.status ?? 'in_review';

  const { error: saveErr } = await userClient.rpc('admin_record_steadfast_shipment', {
    p_order_id: order.id,
    p_consignment_id: consignmentId,
    p_tracking_code: trackingCode,
    p_tracking_link: trackingLink,
    p_courier_status: courierStatus,
  });
  if (saveErr) {
    // The parcel IS booked with Steadfast at this point — only saving it
    // failed. Surface the consignment id so Naeem can enter it by hand via
    // the tracking-number field rather than silently losing it.
    console.error('admin_record_steadfast_shipment failed after a real booking:', saveErr.message);
    return json({
      ok: false,
      error: `Booked with Steadfast (consignment ${consignmentId}, tracking ${trackingCode}) but could not save it here — please enter the tracking number by hand and tell Naeem. (${saveErr.message})`,
    });
  }

  // Batch 30: remember the COD Steadfast was given, so the order can say
  // when it no longer matches what is due. Missing before migration-033 —
  // the booking itself is already saved either way.
  const { error: codErr } = await userClient.rpc('admin_set_steadfast_cod', { p_order_id: order.id, p_amount: codAmount });
  if (codErr) console.error('admin_set_steadfast_cod skipped:', codErr.message);

  return json({ ok: true, consignmentId, trackingCode, trackingLink, courierStatus });
}

interface TrackingOrderRow {
  id: string;
  order_number: string;
  status: string;
  steadfast_consignment_id: string | null;
  steadfast_status: string | null;
}

/**
 * Batch 30 Part 5: every step the parcel went through (GET
 * /trackings_by_invoice/{invoice}) plus its current status. The caller's own
 * session reads the order, so a customer only ever gets their own order
 * (RLS) and staff need "View orders". Never more than one Steadfast call
 * per order per minute: the last answer is kept in steadfast_tracking_cache
 * (migration-033). Customers get rider names and phone numbers removed.
 */
async function handleTracking(
  orderId: string,
  userClient: SupabaseUserClient,
  apiKey: string,
  secretKey: string
): Promise<Response> {
  const { data: orderData, error: orderErr } = await userClient
    .from('orders')
    .select('id, order_number, status, steadfast_consignment_id, steadfast_status')
    .eq('id', orderId)
    .maybeSingle();
  if (orderErr || !orderData) {
    return json({ ok: false, error: 'Order not found.' });
  }
  const order = orderData as TrackingOrderRow;

  const { data: canView, error: canErr } = await userClient.rpc('staff_can', { p_perm: 'view_orders' });
  const isStaff = !canErr && canView === true;

  if (!order.steadfast_consignment_id) {
    return json({ ok: true, courierStatus: order.steadfast_status, events: [], fetchedAt: null });
  }

  const serviceClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const now = Date.now();

  let courierStatus: string | null = order.steadfast_status;
  let events: TrackingEvent[] = [];
  let fetchedAt: string | null = null;
  let fresh = false;

  const { data: cached, error: cacheErr } = await serviceClient
    .from('steadfast_tracking_cache')
    .select('delivery_status, events, fetched_at')
    .eq('order_id', order.id)
    .maybeSingle();
  const cacheTableReady = !cacheErr;
  const cacheRow = cached as { delivery_status: string | null; events: TrackingEvent[]; fetched_at: string } | null;
  const memory = trackingMemory.get(order.id);

  if (cacheRow && now - new Date(cacheRow.fetched_at).getTime() < TRACKING_CACHE_MS) {
    courierStatus = cacheRow.delivery_status ?? courierStatus;
    events = Array.isArray(cacheRow.events) ? cacheRow.events : [];
    fetchedAt = cacheRow.fetched_at;
    fresh = true;
  } else if (!cacheTableReady && memory && now - memory.at < TRACKING_CACHE_MS) {
    courierStatus = memory.courierStatus ?? courierStatus;
    events = memory.events;
    fetchedAt = new Date(memory.at).toISOString();
    fresh = true;
  }

  if (!fresh) {
    let trackRes: Response;
    try {
      trackRes = await fetch(`${STEADFAST_BASE_URL}/trackings_by_invoice/${encodeURIComponent(order.order_number)}`, {
        headers: steadfastHeaders(apiKey, secretKey),
      });
    } catch (err) {
      console.error('Steadfast trackings_by_invoice network error:', err);
      return json({ ok: false, error: 'Could not reach Steadfast. Please try again.' });
    }
    let trackBody: unknown = null;
    try {
      trackBody = await trackRes.json();
    } catch {
      trackBody = null;
    }
    if (!trackRes.ok) {
      return json({ ok: false, error: extractSteadfastError((trackBody ?? {}) as SteadfastStatusResponse, trackRes.status) });
    }
    events = parseTrackingResponse(trackBody);

    const status = await checkSteadfastStatus(order.steadfast_consignment_id, apiKey, secretKey);
    if (status.ok && status.courierStatus) {
      courierStatus = status.courierStatus;
      if (status.courierStatus !== order.steadfast_status) {
        // Same save the 3-hourly refresh makes (marks delivered only on a
        // confirmed delivered / partial_delivered).
        const { error: saveErr } = await serviceClient.rpc('system_update_steadfast_status', {
          p_order_id: order.id,
          p_courier_status: status.courierStatus,
          p_mark_delivered: meansDelivered(status.courierStatus),
        });
        if (saveErr) console.error('system_update_steadfast_status failed:', saveErr.message);
      }
    }

    fetchedAt = new Date(now).toISOString();
    if (cacheTableReady) {
      const { error: upsertErr } = await serviceClient
        .from('steadfast_tracking_cache')
        .upsert({ order_id: order.id, delivery_status: courierStatus, events, fetched_at: fetchedAt });
      if (upsertErr) console.error('steadfast_tracking_cache save failed:', upsertErr.message);
    } else {
      trackingMemory.set(order.id, { at: now, courierStatus, events });
    }
  }

  const shown = isStaff ? events : events.map((e) => ({ text: customerSafeText(e.text), at: e.at }));
  return json({ ok: true, courierStatus, events: shown, fetchedAt });
}

/** Batch 30 Part 6: every thana Steadfast delivers to (GET
 *  /police_stations). Public data, so any visitor of the shop may ask. */
async function handlePoliceStations(apiKey: string, secretKey: string): Promise<Response> {
  const now = Date.now();
  if (policeStationsCache && now - policeStationsCache.at < POLICE_STATIONS_CACHE_MS) {
    return json({ ok: true, stations: policeStationsCache.list }, { 'Cache-Control': 'public, max-age=86400' });
  }
  let res: Response;
  try {
    res = await fetch(`${STEADFAST_BASE_URL}/police_stations`, { headers: steadfastHeaders(apiKey, secretKey) });
  } catch (err) {
    console.error('Steadfast police_stations network error:', err);
    return json({ ok: false, error: 'Could not reach Steadfast.' });
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const list = res.ok ? parsePoliceStations(body) : [];
  if (list.length === 0) {
    return json({ ok: false, error: 'Steadfast did not return a thana list.' });
  }
  policeStationsCache = { at: now, list };
  return json({ ok: true, stations: list }, { 'Cache-Control': 'public, max-age=86400' });
}

/** Batch 31 Part 2: Steadfast's customer check for one phone number.
 *  Staff with "View orders" only — customers and visitors are refused. The
 *  answer is kept 24 h in steadfast_fraud_cache (service role only). */
async function handleFraudCheck(
  body: RequestBody,
  userClient: SupabaseUserClient,
  apiKey: string,
  secretKey: string
): Promise<Response> {
  const { data: canView, error: canErr } = await userClient.rpc('staff_can', { p_perm: 'view_orders' });
  let allowed = !canErr && canView === true;
  if (canErr) {
    const { data: isAdmin } = await userClient.rpc('is_admin');
    allowed = isAdmin === true;
  }
  if (!allowed) return json({ ok: false, error: 'Not authorized.' });

  const phone = steadfastPhone(body.phone);
  if (!phone) return json({ ok: false, error: 'Not a valid Bangladeshi mobile number.' });

  const serviceClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const now = Date.now();
  const { data: cached, error: cacheErr } = await serviceClient
    .from('steadfast_fraud_cache')
    .select('result, fetched_at')
    .eq('phone', phone)
    .maybeSingle();
  const cacheTableReady = !cacheErr;
  const row = cached as { result: FraudCheckResult; fetched_at: string } | null;
  const memory = fraudMemory.get(phone);
  const last = row ? { at: new Date(row.fetched_at).getTime(), result: row.result } : !cacheTableReady ? memory : undefined;
  const maxAge = body.refresh === true ? FRAUD_REFRESH_MIN_MS : FRAUD_CACHE_MS;
  if (last && now - last.at < maxAge) {
    return json({ ok: true, result: last.result, fetchedAt: new Date(last.at).toISOString(), cached: true });
  }

  let res: Response;
  try {
    res = await fetch(`${STEADFAST_BASE_URL}/fraud_check/score/${phone}`, { headers: steadfastHeaders(apiKey, secretKey) });
  } catch (err) {
    console.error('Steadfast fraud_check network error:', err);
    return json({ ok: false, error: 'Could not reach Steadfast.' });
  }
  let answer: unknown = null;
  try {
    answer = await res.json();
  } catch {
    answer = null;
  }
  const result = res.ok ? parseFraudCheck(answer, phone) : null;
  if (!result) {
    return json({ ok: false, error: res.status === 429 ? 'Steadfast is busy. Try again later.' : 'Steadfast did not answer the check.' });
  }
  const fetchedAt = new Date(now).toISOString();
  if (cacheTableReady) {
    const { error: upsertErr } = await serviceClient
      .from('steadfast_fraud_cache')
      .upsert({ phone, result, fetched_at: fetchedAt });
    if (upsertErr) console.error('steadfast_fraud_cache save failed:', upsertErr.message);
  } else {
    fraudMemory.set(phone, { at: now, result });
  }
  return json({ ok: true, result, fetchedAt, cached: false });
}

async function handleStatus(
  order: OrderRow,
  userClient: SupabaseUserClient,
  apiKey: string,
  secretKey: string
): Promise<Response> {
  if (!order.steadfast_consignment_id) {
    return json({ ok: false, error: 'This order has not been booked with Steadfast yet.' });
  }

  const result = await checkSteadfastStatus(order.steadfast_consignment_id, apiKey, secretKey);
  if (!result.ok || !result.courierStatus) {
    return json({ ok: false, error: result.error ?? 'Could not refresh status.' });
  }

  const { error: saveErr } = await userClient.rpc('admin_update_steadfast_status', {
    p_order_id: order.id,
    p_courier_status: result.courierStatus,
    p_mark_delivered: result.markedDelivered ?? false,
  });
  if (saveErr) {
    return json({ ok: false, error: `Got the status from Steadfast but could not save it: ${saveErr.message}` });
  }

  return json({
    ok: true,
    courierStatus: result.courierStatus,
    markedDelivered: result.markedDelivered ?? false,
    needsAttention: result.needsAttention ?? false,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed.' });
  }

  const apiKey = Deno.env.get('STEADFAST_API_KEY');
  const secretKey = Deno.env.get('STEADFAST_SECRET_KEY');
  if (!apiKey || !secretKey) {
    return json({ ok: false, error: 'Steadfast is not connected yet — ask Naeem to add the API keys in Supabase.' });
  }

  let requestBody: RequestBody;
  try {
    requestBody = (await req.json()) as RequestBody;
  } catch {
    return json({ ok: false, error: 'Invalid request.' });
  }
  // Batch 30: the thana list is public (checkout needs it before sign-in).
  if (requestBody.action === 'police_stations') {
    return await handlePoliceStations(apiKey, secretKey);
  }

  // Batch 31 Part 2: the customer check (staff only, checked inside).
  if (requestBody.action === 'fraud_check') {
    const fraudClient = userClientFor(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      req.headers.get('Authorization') ?? ''
    );
    return await handleFraudCheck(requestBody, fraudClient, apiKey, secretKey);
  }

  const knownActions = ['create', 'status', 'tracking'];
  if (!requestBody.orderId || !knownActions.includes(requestBody.action ?? '')) {
    return json({ ok: false, error: 'Invalid request.' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = userClientFor(supabaseUrl, anonKey, authHeader);

  // Batch 30: tracking steps — the customer who owns the order or staff
  // with "View orders"; the order read itself (RLS) decides.
  if (requestBody.action === 'tracking') {
    return await handleTracking(requestBody.orderId, userClient, apiKey, secretKey);
  }

  // Batch 24: the Super Admin always passes; a moderator needs "Book on
  // Steadfast" to book, and that or "Change order status" to check the
  // delivery status. The database functions below check the same thing
  // again themselves (migration-030).
  const permissionNeeded = requestBody.action === 'create' ? ['book_steadfast'] : ['book_steadfast', 'change_order_status'];
  let allowed = false;
  for (const perm of permissionNeeded) {
    const { data: can, error: permErr } = await userClient.rpc('staff_can', { p_perm: perm });
    if (!permErr && can === true) {
      allowed = true;
      break;
    }
    if (permErr) {
      // staff_can doesn't exist until migration-030 runs — keep the old
      // admin-only rule working until then.
      const { data: isAdmin } = await userClient.rpc('is_admin');
      allowed = isAdmin === true;
      break;
    }
  }
  if (!allowed) {
    return json({ ok: false, error: 'Not authorized.' });
  }

  // Batch 30 columns first; before migration-033 they don't exist yet, so
  // the same read without them.
  const withNewColumns = await userClient
    .from('orders')
    .select(`${ORDER_COLUMNS}, alt_phone, courier_note`)
    .eq('id', requestBody.orderId)
    .maybeSingle();
  const orderRes =
    withNewColumns.error?.code === '42703'
      ? await userClient.from('orders').select(ORDER_COLUMNS).eq('id', requestBody.orderId).maybeSingle()
      : withNewColumns;
  const order = orderRes.data as OrderRow | null;
  const orderErr = orderRes.error;

  if (orderErr || !order) {
    return json({ ok: false, error: 'Order not found.' });
  }

  if (requestBody.action === 'create') {
    return await handleCreate(order as OrderRow, userClient, apiKey, secretKey);
  }
  return await handleStatus(order as OrderRow, userClient, apiKey, secretKey);
});
