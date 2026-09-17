import { supabase } from './supabase';
import type { PromoCode, PromoCodeFormData, PromoDiscountType } from '../types';

/** Columns the admin panel reads — the full row. Only an authenticated admin
 *  session can actually see id/created_at (migration-014's column grants). */
export const PROMO_CODE_ADMIN_SELECT =
  'id, code, discount_amount, discount_type, max_uses, times_used, expires_at, active, created_at';

/** Columns a customer needs to validate a code — matches the anon column
 *  grant in migration-014; id/created_at are not readable by anon. */
const PROMO_CODE_VALIDATE_SELECT =
  'code, discount_amount, discount_type, max_uses, times_used, expires_at, active';

/** Admin "Add code" form defaults to a usage cap of 50, never unlimited by
 *  accident — the admin has to deliberately clear it to allow unlimited use. */
export function emptyPromoCodeForm(): PromoCodeFormData {
  return {
    code: '',
    discount_amount: '',
    discount_type: 'fixed',
    max_uses: '50',
    expires_at: '',
    active: true,
  };
}

export function promoCodeToForm(promo: PromoCode): PromoCodeFormData {
  return {
    code: promo.code,
    discount_amount: String(promo.discount_amount),
    discount_type: promo.discount_type,
    max_uses: promo.max_uses === null ? '' : String(promo.max_uses),
    expires_at: promo.expires_at ? promo.expires_at.slice(0, 16) : '',
    active: promo.active,
  };
}

interface ValidPromo {
  code: string;
  discountType: PromoDiscountType;
  discountAmount: number;
}

interface PromoValidateRow {
  code: string;
  discount_amount: number;
  discount_type: string;
  max_uses: number | null;
  times_used: number;
  expires_at: string | null;
  active: boolean;
}

/**
 * Looks up a code case-insensitively (codes are always stored uppercase —
 * see PromoCodesTab) and returns it only if it is currently usable: active,
 * under its usage cap, and not expired. Returns null both for "not found"
 * and "found but invalid" — the caller shows one generic message either
 * way, so a leaked/expired code doesn't reveal *why* it failed.
 */
export async function findValidPromoCode(codeInput: string): Promise<ValidPromo | null> {
  const normalized = codeInput.trim().toUpperCase();
  if (normalized === '') return null;

  const { data, error } = await supabase
    .from('promo_codes')
    .select(PROMO_CODE_VALIDATE_SELECT)
    .eq('code', normalized)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as PromoValidateRow;
  if (!row.active) return null;
  if (row.max_uses !== null && row.times_used >= row.max_uses) return null;
  if (row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now()) return null;
  if (row.discount_type !== 'fixed' && row.discount_type !== 'percent') return null;

  return {
    code: row.code,
    discountType: row.discount_type,
    discountAmount: row.discount_amount,
  };
}

/** Taka discount for a subtotal, clamped so it never exceeds the subtotal. */
export function computePromoDiscount(promo: ValidPromo, subtotal: number): number {
  const raw =
    promo.discountType === 'percent'
      ? (subtotal * promo.discountAmount) / 100
      : promo.discountAmount;
  return Math.min(Math.max(raw, 0), subtotal);
}
