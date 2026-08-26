import { useEffect, useRef, useState, type UIEvent } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useProducts, PRODUCT_SELECT, PRODUCTS_VIEW } from '../contexts/ProductContext';
import { coverImage, productImages } from '../lib/productImages';
import { formatTaka } from '../lib/format';
import { getDisplayPrice } from '../lib/pricing';
import { isOutOfStock } from '../lib/stockStatus';
import { buildCopyText, copyToClipboard } from '../lib/clipboard';
import { useToast } from '../hooks/useToast';
import { ThemeToggle } from '../components/shared/ThemeToggle';
import { BackButton } from '../components/shared/BackButton';
import { ShareButton } from '../components/viewer/ShareButton';
import { WholesaleReveal } from '../components/viewer/WholesaleReveal';
import type { Product } from '../types';

const COPIED_RESET_MS = 2000;

/** App-wide og: values from index.html, restored when the detail page unmounts. */
const DEFAULT_OG = {
  title: "Naeem's Price Hub",
  description: 'Premium Australian skincare — check prices instantly',
  image: '/og-image.png',
  url: window.location.origin + '/',
};

function setOgTag(property: string, content: string): void {
  document
    .querySelector(`meta[property="og:${property}"]`)
    ?.setAttribute('content', content);
}

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

function DetailContent({ product }: { product: Product }) {
  const { showToast } = useToast();
  const [activeImage, setActiveImage] = useState(0);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number>();

  useEffect(() => {
    return () => {
      window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const images = productImages(product);
  const stock = STOCK_CONFIG[product.stock_status];
  const outOfStock = isOutOfStock(product);
  const { mainPrice, strikePrice, savePercent } = getDisplayPrice(product);

  const handleCarouselScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const index = Math.round(el.scrollLeft / el.clientWidth);
    setActiveImage(Math.max(0, Math.min(images.length - 1, index)));
  };

  const handleCopy = async () => {
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

  return (
    <div className="product-detail">
      {images.length > 0 ? (
        <div
          className={`product-detail__carousel-wrap${
            outOfStock ? ' product-media--out' : ''
          }`}
        >
          <div
            className="product-detail__carousel"
            onScroll={handleCarouselScroll}
            aria-label={`${product.name} images, ${activeImage + 1} of ${images.length}`}
          >
            {images.map((url, index) => (
              <img
                key={url}
                src={url}
                alt={`${product.name} — image ${index + 1}`}
                className="product-detail__image"
                loading={index === 0 ? 'eager' : 'lazy'}
              />
            ))}
          </div>
          {images.length > 1 && (
            <div className="product-detail__dots" aria-hidden="true">
              {images.map((url, index) => (
                <span
                  key={url}
                  className={`product-detail__dot${
                    index === activeImage ? ' product-detail__dot--active' : ''
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div
          className="product-detail__carousel-wrap product-card__placeholder"
          aria-hidden="true"
        >
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

      <h1 className="product-detail__name">{product.name}</h1>

      {product.description && (
        <p className="product-detail__description">{product.description}</p>
      )}

      <div className="product-detail__meta-row">
        {product.category && (
          <span className="category-badge category-badge--neutral">
            {product.category.name}
          </span>
        )}
        <span className="product-detail__sku">SKU: {product.sku}</span>
      </div>

      <div className={`price-block${outOfStock ? ' price-block--out' : ''}`}>
        <span className="product-detail__price">{formatTaka(mainPrice)}</span>
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

      {product.note && <p className="product-detail__note">{product.note}</p>}

      {outOfStock ? (
        <button
          type="button"
          className="button copy-button copy-button--disabled"
          disabled
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
  );
}

export function ProductDetailPage() {
  const { sku } = useParams<{ sku: string }>();
  const { isAdmin } = useAuth();
  const { products, isLoading } = useProducts();
  const [fetchedProduct, setFetchedProduct] = useState<Product | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [isFetching, setIsFetching] = useState(false);

  const fromContext = products.find((p) => p.sku === sku) ?? null;
  const product = fromContext ?? (fetchedProduct?.sku === sku ? fetchedProduct : null);

  // Hard-refresh fallback: if the product isn't in the loaded batch, fetch just
  // this one directly so a shared /product/:sku URL renders correctly.
  useEffect(() => {
    if (!sku) return;
    if (isLoading) return;
    if (fromContext) return;
    if (fetchedProduct?.sku === sku) return;

    let cancelled = false;
    setIsFetching(true);
    setNotFound(false);
    (async () => {
      // products_view bypasses the base table's RLS row filter, so keep
      // inactive products hidden from non-admins here (as RLS did before).
      let query = supabase.from(PRODUCTS_VIEW).select(PRODUCT_SELECT).eq('sku', sku);
      if (!isAdmin) {
        query = query.eq('is_active', true);
      }
      const { data, error } = await query.maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setNotFound(true);
      } else {
        setFetchedProduct(data as Product);
      }
      setIsFetching(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [sku, isLoading, isAdmin, fromContext, fetchedProduct]);

  // Scroll to top whenever the viewed product changes.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [sku]);

  // Keep the og: tags in step with the product so a shared link previews it.
  useEffect(() => {
    if (!product) return;
    const price = formatTaka(getDisplayPrice(product).mainPrice);
    const note = product.note ?? '';
    setOgTag('title', product.name);
    setOgTag('description', note === '' ? price : `${price} — ${note}`);
    setOgTag('image', coverImage(product) ?? DEFAULT_OG.image);
    setOgTag('url', window.location.href);

    return () => {
      setOgTag('title', DEFAULT_OG.title);
      setOgTag('description', DEFAULT_OG.description);
      setOgTag('image', DEFAULT_OG.image);
      setOgTag('url', DEFAULT_OG.url);
    };
  }, [product]);

  const showLoading = !product && (isLoading || isFetching);

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <BackButton />
        <div className="detail-header__actions">
          <ThemeToggle />
          {product && <ShareButton product={product} variant="header" />}
        </div>
      </header>

      <main className="detail-main">
        {product ? (
          <DetailContent key={product.sku} product={product} />
        ) : showLoading ? (
          <div className="full-screen-center">
            <span className="spinner spinner--large" aria-hidden="true" />
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state__icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4m0 4h.01" />
              </svg>
            </div>
            <p className="empty-state__message">
              {notFound ? 'Product not found' : "Couldn't load this product"}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
