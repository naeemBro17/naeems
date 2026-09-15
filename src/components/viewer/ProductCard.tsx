import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Product } from '../../types';
import { formatTaka } from '../../lib/format';
import { getDisplayPrice } from '../../lib/pricing';
import { isOutOfStock } from '../../lib/stockStatus';
import { productPath } from '../../lib/slugify';
import { rememberGridScroll } from '../../lib/gridScroll';
import { coverImage } from '../../lib/productImages';
import { buildCopyText, copyToClipboard } from '../../lib/clipboard';
import { useToast } from '../../hooks/useToast';
import { useProducts } from '../../contexts/ProductContext';
import { lowestVariantPrice } from '../../lib/variants';
import { CardMenu } from './CardMenu';

interface ProductCardProps {
  product: Product;
}

/** How long the button holds its success state (Part 6 animation polish). */
const COPIED_RESET_MS = 600;

export function ProductCard({ product }: ProductCardProps) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { variantsFor } = useProducts();
  const [imageFailed, setImageFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number>();

  useEffect(() => {
    return () => {
      window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const openDetail = () => {
    // Remember where the grid was so Back can restore it instead of jumping to top.
    rememberGridScroll();
    navigate(productPath(product));
  };

  // A product with variants shows its cheapest option as a "from" price; the
  // full Region → Size picker lives on the detail page.
  const fromPrice = lowestVariantPrice(variantsFor(product.id));

  const handleCopy = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const ok = await copyToClipboard(buildCopyText(product, fromPrice ?? undefined));
    if (ok) {
      setCopied(true);
      showToast('Copied to clipboard');
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } else {
      showToast('Could not copy', 'error');
    }
  };

  const handleCardKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openDetail();
    }
  };

  const cover = coverImage(product);
  const showImage = cover !== null && !imageFailed;
  const outOfStock = isOutOfStock(product);
  const { mainPrice, strikePrice, savePercent } = getDisplayPrice(product);
  const categoryName = product.category?.name ?? null;
  // Absent until a brand is entered — the category still shows in the badge.
  const brand = product.brand?.trim() || null;

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

        {categoryName && (
          <span className="product-card__badge">{categoryName}</span>
        )}
        {/* The menu stays functional on out-of-stock cards. */}
        <CardMenu product={product} />
      </div>

      <div className="product-card__body">
        {brand && <p className="product-card__brand">{brand}</p>}

        <h3 className="product-card__name">{product.name}</h3>

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

        {outOfStock ? (
          <span className="copy-button copy-button--disabled" aria-hidden="true">
            Out of Stock
          </span>
        ) : (
          <button
            type="button"
            className={`copy-button${copied ? ' copy-button--copied' : ''}`}
            onClick={handleCopy}
            aria-label={`Copy name and price of ${product.name}`}
          >
            {copied ? (
              <>
                <svg
                  className="copy-button__icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Copied!
              </>
            ) : (
              'Copy Price'
            )}
          </button>
        )}
      </div>
    </article>
  );
}
