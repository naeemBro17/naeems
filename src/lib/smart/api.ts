import { supabase } from '../supabase';
import { isMissingSchema, type LoadState } from '../payouts';
import type { DateRange } from '../reports/periods';
import type { BelowCostAnswer, BelowCostLine, BuyingRowsAnswer, InvestorStatement, OfferRowsAnswer } from './types';

/**
 * Batch 43: the smart-helper calls (migration-045). The database refuses
 * the offer list, the buying list and the investor report to anyone
 * without "View profit & costs"; the below-cost check answers anyone who
 * may create or edit orders, with taka only for "View profit & costs".
 */

async function read<T>(fn: string, args: Record<string, unknown> = {}): Promise<LoadState<T>> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    if (isMissingSchema(error)) return { kind: 'no-db' };
    return { kind: 'error', message: error.message?.trim() || 'Something went wrong. Please try again.' };
  }
  return { kind: 'ready', data: data as T };
}

export function fetchOfferRows(): Promise<LoadState<OfferRowsAnswer>> {
  return read<OfferRowsAnswer>('smart_offer_rows');
}

export function fetchBuyingRows(): Promise<LoadState<BuyingRowsAnswer>> {
  return read<BuyingRowsAnswer>('smart_buying_rows');
}

export function fetchInvestorStatement(investorId: string, range: DateRange): Promise<LoadState<InvestorStatement>> {
  return read<InvestorStatement>('report_investor_statement', { p_investor: investorId, p_from: range.from, p_to: range.to });
}

/** Null when the check could not run (no database step yet, offline). */
export async function checkBelowCost(lines: readonly BelowCostLine[]): Promise<BelowCostAnswer[] | null> {
  if (lines.length === 0) return [];
  const { data, error } = await supabase.rpc('smart_below_cost', { p_lines: lines });
  if (error || !Array.isArray(data)) return null;
  return data as BelowCostAnswer[];
}
