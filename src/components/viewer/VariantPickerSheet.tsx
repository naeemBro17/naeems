import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Product, ProductVariant, VariantOption } from '../../types';
import { useCart } from '../../contexts/CartContext';
import { useToast } from '../../hooks/useToast';
import { formatTaka } from '../../lib/format';
import { productImages } from '../../lib/productImages';
import {
  isVariantInStock,
  optionGalleryImages,
  variantDisplayPrice,
  variantOptionLabel,
  variantOptionsFor,
} from '../../lib/variants';
import { trackAddToCart } from '../../lib/analytics';
import { BottomSheet } from '../shared/BottomSheet';
import { VariantSelector } from './VariantSelector';
import { CartIcon } from './CartButton';

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
  const { addItem } = useCart();
  const { showToast } = useToast();
  const options = useMemo(() => variantOptionsFor(product, variants), [product, variants]);
  const [selected, setSelected] = useState<VariantOption>(options[0]);

  // Every open starts from the default option, like the product page.
  useEffect(() => {
    if (isOpen) setSelected(options[0]);
  }, [isOpen, options]);

  const image = optionGalleryImages(productImages(product), selected, variants)[0] ?? null;
  const inStock = isVariantInStock(selected);
  const { mainPrice, strikePrice, savePercent } = variantDisplayPrice(selected);

  const handleAdd = () => {
    const label = variantOptionLabel(selected, product.name);
    addItem(product.id, mainPrice, { id: selected.id, label });
    trackAddToCart({ id: product.id, name: product.name, price: mainPrice }, 1);
    if (typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(15);
      } catch {
        // Some embedded webviews advertise vibrate but reject the call.
      }
    }
    showToast(`Added to cart: ${label}`, 'success');
    onClose();
  };

  return createPortal(
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Choose options">
      <div className="variant-picker">
        <div className="variant-picker__head">
          <div className="variant-picker__thumb">
            {image && <img src={image} alt="" />}
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
            <p className="variant-picker__stock">{inStock ? 'In Stock' : 'Out of Stock'}</p>
          </div>
        </div>

        <VariantSelector
          options={options}
          productName={product.name}
          selected={selected}
          onSelect={setSelected}
        />

        <button
          type="button"
          className={`button copy-button${inStock ? '' : ' copy-button--disabled'}`}
          disabled={!inStock}
          onClick={handleAdd}
        >
          {inStock ? 'Add to Cart' : 'Out of Stock'}
          {inStock && <CartIcon className="copy-button__icon" />}
        </button>
      </div>
    </BottomSheet>,
    document.body
  );
}
