// Supabase Edge Function: books an order's parcel with Steadfast Courier,
// or refreshes its delivery status. Called directly from the admin order
// detail screen (src/lib/orders.ts bookSteadfastShipment/
// refreshSteadfastStatus), never automatically.
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
// DEFINER RPC (migration-025), never a service-role bypass. The order
// itself is always read fresh from the database by id; nothing about a
// customer's name/phone/address/total is ever trusted from the request
// body — the request body only ever carries an orderId and which action to
// run.
//
// STEADFAST_API_KEY and STEADFAST_SECRET_KEY are Naeem's own secrets, set
// in Supabase Edge Function secrets (see reports/batch-20.txt) — never in
// this repo, the frontend, or written to any log line below.
//
// PART 1 assumptions (see reports/batch-20.txt for what the official docs
// confirmed vs. what had to be assumed): base URL, header names, and field
// names below were verified against the source of a real, currently
// maintained open-source Steadfast API client library (not guessed from
// memory) — but there is no way to test them against a real Steadfast
// account from this environment, so treat the very first real booking as
// the actual test. Everything Steadfast-specific is isolated in the three
// constants/helpers right below so a wrong assumption is a one-place fix.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const STEADFAST_BASE_URL = 'https://portal.packzy.com/api/v1';

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

function steadfastHeaders(apiKey: string, secretKey: string): HeadersInit {
  return {
    'Api-Key': apiKey,
    'Secret-Key': secretKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/** Steadfast's own delivery_status values that mean "actually delivered" —
 *  see status_by_cid's documented response. Everything else (cancelled,
 *  hold, in_review, pending, unknown, ...) is shown as-is, never acted on. */
function meansDelivered(courierStatus: string): boolean {
  return courierStatus === 'delivered' || courierStatus === 'partial_delivered';
}

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
  steadfast_status: string | null;
}

interface RequestBody {
  action?: 'create' | 'status';
  orderId?: string;
}

interface SteadfastCreateResponse {
  status?: number;
  message?: string;
  consignment?: {
    consignment_id: number | string;
    tracking_code?: string;
    status?: string;
  };
}

interface SteadfastStatusResponse {
  status?: number;
  delivery_status?: string;
  message?: string;
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
    return json({
      ok: false,
      error: body.message ?? `Steadfast rejected the request (HTTP ${steadfastRes.status}).`,
    });
  }

  const consignmentId = String(body.consignment.consignment_id);
  const trackingCode = body.consignment.tracking_code ?? '';
  const courierStatus = body.consignment.status ?? 'in_review';

  const { error: saveErr } = await userClient.rpc('admin_record_steadfast_shipment', {
    p_order_id: order.id,
    p_consignment_id: consignmentId,
    p_tracking_code: trackingCode,
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

  return json({ ok: true, consignmentId, trackingCode, courierStatus });
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

  let steadfastRes: Response;
  try {
    steadfastRes = await fetch(
      `${STEADFAST_BASE_URL}/status_by_cid/${encodeURIComponent(order.steadfast_consignment_id)}`,
      { headers: steadfastHeaders(apiKey, secretKey) }
    );
  } catch (err) {
    console.error('Steadfast status_by_cid network error:', err);
    return json({ ok: false, error: 'Could not reach Steadfast. Please try again.' });
  }

  let body: SteadfastStatusResponse;
  try {
    body = (await steadfastRes.json()) as SteadfastStatusResponse;
  } catch {
    return json({ ok: false, error: `Steadfast returned an unreadable response (HTTP ${steadfastRes.status}).` });
  }

  if (!steadfastRes.ok || !body.delivery_status) {
    return json({
      ok: false,
      error: body.message ?? `Steadfast rejected the request (HTTP ${steadfastRes.status}).`,
    });
  }

  const courierStatus = body.delivery_status;
  const markedDelivered = meansDelivered(courierStatus);

  const { error: saveErr } = await userClient.rpc('admin_update_steadfast_status', {
    p_order_id: order.id,
    p_courier_status: courierStatus,
    p_mark_delivered: markedDelivered,
  });
  if (saveErr) {
    return json({ ok: false, error: `Got the status from Steadfast but could not save it: ${saveErr.message}` });
  }

  return json({ ok: true, courierStatus, markedDelivered });
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
      'id, order_number, customer_name, customer_phone, division, district, thana, address_line, total, payment_method, payment_status, status, customer_note, steadfast_consignment_id, steadfast_tracking_code, steadfast_status'
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
