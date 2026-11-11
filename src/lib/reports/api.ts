import { supabase } from '../supabase';
import { isMissingSchema, type LoadState } from '../payouts';
import type {
  ChartsReport,
  CountHistoryRow,
  CountInput,
  CountPlan,
  CountResult,
  CustomersReport,
  DashboardData,
  DayBookReport,
  InvestorRow,
  LockChecklist,
  LockedMonth,
  LotRow,
  ProductsReport,
  ProfitLossReport,
  SalesReport,
  StockReport,
} from './types';
import type { DateRange } from './periods';

/**
 * Batch 42: the Dashboard, Reports, stock count and month lock calls
 * (migration-044). The database refuses every one of them for anyone
 * without "View profit & costs"; unlocking a month only for the Super Admin.
 */

export interface Answer<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function message(error: { message?: string } | null): string {
  return error?.message?.trim() || 'Something went wrong. Please try again.';
}

function fail<T>(error: { code?: string; message?: string }): LoadState<T> {
  return isMissingSchema(error) ? { kind: 'no-db' } : { kind: 'error', message: message(error) };
}

async function read<T>(fn: string, args: Record<string, unknown> = {}): Promise<LoadState<T>> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return fail(error);
  return { kind: 'ready', data: data as T };
}

async function write<T>(fn: string, args: Record<string, unknown>): Promise<Answer<T>> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, error: message(error) };
  return { ok: true, data: data as T };
}

const range = (r: DateRange) => ({ p_from: r.from, p_to: r.to });

export function fetchDashboard(current: DateRange, previous: DateRange | null): Promise<LoadState<DashboardData>> {
  return read<DashboardData>('money_dashboard', {
    ...range(current),
    p_prev_from: previous?.from ?? null,
    p_prev_to: previous?.to ?? null,
  });
}

export const fetchProfitLoss = (r: DateRange) => read<ProfitLossReport>('report_profit_loss', range(r));
export const fetchSalesReport = (r: DateRange) => read<SalesReport>('report_sales', range(r));
export const fetchProductsReport = (r: DateRange) => read<ProductsReport>('report_products', range(r));
export const fetchLotsReport = () => read<LotRow[]>('report_lots');
export const fetchStockReport = () => read<StockReport>('report_stock');
export const fetchCustomersReport = (r: DateRange) => read<CustomersReport>('report_customers', range(r));
export const fetchDayBook = (r: DateRange) => read<DayBookReport>('report_day_book', range(r));
export const fetchInvestorsReport = (r: DateRange) => read<InvestorRow[]>('report_investors', range(r));
export const fetchCharts = () => read<ChartsReport>('report_charts');

export const fetchCountPlan = () => read<CountPlan>('stock_count_pick', {});
export const fetchCountHistory = (limit = 100) => read<CountHistoryRow[]>('stock_count_history', { p_limit: limit });
export const saveCounts = (rows: readonly CountInput[]) =>
  write<CountResult[]>('stock_count_save', {
    p_rows: rows.map((r) => ({ product_id: r.product_id, variant_id: r.variant_id, counted: r.counted, note: r.note ?? null })),
  });

export const fetchLockChecklist = (month: string) => read<LockChecklist>('money_lock_checklist', { p_month: month });
export const fetchLockedMonths = () => read<LockedMonth[]>('money_locked_months');
export const lockMonth = (month: string) => write<LockChecklist>('money_lock_month', { p_month: month });
export const unlockMonth = (month: string, reason: string) => write<LockChecklist>('money_unlock_month', { p_month: month, p_reason: reason });

/** Signs in again with the password, so the database accepts a lock /
 *  unlock in the next 5 minutes (the same as the Safety Lock). */
export async function confirmPassword(email: string | undefined, password: string): Promise<string | null> {
  if (!email || password === '') return 'Type your password.';
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return error ? 'Password is incorrect.' : null;
}
