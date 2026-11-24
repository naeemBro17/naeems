import type { DeliveryAddress } from '../features/checkout/types';
import type { CustomerSearchResult } from './customers';
import type { StockUnitWord } from './inventory/types';
import type { CollectMode } from './paymentPlan';
import type { PaymentMethodId } from './payments';
import type { DiscountReason, OrderSource } from '../types';

/**
 * Batch 64 Part 6b: a half-typed New order survives a reload. While Naeem
 * types, the form is kept on his own device (localStorage), one draft per
 * staff login, for 12 hours. Opening New order with a draft shows a bar
 * (Restore / Discard); nothing is filled silently. Smart paste text is not
 * kept. Every storage call is wrapped: if storage fails, New order works
 * exactly as before, just without a draft.
 */

export const DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const PREFIX = 'naeems.newOrderDraft.';
const VERSION = 1;

/** One item as typed: which product, how many, and his own price. */
export interface DraftLine {
  productId: string;
  variantId: string | null;
  quantity: number;
  soldUnit: StockUnitWord | null;
  soldPriceInput: string;
  reason: DiscountReason | null;
  reasonNote: string;
}

export interface NewOrderDraftData {
  source: OrderSource | null;
  address: DeliveryAddress;
  altPhone: string;
  pickedCustomer: CustomerSearchResult | 'new' | null;
  customerQuery: string;
  lines: DraftLine[];
  zone: 'inside_dhaka' | 'outside_dhaka' | 'hand_delivered';
  zoneTouched: boolean;
  zoneFromSource: boolean;
  feeInput: string;
  orderDiscountInput: string;
  discountReason: DiscountReason | null;
  discountNote: string;
  paidNowInput: string;
  paidMethod: PaymentMethodId | null;
  paidTrxId: string;
  collectMode: CollectMode;
  markDelivered: boolean;
  adminNote: string;
}

export interface NewOrderDraft {
  savedAt: number;
  data: NewOrderDraftData;
}

export function draftKey(userId: string): string {
  return PREFIX + userId;
}

function storageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** True when nothing worth keeping was typed (an untouched form). */
export function isDraftEmpty(d: NewOrderDraftData): boolean {
  const a = d.address;
  const typed = [a.fullName, a.phone, a.fullAddress, a.thana, d.altPhone, d.customerQuery, d.paidNowInput, d.paidTrxId, d.adminNote, d.discountNote];
  return (
    d.lines.length === 0 &&
    d.source === null &&
    d.pickedCustomer === null &&
    typed.every((v) => v.trim() === '') &&
    (d.orderDiscountInput.trim() === '' || d.orderDiscountInput.trim() === '0')
  );
}

export function saveDraft(userId: string, data: NewOrderDraftData, now: number = Date.now(), storage: Storage | null = storageOrNull()): void {
  if (!storage) return;
  try {
    if (isDraftEmpty(data)) {
      storage.removeItem(draftKey(userId));
      return;
    }
    storage.setItem(draftKey(userId), JSON.stringify({ v: VERSION, savedAt: now, data }));
  } catch {
    // Full or blocked: no draft this time; the form itself is unaffected.
  }
}

export function clearDraft(userId: string, storage: Storage | null = storageOrNull()): void {
  if (!storage) return;
  try {
    storage.removeItem(draftKey(userId));
  } catch {
    // Nothing to do.
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** The fresh draft, or null. An expired or unreadable one is deleted. */
export function loadDraft(userId: string, now: number = Date.now(), storage: Storage | null = storageOrNull()): NewOrderDraft | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(draftKey(userId));
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const savedAt = isObject(parsed) && typeof parsed.savedAt === 'number' ? parsed.savedAt : null;
  const data = isObject(parsed) && parsed.v === VERSION && isObject(parsed.data) ? parsed.data : null;
  const ok = savedAt !== null && data !== null && Array.isArray(data.lines) && isObject(data.address);
  // Expired (or saved "in the future" by a wrong clock): deleted silently.
  if (!ok || savedAt === null || now - savedAt > DRAFT_MAX_AGE_MS || now < savedAt - 60_000) {
    clearDraft(userId, storage);
    return null;
  }
  return { savedAt, data: data as unknown as NewOrderDraftData };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "10:42 PM" when saved today (local time), else "23 Nov, 10:42 PM". */
export function draftTimeLabel(savedAt: number, now: number = Date.now()): string {
  const d = new Date(savedAt);
  const today = new Date(now);
  const hours = d.getHours();
  const time = `${hours % 12 === 0 ? 12 : hours % 12}:${String(d.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? time : `${d.getDate()} ${MONTHS[d.getMonth()]}, ${time}`;
}

/** Splits a draft's items into the ones still for sale (`find` returns the
 *  current option) and how many were left out. */
export function restorableLines<T>(lines: DraftLine[], find: (line: DraftLine) => T | null): { kept: { line: DraftLine; option: T }[]; dropped: number } {
  const kept: { line: DraftLine; option: T }[] = [];
  let dropped = 0;
  for (const line of lines) {
    const option = find(line);
    if (option === null) dropped += 1;
    else kept.push({ line, option });
  }
  return { kept, dropped };
}

/** "1 item was left out because it is no longer available." */
export function droppedItemsText(count: number): string {
  return count === 1
    ? '1 item was left out because it is no longer available.'
    : `${count} items were left out because they are no longer available.`;
}
