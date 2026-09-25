import { useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Product } from '../../types';
import { formatTaka } from '../../lib/format';
import { getDisplayPrice } from '../../lib/pricing';
import { isOutOfStock } from '../../lib/stockStatus';
import { productPath } from '../../lib/slugify';
import { rememberGridScroll } from '../../lib/gridScroll';
import { cardImage } from '../../lib/productImages';
import { useProducts } from '../../contexts/ProductContext';
import { lowestVariantPrice, variantOptionsFor } from '../../lib/variants';
import { navigateToProductWithHero, productHeroName } from '../../lib/viewTransition';
import { CardMenu } from './CardMenu';
import { CartButton } from './CartButton';

interface ProductCardProps {
  product: Product;
}

/**
 * Product name, wrapped by the browser's own line-breaking — see Naeems.txt
 * "Batch 7" for why a separate JS measurement (the old src/lib/textWrap.ts)
 * was removed. Kept as its own component (no hooks, no props beyond the
 * name) so it can be unit-tested without pulling in router/Supabase context.
 */
export function ProductCardName({ name }: { name: string }) {
  return <h3 className="product-card__name">{name}</h3>;
}

export function ProductCard({ product }: ProductCardProps) {
  const navigate = useNavigate();
  const { variantsFor } = useProducts();
  const [imageFailed, setImageFailed] = useState(false);
  const imageWrapRef = useRef<HTMLDivElement>(null);

  const openDetail = () => {
    // Remember where the grid was so Back can restore it instead of jumping to top.
    rememberGridScroll();
    // Tag only THIS card's image box for the shared-element transition, set
    // imperatively at tap time rather than on every card up front — tagging
    // all ~100+ grid cards at once forces the browser to snapshot every one
    // of them for a transition only one of them is actually part of, which
    // is exactly what was making the tap-to-open feel slow.
    imageWrapRef.current?.style.setProperty('view-transition-name', productHeroName(product.id));
    navigateToProductWithHero(navigate, productPath(product), product);
  };

  // A product with real variant rows shows its cheapest option (including
  // its own base price, folded in as option zero) as a "from" price; the
  // full Region → Size picker lives on the detail page. A product with no
  // real variant rows (even one carrying just a Region/Size label) behaves
  // exactly as before — its own plain price, no "from".
  const realVariants = variantsFor(product.id);
  const fromPrice =
    realVariants.length > 0 ? lowestVariantPrice(variantOptionsFor(product, realVariants)) : null;

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

  return (
    <article
      className="product-card"
      role="button"
      tabIndex={0}
      onClick={openDetail}
      onKeyDown={handleCardKeyDown}
      aria-label={`View details for ${product.name}`}
    >
      <div
        ref={imageWrapRef}
        className={`product-card__image-wrap${outOfStock ? ' product-media--out' : ''}`}
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
        <CardMenu product={product} copyPrice={fromPrice ?? mainPrice} outOfStock={outOfStock} />
      </div>

      <div className="product-card__body">
        {/* Reserving a dedicated column (not absolute positioning) for the cart
            button means text here physically cannot flow under it. */}
        <div className="product-card__info">
          <ProductCardName name={product.name} />

          {fromPrice !== null ? (
            <div className="product-card__prices">
              <span
                className={`product-card__price${
                  outOfStock ? ' product-card__price--out' : ''
                }`}
              >
                <span className="product-card__from">from</span>
                {formatTaka(fromPrice)}
              </span>
            </div>
          ) : strikePrice !== null ? (
            <div className="product-card__prices">
              <span
                className={`product-card__price${
                  outOfStock ? ' product-card__price--out' : ''
                }`}
              >
                {formatTaka(mainPrice)}
              </span>
              <span className="product-card__price-sub">
                <span className="product-card__strike">{formatTaka(strikePrice)}</span>
                {savePercent !== null && !outOfStock && (
                  <span className="product-card__save">Save {savePercent}%</span>
                )}
              </span>
            </div>
          ) : (
            <div className="product-card__prices">
              <span
                className={`product-card__price${
                  outOfStock ? ' product-card__price--out' : ''
                }`}
              >
                {formatTaka(mainPrice)}
              </span>
            </div>
          )}

          <p className="product-card__stock">
            <span
              className={`product-card__dot product-card__dot--${
                outOfStock ? 'out' : 'in'
              }`}
              aria-hidden="true"
            />
            {outOfStock ? 'Out of Stock' : 'In Stock'}
          </p>
        </div>

        <div className="product-card__cart-slot">
          <CartButton
            productId={product.id}
            productName={product.name}
            price={fromPrice ?? mainPrice}
            outOfStock={outOfStock}
            hasVariants={fromPrice !== null}
            onRequiresVariant={openDetail}
          />
        </div>
      </div>
    </article>
  );
}
