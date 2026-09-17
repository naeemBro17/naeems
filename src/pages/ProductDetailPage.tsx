import { useEffect, useMemo, useRef, useState, type CSSProperties, type UIEvent } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useCart } from '../contexts/CartContext';
import { useProducts, PRODUCT_SELECT, PRODUCTS_VIEW } from '../contexts/ProductContext';
import { coverImage, productImages } from '../lib/productImages';
import { formatTaka } from '../lib/format';
import { getDisplayPrice } from '../lib/pricing';
import { isOutOfStock } from '../lib/stockStatus';
import { buildCopyText, copyToClipboard } from '../lib/clipboard';
import {
  regionsOf,
  sortVariants,
  VARIANT_SELECT,
  VARIANTS_VIEW,
  variantDisplayPrice,
} from '../lib/variants';
import { productHeroName } from '../lib/viewTransition';
import { useToast } from '../hooks/useToast';
import { ThemeToggle } from '../components/shared/ThemeToggle';
import { BackButton } from '../components/shared/BackButton';
import { ShareButton } from '../components/viewer/ShareButton';
import { CartIcon } from '../components/viewer/CartButton';
import { WholesaleReveal } from '../components/viewer/WholesaleReveal';
import { Accordion, AccordionItem } from '../components/viewer/Accordion';
import type { Product, ProductVariant } from '../types';

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

/** One row of pill chips — regions or the sizes within a region. */
function ChipRow({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: string[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="variant-row" role="group" aria-label={label}>
      <span className="variant-row__label">{label}</span>
      <div className="variant-row__chips">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={`chip-select${option === selected ? ' chip-select--on' : ''}`}
            aria-pressed={option === selected}
            onClick={() => onSelect(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Region → Size picker, rendered only when the product has variants. The
 * chosen combination drives the price block, stock row, Copy Price and the
 * wholesale row below it.
 */
function VariantSelector({
  variants,
  selected,
  onSelect,
}: {
  variants: ProductVariant[];
  selected: ProductVariant;
  onSelect: (variant: ProductVariant) => void;
}) {
  const regions = regionsOf(variants);
  const sizes = variants.filter((v) => v.region === selected.region);

  const pickRegion = (region: string) => {
    const first = variants.find((v) => v.region === region);
    if (first) onSelect(first);
  };

  return (
    <div className="variant-selector">
      <ChipRow label="Region" options={regions} selected={selected.region} onSelect={pickRegion} />
      <ChipRow
        label="Size"
        options={sizes.map((v) => v.size)}
        selected={selected.size}
        onSelect={(size) => {
          const match = sizes.find((v) => v.size === size);
          if (match) onSelect(match);
        }}
      />
    </div>
  );
}

function DetailContent({
  product,
  variants,
}: {
  product: Product;
  variants: ProductVariant[];
}) {
  const { showToast } = useToast();
  const { addItem } = useCart();
  const [activeImage, setActiveImage] = useState(0);
  const [copied, setCopied] = useState(false);
  const [justAddedToCart, setJustAddedToCart] = useState(false);
  const copyTimerRef = useRef<number>();
  const cartTimerRef = useRef<number>();
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);

  // Default to the first variant in sort order; re-resolve if the list changes.
  const selectedVariant = useMemo(() => {
    if (variants.length === 0) return null;
    return variants.find((v) => v.id === selectedVariantId) ?? variants[0];
  }, [variants, selectedVariantId]);

  useEffect(() => {
    return () => {
      window.clearTimeout(copyTimerRef.current);
      window.clearTimeout(cartTimerRef.current);
    };
  }, []);

  const images = productImages(product);
  // With a variant selected, everything price/stock-related follows it.
  const outOfStock = selectedVariant ? !selectedVariant.in_stock : isOutOfStock(product);
  const { mainPrice, strikePrice, savePercent } = selectedVariant
    ? variantDisplayPrice(selectedVariant)
    : getDisplayPrice(product);
  const hasWholesale = selectedVariant ? selectedVariant.has_wholesale : product.has_wholesale;
  const wholesalePrice = selectedVariant
    ? selectedVariant.wholesale_price
    : product.wholesale_price;
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

  const handleAddToCart = () => {
    const variant = selectedVariant
      ? { id: selectedVariant.id, label: `${selectedVariant.region} · ${selectedVariant.size}` }
      : null;
    addItem(product.id, mainPrice, variant);
    if (typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(15);
      } catch {
        // Some embedded webviews advertise vibrate but reject the call.
      }
    }
    setJustAddedToCart(true);
    window.clearTimeout(cartTimerRef.current);
    cartTimerRef.current = window.setTimeout(() => setJustAddedToCart(false), COPIED_RESET_MS);
  };

  const handleCopy = async () => {
    const ok = await copyToClipboard(buildCopyText(product, mainPrice));
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
          style={{ viewTransitionName: productHeroName(product.id) } as CSSProperties}
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
          style={{ viewTransitionName: productHeroName(product.id) } as CSSProperties}
        >
          <PlaceholderIcon />
        </div>
      )}

      <div className="product-detail__info">
        {brand !== '' && <p className="product-detail__brand">{brand}</p>}

        <h1 className="product-detail__name">{product.name}</h1>

        {selectedVariant && (
          <VariantSelector
            variants={variants}
            selected={selectedVariant}
            onSelect={(v) => setSelectedVariantId(v.id)}
          />
        )}

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
          <div className="product-detail__actions">
            <button
              type="button"
              className={`button copy-button${justAddedToCart ? ' copy-button--copied' : ''}`}
              onClick={handleAddToCart}
              aria-label={`Add ${product.name} to cart`}
            >
              {justAddedToCart ? 'Added!' : 'Add to Cart'}
              {justAddedToCart ? (
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
                <CartIcon className="copy-button__icon" />
              )}
            </button>

            <button
              type="button"
              className={`button copy-button copy-button--secondary${copied ? ' copy-button--copied' : ''}`}
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
          </div>
        )}

        <WholesaleReveal hasWholesale={hasWholesale} price={wholesalePrice} />
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

/**
 * Whole-page loading placeholder, shaped like the real layout. Only ever
 * shown for a direct/shared-link open where there is no card data to paint
 * from immediately — never for the normal tap-from-grid path, which renders
 * the real content (and starts the hero transition) on the very first frame.
 */
function ProductDetailSkeleton() {
  return (
    <div className="product-detail-skeleton" aria-hidden="true">
      <div className="skeleton product-detail-skeleton__image" />
      <div className="product-detail-skeleton__info">
        <div className="skeleton product-detail-skeleton__bar product-detail-skeleton__bar--brand" />
        <div className="skeleton product-detail-skeleton__bar product-detail-skeleton__bar--name" />
        <div className="skeleton product-detail-skeleton__bar product-detail-skeleton__bar--name-short" />
        <div className="skeleton product-detail-skeleton__bar product-detail-skeleton__bar--price" />
        <div className="skeleton product-detail-skeleton__bar product-detail-skeleton__bar--stock" />
        <div className="skeleton product-detail-skeleton__bar product-detail-skeleton__bar--button" />
      </div>
    </div>
  );
}

export function ProductDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const location = useLocation();
  const { isAdmin } = useAuth();
  const { products, isLoading, variantsFor } = useProducts();
  const [fetchedProduct, setFetchedProduct] = useState<Product | null>(null);
  const [fetchedVariants, setFetchedVariants] = useState<ProductVariant[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [isFetching, setIsFetching] = useState(false);

  /** Slug is canonical; SKU still resolves so links shared before the slug
   *  migration (and cached rows that predate it) keep working. */
  const matches = (p: Product): boolean => p.slug === slug || p.sku === slug;

  // The exact row the tapped card was already showing (see
  // navigateToProductWithHero) — lets the very first render paint real
  // content instead of waiting on the catalog context or a network fetch.
  // Only trusted when it actually matches the current :slug, so navigating
  // from one product's page to a related one can't flash stale data.
  const navProduct = (location.state as { product?: Product } | null)?.product ?? null;
  const fromNavState = navProduct && matches(navProduct) ? navProduct : null;

  const fromContext = products.find(matches) ?? null;
  const fromCatalog = fromContext ?? fromNavState;
  const product =
    fromCatalog ?? (fetchedProduct && matches(fetchedProduct) ? fetchedProduct : null);

  // Hard-refresh fallback: if the product isn't in the loaded batch AND
  // wasn't handed to us by the card that was tapped, fetch just this one
  // directly so a shared /product/:slug URL renders correctly.
  useEffect(() => {
    if (!slug) return;
    if (isLoading) return;
    if (fromCatalog) return;
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
  }, [slug, isLoading, isAdmin, fromCatalog, fetchedProduct]);

  // The context already holds every product's variants (or will shortly,
  // for the nav-state case); a product that had to be fetched directly (not
  // in the loaded batch, and no card handed it to us) fetches its own.
  const fetchedId = fetchedProduct?.id ?? null;
  useEffect(() => {
    if (fromCatalog || fetchedId === null) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from(VARIANTS_VIEW)
        .select(VARIANT_SELECT)
        .eq('product_id', fetchedId);
      if (cancelled) return;
      if (error) {
        console.warn('Product variants unavailable:', error.message);
        return;
      }
      setFetchedVariants(sortVariants((data ?? []) as ProductVariant[]));
    })();
    return () => {
      cancelled = true;
    };
  }, [fromCatalog, fetchedId]);

  const variants = product
    ? fromCatalog
      ? variantsFor(product.id)
      : fetchedVariants
    : [];

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
          <DetailContent key={product.id} product={product} variants={variants} />
        ) : showLoading ? (
          <ProductDetailSkeleton />
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
