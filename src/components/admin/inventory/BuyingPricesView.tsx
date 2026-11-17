import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { fetchMissingBuyingPrices, packKey, saveBuyingPrices } from '../../../lib/inventory/api';
import type { MissingBuyingPrice } from '../../../lib/inventory/types';
import type { LoadState } from '../../../lib/payouts';
import { AdminPageHeader, EmptyState, SkeletonRows } from '../ui/AdminUi';

/** "per piece", or "per pcs (1 pack = 400 pcs)" for a product kept in units. */
export function buyingPriceUnit(row: Pick<MissingBuyingPrice, 'stock_unit' | 'pack_size'>): string {
  return row.pack_size > 1 ? `per ${row.stock_unit} (1 pack = ${row.pack_size} ${row.stock_unit})` : 'per piece';
}

/**
 * Batch 45 Part 8: Set buying prices — every product / option with no
 * buying price (no priced lot row, no buying price typed before). Those
 * already sold come first (they hold the profit figures back). One Save
 * all; empty rows are left alone. The list is loaded once when the screen
 * opens; typing never re-orders or re-mounts the rows.
 */
export function BuyingPricesView({ onBack }: { onBack: () => void }) {
  const { showToast } = useToast();
  const [state, setState] = useState<LoadState<MissingBuyingPrice[]> | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState(await fetchMissingBuyingPrices());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = state?.kind === 'ready' ? state.data : [];
  const filled = useMemo(
    () =>
      rows
        .map((r) => ({ row: r, value: (prices[packKey(r.product_id, r.variant_id)] ?? '').replace(/,/g, '').trim() }))
        .filter((x) => x.value !== ''),
    [rows, prices]
  );

  const handleSave = async () => {
    setError(null);
    const bad = filled.find((x) => !Number.isFinite(Number(x.value)) || Number(x.value) <= 0);
    if (bad) {
      setError(`"${bad.row.label}": the buying price must be a number above 0.`);
      return;
    }
    if (filled.length === 0) {
      setError('Type at least one buying price.');
      return;
    }
    setIsSaving(true);
    const answer = await saveBuyingPrices(filled.map((x) => ({ product_id: x.row.product_id, variant_id: x.row.variant_id, price: x.value })));
    setIsSaving(false);
    if (!answer.ok || !answer.data) {
      setError(answer.error ?? 'Could not save.');
      return;
    }
    showToast(
      `Saved ${answer.data.saved} buying price${answer.data.saved === 1 ? '' : 's'}${answer.data.items_filled ? ` · ${answer.data.items_filled} sold items got their cost` : ''}`
    );
    setPrices({});
    await load();
  };

  return (
    <section className="inv" aria-label="Set buying prices">
      <AdminPageHeader title="Set buying prices" onBack={onBack} />
      {state === null ? (
        <SkeletonRows rows={6} thumb={false} />
      ) : state.kind === 'no-db' ? (
        <EmptyState icon="inventory" title="Not set up yet" hint="Run the Batch 45 database step first." />
      ) : state.kind === 'error' ? (
        <EmptyState icon="alert" title="Could not load the list" hint={state.message} />
      ) : rows.length === 0 ? (
        <EmptyState icon="check" title="All products have a buying price" hint="Profit figures have a cost for every product." />
      ) : (
        <>
          <p className="inv-mode__title" data-testid="inv-bp-count">
            {rows.length} product{rows.length === 1 ? '' : 's'} still need{rows.length === 1 ? 's' : ''} a buying price
          </p>
          <p className="inv-muted">
            What you paid for one piece (in taka). A product with a lot that has a price already uses the lot’s price. Products already sold are first.
          </p>
          <div className="adm-ocard" data-testid="inv-bp-list">
            {rows.map((r) => {
              const key = packKey(r.product_id, r.variant_id);
              return (
                <label key={key} className="inv-bp-row" data-testid="inv-bp-row">
                  <span className="inv-bp-row__name">
                    {r.label}
                    <span className="inv-bp-row__sub">
                      {r.units_sold > 0 ? `${r.units_sold} sold · ` : ''}৳ {buyingPriceUnit(r)}
                    </span>
                  </span>
                  <input
                    className="inv-cf__input"
                    inputMode="decimal"
                    value={prices[key] ?? ''}
                    onChange={(e) => {
                      const value = e.target.value;
                      setPrices((p) => ({ ...p, [key]: value }));
                    }}
                    placeholder="৳"
                    aria-label={`Buying price ${buyingPriceUnit(r)} of ${r.label}`}
                  />
                </label>
              );
            })}
          </div>
          {error && (
            <p className="inv-error" role="alert">
              {error}
            </p>
          )}
          <div className="inv-sticky-save">
            <button type="button" className="adm-btn adm-btn--primary adm-btn--lg" onClick={() => void handleSave()} disabled={isSaving} data-testid="inv-bp-save">
              {isSaving ? <span className="spinner" aria-hidden="true" /> : `Save all${filled.length ? ` (${filled.length})` : ''}`}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
