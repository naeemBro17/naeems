// Supabase Edge Function: Telegram notes about the nightly database backup
// — Batch 31 Part 1. Called by the GitHub Action .github/workflows/backup.yml,
// never by the website.
//
// Uses the same bot and chat as the order alerts (TELEGRAM_BOT_TOKEN /
// TELEGRAM_CHAT_ID, already set for notify-telegram-order), so Naeem gets
// these in the same Telegram chat. The caller must send BACKUP_ALERT_SECRET
// (a long random token kept only as a Supabase secret and a GitHub secret)
// in the x-backup-alert-secret header. JWT verification is off for this
// function (supabase/config.toml) because GitHub has no Supabase login; the
// secret check below stands in for it.
//
// Only two fixed messages can be sent — never text chosen by the caller —
// so even a leaked secret could not be used to send anything else.

type Kind = 'failed' | 'weekly';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function backupMessage(kind: Kind, date: string, saved: number): string {
  if (kind === 'failed') return `Backup failed on ${date} — check GitHub Actions`;
  return saved >= 7 ? 'Backups OK — last 7 days saved.' : `Backups: only ${saved} of the last 7 days saved — check GitHub Actions`;
}

Deno.serve(async (req: Request) => {
  const expected = Deno.env.get('BACKUP_ALERT_SECRET');
  const given = req.headers.get('x-backup-alert-secret') ?? '';
  if (req.method !== 'POST' || !expected || !timingSafeEqual(given, expected)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID');
  if (!token || !chatId) {
    return new Response(JSON.stringify({ skipped: 'telegram secrets not set' }), { status: 200 });
  }

  let body: { kind?: unknown; date?: unknown; saved?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
  }
  const kind = body.kind === 'failed' || body.kind === 'weekly' ? body.kind : null;
  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
  const saved = typeof body.saved === 'number' && Number.isInteger(body.saved) ? Math.max(0, Math.min(7, body.saved)) : 0;
  if (!kind || !date) {
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: backupMessage(kind, date, saved), disable_notification: kind === 'weekly' }),
  });
  if (!res.ok) {
    console.error('backup-alert: Telegram refused the message, status', res.status);
    return new Response(JSON.stringify({ error: 'telegram' }), { status: 502 });
  }
  return new Response(JSON.stringify({ sent: true }), { status: 200 });
});
