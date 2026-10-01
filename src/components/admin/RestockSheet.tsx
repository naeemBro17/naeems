import { useEffect, useState } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
import { restock, type RestockMode } from '../../lib/brandAdmin';
import { useToast } from '../../hooks/useToast';
import type { Product, ProductVariant } from '../../types';

interface StockRow {
  /** null = the product's own (first) option. */
  variantId: string | null;
  label: string;
  current: number | null;
}

function rowsFor(product: Product, variants: ProductVariant[]): StockRow[] {
  const label = (region: string | null, size: string | null, fallback: string) =>
    [region ?? '', size ?? ''].filter((p) => p.trim() !== '').join(' · ') || fallback;
  return [
    { variantId: null, label: variants.length > 0 ? label(product.region, product.size, 'Main option') : 'Stock', current: product.stock_quantity },
    ...variants.map((v) => ({ variantId: v.id, label: label(v.region, v.size, 'Option'), current: v.stock_quantity })),
  ];
}

function countText(count: number | null): string {
  return count === null ? 'not counted' : `${count} pcs`;
}

/**
 * Restock (Batch 26 Part 7): the quick stock update from a product's ⋮
 * menu. "Add" (e.g. +24 arrived) or "Set to" (an exact count), one row per
 * option. The new count is worked out and saved inside the database
 * (admin_restock), which also writes "Restock: 21 → 45" to the Activity Log
 * and "Last updated by". Needs "Edit products and stock".
 */
export function RestockSheet({
  product,
  variants,
  onClose,
  onDone,
}: {
  product: Product | null;
  variants: ProductVariant[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [mode, setMode] = useState<RestockMode>('add');
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValues({});
    setError(null);
    setMode('add');
  }, [product?.id]);

  const rows = product ? rowsFor(product, variants) : [];
  const keyOf = (row: StockRow) => row.variantId ?? 'base';

  const parsed = rows.map((row) => {
    const raw = (values[keyOf(row)] ?? '').trim();
    if (raw === '') return { row, amount: null as number | null, valid: true };
    const n = Number(raw);
    const valid = Number.isInteger(n) && n >= 0 && n <= 100000 && !(mode === 'add' && n === 0);
    return { row, amount: valid ? n : null, valid };
  });
  const changes = parsed.filter((p) => p.amount !== null);
  const anyInvalid = parsed.some((p) => !p.valid);

  const save = async () => {
    if (!product || changes.length === 0 || anyInvalid) return;
    setSaving(true);
    setError(null);
    const done: string[] = [];
    for (const change of changes) {
      const result = await restock(product.id, change.row.variantId, mode, change.amount as number);
      if ('error' in result) {
        setError(result.error);
        break;
      }
      done.push(`${result.before ?? 0} → ${result.after}`);
    }
    setSaving(false);
    if (done.length > 0) {
      await onDone();
      showToast(done.length === 1 ? `Stock updated: ${done[0]}` : `Stock updated for ${done.length} options`);
    }
    if (done.length === changes.length) onClose();
  };

  return (
    <BottomSheet isOpen={product !== null} onClose={onClose} title={product ? `Restock: ${product.name}` : 'Restock'}>
      {product && (
        <div className="adm-restock" data-testid="restock-sheet">
          <p className="adm-restock__name">{product.name}</p>
          <div className="adm-segment" role="radiogroup" aria-label="How to change the stock">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'add'}
              className={`adm-segment__item${mode === 'add' ? ' adm-segment__item--on' : ''}`}
              onClick={() => setMode('add')}
            >
              Add
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'set'}
              className={`adm-segment__item${mode === 'set' ? ' adm-segment__item--on' : ''}`}
              onClick={() => setMode('set')}
            >
              Set to
            </button>
          </div>
          <p className="adm-restock__help">
            {mode === 'add' ? 'How many arrived? They are added to what you have now.' : 'The exact count you have now.'}
          </p>

          <div className="adm-group__box adm-restock__rows">
            {parsed.map(({ row, amount, valid }) => {
              const next = amount === null ? null : mode === 'add' ? (row.current ?? 0) + amount : amount;
              return (
                <label key={keyOf(row)} className="adm-restock__row" data-testid="restock-row">
                  <span className="adm-restock__label">
                    <b>{row.label}</b>
                    <span className="adm-restock__now">
                      Now: {countText(row.current)}
                      {next !== null && <> → <b data-testid="restock-preview">{next}</b></>}
                    </span>
                  </span>
                  <span className="adm-restock__input-wrap">
                    {mode === 'add' && <span className="adm-restock__plus" aria-hidden="true">+</span>}
                    <input
                      type="number"
                      inputMode="numeric"
                      min={mode === 'add' ? 1 : 0}
                      step={1}
                      className={`form-input adm-restock__input${valid ? '' : ' form-input--error'}`}
                      value={values[keyOf(row)] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [keyOf(row)]: e.target.value }))}
                      aria-label={`${mode === 'add' ? 'Add to' : 'Set'} ${row.label}`}
                      placeholder="0"
                    />
                  </span>
                </label>
              );
            })}
          </div>

          {anyInvalid && (
            <p className="form-error" role="alert">
              {mode === 'add' ? 'Type a whole number above 0.' : 'Type a whole number of 0 or more.'}
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <button
            type="button"
            className="adm-btn adm-btn--primary adm-btn--lg adm-restock__save"
            disabled={saving || changes.length === 0 || anyInvalid}
            onClick={() => void save()}
          >
            {saving ? <span className="spinner" aria-hidden="true" /> : 'Save stock'}
          </button>
        </div>
      )}
    </BottomSheet>
  );
}
