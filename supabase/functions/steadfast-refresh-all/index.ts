// Supabase Edge Function: refreshes Steadfast's delivery status for every
// shipped-and-booked order, unattended — Batch 20 Part 2. Triggered by a
// pg_cron job every 3 hours (see migration-026-steadfast-auto.sql), not by
// a person, so there is no admin session/JWT to check is_admin() against —
// this function authenticates the CALLER (pg_cron, via pg_net) instead of
// the order, using STEADFAST_CRON_REFRESH_SECRET, a long random token that
// exists only as a Supabase Edge Function secret and inside this project's
// database Vault (never in this repo) — the same "long secret token"
// fallback the task asked for, used here because Steadfast's API guide PDF
// documents that webhooks exist but Naeem's PDF export didn't include the
// separate page describing their payload/signature — see
// reports/fix-steadfast-auto.txt.
//
// Writes go through system_update_steadfast_status (migration-026), a
// second SECURITY DEFINER function alongside admin_update_steadfast_status
// — same body, but callable only by the service_role, never by
// `authenticated` — because there's no is_admin() to check here; the
// caller-secret check above is what stands in for it. Exactly like the
// admin-triggered refresh: delivered/partial_delivered marks the order
// delivered with a history row, and anything needing attention (cancelled,
// hold, exceptional) never touches the order's own status — the existing
// orders Database Webhook already calls notify-telegram-order on every
// `orders` UPDATE, and that function now also alerts Naeem by Telegram the
// moment one of those three shows up, so "unattended" doesn't mean "silent"
// for the cases that actually need him.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { checkSteadfastStatus } from '../_shared/steadfast.ts';

interface ShippedOrder {
  id: string;
  steadfast_consignment_id: string;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get('STEADFAST_CRON_REFRESH_SECRET');
  const authHeader = req.headers.get('Authorization') ?? '';
  const providedSecret = authHeader.replace(/^Bearer\s+/i, '');

  // Fails closed: no secret configured, or the caller didn't present the
  // right one — refuse rather than silently skip, so a misconfiguration
  // shows up as an obvious error in the pg_cron job's own logs instead of
  // just quietly never running.
  if (!cronSecret || providedSecret !== cronSecret) {
    return json({ ok: false, error: 'Not authorized.' }, 401);
  }

  const apiKey = Deno.env.get('STEADFAST_API_KEY');
  const secretKey = Deno.env.get('STEADFAST_SECRET_KEY');
  if (!apiKey || !secretKey) {
    return json({ ok: false, error: 'Steadfast is not connected yet.' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const serviceClient = createClient(supabaseUrl, serviceRoleKey);

  // "Every shipped + booked order" (task wording) — in this app a shipped
  // order that came through Steadfast always has a consignment id (booking
  // sets both at once, see admin_record_steadfast_shipment), so this also
  // naturally skips any order marked shipped by hand through a different
  // courier, which Steadfast has never heard of.
  const { data: orders, error: fetchErr } = await serviceClient
    .from('orders')
    .select('id, steadfast_consignment_id')
    .eq('status', 'shipped')
    .not('steadfast_consignment_id', 'is', null);

  if (fetchErr) {
    console.error('steadfast-refresh-all: fetching shipped orders failed:', fetchErr.message);
    return json({ ok: false, error: 'Could not load shipped orders.' });
  }

  const shipped = (orders ?? []) as ShippedOrder[];
  let updated = 0;
  let delivered = 0;
  let flagged = 0;
  let failed = 0;

  for (const order of shipped) {
    const result = await checkSteadfastStatus(order.steadfast_consignment_id, apiKey, secretKey);
    if (!result.ok || !result.courierStatus) {
      failed += 1;
      console.error(`steadfast-refresh-all: status check failed for order ${order.id}:`, result.error);
      continue;
    }

    const { error: saveErr } = await serviceClient.rpc('system_update_steadfast_status', {
      p_order_id: order.id,
      p_courier_status: result.courierStatus,
      p_mark_delivered: result.markedDelivered ?? false,
    });
    if (saveErr) {
      failed += 1;
      console.error(`steadfast-refresh-all: saving status failed for order ${order.id}:`, saveErr.message);
      continue;
    }

    updated += 1;
    if (result.markedDelivered) delivered += 1;
    if (result.needsAttention) flagged += 1;
  }

  return json({
    ok: true,
    checked: shipped.length,
    updated,
    delivered,
    flagged,
    failed,
  });
});
