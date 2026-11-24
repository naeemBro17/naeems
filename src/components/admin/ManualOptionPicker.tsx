import { useEffect, useState } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
import { formatTaka } from '../../lib/format';
import type { SellableOption, SellableProduct } from '../../lib/manualOrderSearch';
import { stockLine } from '../../lib/newOrderLook';
import { AdminIcon } from './ui/AdminIcon';

/** Batch 63: the neutral tile's bottle outline when a product has no photo. */
export function BottleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3h4v3h-4z" />
      <path d="M8.5 6h7a1.5 1.5 0 0 1 1.5 1.5V19a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V7.5A1.5 1.5 0 0 1 8.5 6z" />
      <path d="M7 11h10" />
    </svg>
  );
}

/** Batch 63: one result with its small photo, name, stock line and price
 *  (or "3 sizes · from ৳…" and a chevron for a product with sizes). */
function PhotoRow({ group, onTap }: { group: SellableProduct; onTap: () => void }) {
  const single = group.options.length === 1 ? group.options[0] : null;
  const thumb = single ? single.thumbUrl : (group.options[0]?.thumbUrl ?? null);
  const stock = single ? stockLine(single.stockQuantity) : null;
  const isOut = stock?.tone === 'out';
  return (
    <button type="button" className={`nord-res${isOut ? ' nord-res--out' : ''}`} onClick={onTap} data-testid="manual-product-result">
      <span className="nord-thumb">
        {thumb ? <img src={thumb} alt="" width={52} height={52} loading="lazy" decoding="async" /> : <BottleIcon />}
      </span>
      <span className="nord-res__main">
        <span className="nord-res__name">{single ? single.label : group.name}</span>
        {single ? (
          stock && (
            <span className="nord-res__sub" data-testid="manual-product-stock">
              {stock.tone === 'normal' ? stock.text : <span className={stock.tone === 'low' ? 'is-low' : 'is-out'}>{stock.text}</span>}
            </span>
          )
        ) : (
          <span className="nord-res__sub">
            {group.options.length} sizes · from {formatTaka(Math.min(...group.options.map((o) => o.listPrice)))}
          </span>
        )}
      </span>
      {single ? (
        <span className="nord-res__price" data-testid="manual-product-price">
          {formatTaka(single.listPrice)}
          {single.retailPrice > single.listPrice && <s>{formatTaka(single.retailPrice)}</s>}
        </span>
      ) : (
        <AdminIcon name="chevron-right" className="nord-res__go" />
      )}
    </button>
  );
}

/**
 * Batch 45 Part 4 (shared since Batch 47 by New order and Edit order): the
 * search results — each product once — and the size picker a product with
 * options opens. A product without options is added on one tap.
 *
 * Batch 63: New order and Edit order show the rows with photos
 * (`photos`); the combo editor keeps the plain rows.
 */
export function ProductResults({
  results,
  onAdd,
  className = 'picker-sheet__list',
  photos = false,
  label,
}: {
  results: SellableProduct[];
  onAdd: (option: SellableOption, quantity: number) => void;
  className?: string;
  photos?: boolean;
  /** A small heading at the top of the list (New order: "Products"). */
  label?: string;
}) {
  const [picking, setPicking] = useState<SellableProduct | null>(null);
  if (results.length === 0 && picking === null) return null;
  const tap = (group: SellableProduct) => (group.options.length === 1 ? onAdd(group.options[0], 1) : setPicking(group));
  return (
    <>
      {results.length > 0 && (
        <ul className={className} data-testid="manual-product-results">
          {label && (
            <li className="nord-drop__label" aria-hidden="true">
              {label}
            </li>
          )}
          {results.map((group) => (
            <li key={group.productId}>
              {photos ? (
                <PhotoRow group={group} onTap={() => tap(group)} />
              ) : (
              <button
                type="button"
                className="picker-sheet__row"
                onClick={() => tap(group)}
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
              )}
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
