import type { DeliveryAddress } from '../features/checkout/types';

/**
 * Batch 71: what the shopper has typed on the delivery form but not sent
 * yet, kept for this tab (sessionStorage) until the order is placed, so
 * going back to the shop and returning never loses it.
 */
export const DELIVERY_DRAFT_KEY = 'naeems.deliveryDraft';

const FIELDS = ['fullName', 'phone', 'division', 'district', 'thana', 'fullAddress'] as const;

export function readDeliveryDraft(): DeliveryAddress | null {
  try {
    const raw = sessionStorage.getItem(DELIVERY_DRAFT_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (!FIELDS.every((key) => typeof record[key] === 'string')) return null;
    return {
      fullName: String(record.fullName),
      phone: String(record.phone),
      division: String(record.division),
      district: String(record.district),
      thana: String(record.thana),
      fullAddress: String(record.fullAddress),
    };
  } catch {
    return null;
  }
}

export function writeDeliveryDraft(draft: DeliveryAddress): void {
  try {
    sessionStorage.setItem(DELIVERY_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Storage off: the form still works, it just isn't kept.
  }
}

export function clearDeliveryDraft(): void {
  try {
    sessionStorage.removeItem(DELIVERY_DRAFT_KEY);
  } catch {
    // Nothing kept, nothing to clear.
  }
}
