import { supabase } from '../supabase';

/**
 * Batch 50: a customer's old Kaarbar bills (history only — never orders,
 * never dues). Staff with "View profit & costs" only; an empty list before
 * migration-051 is run.
 */
export interface OldPurchaseLine {
  name: string;
  quantity: number;
  unit: string | null;
  rate: number;
  line_discount: number;
  line_total: number;
}

export interface OldPurchase {
  id: string;
  kind: 'sale' | 'return';
  bill_no: string;
  date: string;
  items_total: number;
  bill_discount: number;
  delivery: number;
  bill_total: number;
  lines: OldPurchaseLine[];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function fetchOldPurchases(customerKey: string, phone: string): Promise<OldPurchase[]> {
  const { data, error } = await supabase.rpc('kaarbar_customer_old_bills', { p_customer_key: customerKey, p_phone: phone });
  if (error || !Array.isArray(data)) return [];
  return (data as Record<string, unknown>[]).map((b) => ({
    id: String(b.id),
    kind: b.kind === 'return' ? 'return' : 'sale',
    bill_no: String(b.bill_no ?? ''),
    date: String(b.date ?? ''),
    items_total: num(b.items_total),
    bill_discount: num(b.bill_discount),
    delivery: num(b.delivery),
    bill_total: num(b.bill_total),
    lines: ((b.lines ?? []) as Record<string, unknown>[]).map((l) => ({
      name: String(l.name ?? ''),
      quantity: num(l.quantity),
      unit: (l.unit as string | null) ?? null,
      rate: num(l.rate),
      line_discount: num(l.line_discount),
      line_total: num(l.line_total),
    })),
  }));
}
