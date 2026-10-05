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
