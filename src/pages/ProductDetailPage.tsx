import { useEffect, useMemo, useRef, useState, type CSSProperties, type UIEvent } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useCart } from '../contexts/CartContext';
import { useProducts, PRODUCT_SELECT, PRODUCTS_VIEW } from '../contexts/ProductContext';
import { coverImage, productImages } from '../lib/productImages';
import { formatTaka } from '../lib/format';
import { getDisplayPrice } from '../lib/pricing';
import { isOutOfStock } from '../lib/stockStatus';
import {
  isVariantInStock,
  mergedGalleryImages,
  regionsOf,
  sortVariants,
  VARIANT_SELECT,
  VARIANTS_VIEW,
  variantDisplayPrice,
  variantOptionLabel,
  variantOptionsFor,
} from '../lib/variants';
import { productHeroName } from '../lib/viewTransition';
import { extractYouTubeId, youtubeEmbedUrl } from '../lib/youtube';
import { trackAddToCart, trackViewContent } from '../lib/analytics';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { ThemeToggle } from '../components/shared/ThemeToggle';
import { BackButton } from '../components/shared/BackButton';
import { Modal } from '../components/shared/Modal';
import { ShareButton } from '../components/viewer/ShareButton';
import { CartIcon } from '../components/viewer/CartButton';
import { WholesaleReveal } from '../components/viewer/WholesaleReveal';
import { Accordion, AccordionItem } from '../components/viewer/Accordion';
import type { Product, ProductVariant, VariantOption } from '../types';

/** The URL query param a shared variant link uses, e.g. /product/x?variant=<id>. */
const VARIANT_PARAM = 'variant';

/** How long the Add to Cart button holds its "Added!" success state. */
const ADDED_RESET_MS = 600;

/** App-wide og: values from index.html, restored when the detail page unmounts. */
const DEFAULT_OG = {
  title: "Naeem's Price Hub",
  description: 'Premium Australian skincare — check prices instantly',
  image: window.location.origin + '/og-image.png',
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

const JSON_LD_ID = 'product-json-ld';

/** Google's Product rich-result schema, written into a <script> tag that
 *  lives only as long as this page does. Facebook/Google crawlers that don't
 *  run JS won't see this on a shared link preview (this is a client-rendered
 *  SPA — see Batch 15 audit notes), but Google does execute JS when indexing,
 *  so this still helps search rich results. */
function setProductJsonLd(product: Product, price: number, inStock: boolean): void {
  const existing = document.getElementById(JSON_LD_ID);
  if (existing) existing.remove();

  const script = document.createElement('script');
  script.id = JSON_LD_ID;
  script.type = 'application/ld+json';
  script.textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    image: coverImage(product) ?? undefined,
    description: product.description ?? product.note ?? undefined,
    brand: product.brand ? { '@type': 'Brand', name: product.brand } : undefined,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'BDT',
      price: price.toFixed(2),
      availability: inStock
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      url: window.location.href,
    },
  });
  document.head.appendChild(script);
}

function removeProductJsonLd(): void {
  document.getElementById(JSON_LD_ID)?.remove();
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

/**
 * A recognisable YouTube link plays inline in a modal on tap — the customer
 * never leaves the site. A link we can't parse as YouTube (mistyped, or a
 * different host entirely) falls back to opening it in a new tab instead of
 * breaking the page or silently doing nothing.
 */
function VideoReviewCard({ url }: { url: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const videoId = useMemo(() => extractYouTubeId(url), [url]);

  return (
    <>
      <button
        type="button"
        className="video-review"
        onClick={() =>
          videoId ? setIsOpen(true) : window.open(url, '_blank', 'noopener,noreferrer')
        }
      >
        <span className="video-review__thumb" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.5v13l11-6.5-11-6.5z" />
          </svg>
        </span>
        <span className="video-review__text">
          <span className="video-review__title">Watch Review</span>
          <span className="video-review__sub">
            {videoId ? 'Tap to play' : 'Tap to watch on YouTube'}
          </span>
        </span>
      </button>

      {videoId && (
        <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Watch Review">
          <div className="video-embed">
            <iframe
              src={youtubeEmbedUrl(videoId)}
              title="Product video review"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        </Modal>
      )}
    </>
  );
}

/** One row of pill chips — a Region row, a Size row, or (for the flat
 *  fallback) a row of full option labels. */
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

/** Flat single row, one chip per option, each showing its own full label —
 *  the fallback for a product whose options don't cleanly split into a
 *  Region×Size matrix (see VariantSelector's doc comment). */
function FlatOptionRow({
  options,
  productName,
  selected,
  onSelect,
}: {
  options: VariantOption[];
  productName: string;
  selected: VariantOption;
  onSelect: (option: VariantOption) => void;
}) {
  return (
    <div className="variant-selector">
      <div className="variant-row" role="group" aria-label="Choose an option">
        <div className="variant-row__chips">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`chip-select${option.id === selected.id ? ' chip-select--on' : ''}`}
              aria-pressed={option.id === selected.id}
              onClick={() => onSelect(option)}
            >
              {variantOptionLabel(option, productName)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Option picker, rendered only when a product has 2+ selectable options (its
 * own base entry plus one or more real variant rows — see variantOptionsFor).
 *
 * Two-level by default — a Region row, then a Size row filtered to whatever
 * that region actually has — because that's what reads best for the common
 * case where every option cleanly carries both. Falls back to one flat row
 * of full labels only when it can't: an option with a blank Region or Size
 * (a product with no label at all, showing its bare name as the fallback
 * option — see variantOptionLabel — or an option built by the "combine
 * products into variants" flow that was only given one half of a label)
 * can't be placed in a region×size grid at all, so the whole selector drops
 * to the flat list rather than showing a broken or misleading grid.
 */
function VariantSelector({
  options,
  productName,
  selected,
  onSelect,
}: {
  options: VariantOption[];
  productName: string;
  selected: VariantOption;
  onSelect: (option: VariantOption) => void;
}) {
  const canGroup = options.every((o) => o.region.trim() !== '' && o.size.trim() !== '');

  if (!canGroup) {
    return (
      <FlatOptionRow
        options={options}
        productName={productName}
        selected={selected}
        onSelect={onSelect}
      />
    );
  }

  const regions = regionsOf(options);
  const optionsInRegion = options.filter((o) => o.region === selected.region);
  const sizesInRegion = Array.from(new Set(optionsInRegion.map((o) => o.size)));

  const pickRegion = (region: string) => {
    // Keep the same size selected across the region switch when that size
    // exists there too; otherwise fall back to the first option in it.
    const sameSize = options.find((o) => o.region === region && o.size === selected.size);
    const first = sameSize ?? options.find((o) => o.region === region);
    if (first) onSelect(first);
  };

  const pickSize = (size: string) => {
    const match = optionsInRegion.find((o) => o.size === size);
    if (match) onSelect(match);
  };

  return (
    <div className="variant-selector">
      {regions.length > 1 && (
        <ChipRow label="Region" options={regions} selected={selected.region} onSelect={pickRegion} />
      )}
      {sizesInRegion.length > 1 && (
        <ChipRow label="Size" options={sizesInRegion} selected={selected.size} onSelect={pickSize} />
      )}
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
  const { addItem } = useCart();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeImage, setActiveImage] = useState(0);
  const [justAddedToCart, setJustAddedToCart] = useState(false);
  const cartTimerRef = useRef<number>();
  const carouselRef = useRef<HTMLDivElement>(null);

  // Option zero is always the product's own data; real variant rows follow.
  // A product with no real variants has exactly one option and no selector
  // shows — see variantOptionsFor's doc comment.
  const options = useMemo(() => variantOptionsFor(product, variants), [product, variants]);
  const hasSelector = options.length > 1;

  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);

  // A link opened with ?variant=<id> pre-selects that option (falls back to
  // the default — the base option — when absent or the id doesn't match any
  // option, e.g. a stale link after the variant was deleted).
  useEffect(() => {
    const fromUrl = searchParams.get(VARIANT_PARAM);
    setSelectedOptionId(fromUrl && options.some((o) => o.id === fromUrl) ? fromUrl : null);
    // Only re-resolve from the URL when the product itself changes — once
    // resolved, tapping a chip owns selection state (see handleSelectOption).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  const selectedOption = useMemo(
    () => options.find((o) => o.id === selectedOptionId) ?? options[0],
    [options, selectedOptionId]
  );

  const handleSelectOption = (option: VariantOption) => {
    setSelectedOptionId(option.id);
    const next = new URLSearchParams(searchParams);
    next.set(VARIANT_PARAM, option.id);
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    return () => {
      window.clearTimeout(cartTimerRef.current);
    };
  }, []);

  // Every variant's own photo (smallest Size first) plus the product's own
  // gallery, merged into one set — then whichever option is selected moves
  // its own photo to the front, the same way Amazon's size picker does.
  const baseImages = productImages(product);
  const galleryImages = mergedGalleryImages(baseImages, variants);
  const images =
    selectedOption.image_url !== null
      ? [selectedOption.image_url, ...galleryImages.filter((url) => url !== selectedOption.image_url)]
      : galleryImages;

  // The carousel keeps its own scroll position across re-renders — without
  // this, the browser's native scroll anchoring "helpfully" compensates for
  // the new first slide by scrolling forward to keep whatever was already
  // on screen in view, which silently cancels out the whole swap (verified
  // live: scrollLeft jumped to exactly one slide-width on its own the
  // instant the images array reordered). Snap back to the first slide —
  // wherever the selected option's own image now sits in the array —
  // every time the selection actually changes.
  useEffect(() => {
    if (carouselRef.current) carouselRef.current.scrollLeft = 0;
    setActiveImage(0);
  }, [selectedOption.id]);

  const outOfStock = hasSelector ? !isVariantInStock(selectedOption) : isOutOfStock(product);
  const { mainPrice, strikePrice, savePercent } = hasSelector
    ? variantDisplayPrice(selectedOption)
    : getDisplayPrice(product);
  const hasWholesale = hasSelector ? selectedOption.has_wholesale : product.has_wholesale;
  const wholesalePrice = hasSelector ? selectedOption.wholesale_price : product.wholesale_price;
  const brand = product.brand?.trim() ?? '';
  // `note` is the short line under the price; `description` is the long copy.
  // A variant's own note (Part 5) stands in for the product's when set.
  const about = product.description?.trim() ?? '';
  const noteText = (selectedOption.note ?? product.note ?? '').trim();
  const howToUse = product.how_to_use?.trim() ?? '';
  const keyIngredients = product.key_ingredients?.trim() ?? '';
  const youtubeUrl = product.youtube_url?.trim() ?? '';
  const hasAccordion = howToUse !== '' || keyIngredients !== '' || youtubeUrl !== '';
  // No real variants, but the product itself carries a Region/Size label —
  // shown as plain text since there's nothing to select between (state 2).
  const plainLabel = !hasSelector ? variantOptionLabel(options[0], '') : '';

  // Fires once per product shown (not on every variant swap) — see
  // trackViewContent's own doc comment for what is/isn't sent.
  useEffect(() => {
    if (!product) return;
    trackViewContent({ id: product.id, name: product.name, price: mainPrice });
  }, [product?.id]);

  const handleCarouselScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const index = Math.round(el.scrollLeft / el.clientWidth);
    setActiveImage(Math.max(0, Math.min(images.length - 1, index)));
  };

  const handleAddToCart = () => {
    const variant = hasSelector
      ? { id: selectedOption.id, label: variantOptionLabel(selectedOption, product.name) }
      : null;
    addItem(product.id, mainPrice, variant);
    trackAddToCart({ id: product.id, name: product.name, price: mainPrice }, 1);
    if (typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(15);
      } catch {
        // Some embedded webviews advertise vibrate but reject the call.
      }
    }
    setJustAddedToCart(true);
    window.clearTimeout(cartTimerRef.current);
    cartTimerRef.current = window.setTimeout(() => setJustAddedToCart(false), ADDED_RESET_MS);
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
            ref={carouselRef}
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

        {plainLabel !== '' && <p className="product-detail__variant-label">{plainLabel}</p>}

        {hasSelector && (
          <VariantSelector
            options={options}
            productName={product.name}
            selected={selectedOption}
            onSelect={handleSelectOption}
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

        {noteText !== '' && <p className="product-detail__note">{noteText}</p>}

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
    const mainPrice = getDisplayPrice(product).mainPrice;
    const price = formatTaka(mainPrice);
    const note = product.note ?? '';
    setOgTag('title', product.name);
    setOgTag('description', note === '' ? price : `${price} — ${note}`);
    setOgTag('image', coverImage(product) ?? DEFAULT_OG.image);
    setOgTag('url', window.location.href);
    setProductJsonLd(product, mainPrice, !isOutOfStock(product));

    return () => {
      setOgTag('title', DEFAULT_OG.title);
      setOgTag('description', DEFAULT_OG.description);
      setOgTag('image', DEFAULT_OG.image);
      setOgTag('url', DEFAULT_OG.url);
      removeProductJsonLd();
    };
  }, [product]);

  useDocumentTitle(product ? `${product.name} — Naeem's` : "Naeem's");

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
