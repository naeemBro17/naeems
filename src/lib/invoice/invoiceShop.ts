// Batch 37: the invoice settings (Admin → Settings → Invoice), read from
// one place with their defaults. No database code here, so tests and the
// settings page can use it directly.
import type { AppSettings } from '../../types';
import { bdPhoneKey } from '../phone';

export const INVOICE_DEFAULTS = {
  shopName: "NAEEM'S",
  city: 'Dhaka, Bangladesh',
  communityLink: 'https://www.facebook.com/groups/skinscience.psychology.solution',
  communityTitle: "Join the NAEEM'S skincare community",
  communityLine1: 'Skincare tips, new arrivals and members-only offers.',
  communityLine2: 'Scan the code with your phone camera to join our Facebook group.',
} as const;

export interface InvoiceShop {
  name: string;
  /** "01560-040012" (or as typed when not a BD mobile); '' when unset. */
  phone: string;
  city: string;
  community: {
    show: boolean;
    link: string;
    title: string;
    line1: string;
    line2: string;
  };
}

/** "01850-078600" for a BD mobile; anything else as typed. */
export function formatInvoicePhone(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  if (/^https?:/i.test(text)) {
    const digits = text.replace(/\D/g, '');
    return digits === '' ? '' : formatInvoicePhone(digits);
  }
  const key = bdPhoneKey(text);
  if (key && /^01\d{9}$/.test(key)) return `${key.slice(0, 5)}-${key.slice(5)}`;
  return text;
}

/** Every invoice setting, read from one place, with its default. */
export function invoiceShop(settings: Partial<AppSettings>): InvoiceShop {
  const pick = (value: string | undefined, fallback: string) => {
    const v = (value ?? '').trim();
    return v === '' ? fallback : v;
  };
  return {
    name: INVOICE_DEFAULTS.shopName,
    phone: formatInvoicePhone(pick(settings.invoice_shop_phone, settings.shop_whatsapp_number ?? '')),
    city: pick(settings.invoice_shop_city, INVOICE_DEFAULTS.city),
    community: {
      show: (settings.invoice_show_community ?? 'true').trim() !== 'false',
      link: pick(settings.invoice_community_link, INVOICE_DEFAULTS.communityLink),
      title: pick(settings.invoice_community_title, INVOICE_DEFAULTS.communityTitle),
      line1: pick(settings.invoice_community_line1, INVOICE_DEFAULTS.communityLine1),
      line2: pick(settings.invoice_community_line2, INVOICE_DEFAULTS.communityLine2),
    },
  };
}
