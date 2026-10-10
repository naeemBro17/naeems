import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useProducts } from '../../../contexts/ProductContext';
import { useToast } from '../../../hooks/useToast';
import { fetchPackUnits, packKey, setPack } from '../../../lib/inventory/api';
import { STOCK_UNITS, type StockUnitWord } from '../../../lib/inventory/types';

interface Row {
  key: string;
  variantId: string | null;
  label: string;
  unit: StockUnitWord;
  pack: string;
  savedUnit: StockUnitWord;
  savedPack: number;
}

/**
 * Batch 39 Part 0: "Stock unit" and "Pack size" of a product (or of each of
 * its options), in the product editor. Staff with "Edit products" only;
 * the shop never sees these (the columns have no public access). Example:
 * a fish-oil bottle of 400 capsules is pcs, pack size 400; a CeraVe refill
 * of 473 ml is ml, 473. Almost every product stays pcs, 1.
 */
export function PackSizePanel({ productId }: { productId: string }) {
  const { can, isAdmin } = useAuth();
  const { allVariants } = useProducts();
  const { showToast } = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const allowed = isAdmin || can('edit_products') || can('view_profit_costs');

  const load = useCallback(async () => {
    const packs = await fetchPackUnits();
    const options = allVariants.filter((v) => v.product_id === productId);
    const units: { variantId: string | null; label: string }[] =
      options.length === 0
        ? [{ variantId: null, label: 'This product' }]
        : options.map((v) => ({
            variantId: v.id,
            label: [v.region, v.size].filter((s) => s && s.trim() !== '').join(' · ') || 'Option',
          }));
    setRows(
      units.map((u) => {
        const saved = packs.get(packKey(productId, u.variantId));
        const unit = saved?.stock_unit ?? 'pcs';
        const pack = saved?.pack_size ?? 1;
        return { key: packKey(productId, u.variantId), variantId: u.variantId, label: u.label, unit, pack: String(pack), savedUnit: unit, savedPack: pack };
      })
    );
  }, [allVariants, productId]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  if (!allowed || rows === null) return null;

  const patch = (key: string, change: Partial<Row>) => setRows((list) => (list ?? []).map((r) => (r.key === key ? { ...r, ...change } : r)));

  const save = async (row: Row) => {
    const pack = Number(row.pack);
    if (!Number.isInteger(pack) || pack < 1 || pack > 1_000_000) {
      showToast('Pack size must be a whole number from 1.', 'error');
      return;
    }
    setSavingKey(row.key);
    const answer = await setPack(productId, row.variantId, row.unit, pack);
    setSavingKey(null);
    if (!answer.ok) {
      showToast(answer.error ?? 'Could not save the pack size.', 'error');
      return;
    }
    patch(row.key, { savedUnit: row.unit, savedPack: pack, pack: String(pack) });
    showToast('Pack size saved');
  };

  return (
    <div className="form-field" data-testid="pack-size-panel">
      <span className="form-label">Stock unit &amp; pack size</span>
      <p className="form-helper">
        How this product is counted in stock. Most products: pcs, pack size 1. A fish-oil bottle of 400 capsules: pcs, 400.
        A 473 ml refill: ml, 473. Customers buy whole packs; only you can sell loose units. Shoppers never see this.
      </p>
      {rows.map((row) => {
        const changed = row.unit !== row.savedUnit || row.pack !== String(row.savedPack);
        return (
          <div key={row.key} className="form-row" data-testid="pack-size-row">
            {rows.length > 1 && <span className="form-helper">{row.label}</span>}
            <label className="form-field">
              <span className="form-label">Stock unit</span>
              <select
                className="form-input form-select"
                value={row.unit}
                onChange={(e) => patch(row.key, { unit: e.target.value as StockUnitWord })}
                aria-label={`Stock unit of ${row.label}`}
              >
                {STOCK_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span className="form-label">Pack size</span>
              <input
                className="form-input"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={row.pack}
                onChange={(e) => patch(row.key, { pack: e.target.value })}
                aria-label={`Pack size of ${row.label}`}
              />
            </label>
            {changed && (
              <button type="button" className="button button--secondary" onClick={() => void save(row)} disabled={savingKey === row.key} data-testid="pack-size-save">
                {savingKey === row.key ? <span className="spinner" aria-hidden="true" /> : 'Save pack size'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
