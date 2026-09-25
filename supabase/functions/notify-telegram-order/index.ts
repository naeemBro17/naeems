// Supabase Edge Function: sends Naeem a Telegram message for every new order
// (and every order a customer/admin cancels). Meant to be called by a
// Supabase Database Webhook on the `orders` table (INSERT, and UPDATE —
// see reports/batch-18.txt for the exact dashboard setup steps), which POSTs
// the standard webhook payload shape:
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

const ADMIN_URL = 'https://naeems-all.vercel.app/admin';

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
  for (const item of items) {
    const variant = item.variant_label ? ` (${item.variant_label})` : '';
    lines.push(`- ${item.product_name}${variant} x${item.quantity} — ${formatTaka(item.line_total)}`);
  }
  lines.push('');
  lines.push(`💰 <b>Total: ${formatTaka(order.total)}</b>`);
  if (order.payment_method === 'bkash') {
    lines.push(`💳 bKash — TrxID: ${order.bkash_trx_id ?? '-'}`);
  } else {
    lines.push('💳 Cash on Delivery');
  }
  lines.push('');
  lines.push(`🔗 ${ADMIN_URL}`);
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
    `🔗 ${ADMIN_URL}`,
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

    if (!isNewOrder && !isNewCancellation) {
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
    } else {
      await sendTelegramMessage(token, chatId, buildCancelMessage(order));
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
