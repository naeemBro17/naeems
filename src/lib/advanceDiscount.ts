// Batch 48: the advance-payment discount — customers who pay in advance with
// bKash or Nagad get this off their products (never off delivery). Pure
// code, shared by the checkout, the order pages, the invoice and the admin
// settings card. The database works out the real amount itself when the
// order is saved (advance_discount_amount() in migration-049); the numbers
// here are the same rule, for showing it before the order is placed.
import type { AppSettings, Order, OrderPaymentMethod } from '../types';

export type AdvanceDiscountType = 'percent' | 'fixed';

export interface AdvanceDiscountRule {
  enabled: boolean;
  type: AdvanceDiscountType;
  value: number;
}

/** The two wallets that count as paying in advance. */
export type WalletMethod = 'bkash' | 'nagad';

export const WALLET_NAMES: Record<WalletMethod, string> = {
  bkash: 'bKash',
  nagad: 'Nagad',
};

export function isWalletMethod(method: string | null | undefined): method is WalletMethod {
  return method === 'bkash' || method === 'nagad';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "৳1,000" — the wording the offer badge and the admin preview use. */
export function takaTight(amount: number): string {
  return `৳${round2(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/** Reads the three settings. Anything broken or missing counts as Off, so a
 *  bad value can never stop bKash / Nagad orders (the database does the
 *  same). */
export function advanceRuleFromSettings(
  settings: Pick<AppSettings, 'advance_discount_enabled' | 'advance_discount_type' | 'advance_discount_value'>
): AdvanceDiscountRule {
  const type: AdvanceDiscountType = settings.advance_discount_type === 'fixed' ? 'fixed' : 'percent';
  const raw = settings.advance_discount_value.trim();
  const value = /^\d+(\.\d+)?$/.test(raw) ? round2(Number(raw)) : 0;
  const typeOk = settings.advance_discount_type === 'percent' || settings.advance_discount_type === 'fixed';
  const valueOk = value > 0 && (type === 'fixed' || value <= 100);
  return { enabled: settings.advance_discount_enabled === 'true' && typeOk && valueOk, type, value: valueOk ? value : 0 };
}

/** True when checkout should show the offer at all (On and more than 0). */
export function advanceOfferActive(rule: AdvanceDiscountRule): boolean {
  return rule.enabled && rule.value > 0;
}

/**
 * The advance discount in taka.
 *   base    = the product subtotal after any promo code (delivery is never
 *             discounted)
 *   percent = round(base × value / 100) to the nearest taka
 *   fixed   = the value, never more than the base
 * Cash on Delivery (or the offer Off / 0) gets nothing.
 */
export function computeAdvanceDiscount(rule: AdvanceDiscountRule, base: number, method: OrderPaymentMethod | string): number {
  if (!isWalletMethod(method) || !advanceOfferActive(rule)) return 0;
  const safeBase = Math.max(0, round2(base));
  if (rule.type === 'percent') return Math.min(Math.round((safeBase * rule.value) / 100), safeBase);
  return Math.min(rule.value, safeBase);
}

/** The promo code's discount as the database keeps it (to the paisa). */
export function promoDiscountRounded(discount: number): number {
  return round2(Math.max(0, discount));
}

/** "0.5" / "2" / "12.5" — no trailing zeros. */
function plainNumber(n: number): string {
  return String(round2(n));
}

/** The green badge on the "Pay in advance" group: "0.5% OFF" / "৳50 OFF". */
export function advanceOfferBadge(rule: AdvanceDiscountRule): string {
  return rule.type === 'percent' ? `${plainNumber(rule.value)}% OFF` : `${takaTight(rule.value)} OFF`;
}

/** The line in the order's money: "Advance payment 0.5%" for percent,
 *  "Advance payment discount" for a fixed amount. */
export function advanceLineLabel(type: AdvanceDiscountType | null | undefined, value: number | null | undefined): string {
  return type === 'percent' && value ? `Advance payment ${plainNumber(value)}%` : 'Advance payment discount';
}

/** The admin card's preview line. */
export function advancePreview(rule: Pick<AdvanceDiscountRule, 'type' | 'value'>): string {
  if (rule.type === 'percent') {
    const saves = Math.min(Math.round((1000 * Math.max(rule.value, 0)) / 100), 1000);
    return `On a ${takaTight(1000)} order the customer saves ${takaTight(saves)}.`;
  }
  return `The customer saves ${takaTight(Math.max(rule.value, 0))} on every bKash or Nagad order.`;
}

/** An order's whole discount split into the promo / hand-typed part and the
 *  advance-payment part (orders.discount holds both — migration-049). */
export function orderDiscountParts(order: Pick<Order, 'discount' | 'advance_discount'>): { other: number; advance: number } {
  const whole = Math.max(0, Number(order.discount) || 0);
  const advance = Math.min(Math.max(0, Number(order.advance_discount) || 0), whole);
  return { other: round2(whole - advance), advance: round2(advance) };
}
