import { useEffect, useState } from 'react';
import { dhakaToday } from '../../../lib/inventory/api';
import type { LoadState } from '../../../lib/payouts';
import { fetchWriteOffs } from '../../../lib/money/api';
import { dayText, monthRange, monthText, moneyText, writeOffReasonLabel } from '../../../lib/money/format';
import type { WriteOff } from '../../../lib/money/types';
import { AdminPageHeader, EmptyState, SkeletonRows } from '../ui/AdminUi';

/**
 * Batch 41 Part 5: stock that left without a sale, month by month, with
 * its loss at landed cost. Removed on a product (Products → the product →
 * Remove stock) or as a damaged return.
 */
export function WriteOffsView({ onBack, onOpenOrder }: { onBack: () => void; onOpenOrder: (orderNumber: string) => void }) {
  const today = dhakaToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [state, setState] = useState<LoadState<WriteOff[]> | null>(null);

  useEffect(() => {
    let alive = true;
    setState(null);
    const { from, to } = monthRange(month);
    void fetchWriteOffs({ from, to }).then((answer) => {
      if (alive) setState(answer);
    });
    return () => {
      alive = false;
    };
  }, [month]);

  const [y, m] = today.slice(0, 7).split('-').map(Number);
  const months = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
  const rows = state?.kind === 'ready' ? state.data : [];
  const total = rows.reduce((s, r) => s + r.cost_bdt, 0);

  return (
    <section className="inv money" aria-label="Stock removed">
      <AdminPageHeader title="Stock removed" onBack={onBack} />
      <label className="form-field">
        <span className="form-label">Month</span>
        <select className="form-input" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
          {months.map((x) => (
            <option key={x} value={x}>
              {monthText(x)}
            </option>
          ))}
        </select>
      </label>
      {state === null ? (
        <SkeletonRows rows={4} thumb={false} />
      ) : state.kind !== 'ready' ? (
        <EmptyState icon="alert" title="Could not load" hint={state.kind === 'error' ? state.message : undefined} />
      ) : rows.length === 0 ? (
        <EmptyState icon="restock" title="Nothing removed this month" hint="Remove stock on a product (Products → the product → Remove stock)." />
      ) : (
        <>
          <div className="adm-ocard inv-line inv-line--total">
            <span>Loss at landed cost</span>
            <b>{moneyText(total)}</b>
          </div>
          <div className="inv-list" data-testid="money-writeoffs">
            {rows.map((w) => (
              <div key={w.id} className="inv-lot">
                <span className="inv-lot__main">
                  <span className="inv-lot__title">{w.label || 'Product'}</span>
                  <span className="inv-lot__sub">
                    {dayText(w.write_date)} · {w.units} units · {writeOffReasonLabel(w.reason)}
                    {w.note ? ` · ${w.note}` : ''} · {w.lots.map((l) => `${l.units} ${l.code}`).join(', ')}
                  </span>
                  {w.order_number && (
                    <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" onClick={() => onOpenOrder(w.order_number ?? '')}>
                      Open {w.order_number}
                    </button>
                  )}
                </span>
                <span className="inv-lot__side">
                  <b>{moneyText(w.cost_bdt)}</b>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
