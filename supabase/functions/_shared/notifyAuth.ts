// Batch 34 Part 3: who may call notify-telegram-order.
//
// The orders trigger sends a dedicated random shared secret (kept in
// Supabase Vault, migration-036) in the x-notify-secret header. The old
// Database Webhook sent the service key as "Authorization: Bearer …"; that
// call is still accepted (compared with the function's own copy of the
// key), so alerts keep working in the minutes between deploying this
// function and running migration-036. Anything else is refused.

/** Compares two strings in constant time (for equal lengths). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface NotifyAuthInput {
  /** x-notify-secret header, or null. */
  secretHeader: string | null;
  /** Authorization header, or null. */
  authorization: string | null;
  /** The shared secret from Vault, or null if not set up yet. */
  expectedSecret: string | null;
  /** The function's own service key, or null. */
  serviceKey: string | null;
}

export function isAuthorizedNotifyCall(input: NotifyAuthInput): boolean {
  const { secretHeader, authorization, expectedSecret, serviceKey } = input;
  if (secretHeader && expectedSecret && timingSafeEqual(secretHeader, expectedSecret)) return true;
  if (authorization && serviceKey && authorization.startsWith('Bearer ')) {
    return timingSafeEqual(authorization.slice('Bearer '.length), serviceKey);
  }
  return false;
}
