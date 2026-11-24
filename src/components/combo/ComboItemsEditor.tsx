import { useMemo, useState } from 'react';
import { useProducts } from '../../contexts/ProductContext';
import type { LiveComboLine } from '../../hooks/useComboLines';
import { useSellLimit } from '../../hooks/useSellLimit';
import { productSearchGroups, searchProductGroups, type SellableOption } from '../../lib/manualOrderSearch';
import { formatTaka } from '../../lib/format';
import type { ComboItem } from '../../lib/combos';
import { ProductResults } from '../admin/ManualOptionPicker';

/** Batch 62: a combo line's shop status, the way the product page shows it. */
export function comboLineStatus(line: Pick<LiveComboLine, 'available' | 'facts' | 'lowText'>): string {
  if (!line.available) return 'Out of stock';
  if (line.facts.keepSelling && line.facts.stock !== null && line.facts.stock <= 0) return 'Keep selling: bought after the order';
  return line.lowText ?? 'In stock';
}

/** Index of a live line in the saved list (useComboLines keys start with it). */
function indexOf(line: LiveComboLine): number {
  return Number(line.key.split('-')[0]);
}

/**
 * Batch 62: the combo's products in the admin's "Share as a combo" sheet:
 * "Add products" (the same search as admin New order: product, then size),
 * then each product with its shop status, quantity, move up / down and
 * remove. Any active product can be added, also one out of stock. Only the
 * shop's sizes are offered (a size hidden from the shop is not).
 */
export function ComboItemsEditor({
  items,
  lines,
  onChange,
}: {
  items: readonly ComboItem[];
  lines: readonly LiveComboLine[];
  onChange: (next: ComboItem[]) => void;
}) {
  const { products, variantsFor } = useProducts();
  const sell = useSellLimit();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => productSearchGroups(products, variantsFor), [products, variantsFor]);
  const results = useMemo(() => searchProductGroups(groups, query), [groups, query]);

  const add = (option: SellableOption, quantity: number) => {
    const at = items.findIndex((i) => i.product_id === option.productId && (i.variant_id ?? null) === option.variantId);
    if (at >= 0) {
      onChange(items.map((i, n) => (n === at ? { ...i, quantity: Math.min(i.quantity + quantity, 99) } : i)));
    } else {
      onChange([...items, { product_id: option.productId, variant_id: option.variantId, quantity: Math.max(1, quantity) }]);
    }
    setQuery('');
  };
  const setQty = (index: number, quantity: number) =>
    onChange(items.map((i, n) => (n === index ? { ...i, quantity: Math.max(1, Math.min(quantity, 99)) } : i)));
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
  };
  const remove = (index: number) => onChange(items.filter((_, n) => n !== index));

  return (
    <div className="combo-edit" data-testid="combo-edit">
      <label className="combo-field">
        <span className="combo-field__label">Add products</span>
        <input
          type="search"
          className="combo-field__input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search product name..."
          autoComplete="off"
          data-testid="combo-add-search"
        />
      </label>
      <ProductResults results={results} onAdd={add} className="picker-sheet__list combo-edit__results" />

      {lines.length > 0 && (
        <ul className="combo-edit__list" data-testid="combo-edit-list">
          {lines.map((line, n) => {
            const index = indexOf(line);
            const status = comboLineStatus(line);
            return (
              <li key={line.key} className="combo-edit__row" data-testid="combo-edit-row">
                <span className="combo-edit__thumb">{line.thumb ? <img src={line.thumb} alt="" width={44} height={44} loading="lazy" /> : null}</span>
                <span className="combo-edit__main">
                  <span className="combo-edit__name">{line.product.name}</span>
                  {line.optionLabel && <span className="combo-edit__sub">{line.optionLabel}</span>}
                  <span className={`combo-edit__status${line.available ? '' : ' combo-edit__status--out'}`} data-testid="combo-edit-status">
                    {status} · {formatTaka(line.price)}
                  </span>
                </span>
                <span className="combo-edit__qty">
                  <button type="button" aria-label={`One less ${line.product.name}`} onClick={() => setQty(index, line.quantity - 1)} disabled={line.quantity <= 1}>
                    −
                  </button>
                  <span data-testid="combo-edit-qty">{line.quantity}</span>
                  <button
                    type="button"
                    aria-label={`One more ${line.product.name}`}
                    onClick={() => setQty(index, line.quantity + 1)}
                    disabled={line.quantity >= sell.limit && sell.limit > 0}
                  >
                    +
                  </button>
                </span>
                <span className="combo-edit__order">
                  <button type="button" aria-label={`Move ${line.product.name} up`} onClick={() => move(index, -1)} disabled={n === 0}>
                    ↑
                  </button>
                  <button type="button" aria-label={`Move ${line.product.name} down`} onClick={() => move(index, 1)} disabled={n === lines.length - 1}>
                    ↓
                  </button>
                  <button type="button" aria-label={`Remove ${line.product.name}`} onClick={() => remove(index)} data-testid="combo-edit-remove">
                    ×
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
