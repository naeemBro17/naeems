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
import { Accordion, AccordionItem } from '../components/viewer/Accordion';
import type { Product } from '../types';

/** How long the Copy Price button holds its success state. */
const COPIED_RESET_MS = 600;

/** App-wide og: values from index.html, restored when the detail page unmounts. */
const DEFAULT_OG = {
  title: "Naeem's Price Hub",
  description: 'Premium Australian skincare — check prices instantly',
  image: '/og-image.png',
  url: window.location.origin + '/',
};

/**
 * PostgREST's `or=` filter is comma/parenthesis delimited, so a raw URL
 * segment can't be interpolated into it. Slugs and SKUs are alphanumeric plus
 * hyphens and underscores; anything else can only be a miss.
 */
function safeIdentifier(value: string): string | null {
  return /^[A-Za-z0-9_-]{1,120}$/.test(value) ? value : null;
}

function setOgTag(property: string, content: string): void {
  document
    .querySelector(`meta[property="og:${property}"]`)
    ?.setAttribute('content', content);
}

function PlaceholderIcon() {
  return (
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
  );
}

function VideoReviewCard({ url }: { url: string }) {
  return (
    <button
      type="button"
      className="video-review"
      onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
    >
      <span className="video-review__thumb" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5.5v13l11-6.5-11-6.5z" />
        </svg>
      </span>
      <span className="video-review__text">
        <span className="video-review__title">Watch Review</span>
        <span className="video-review__sub">Tap to watch on YouTube</span>
      </span>
    </button>
  );
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
  const outOfStock = isOutOfStock(product);
  const { mainPrice, strikePrice, savePercent } = getDisplayPrice(product);
  const brand = product.brand?.trim() ?? '';
  // `note` is the short line under the price; `description` is the long copy.
  const about = product.description?.trim() ?? '';
  const howToUse = product.how_to_use?.trim() ?? '';
  const keyIngredients = product.key_ingredients?.trim() ?? '';
  const youtubeUrl = product.youtube_url?.trim() ?? '';
  const hasAccordion = howToUse !== '' || keyIngredients !== '' || youtubeUrl !== '';

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
          className={`product-detail__gallery${
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
          className="product-detail__gallery product-card__placeholder"
          aria-hidden="true"
        >
          <PlaceholderIcon />
        </div>
      )}

      <div className="product-detail__info">
        {brand !== '' && <p className="product-detail__brand">{brand}</p>}

        <h1 className="product-detail__name">{product.name}</h1>

        <div className={`price-block${outOfStock ? ' price-block--out' : ''}`}>
          <span className="product-detail__price">{formatTaka(mainPrice)}</span>
          {strikePrice !== null && (
            <span className="price-block__sub">
              <span className="price-block__strike">{formatTaka(strikePrice)}</span>
              {savePercent !== null && !outOfStock && (
                <span className="save-badge">Save {savePercent}%</span>
              )}
            </span>
          )}
        </div>

        <p className="stock-row">
          <span
            className={`stock-dot ${
              outOfStock ? 'stock-dot--red' : 'stock-dot--green'
            }`}
            aria-hidden="true"
          />
          <span className="stock-row__text">
            {outOfStock ? 'Out of Stock' : 'In Stock'}
          </span>
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
            {copied ? 'Copied!' : 'Copy Price'}
            {copied ? (
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
            ) : (
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
            )}
          </button>
        )}

        <WholesaleReveal product={product} />
      </div>

      {about !== '' && (
        <>
          <div className="section-divider" aria-hidden="true" />
          <section className="product-detail__section">
            <h2 className="product-detail__section-label">About this product</h2>
            <p className="product-detail__description">{about}</p>
          </section>
        </>
      )}

      {hasAccordion && (
        <>
          <div className="section-divider" aria-hidden="true" />
          <Accordion>
            {howToUse !== '' && (
              <AccordionItem title="How to Use" defaultOpen>
                <p className="accordion__text">{howToUse}</p>
              </AccordionItem>
            )}
            {keyIngredients !== '' && (
              <AccordionItem title="Key Ingredients">
                <p className="accordion__text">{keyIngredients}</p>
              </AccordionItem>
            )}
            {youtubeUrl !== '' && (
              <AccordionItem title="Video Review">
                <VideoReviewCard url={youtubeUrl} />
              </AccordionItem>
            )}
          </Accordion>
        </>
      )}
    </div>
  );
}

export function ProductDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const { isAdmin } = useAuth();
  const { products, isLoading } = useProducts();
  const [fetchedProduct, setFetchedProduct] = useState<Product | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [isFetching, setIsFetching] = useState(false);

  /** Slug is canonical; SKU still resolves so links shared before the slug
   *  migration (and cached rows that predate it) keep working. */
  const matches = (p: Product): boolean => p.slug === slug || p.sku === slug;

  const fromContext = products.find(matches) ?? null;
  const product =
    fromContext ?? (fetchedProduct && matches(fetchedProduct) ? fetchedProduct : null);

  // Hard-refresh fallback: if the product isn't in the loaded batch, fetch just
  // this one directly so a shared /product/:slug URL renders correctly.
  useEffect(() => {
    if (!slug) return;
    if (isLoading) return;
    if (fromContext) return;
    if (fetchedProduct && matches(fetchedProduct)) return;

    const identifier = safeIdentifier(slug);
    if (identifier === null) {
      setNotFound(true);
      return;
    }

    let cancelled = false;
    setIsFetching(true);
    setNotFound(false);
    (async () => {
      // products_view bypasses the base table's RLS row filter, so keep
      // inactive products hidden from non-admins here (as RLS did before).
      const byIdentifier = (filter: 'both' | 'sku') => {
        let query = supabase.from(PRODUCTS_VIEW).select(PRODUCT_SELECT);
        query =
          filter === 'both'
            ? query.or(`slug.eq.${identifier},sku.eq.${identifier}`)
            : query.eq('sku', identifier);
        if (!isAdmin) {
          query = query.eq('is_active', true);
        }
        return query.limit(1).maybeSingle();
      };

      let { data, error } = await byIdentifier('both');
      // Before migration-008 the view has no slug column, which makes the
      // combined filter an error rather than a miss. SKUs still resolve.
      if (error) {
        ({ data, error } = await byIdentifier('sku'));
      }
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
  }, [slug, isLoading, isAdmin, fromContext, fetchedProduct]);

  // Scroll to top whenever the viewed product changes.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [slug]);

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
          <DetailContent key={product.id} product={product} />
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
