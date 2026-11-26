import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Product, ProductVariant, VariantOption } from '../../types';
import { useCart } from '../../contexts/CartContext';
import { useToast } from '../../hooks/useToast';
import { formatTaka } from '../../lib/format';
import { productImages, smallImageFor } from '../../lib/productImages';
import {
  isVariantInStock,
  optionGalleryImages,
  variantDisplayPrice,
  variantOptionLabel,
  variantOptionsFor,
} from '../../lib/variants';
import { trackAddToCart } from '../../lib/analytics';
import { afterAdd } from '../../lib/sideCart';
import { flyToCart } from '../../lib/flyToCart';
import { BottomSheet } from '../shared/BottomSheet';
import { VariantSelector } from './VariantSelector';
import { CartIcon } from './CartButton';
import { LimitPopup } from './LimitPopup';
import { useSellLimit } from '../../hooks/useSellLimit';
import type { LimitReason } from '../../lib/sellRules';

/**
 * The card's cart button for a product with Region/Size options (Batch 23
 * Part 4). It used to silently open the product page instead, which read as
 * "the cart button doesn't work". Now it opens this sheet over the grid:
 * pick the option, see its own photo, price and stock, add — never leaving
 * the page. Same selector and image rule as the product page.
 *
 * Rendered into <body> so it sits outside the card's tap target and any
 * transformed ancestor (a pressed card scales).
 */
export function VariantPickerSheet({
  product,
  variants,
  isOpen,
  onClose,
}: {
  product: Product;
  variants: ProductVariant[];
  isOpen: boolean;
  onClose: () => void;
}) {
  const { addItem, items } = useCart();
  const { showToast } = useToast();
  const sell = useSellLimit();
  const [limitPopup, setLimitPopup] = useState<LimitReason | null>(null);
  const options = useMemo(() => variantOptionsFor(product, variants), [product, variants]);
  const [selected, setSelected] = useState<VariantOption>(options[0]);

  // Every open starts from the default option, like the product page.
  useEffect(() => {
    if (isOpen) setSelected(options[0]);
  }, [isOpen, options]);

  const large = optionGalleryImages(productImages(product), selected, variants)[0] ?? null;
  const image = large === null ? null : smallImageFor(large, product, variants);
  const inStock = isVariantInStock(selected);
  const { mainPrice, strikePrice, savePercent } = variantDisplayPrice(selected);

  const handleAdd = (e: MouseEvent<HTMLButtonElement>) => {
    const label = variantOptionLabel(selected, product.name);
    // Batch 51: never past the order limit (or the last of the stock).
    const facts = sell.factsFor(product, selected);
    const inCart = items.find((i) => i.productId === product.id && i.variantId === selected.id)?.quantity ?? 0;
    if (inCart + 1 > sell.maxFor(facts)) {
      setLimitPopup(sell.reasonFor(facts));
      return;
    }
    addItem(product.id, mainPrice, { id: selected.id, label });
    trackAddToCart({ id: product.id, name: product.name, price: mainPrice }, 1);
    if (typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(15);
      } catch {
        // Some embedded webviews advertise vibrate but reject the call.
      }
    }
    // Batch 70: the first add of a visit opens the side cart (which says
    // "Added to cart"); later adds fly into the bubble with the toast.
    if (!afterAdd(product.id, selected.id)) {
      flyToCart(e.currentTarget, image);
      showToast(`Added to cart: ${label}`, 'success');
    }
    onClose();
  };

  return createPortal(
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Choose options">
      <div className="variant-picker">
        <div className="variant-picker__head">
          <div className="variant-picker__thumb">
            {image && <img src={image} alt="" width={72} height={72} loading="lazy" decoding="async" />}
          </div>
          <div className="variant-picker__summary">
            <p className="variant-picker__name">{product.name}</p>
            <p className="variant-picker__price">
              <span className="variant-picker__main">{formatTaka(mainPrice)}</span>
              {strikePrice !== null && (
                <span className="variant-picker__strike">{formatTaka(strikePrice)}</span>
              )}
              {savePercent !== null && inStock && (
                <span className="variant-picker__save">Save {savePercent}%</span>
              )}
            </p>
            <p className="variant-picker__stock">{inStock ? 'In Stock' : 'Sold out'}</p>
          </div>
        </div>

        <VariantSelector
          options={options}
          productName={product.name}
          selected={selected}
          onSelect={setSelected}
        />

        <div className="variant-picker__add">
        {limitPopup && (
          <LimitPopup
            reason={limitPopup}
            productName={product.name}
            optionLabel={variantOptionLabel(selected, product.name)}
            onClose={() => setLimitPopup(null)}
          />
        )}
        <button
          type="button"
          className={`button copy-button${inStock ? '' : ' copy-button--disabled'}`}
          disabled={!inStock}
          onClick={handleAdd}
        >
          {inStock ? 'Add to Cart' : 'Sold out'}
          {inStock && <CartIcon className="copy-button__icon" />}
        </button>
        </div>
      </div>
    </BottomSheet>,
    document.body
  );
}
