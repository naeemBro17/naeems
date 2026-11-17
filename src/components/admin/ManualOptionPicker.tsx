import { useEffect, useState } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
import { formatTaka } from '../../lib/format';
import type { SellableOption, SellableProduct } from '../../lib/manualOrderSearch';

/**
 * Batch 45 Part 4 (shared since Batch 47 by New order and Edit order): the
 * search results — each product once — and the size picker a product with
 * options opens. A product without options is added on one tap.
 */
export function ProductResults({
  results,
  onAdd,
  className = 'picker-sheet__list',
}: {
  results: SellableProduct[];
  onAdd: (option: SellableOption, quantity: number) => void;
  className?: string;
}) {
  const [picking, setPicking] = useState<SellableProduct | null>(null);
  if (results.length === 0 && picking === null) return null;
  return (
    <>
      {results.length > 0 && (
        <ul className={className} data-testid="manual-product-results">
          {results.map((group) => (
            <li key={group.productId}>
              <button
                type="button"
                className="picker-sheet__row"
                onClick={() => (group.options.length === 1 ? onAdd(group.options[0], 1) : setPicking(group))}
                data-testid="manual-product-result"
              >
                <span className="picker-sheet__row-label">
                  {group.options.length === 1 ? group.options[0].label : group.name}
                  <span className="picker-sheet__row-sub">
                    {group.options.length === 1
                      ? `${formatTaka(group.options[0].listPrice)}${group.options[0].stockQuantity !== null ? ` · stock ${group.options[0].stockQuantity}` : ''}`
                      : `${group.options.length} sizes · from ${formatTaka(Math.min(...group.options.map((o) => o.listPrice)))}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ManualOptionPicker
        product={picking}
        onClose={() => setPicking(null)}
        onAdd={(option, quantity) => {
          onAdd(option, quantity);
          setPicking(null);
        }}
      />
    </>
  );
}

/** "Pick a size": its own size first, then each option with its price and
 *  stock, a quantity, and Add to order. */
export function ManualOptionPicker({
  product,
  onClose,
  onAdd,
}: {
  product: SellableProduct | null;
  onClose: () => void;
  onAdd: (option: SellableOption, quantity: number) => void;
}) {
  const [pickKey, setPickKey] = useState<string | null>(null);
  const [pickQty, setPickQty] = useState(1);

  useEffect(() => {
    setPickKey(null);
    setPickQty(1);
  }, [product]);

  return (
    <BottomSheet isOpen={product !== null} onClose={onClose} title={product ? `Pick a size: ${product.name}` : 'Pick a size'}>
      {product && (
        <div className="manual-pick" data-testid="manual-option-picker">
          <p className="manual-pick__title">{product.name}</p>
          <ul className="manual-pick__list" role="radiogroup" aria-label="Size">
            {product.options.map((o) => {
              const soldOut = o.stockQuantity !== null && o.stockQuantity <= 0;
              return (
                <li key={o.key}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={pickKey === o.key}
                    className={`manual-pick__row${pickKey === o.key ? ' manual-pick__row--on' : ''}`}
                    onClick={() => setPickKey(o.key)}
                    data-testid="manual-option"
                  >
                    <span className="manual-pick__name">{o.variantLabel ?? 'Own size'}</span>
                    <span className="manual-pick__meta">
                      {formatTaka(o.listPrice)} · {o.stockQuantity === null ? 'stock not counted' : soldOut ? 'Sold out' : `stock ${o.stockQuantity}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="manual-pick__qty">
            <span>Quantity</span>
            <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" aria-label="One less" onClick={() => setPickQty((q) => Math.max(1, q - 1))}>
              −
            </button>
            <span data-testid="manual-pick-qty">{pickQty}</span>
            <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" aria-label="One more" onClick={() => setPickQty((q) => q + 1)}>
              +
            </button>
          </div>
          <button
            type="button"
            className="adm-btn adm-btn--primary adm-btn--lg"
            disabled={pickKey === null}
            onClick={() => {
              const option = product.options.find((o) => o.key === pickKey);
              if (option) onAdd(option, pickQty);
            }}
            data-testid="manual-pick-add"
          >
            Add to order
          </button>
        </div>
      )}
    </BottomSheet>
  );
}
