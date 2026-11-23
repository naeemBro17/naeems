import { describe, expect, it } from 'vitest';
import { courierBillLine, shortDay } from './money/courierBill';
import type { CourierBillStatus } from './money/types';
import { hasLockedAdjustments, pnlLines, pnlSheet } from './reports/sheets';
import type { PnlMonth, PnlParts, ProfitLossReport } from './reports/types';

/* Batch 58 — the accounts fix: the order page's line for a Steadfast bill
   paid outside a payout, and the "Adjustments to locked months" line on
   Profit & loss. No network. */

function status(over: Partial<CourierBillStatus>): CourierBillStatus {
  return { bill: 65, counts: true, recorded: 0, owed: 65, payments: [], ...over };
}

describe('courierBillLine', () => {
  it('says the bill is owed while no account has paid it', () => {
    expect(courierBillLine(status({}))).toEqual({ kind: 'owed', amount: 65 });
  });

  it('names the account and day once it is recorded', () => {
    const line = courierBillLine(status({ owed: 0, recorded: 65, payments: [{ id: 'm1', account: 'bKash', date: '2026-11-21', amount: 65 }] }));
    expect(line).toEqual({ kind: 'paid', text: 'paid from bKash on 21 Nov' });
  });

  it('lists every payment when it was paid in parts', () => {
    const line = courierBillLine(
      status({
        owed: 0,
        recorded: 65,
        payments: [
          { id: 'm1', account: 'Cash', date: '2026-11-20', amount: 40 },
          { id: 'm2', account: 'bKash', date: '2026-11-21', amount: 25 },
        ],
      }),
    );
    expect(line).toEqual({ kind: 'paid', text: 'paid from Cash on 20 Nov, bKash on 21 Nov' });
  });

  it('says nothing for a bill on an order counted before the start date (inside the opening balances)', () => {
    expect(courierBillLine(status({ counts: false, owed: 0 }))).toBeNull();
  });

  it('says nothing when there is no bill or no answer yet', () => {
    expect(courierBillLine(null)).toBeNull();
    expect(courierBillLine(status({ bill: 0, owed: 0 }))).toBeNull();
  });

  it('treats less than a paisa as nothing owed', () => {
    expect(courierBillLine(status({ owed: 0.004 }))).toBeNull();
  });
});

describe('shortDay', () => {
  it('reads a date as day and short month', () => {
    expect(shortDay('2026-11-21')).toBe('21 Nov');
    expect(shortDay('2026-01-05T10:00:00Z')).toBe('5 Jan');
  });
});

const PARTS: PnlParts = {
  from: '2026-11-01', to: '2026-11-30', orders: 3, uncosted_orders: 0, sales: 3000, cost: 1500, provisional: 0, delivery: 160,
  courier: 140, cost_adjustments: 0, locked_adjustments: 0, expenses: 500, write_offs: 0, net_profit: 1020, profit_share: 0,
  your_profit: 1020, withdrawals: 0, left_in_business: 1020, owner_money_in: 0, not_shop_money: 0, count_differences: 0,
  gross_profit: 1500,
};

function report(locked: number, months: PnlMonth[] = []): ProfitLossReport {
  return {
    from: PARTS.from,
    to: PARTS.to,
    parts: { ...PARTS, locked_adjustments: locked, net_profit: PARTS.net_profit + locked },
    expenses_by_category: [],
    months,
    locked_months: [],
    start_date: '2026-11-13',
  };
}

/** Plain (not total, not sub) lines add up to Net profit. */
function plainSum(r: ProfitLossReport): number {
  const lines = pnlLines(r);
  const net = lines.findIndex((l) => l.key === 'net');
  return lines
    .slice(0, net)
    .filter((l) => !l.kind)
    .reduce((s, l) => s + l.value(r.parts, new Map()), 0);
}

describe('Profit & loss: Adjustments to locked months', () => {
  it('is not shown when there are none', () => {
    const r = report(0);
    expect(hasLockedAdjustments(r)).toBe(false);
    expect(pnlLines(r).map((l) => l.key)).not.toContain('locked_adjustments');
  });

  it('is its own line, before Net profit, when a late courier bill changed a locked month', () => {
    const r = report(-5);
    expect(hasLockedAdjustments(r)).toBe(true);
    const keys = pnlLines(r).map((l) => l.key);
    expect(keys.indexOf('locked_adjustments')).toBeGreaterThan(keys.indexOf('cost_adjustments'));
    expect(keys.indexOf('locked_adjustments')).toBeLessThan(keys.indexOf('net'));
    const sheet = pnlSheet(r);
    expect(sheet.rows.find((row) => row[0] === 'Adjustments to locked months')?.[1]).toBe(-5);
    // The plain lines still add up to Net profit.
    expect(plainSum(r)).toBeCloseTo(r.parts.net_profit, 2);
  });

  it('shows the line when only one month of the range has an adjustment', () => {
    const month: PnlMonth = { ...PARTS, month: '2026-11-01', expenses_by_category: [], locked: false, locked_adjustments: 100 };
    const r = report(0, [month]);
    expect(hasLockedAdjustments(r)).toBe(true);
  });

  it('ignores less than a paisa', () => {
    expect(hasLockedAdjustments(report(0.001))).toBe(false);
  });
});
