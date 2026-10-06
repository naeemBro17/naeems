import { whatsAppChatUrl } from './phone';

/**
 * Resolve the WhatsApp setting into an openable URL. The field accepts either
 * a full link or a bare phone number, which becomes a wa.me link — with the
 * country code added (Batch 31 Part 5: "017…" alone does not open).
 */
export function whatsAppUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  if (value.startsWith('http')) return value;
  return whatsAppChatUrl(value);
}

/** Open an external destination in a new tab, never leaking the opener. */
export function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}
