import { supabase } from './supabase';
import { bdPhoneKey } from './phone';
import type { FraudCheckResult } from '../../supabase/functions/_shared/fraudCheck';

export type { FraudCheckResult };

/**
 * Batch 31 Part 2: Steadfast's customer check, shown to staff before they
 * confirm a COD order. The function keeps each answer 24 h (one Steadfast
 * call per number per day); this page also remembers it while open, so
 * opening the same order again doesn't even ask the function.
 */
export interface FraudAnswer {
  result: FraudCheckResult;
  fetchedAt: string;
}

/** good ≥ 80 % delivered · warn 50–79 % · risk < 50 % · none = no history. */
export type FraudTone = 'good' | 'warn' | 'risk' | 'none';

export function fraudTone(result: FraudCheckResult): FraudTone {
  if (result.deliveryRatio === null) return 'none';
  if (result.deliveryRatio >= 80) return 'good';
  if (result.deliveryRatio >= 50) return 'warn';
  return 'risk';
}

/** "01712345678" for any way a Bangladeshi mobile is typed; null otherwise. */
export function fraudCheckPhone(raw: string | null | undefined): string | null {
  const key = bdPhoneKey(raw);
  return key && /^01[3-9]\d{8}$/.test(key) ? key : null;
}

const memory = new Map<string, FraudAnswer>();

/**
 * Null when the number isn't a valid mobile, the person isn't allowed, or
 * the function's fraud_check action isn't deployed / can't be reached —
 * the page then shows nothing (no error).
 */
export async function fetchFraudCheck(rawPhone: string, options: { refresh?: boolean } = {}): Promise<FraudAnswer | null> {
  const phone = fraudCheckPhone(rawPhone);
  if (!phone) return null;
  if (!options.refresh) {
    const known = memory.get(phone);
    if (known) return known;
  }
  try {
    const { data, error } = await supabase.functions.invoke('steadfast', {
      body: { action: 'fraud_check', phone, refresh: options.refresh === true },
    });
    if (error) return null;
    const body = data as { ok?: boolean; result?: FraudCheckResult; fetchedAt?: string } | null;
    if (!body?.ok || !body.result || typeof body.fetchedAt !== 'string') return null;
    const answer: FraudAnswer = { result: body.result, fetchedAt: body.fetchedAt };
    memory.set(phone, answer);
    return answer;
  } catch {
    return null;
  }
}

/** Test hook: forget what this page remembered. */
export function clearFraudMemory(): void {
  memory.clear();
}
