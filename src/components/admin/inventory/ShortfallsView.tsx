import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchShortfalls } from '../../../lib/inventory/api';
import type { Shortfall } from '../../../lib/inventory/types';
import type { LoadState } from '../../../lib/payouts';
import { adminPath } from '../../../lib/adminPages';
import { AdminPageHeader, ChipRow, EmptyState, SkeletonRows } from '../ui/AdminUi';
import { formatLotDate, taka2 } from './invFormat';

/**
 * Batch 39 Part 2.6: "Sold without stock" — units the admin sold after
 * "Not in stock — sell anyway?". Open = still waiting for stock (counted
 * at the latest known cost, provisional). Filled = the next lot (or the
 * opening stock) took them, with the real cost; the difference went to
 * cost adjustments on that day.
 */
export function ShortfallsView({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState<Shortfall[]> | null>(null);
  const [filter, setFilter] = useState<'open' | 'filled'>('open');

  useEffect(() => {
    void fetchShortfalls().then(setState);
  }, []);

  const list = state?.kind === 'ready' ? state.data : [];
  const open = useMemo(() => list.filter((s) => s.status === 'open'), [list]);
  const filled = useMemo(() => list.filter((s) => s.status === 'filled'), [list]);
  const shown = filter === 'open' ? open : filled;

  return (
    <section className="inv" aria-label="Sold without stock">
      <AdminPageHeader title="Sold without stock" onBack={onBack} />
      <p className="inv-muted">
        Units sold from admin when there was not enough stock. The next lot that brings the product fills them first, with
        its real cost.
      </p>
      <ChipRow
        label="Show"
        active={filter}
        onSelect={(id) => setFilter(id as 'open' | 'filled')}
        chips={[
          { id: 'open', label: 'Waiting for stock', count: open.length },
          { id: 'filled', label: 'Filled', count: filled.length },
        ]}
      />
      {state === null ? (
        <SkeletonRows rows={4} thumb={false} />
      ) : state.kind !== 'ready' ? (
        <EmptyState icon="alert" title="Could not load" hint={state.kind === 'error' ? state.message : 'The Batch 39 database step has not been run.'} />
      ) : shown.length === 0 ? (
        <EmptyState icon="check" title={filter === 'open' ? 'Nothing is waiting for stock' : 'Nothing filled yet'} />
      ) : (
        <div className="inv-stack" data-testid="inv-shortfalls">
          {shown.map((s) => (
            <div key={s.id} className="inv-item" data-testid="inv-shortfall">
              <div className="inv-item__head">
                <span className="inv-item__name">{s.label}</span>
                <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" onClick={() => navigate(adminPath.order(s.order_number))}>
                  {s.order_number}
                </button>
              </div>
              <div className="inv-line">
                <span>Units</span>
                <span>
                  {s.units} {s.stock_unit}
                </span>
              </div>
              <div className="inv-line">
                <span>Sold on</span>
                <span>{formatLotDate(s.created_at.slice(0, 10))}</span>
              </div>
              <div className="inv-line">
                <span>Provisional cost per unit</span>
                <span>{taka2(s.provisional_unit_cost)}</span>
              </div>
              {s.status === 'filled' && (
                <>
                  <div className="inv-line">
                    <span>Filled from</span>
                    <span>
                      {s.filled_lot_code ?? '—'}
                      {s.filled_at ? ` · ${formatLotDate(s.filled_at.slice(0, 10))}` : ''}
                    </span>
                  </div>
                  <div className="inv-line">
                    <span>Real cost per unit</span>
                    <span>{s.real_unit_cost === null ? '—' : taka2(s.real_unit_cost)}</span>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
