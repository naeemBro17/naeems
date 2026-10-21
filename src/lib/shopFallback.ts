import { whatsAppChatUrl } from './phone';

/* Batch 40 Part 3: how customers reach Naeem when the shop can't reach its
   database. These can't come from the database (it may be the thing that is
   down), so they are built into the site: the Vercel settings
   VITE_FALLBACK_WHATSAPP and VITE_FALLBACK_MESSENGER, else the values below
   (Admin → Settings as of 21 Oct 2026: shop_whatsapp_number and
   messenger_link). */

export const DEFAULT_FALLBACK_WHATSAPP = '8801560040012';
export const DEFAULT_FALLBACK_MESSENGER = 'https://m.me/naeems.skinscience';

/** https://wa.me/8801… — from a number typed any way, or a full link. */
export function fallbackWhatsAppUrl(raw = import.meta.env.VITE_FALLBACK_WHATSAPP): string {
  const value = (raw ?? '').trim();
  if (value.startsWith('https://')) return value;
  return whatsAppChatUrl(value) ?? `https://wa.me/${DEFAULT_FALLBACK_WHATSAPP}`;
}

/** The Messenger link (m.me/…); the default when the setting isn't a link. */
export function fallbackMessengerUrl(raw = import.meta.env.VITE_FALLBACK_MESSENGER): string {
  const value = (raw ?? '').trim();
  return value.startsWith('https://') ? value : DEFAULT_FALLBACK_MESSENGER;
}
