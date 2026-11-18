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

/** "Wednesday, 7 October" in Bangladesh time (Batch 51: the comma is
 *  added here — some browsers leave it out of the en-GB format). */
export function homeDateLabel(now: Date = new Date()): string {
  const part = (o: Intl.DateTimeFormatOptions) => now.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', ...o });
  return `${part({ weekday: 'long' })}, ${part({ day: 'numeric', month: 'long' })}`;
}
