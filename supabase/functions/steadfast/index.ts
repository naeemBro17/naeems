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
  type SteadfastStatusResponse,
} from '../_shared/steadfast.ts';

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
  payment_method: 'cod' | 'bkash';
  payment_status: 'unpaid' | 'pending_verification' | 'paid';
  status: string;
  customer_note: string | null;
  steadfast_consignment_id: string | null;
  steadfast_tracking_code: string | null;
  steadfast_tracking_link: string | null;
  steadfast_status: string | null;
}

interface RequestBody {
  action?: 'create' | 'status';
  orderId?: string;
}

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

type SupabaseUserClient = ReturnType<typeof createClient>;

function json(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
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

  let codAmount: number;
  if (order.payment_method === 'bkash') {
    if (order.payment_status !== 'paid') {
      return json({
        ok: false,
        error: 'This bKash payment has not been verified yet — mark it as paid before booking with Steadfast.',
      });
    }
    codAmount = 0;
  } else {
    codAmount = order.total;
  }

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
        ...(order.customer_note ? { note: order.customer_note } : {}),
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

  return json({ ok: true, consignmentId, trackingCode, trackingLink, courierStatus });
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
  if (!requestBody.orderId || (requestBody.action !== 'create' && requestBody.action !== 'status')) {
    return json({ ok: false, error: 'Invalid request.' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: isAdmin, error: adminErr } = await userClient.rpc('is_admin');
  if (adminErr || !isAdmin) {
    return json({ ok: false, error: 'Not authorized.' });
  }

  const { data: order, error: orderErr } = await userClient
    .from('orders')
    .select(
      'id, order_number, customer_name, customer_phone, division, district, thana, address_line, total, payment_method, payment_status, status, customer_note, steadfast_consignment_id, steadfast_tracking_code, steadfast_tracking_link, steadfast_status'
    )
    .eq('id', requestBody.orderId)
    .maybeSingle();

  if (orderErr || !order) {
    return json({ ok: false, error: 'Order not found.' });
  }

  if (requestBody.action === 'create') {
    return await handleCreate(order as OrderRow, userClient, apiKey, secretKey);
  }
  return await handleStatus(order as OrderRow, userClient, apiKey, secretKey);
});
