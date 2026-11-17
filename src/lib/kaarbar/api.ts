import type { SheetCell } from '../inventory/opening';
import { supabase } from '../supabase';
import type { CustomerImportRow, ExpenseImportRow, SiteMatch } from './parse';

/**
 * Batch 49: the Import from Kaarbar screen's database calls
 * (migration-050). Every function refuses anyone but the Super Admin;
 * importing and undoing also need the password typed in the last 5
 * minutes. Before migration-050 is run every call answers "needs-update".
 */

const FUNCTION_NOT_FOUND = 'PGRST202';
export const NEEDS_UPDATE = 'This needs the Batch 49 database update (migration-050).';

export type Answer<T> = { ok: true; data: T } | { ok: false; error: string; needsUpdate: boolean };

function failed<T>(error: { code?: string; message?: string }): Answer<T> {
  const needsUpdate = error.code === FUNCTION_NOT_FOUND;
  return { ok: false, error: needsUpdate ? NEEDS_UPDATE : error.message?.trim() || 'Something went wrong. Please try again.', needsUpdate };
}

async function call<T>(fn: string, args: Record<string, unknown>, map: (raw: unknown) => T): Promise<Answer<T>> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return failed<T>(error);
  return { ok: true, data: map(data) };
}

export interface LastImport {
  id: string;
  at: string;
  by: string | null;
  count: number;
  total: number;
}

export interface KaarbarStatus {
  startDate: string | null;
  today: string;
  lockedMonths: string[];
  billNos: string[];
  lastCustomers: LastImport | null;
  lastExpenses: LastImport | null;
}

function lastImport(raw: unknown): LastImport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return { id: String(r.id), at: String(r.at), by: (r.by as string | null) ?? null, count: Number(r.count ?? 0), total: Number(r.total ?? 0) };
}

export function fetchKaarbarStatus(): Promise<Answer<KaarbarStatus>> {
  return call('kaarbar_status', {}, (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      startDate: (r.start_date as string | null) ?? null,
      today: String(r.today ?? ''),
      lockedMonths: ((r.locked_months ?? []) as string[]).map(String),
      billNos: ((r.bill_nos ?? []) as unknown[]).map(String),
      lastCustomers: lastImport(r.last_customers),
      lastExpenses: lastImport(r.last_expenses),
    };
  });
}

/** Who is already on the site (by phone, or by name with no phone). */
export function checkCustomers(rows: { n: number; phone_key: string | null; name: string }[]): Promise<Answer<Map<number, SiteMatch>>> {
  return call('kaarbar_customers_check', { p_rows: rows }, (raw) => {
    const map = new Map<number, SiteMatch>();
    for (const r of (raw ?? []) as Record<string, unknown>[]) {
      map.set(Number(r.n), {
        siteKey: (r.site_key as string | null) ?? null,
        siteName: (r.site_name as string | null) ?? null,
        siteDue: Number(r.site_due ?? 0),
      });
    }
    return map;
  });
}

export function importCustomers(rows: CustomerImportRow[]): Promise<Answer<{ added: number; skipped: number }>> {
  return call('kaarbar_import_customers', { p_rows: rows }, (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return { added: Number(r.added ?? 0), skipped: Number(r.skipped ?? 0) };
  });
}

export interface KeptCustomer {
  name: string;
  phone: string;
  reason: string;
}

export function undoCustomers(): Promise<Answer<{ removed: number; kept: KeptCustomer[] }>> {
  return call('kaarbar_undo_customers', {}, (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return { removed: Number(r.removed ?? 0), kept: (r.kept ?? []) as KeptCustomer[] };
  });
}

export function importExpenses(rows: ExpenseImportRow[]): Promise<Answer<{ added: number; skipped: number; total: number; newCategories: number }>> {
  return call('kaarbar_import_expenses', { p_rows: rows }, (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return { added: Number(r.added ?? 0), skipped: Number(r.skipped ?? 0), total: Number(r.total ?? 0), newCategories: Number(r.new_categories ?? 0) };
  });
}

export interface KeptExpense {
  bill_no: string;
  date: string;
  amount: number;
  reason: string;
}

export function undoExpenses(): Promise<Answer<{ removed: number; total: number; kept: KeptExpense[] }>> {
  return call('kaarbar_undo_expenses', {}, (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return { removed: Number(r.removed ?? 0), total: Number(r.total ?? 0), kept: (r.kept ?? []) as KeptExpense[] };
  });
}

/** Every sheet of the .xlsx (the reader Batch 38 / 45 already use). The
 *  file is read here in the browser; it is never uploaded. */
export async function readKaarbarFile(file: Blob): Promise<SheetCell[][][]> {
  const { default: readXlsxFile } = await import('read-excel-file/browser');
  try {
    const sheets = (await readXlsxFile(file)) as unknown as { sheet: string; data: SheetCell[][] }[];
    return sheets.map((s) => s.data);
  } catch {
    throw new Error('This is not an .xlsx file Excel can open. Export the report from Kaarbar as Excel and pick it again.');
  }
}
