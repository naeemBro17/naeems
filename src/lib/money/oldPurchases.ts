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
  /** Batch 54 (migration-055): the Kaarbar item and the site product it counts as. */
  item_id: string | null;
  name_key: string | null;
  match_how: 'auto' | 'hand' | 'hidden' | null;
  product_name: string | null;
  option: string | null;
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
  /** Batch 54: as the Kaarbar app showed it (null = bulk Step 2 bills). */
  paid_amount: number | null;
  due_amount: number | null;
  note: string | null;
  /** When the bill was merged / imported, and whether from a customer merge. */
  merged_at: string | null;
  from_merge: boolean;
  lines: OldPurchaseLine[];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : num(v));
const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

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
    paid_amount: numOrNull(b.paid_amount),
    due_amount: numOrNull(b.due_amount),
    note: textOrNull(b.note),
    merged_at: textOrNull(b.merged_at),
    from_merge: b.from_merge === true,
    lines: ((b.lines ?? []) as Record<string, unknown>[]).map((l) => ({
      name: String(l.name ?? ''),
      quantity: num(l.quantity),
      unit: (l.unit as string | null) ?? null,
      rate: num(l.rate),
      line_discount: num(l.line_discount),
      line_total: num(l.line_total),
      item_id: textOrNull(l.item_id),
      name_key: textOrNull(l.name_key),
      match_how: l.match_how === 'auto' || l.match_how === 'hand' || l.match_how === 'hidden' ? l.match_how : null,
      product_name: textOrNull(l.product_name),
      option: textOrNull(l.option),
    })),
  }));
}
