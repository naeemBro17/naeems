// Supabase Edge Function: sends Naeem a Telegram message for every new
// order, every order a customer/admin cancels, and — Batch 20 Part 2 —
// every order whose Steadfast courier status turns into something that
// needs his attention (cancelled/hold/exceptional), whether that came from
// the manual refresh button or the automatic 3-hourly one. Meant to be
// called by a Supabase Database Webhook on the `orders` table (INSERT, and
// UPDATE — see reports/batch-18.txt for the exact dashboard setup steps,
// unchanged by Part 2: it already fires on every UPDATE, not just specific
// columns), which POSTs the standard webhook payload shape:
//   { type: "INSERT" | "UPDATE", table: "orders", record: {...}, old_record: {...} | null }
//
// Deliberately fails soft everywhere: if the bot token/chat id secrets
// aren't set yet, or the Telegram API call itself fails, this returns 200
// and just logs — a notification going missing must never be able to take
// the order flow down, and the order itself is already safely committed to
// the database by the time this runs (the webhook fires after the INSERT/
// UPDATE, not as part of place_order()'s own transaction).
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Edge Functions runtime for every function — nothing to configure for
// those two. TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are the two secrets
// Naeem sets himself (see the report).

import { createClient } from 'jsr:@supabase/supabase-js@2';

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
  bkash_trx_id: string | null;
  status: string;
  steadfast_status: string | null;
}

/** Mirrors needsAttention() in functions/_shared/steadfast.ts — kept as a
 *  separate literal here rather than a cross-function import since this
 *  function's only other job (new-order/cancellation alerts) has nothing to
 *  do with Steadfast; three status strings aren't worth coupling the two
 *  together for. See reports/fix-steadfast-auto.txt Part 2. */
function steadfastNeedsAttention(courierStatus: string): boolean {
  return courierStatus === 'cancelled' || courierStatus === 'hold' || courierStatus === 'exceptional';
}

interface OrderItemRow {
  product_name: string;
  variant_label: string | null;
  quantity: number;
  line_total: number;
}

interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  record: OrderRow | null;
  old_record: OrderRow | null;
}

const ADMIN_BASE_URL = 'https://naeems-all.vercel.app/admin';

/** Deep links straight to the Orders tab with this order's sheet open
 *  (AdminPage reads ?tab= and ?order= — see src/pages/AdminPage.tsx). */
function adminOrderUrl(orderId: string): string {
  return `${ADMIN_BASE_URL}?tab=orders&order=${orderId}`;
}

function formatTaka(amount: number): string {
  return '৳' + amount.toLocaleString('en-BD');
}

async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('Telegram sendMessage failed:', res.status, body);
  }
}

function buildNewOrderMessage(order: OrderRow, items: OrderItemRow[]): string {
  const lines: string[] = [];
  lines.push(`🆕 <b>নতুন অর্ডার ${order.order_number}</b>`);
  lines.push('');
  lines.push(`👤 ${order.customer_name}`);
  lines.push(`📞 ${order.customer_phone}`);
  lines.push(`📍 ${order.thana}, ${order.district}, ${order.division}`);
  lines.push('');
  lines.push('🛒 <b>Items:</b>');
  if (items.length === 0) {
    lines.push('(no items found for this order)');
  }
  for (const item of items) {
    const variant = item.variant_label ? ` (${item.variant_label})` : '';
    lines.push(`- ${item.product_name}${variant} × ${item.quantity} — ${formatTaka(item.line_total)}`);
  }
  lines.push('');
  lines.push(`💰 <b>Total: ${formatTaka(order.total)}</b>`);
  if (order.payment_method === 'bkash') {
    lines.push(`💳 bKash — TrxID: ${order.bkash_trx_id ?? '-'}`);
  } else {
    lines.push('💳 Cash on Delivery');
  }
  lines.push('');
  lines.push(`🔗 ${adminOrderUrl(order.id)}`);
  return lines.join('\n');
}

function buildCancelMessage(order: OrderRow): string {
  return [
    `❌ <b>অর্ডার বাতিল হয়েছে</b>`,
    '',
    `Order: ${order.order_number}`,
    `👤 ${order.customer_name} · 📞 ${order.customer_phone}`,
    `💰 ${formatTaka(order.total)}`,
    '',
    `🔗 ${adminOrderUrl(order.id)}`,
  ].join('\n');
}

/** Batch 20 Part 2: the 3-hourly automatic Steadfast refresh (and the
 *  manual "refresh status" button) writes steadfast_status straight to the
 *  order — it never auto-cancels the order itself. This is what makes an
 *  automatic "cancelled" or "hold" or "exceptional" actually visible to
 *  Naeem instead of sitting quietly in a field nobody's looking at. */
function buildSteadfastAttentionMessage(order: OrderRow): string {
  return [
    `⚠️ <b>Steadfast: এই অর্ডারে নজর দিন</b>`,
    '',
    `Order: ${order.order_number}`,
    `👤 ${order.customer_name} · 📞 ${order.customer_phone}`,
    `📦 Courier status: ${order.steadfast_status}`,
    '',
    `🔗 ${adminOrderUrl(order.id)}`,
  ].join('\n');
}

Deno.serve(async (req: Request) => {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID');

  // No secrets set yet — do nothing, successfully. Naeem hasn't finished
  // setup, that must never show up as a broken order flow.
  if (!token || !chatId) {
    return new Response(JSON.stringify({ skipped: 'telegram secrets not set' }), { status: 200 });
  }

  try {
    const payload = (await req.json()) as WebhookPayload;
    if (payload.table !== 'orders' || !payload.record) {
      return new Response(JSON.stringify({ skipped: 'not an orders row' }), { status: 200 });
    }

    const order = payload.record;
    const isNewOrder = payload.type === 'INSERT';
    const isNewCancellation =
      payload.type === 'UPDATE' &&
      order.status === 'cancelled' &&
      payload.old_record?.status !== 'cancelled';
    // Fires for both the manual refresh button and the 3-hourly automatic
    // one (both go through admin_update_steadfast_status /
    // system_update_steadfast_status, an ordinary UPDATE this same webhook
    // already receives) — only on the moment it FIRST becomes a status that
    // needs Naeem's attention, not on every later poll that finds it still
    // the same.
    const isNewSteadfastAttention =
      payload.type === 'UPDATE' &&
      order.steadfast_status !== null &&
      steadfastNeedsAttention(order.steadfast_status) &&
      order.steadfast_status !== payload.old_record?.steadfast_status;

    if (!isNewOrder && !isNewCancellation && !isNewSteadfastAttention) {
      return new Response(JSON.stringify({ skipped: 'not a notifiable change' }), { status: 200 });
    }

    if (isNewOrder) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, serviceKey);
      const { data: items, error } = await supabase
        .from('order_items')
        .select('product_name, variant_label, quantity, line_total')
        .eq('order_id', order.id);
      if (error) {
        console.error('Fetching order_items for notification failed:', error.message);
      }
      await sendTelegramMessage(token, chatId, buildNewOrderMessage(order, (items ?? []) as OrderItemRow[]));
    } else if (isNewCancellation) {
      await sendTelegramMessage(token, chatId, buildCancelMessage(order));
    } else {
      await sendTelegramMessage(token, chatId, buildSteadfastAttentionMessage(order));
    }

    return new Response(JSON.stringify({ sent: true }), { status: 200 });
  } catch (err) {
    // Whatever went wrong, this must not surface as a failure to whatever
    // called it (the database webhook doesn't care about the response body,
    // but 200 keeps Supabase from logging/retrying this as a hard error).
    console.error('notify-telegram-order failed:', err);
    return new Response(JSON.stringify({ error: 'internal' }), { status: 200 });
  }
});
