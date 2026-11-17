import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useProducts } from '../../../contexts/ProductContext';
import { fetchStockCheck } from '../../../lib/inventory/api';
import type { StockCheckRow } from '../../../lib/inventory/types';
import type { LoadState } from '../../../lib/payouts';
import { adminPath } from '../../../lib/adminPages';
import { AdminPageHeader, EmptyState, SkeletonRows } from '../ui/AdminUi';

/**
 * Batch 45 Part 2: Stock check — read only. Every product / option where
 * the shop's numbers and the lots do not add up, with a plain reason and a
 * link to where it can be fixed. One query, only when this screen opens.
 * Nothing is corrected here.
 */
export function StockCheckView({ onBack, onOpenLot }: { onBack: () => void; onOpenLot: (id: string) => void }) {
  const { settings } = useProducts();
  const [state, setState] = useState<LoadState<StockCheckRow[]> | null>(null);
  const modeOn = settings.inventory_mode === 'true';

  useEffect(() => {
    let alive = true;
    void fetchStockCheck().then((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  const numbers = (r: StockCheckRow): string => {
    switch (r.reason_code) {
      case 'shop_differs':
        return `Shop: ${r.shop_number ?? 'not counted'} · Lots: ${r.lot_number ?? 0}`;
      case 'no_lot':
        return `Shop: ${r.shop_number ?? 'in stock (not counted)'} · Lots: none`;
      case 'negative_lot':
        return `Lot ${r.lot_code ?? ''}: ${r.lot_number ?? 0} units left`;
      case 'ledger':
        return `Lot ${r.lot_code ?? ''}: says ${r.shop_number ?? 0} left · movements add up to ${r.lot_number ?? 0}`;
      case 'sold_no_lot':
        return `${r.lot_number ?? 0} units sold with no lot`;
      default:
        return '';
    }
  };

  return (
    <section className="inv" aria-label="Stock check">
      <AdminPageHeader title="Stock check" onBack={onBack} />
      <p className="inv-muted">
        {modeOn
          ? 'Inventory mode is On: the shop’s stock should equal the units left in lots. Nothing here changes anything — fix each line at its link.'
          : 'Inventory mode is Off: the shop’s stock numbers are not taken from lots, so “shop stock differs” lines are expected until it is On.'}
      </p>
      {state === null ? (
        <SkeletonRows rows={5} thumb={false} />
      ) : state.kind === 'no-db' ? (
        <EmptyState icon="inventory" title="Not set up yet" hint="Run the Batch 45 database step first." />
      ) : state.kind === 'error' ? (
        <EmptyState icon="alert" title="Could not check the stock" hint={state.message} />
      ) : state.data.length === 0 ? (
        <EmptyState icon="check" title="Everything matches" hint="Every product’s shop stock equals what is left in its lots." />
      ) : (
        <>
          <p className="inv-muted" data-testid="inv-check-count">
            {state.data.length} line{state.data.length === 1 ? '' : 's'} to look at
          </p>
          <div className="adm-ocard inv-check-list-card" data-testid="inv-stock-check">
            {state.data.map((r, i) => (
              <div key={`${r.reason_code}-${r.product_id}-${r.variant_id ?? ''}-${r.lot_id ?? ''}-${i}`} className="inv-check-row" data-testid="inv-check-row">
                <span className="inv-check-row__name">{r.label}</span>
                <span className="inv-muted">{r.reason}</span>
                <span className="inv-check-row__nums">{numbers(r)}</span>
                <span className="inv-actions">
                  {r.lot_id ? (
                    <button type="button" className="inv-link" onClick={() => onOpenLot(r.lot_id as string)}>
                      Open lot {r.lot_code}
                    </button>
                  ) : (
                    <Link className="inv-link" to={adminPath.editProduct(r.product_id)}>
                      Open product
                    </Link>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
