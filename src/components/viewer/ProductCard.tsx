import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Product } from '../../types';
import { formatTaka } from '../../lib/format';
import { getDisplayPrice } from '../../lib/pricing';
import { isOutOfStock } from '../../lib/stockStatus';
import { productPath } from '../../lib/slugify';
import { cardImage } from '../../lib/productImages';
import { useProducts } from '../../contexts/ProductContext';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { lowestVariantPrice, variantOptionsFor } from '../../lib/variants';
import { navigateToProductWithHero, productHeroName } from '../../lib/viewTransition';
import { heroReverseTargetFor, rememberHeroOrigin } from '../../lib/heroTransition';
import { CardMenu } from './CardMenu';
import { CartButton } from './CartButton';
import { VariantPickerSheet } from './VariantPickerSheet';

interface ProductCardProps {
  product: Product;
  /** 'grid' (Home, Search, brand pages) opens the product with the picture
   *  morph. 'related' (the product page's "You may also like" row) is a
   *  smaller card that opens the product with a plain page switch, so it
   *  can never claim the morph that belongs to the main grid. */
  variant?: 'grid' | 'related';
}

/**
 * The card title (Batch 27 Part 5): plain CSS only — a block as wide as the
 * card's text area, the browser's normal word wrapping, two lines tall
 * always (so prices line up across a row), "…" only past two lines. Nothing
 * measures or splits the name; the text node is the name exactly.
 */
export function ProductCardName({ name }: { name: string }) {
  return <h3 className="product-card__name">{name}</h3>;
}

export function ProductCard({ product, variant = 'grid' }: ProductCardProps) {
  const navigate = useNavigate();
  const appNavigate = useAppNavigate();
  const { variantsFor } = useProducts();
  const [imageFailed, setImageFailed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const imageWrapRef = useRef<HTMLDivElement>(null);
  const isGrid = variant === 'grid';

  const openDetail = () => {
    if (!isGrid) {
      appNavigate(productPath(product), { state: { product } });
      return;
    }
    // Where the grid was is saved by lib/appHistory.ts as this page is left,
    // so Back restores it (see PageTransition's ScrollRestorer).
    // Tag only THIS card's image box for the shared-element transition, set
    // imperatively at tap time rather than on every card up front — tagging
    // all ~100+ grid cards at once forces the browser to snapshot every one
    // of them for a transition only one of them is actually part of, which
    // is exactly what was making the tap-to-open feel slow.
    imageWrapRef.current?.style.setProperty('view-transition-name', productHeroName(product.id));
    rememberHeroOrigin(product.id, 'grid');
    navigateToProductWithHero(navigate, productPath(product), product);
  };

  // A product with real variant rows shows its cheapest option (including
  // its own base price, folded in as option zero) as a "from" price; the
  // full Region → Size picker lives on the detail page. A product with no
  // real variant rows (even one carrying just a Region/Size label) behaves
  // exactly as before — its own plain price, no "from".
  const realVariants = variantsFor(product.id);
  const options = variantOptionsFor(product, realVariants);
  const fromPrice = realVariants.length > 0 ? lowestVariantPrice(options) : null;

  const handleCardKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openDetail();
    }
  };

  const cover = cardImage(product);
  const showImage = cover !== null && !imageFailed;
  const outOfStock = isOutOfStock(product);
  const { mainPrice, strikePrice, savePercent } = getDisplayPrice(product);
  const priceClass = `product-card__price${outOfStock ? ' product-card__price--out' : ''}`;

  return (
    <>
      <article
        className={`product-card${isGrid ? '' : ' product-card--related'}`}
        role="button"
        tabIndex={0}
        onClick={openDetail}
        onKeyDown={handleCardKeyDown}
        aria-label={`View details for ${product.name}`}
      >
        <div
          ref={imageWrapRef}
          className={`product-card__image-wrap${outOfStock ? ' product-media--out' : ''}`}
          // Only set when this render is the one frame right after leaving
          // THIS product's detail page — see lib/heroTransition.ts. Applied
          // declaratively (not the imperative ref-set openDetail uses for the
          // forward tap) because this element hasn't been created yet at the
          // moment the back navigation starts; it only exists once React has
          // remounted the grid, so it has to be baked into the very first
          // render instead.
          style={
            isGrid && heroReverseTargetFor('grid') === product.id
              ? ({ viewTransitionName: productHeroName(product.id) } as CSSProperties)
              : undefined
          }
        >
          {showImage ? (
            <img
              className="product-card__image"
              src={cover ?? ''}
              alt={product.name}
              loading="lazy"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <div className="product-card__placeholder" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
                <path d="M3 8l9 5 9-5" />
                <path d="M12 13v8" />
              </svg>
            </div>
          )}

          {/* The menu stays functional on out-of-stock cards. */}
          {isGrid && (
            <CardMenu product={product} copyPrice={fromPrice ?? mainPrice} outOfStock={outOfStock} />
          )}
        </div>

        <div className="product-card__body">
          <ProductCardName name={product.name} />

          <div className="product-card__prices">
            {fromPrice !== null ? (
              <span className={priceClass}>
                <span className="product-card__from">from</span>
                {formatTaka(fromPrice)}
              </span>
            ) : (
              <>
                <span className={priceClass}>{formatTaka(mainPrice)}</span>
                {strikePrice !== null && (
                  <span className="product-card__price-sub">
                    <span className="product-card__strike">{formatTaka(strikePrice)}</span>
                    {savePercent !== null && !outOfStock && (
                      <span className="product-card__save">Save {savePercent}%</span>
                    )}
                  </span>
                )}
              </>
            )}
          </div>

          {/* Stock on the left, the cart control in its own reserved slot on
              the right — a grid, never positioned over the text. */}
          <div className="product-card__foot">
            <p className="product-card__stock">
              <span
                className={`product-card__dot product-card__dot--${outOfStock ? 'out' : 'in'}`}
                aria-hidden="true"
              />
              {outOfStock ? 'Out of Stock' : 'In Stock'}
            </p>
            <div className="product-card__cart-slot">
              <CartButton
                product={product}
                options={options}
                price={fromPrice ?? mainPrice}
                outOfStock={outOfStock}
                hasVariants={fromPrice !== null}
                onRequiresVariant={() => setPickerOpen(true)}
              />
            </div>
          </div>
        </div>
      </article>
      {realVariants.length > 0 && (
        <VariantPickerSheet
          product={product}
          variants={realVariants}
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
