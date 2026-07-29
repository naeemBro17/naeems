import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Product } from '../../types';
import { formatTaka } from '../../lib/format';
import { getDisplayPrice } from '../../lib/pricing';
import { isOutOfStock } from '../../lib/stockStatus';
import { coverImage } from '../../lib/productImages';
import { buildCopyText, copyToClipboard } from '../../lib/clipboard';
import { useToast } from '../../hooks/useToast';
import { ShareButton } from './ShareButton';
import { WholesaleReveal } from './WholesaleReveal';

interface ProductCardProps {
  product: Product;
  /** Index of the product's category in the sorted category list (badge color). */
  categoryIndex: number;
}

const COPIED_RESET_MS = 2000;

const STOCK_CONFIG: Record<
  Product['stock_status'],
  { dotClass: string; label: string }
> = {
  in_stock: { dotClass: 'stock-dot--green', label: 'In Stock' },
  low_stock: { dotClass: 'stock-dot--amber', label: 'Low Stock' },
  out_of_stock: { dotClass: 'stock-dot--red', label: 'Out of Stock' },
};

function stockText(product: Product): string {
  const { label } = STOCK_CONFIG[product.stock_status];
  if (product.stock_status !== 'out_of_stock' && product.stock_quantity !== null) {
    return `${label} · ${product.stock_quantity} pcs`;
  }
  return label;
}

export function ProductCard({ product, categoryIndex }: ProductCardProps) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [imageFailed, setImageFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number>();

  useEffect(() => {
    return () => {
      window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const openDetail = () => navigate(`/product/${product.sku}`);

  const handleCopy = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const ok = await copyToClipboard(buildCopyText(product));
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

  const stock = STOCK_CONFIG[product.stock_status];
  const cover = coverImage(product);
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
        {/* Share stays functional even when out of stock. */}
        <ShareButton product={product} variant="card" />
      </div>

      <div className="product-card__body">
        {product.category && (
          <span className={`category-badge category-badge--${categoryIndex % 8}`}>
            {product.category.name}
          </span>
        )}

        <h3 className="product-card__name">{product.name}</h3>

        <p className="product-card__sku">SKU: {product.sku}</p>

        <div className={`price-block${outOfStock ? ' price-block--out' : ''}`}>
          <span className="product-card__price">{formatTaka(mainPrice)}</span>
          {strikePrice !== null && (
            <span className="price-block__strike">{formatTaka(strikePrice)}</span>
          )}
          {savePercent !== null && !outOfStock && (
            <span className="save-badge">Save {savePercent}%</span>
          )}
        </div>

        <WholesaleReveal product={product} />

        <p className="stock-row">
          <span className={`stock-dot ${stock.dotClass}`} aria-hidden="true" />
          <span className="stock-row__text">{stockText(product)}</span>
        </p>

        {product.note && <p className="product-card__note">{product.note}</p>}

        {outOfStock ? (
          <button
            type="button"
            className="button copy-button copy-button--disabled"
            disabled
            onClick={(e) => e.stopPropagation()}
            aria-label={`${product.name} is out of stock`}
          >
            Out of Stock
          </button>
        ) : (
          <button
            type="button"
            className={`button copy-button${copied ? ' copy-button--copied' : ''}`}
            onClick={handleCopy}
            aria-label={`Copy name and price of ${product.name}`}
          >
            {copied ? (
              '✓ Copied!'
            ) : (
              <>
                Copy Price
                <svg
                  className="copy-button__icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
              </>
            )}
          </button>
        )}
      </div>
    </article>
  );
}
