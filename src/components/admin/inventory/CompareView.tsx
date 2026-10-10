import { useEffect, useMemo, useState } from 'react';
import { fetchStockUnits, unitName } from '../../../lib/inventory/api';
import type { StockUnit } from '../../../lib/inventory/types';
import type { LoadState } from '../../../lib/payouts';
import { AdminPageHeader, ChipRow, EmptyState, SkeletonRows } from '../ui/AdminUi';

/** Shop stock minus pieces left in lots; null when the shop doesn't count
 *  this product (only "in stock" / "out of stock"). */
export function stockDifference(unit: Pick<StockUnit, 'site_stock' | 'lot_pieces_left'>): number | null {
  return unit.site_stock === null ? null : unit.site_stock - unit.lot_pieces_left;
}

/**
 * Batch 38 Part 3: read-only — for each product, the shop's stock number
 * next to the pieces left in lots. This is the check before Inventory mode
 * is ever turned On (Batch 39): the two should match.
 */
export function CompareView({ onBack }: { onBack: () => void }) {
  const [units, setUnits] = useState<LoadState<StockUnit[]> | null>(null);
  const [filter, setFilter] = useState<'diff' | 'all'>('diff');

  useEffect(() => {
    void fetchStockUnits().then(setUnits);
  }, []);

  const list = units?.kind === 'ready' ? units.data : [];
  const differing = useMemo(() => list.filter((u) => stockDifference(u) !== 0), [list]);
  const shown = filter === 'diff' ? differing : list;

  return (
    <section className="inv" aria-label="Compare stock">
      <AdminPageHeader title="Compare stock" onBack={onBack} />
      <p className="inv-muted">
        Shop = the stock number on the product today. Lots = pieces left in lots. Read only: nothing here changes either number.
        &quot;Not counted&quot; means the shop only marks the product in or out of stock.
      </p>
      <ChipRow
        label="Show"
        active={filter}
        onSelect={(id) => setFilter(id as 'diff' | 'all')}
        chips={[
          { id: 'diff', label: 'Different', count: differing.length },
          { id: 'all', label: 'All', count: list.length },
        ]}
      />
      {units === null ? (
        <SkeletonRows rows={6} thumb={false} />
      ) : units.kind !== 'ready' ? (
        <EmptyState icon="alert" title="Could not load stock" hint={units.kind === 'error' ? units.message : 'The Batch 38 database step has not been run.'} />
      ) : shown.length === 0 ? (
        <EmptyState icon="check" title="Shop and lots match" />
      ) : (
        <div className="inv-stack" data-testid="inv-compare">
          {shown.map((u) => {
            const diff = stockDifference(u);
            return (
              <div key={`${u.product_id}:${u.variant_id ?? ''}`} className="inv-item">
                <span className="inv-item__name">{unitName(u)}</span>
                <div className="inv-compare">
                  <span>
                    Shop <b>{u.site_stock === null ? (u.in_stock ? 'Not counted (in stock)' : 'Not counted (out)') : u.site_stock}</b>
                  </span>
                  <span>
                    Lots <b>{u.lot_pieces_left}</b>
                  </span>
                  <span className={diff === 0 ? 'inv-ok' : 'inv-bad'}>
                    Difference <b>{diff === null ? '—' : diff > 0 ? `+${diff}` : diff}</b>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
