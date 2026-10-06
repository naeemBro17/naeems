import type { CustomerRow } from './adminData';

/** Batch 32 Part 5: Admin Home's "৳X due from N customers". */
export interface DueSummary {
  total: number;
  customers: number;
}

export function dueSummary(rows: Pick<CustomerRow, 'total_due'>[]): DueSummary {
  let total = 0;
  let customers = 0;
  for (const r of rows) {
    const due = r.total_due ?? 0;
    if (due > 0) {
      total += due;
      customers += 1;
    }
  }
  return { total: Math.round(total * 100) / 100, customers };
}

/** "Wednesday, 7 October" in Bangladesh time. */
export function homeDateLabel(now: Date = new Date()): string {
  return now.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', weekday: 'long', day: 'numeric', month: 'long' });
}
