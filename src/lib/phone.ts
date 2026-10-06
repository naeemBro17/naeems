/**
 * One key per Bangladeshi mobile number, however it was typed (Batch 30
 * Part 4): "+880 1712-345678", "8801712345678", "01712345678" and
 * "1712345678" all become "01712345678". Anything else is kept as its
 * digits (empty → null). The database has the same rule (bd_phone_key(),
 * migration-033), so the New order search and the Customers page agree.
 */
export function bdPhoneKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (/^(00)?8801\d{9}$/.test(digits)) return digits.slice(-11);
  if (/^01\d{9}$/.test(digits)) return digits;
  if (/^1\d{9}$/.test(digits)) return `0${digits}`;
  return digits === '' ? null : digits;
}

/** The part of a typed number that survives any prefix — "+880 17…",
 *  "017…" and "17…" all search for "17…". */
export function phoneSearchCore(raw: string): string {
  return raw.replace(/\D/g, '').replace(/^(00)?880/, '').replace(/^0/, '');
}

/** True when the text looks like a phone number rather than a name. */
export function looksLikePhone(raw: string): boolean {
  return phoneSearchCore(raw).length >= 3 && /^[\d\s+()-]+$/.test(raw.trim());
}

/**
 * Batch 31 Part 5: the number in international form for WhatsApp, digits
 * only, no "+": "01610981117", "+880 1610-981117", "8801610981117" and
 * "1610981117" all become "8801610981117". WhatsApp cannot open a chat
 * without the country code ("Couldn't look up phone number …"). A number
 * that isn't Bangladeshi keeps its own digits (it must already carry its
 * country code); "00" in front is dropped. Null when there are no digits.
 */
export function whatsAppNumber(raw: string | null | undefined): string | null {
  const key = bdPhoneKey(raw);
  if (!key) return null;
  if (/^01\d{9}$/.test(key)) return `88${key}`;
  const digits = key.replace(/^00/, '');
  return digits === '' ? null : digits;
}

/** https://wa.me/8801… for any way the number was typed; null if none. */
export function whatsAppChatUrl(raw: string | null | undefined): string | null {
  const number = whatsAppNumber(raw);
  return number ? `https://wa.me/${number}` : null;
}

/** tel:+8801… for any way the number was typed; null if none. */
export function telHref(raw: string | null | undefined): string | null {
  const number = whatsAppNumber(raw);
  return number ? `tel:+${number}` : null;
}
