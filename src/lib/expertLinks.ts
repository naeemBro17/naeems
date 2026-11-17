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

/**
 * Batch 47: "Questions about this order?" — WhatsApp to the shop's number
 * (the expert's WhatsApp link when the shop number is not set), with the
 * order number already written. Used by the order page and the "Order
 * placed" page. Null when no WhatsApp is set up.
 */
export function orderHelpWhatsAppUrl(
  settings: { shop_whatsapp_number?: string | null; expert_whatsapp_url?: string | null },
  orderNumber: string
): string | null {
  const base = whatsAppChatUrl(settings.shop_whatsapp_number) ?? whatsAppUrl(settings.expert_whatsapp_url ?? '');
  if (!base) return null;
  return `${base}${base.includes('?') ? '&' : '?'}text=${encodeURIComponent(`Hi, I have a question about order ${orderNumber}`)}`;
}
