import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type RefObject, type UIEvent } from 'react';
import { PROTECTED_IMAGE_CLASS, protectedImageProps } from '../lib/protectImage';
import { createPortal } from 'react-dom';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useCart } from '../contexts/CartContext';
import { useProducts, PRODUCT_SELECT, PRODUCTS_VIEW } from '../contexts/ProductContext';
import { cardImage, coverImage, productImages, smallImageFor } from '../lib/productImages';
import { formatTaka } from '../lib/format';
import { getDisplayPrice } from '../lib/pricing';
import { isOutOfStock } from '../lib/stockStatus';
import { siteText } from '../lib/editableTexts';
import { useSellLimit } from '../hooks/useSellLimit';
import { arrivesByDay, deliveryLine, lowStockText, type LimitReason } from '../lib/sellRules';
import { LimitPopup } from '../components/viewer/LimitPopup';
import { PriceRoll } from '../components/viewer/PriceRoll';
import {
  isVariantInStock,
  optionGalleryImages,
  shopVisibleVariants, sortVariants,

  variantDisplayPrice,
  variantOptionLabel,
  variantOptionsFor,
} from '../lib/variants';
import { prefersReducedMotion, productHeroName } from '../lib/viewTransition';
import { isTransitionRunning, setCurrentDetailProductId } from '../lib/heroTransition';
import { trackAddToCart, trackViewContent } from '../lib/analytics';
import { setBuyBarState } from '../lib/buyBarState';
import { afterAdd } from '../lib/sideCart';
import { flyToCart } from '../lib/flyToCart';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { BackButton } from '../components/shared/BackButton';
import { ShareButton } from '../components/viewer/ShareButton';
import { HeartButton } from '../components/viewer/Wishlist';
import { CartIcon, tapHaptic } from '../components/viewer/CartButton';
import { RelatedProducts } from '../components/viewer/RelatedProducts';
import { WholesaleReveal } from '../components/viewer/WholesaleReveal';
import { VariantSelector } from '../components/viewer/VariantSelector';
import { VideoReview } from '../components/viewer/VideoReview';
import { extractYouTubeId } from '../lib/youtube';
import { Accordion, AccordionItem } from '../components/viewer/Accordion';
import { RichTextView } from '../components/shared/RichTextView';
import { fetchVariantRows } from '../lib/variantRows';
import { richTextToPlain } from '../lib/richTextPlain';
import type { Product, ProductVariant, VariantOption } from '../types';

/** The URL query param a shared variant link uses, e.g. /product/x?variant=<id>. */
const VARIANT_PARAM = 'variant';

/** App-wide og: values from index.html, restored when the detail page unmounts. */
const DEFAULT_OG = {
  title: "NAEEM'S",
  description: 'Premium Australian skincare. Check prices instantly',
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
    // Batch 36 Part 2: search engines get the plain-text version.
    description: (product.description ? richTextToPlain(product.description) : '') || product.note || undefined,
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

/** Batch 51: the small delivery truck; Fix 72.1: beside "Arrives by …". */
function TruckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6.5h11v9h-11z" />
      <path d="M13.5 9.5h4l3 3v3h-7z" />
      <circle cx="6.5" cy="17.5" r="1.6" />
      <circle cx="17" cy="17.5" r="1.6" />
    </svg>
  );
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

/** Height of the product page's top bar — the part of the screen it covers. */
const PDP_HEADER_PX = 56;

function TrustIcon({ kind }: { kind: 'authentic' | 'cod' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'authentic' && (
        <>
          <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" />
          <path d="M8.8 12.2l2.2 2.2 4.3-4.6" />
        </>
      )}
      {kind === 'cod' && (
        <>
          <rect x="2.5" y="6" width="19" height="12" rx="2" />
          <circle cx="12" cy="12" r="2.6" />
          <path d="M6 9.5v5M18 9.5v5" />
        </>
      )}
    </svg>
  );
}

function StepIcon({ plus }: { plus: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M6 12h12" />
      {plus && <path d="M12 6v12" />}
    </svg>
  );
}

/** Fix 72.1: the tick on "Added". */
function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/**
 * Batch 70: the buy bar shows only while the in-page Add to Cart is off
 * the screen (scrolled up under the top bar, or still below a very short
 * screen); while that button is on screen the bar stays away. One
 * IntersectionObserver, no scroll listener.
 */
function useBuyBarVisibility(target: RefObject<HTMLElement>): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = target.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => setShown(!entry.isIntersecting), {
      rootMargin: `-${PDP_HEADER_PX}px 0px 0px 0px`,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [target]);
  return shown;
}

/**
 * Batch 70: "About this product" shows four lines, then "Read more"
 * (only when the text is longer than that); "Show less" folds it again.
 */
function ClampedAbout({ value }: { value: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [lineHeight, setLineHeight] = useState<number | null>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const text = box?.firstElementChild;
    if (!box || !(text instanceof HTMLElement)) return;
    const style = window.getComputedStyle(text);
    const lh = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6;
    setLineHeight(lh);
    setLong(text.scrollHeight > lh * 4 + 2);
  }, [value]);
  const clamped = long && !open && lineHeight !== null;
  return (
    <>
      <div
        ref={boxRef}
        className={clamped ? 'b70-about b70-about--clamped' : 'b70-about'}
        style={clamped ? { maxHeight: `${lineHeight * 4}px` } : undefined}
        data-testid="pdp-about-box"
      >
        <RichTextView value={value} testId="pdp-about" />
      </div>
      {long && (
        <button
          type="button"
          className="b70-more"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="pdp-read-more"
        >
          {open ? 'Show less' : 'Read more'}
        </button>
      )}
    </>
  );
}

function DetailContent({
  product,
  variants,
  onHeroOffScreen,
}: {
  product: Product;
  variants: ProductVariant[];
  /** Told whether the main picture has scrolled away (the top bar's cue). */
  onHeroOffScreen: (off: boolean) => void;
}) {
  const { addItem, updateQuantity, items } = useCart();
  const { brands, settings } = useProducts();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeImage, setActiveImage] = useState(0);
  const carouselRef = useRef<HTMLDivElement>(null);
  // Batch 36 Part 4: the mirrored strip under the photo moves with the
  // carousel (transform only, no re-render).
  const mirrorRef = useRef<HTMLDivElement>(null);
  const syncMirror = (left: number) => {
    if (mirrorRef.current) mirrorRef.current.style.transform = `translate3d(${-left}px, 0, 0)`;
  };
  const galleryRef = useRef<HTMLDivElement>(null);
  // Opened by the picture morph: the sheet waits for the photo to land
  // before sliding up over its bottom edge (see .pdp-sheet--settle).
  const [settleSheet] = useState(() => isTransitionRunning() && !prefersReducedMotion());

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

  // The selected option's own photos first (the default option's are the
  // product's own — the same photo its card showed), then every other photo
  // once. See optionGalleryImages for the one rule the whole site follows.
  const images = optionGalleryImages(productImages(product), selectedOption, variants);
  const firstImage = images[0] ?? null;

  // The carousel keeps its own scroll position across re-renders — without
  // this, the browser's native scroll anchoring "helpfully" compensates for
  // the new first slide by scrolling forward to keep whatever was already
  // on screen in view, which silently cancels out the whole swap (verified
  // live: scrollLeft jumped to exactly one slide-width on its own the
  // instant the images array reordered). Snap back to the first slide —
  // wherever the selected option's own image now sits in the array —
  // every time the selection actually changes.
  // Layout effect, keyed on the first photo itself: the reset lands before
  // the browser paints, so no frame ever shows the previous photo.
  useLayoutEffect(() => {
    if (carouselRef.current) carouselRef.current.scrollLeft = 0;
    syncMirror(0);
    setActiveImage(0);
  }, [selectedOption.id, firstImage]);

  // The top bar turns solid (with the product name) once the picture has
  // scrolled away under it.
  useEffect(() => {
    const el = galleryRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => onHeroOffScreen(!entry.isIntersecting),
      { rootMargin: `-${PDP_HEADER_PX}px 0px 0px 0px` }
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      onHeroOffScreen(false);
    };
  }, [onHeroOffScreen]);

  const outOfStock = hasSelector ? !isVariantInStock(selectedOption) : isOutOfStock(product);
  const { mainPrice, strikePrice, savePercent } = hasSelector
    ? variantDisplayPrice(selectedOption)
    : getDisplayPrice(product);
  const hasWholesale = hasSelector ? selectedOption.has_wholesale : product.has_wholesale;
  const wholesalePrice = hasSelector ? selectedOption.wholesale_price : product.wholesale_price;
  const brand = product.brand?.trim() ?? '';
  // The small brand name opens that brand's page (Batch 26).
  const brandSlug = brands.find((b) => b.id === product.brand_id)?.slug ?? null;
  // `note` is the short line beside the stock; `description` is the long copy.
  // A variant's own note (Part 5) stands in for the product's when set.
  const about = product.description?.trim() ?? '';
  const noteText = (selectedOption.note ?? product.note ?? '').trim();
  const howToUse = product.how_to_use?.trim() ?? '';
  const keyIngredients = product.key_ingredients?.trim() ?? '';
  // Only a real YouTube video gets a Video review section (see VideoReview).
  const rawYoutubeUrl = product.youtube_url?.trim() ?? '';
  const youtubeUrl = extractYouTubeId(rawYoutubeUrl) !== null ? rawYoutubeUrl : '';
  const hasSections = about !== '' || howToUse !== '' || keyIngredients !== '' || youtubeUrl !== '';
  // No real variants, but the product itself carries a Region/Size label —
  // shown as plain text since there's nothing to select between (state 2).
  const plainLabel = !hasSelector ? variantOptionLabel(options[0], '') : '';

  // The buy bar shows the real cart quantity of exactly this product (and
  // selected option) — read from the cart itself, so it always matches the
  // cards, the floating cart badge and the cart page, also after a reload.
  const lineVariantId = hasSelector ? selectedOption.id : null;
  const inCart =
    items.find((item) => item.productId === product.id && item.variantId === lineVariantId)?.quantity ?? 0;
  // Batch 51: the order limit (or the stock, for a product that sells only
  // from stock), the "Only 2 left" line and the delivery line.
  const sell = useSellLimit();
  const stockFacts = sell.factsFor(product, hasSelector ? selectedOption : null);
  const limit = sell.maxFor(stockFacts);
  const [limitPopup, setLimitPopup] = useState<LimitReason | null>(null);
  const lowText = outOfStock ? null : lowStockText(stockFacts, sell.limit);
  const inHand = (hasSelector ? selectedOption.in_hand : product.in_hand) ?? !outOfStock;
  const deliveryText = deliveryLine(settings, { available: !outOfStock, inHand });
  const arrivesBy = arrivesByDay(settings, { available: !outOfStock, inHand }, new Date().toISOString());
  const selectedLabel = hasSelector ? variantOptionLabel(selectedOption, product.name) : null;
  // Batch 70: the in-page Add to Cart; the buy bar shows once it is gone.
  const buyRef = useRef<HTMLDivElement>(null);
  const barShown = useBuyBarVisibility(buyRef);

  // The floating cart (outside this page) rides just above the bar and moves
  // with it — tell it where the bar is, and that there's no bar once we leave.
  // A layout effect, so on the page's first frame the cart is already in its
  // spot instead of sliding there.
  useLayoutEffect(() => {
    setBuyBarState(barShown ? 'shown' : 'hidden');
  }, [barShown]);
  useLayoutEffect(() => () => setBuyBarState('none'), []);

  // Fires once per product shown (not on every variant swap) — see
  // trackViewContent's own doc comment for what is/isn't sent.
  useEffect(() => {
    if (!product) return;
    trackViewContent({ id: product.id, name: product.name, price: mainPrice });
  }, [product?.id]);

  const handleCarouselScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    syncMirror(el.scrollLeft);
    const index = Math.round(el.scrollLeft / el.clientWidth);
    setActiveImage(Math.max(0, Math.min(images.length - 1, index)));
  };

  // Batch 70: what flies into the bubble — the option's own small photo,
  // else the product's card photo (never the full-size photo).
  const flyImage = selectedOption.image_url ? smallImageFor(selectedOption.image_url, product, variants) : cardImage(product);

  // Fix 72.1: the in-page quantity picker; Add to Cart adds that many.
  const [pickQty, setPickQty] = useState(1);
  const [justAdded, setJustAdded] = useState(false);
  const addedTimer = useRef<number | null>(null);
  const room = Math.max(1, limit - inCart);
  useEffect(() => setPickQty(1), [selectedOption.id]);
  useEffect(() => () => {
    if (addedTimer.current !== null) window.clearTimeout(addedTimer.current);
  }, []);

  const handleAddToCart = (e: MouseEvent<HTMLButtonElement>) => {
    if (outOfStock) return;
    if (limit < 1 || inCart >= limit) {
      setLimitPopup(sell.reasonFor(stockFacts));
      return;
    }
    const qty = Math.min(pickQty, limit - inCart);
    const variant = hasSelector ? { id: selectedOption.id, label: variantOptionLabel(selectedOption, product.name) } : null;
    // addItem adds on top of a line already in the cart (CartContext).
    addItem(product.id, mainPrice, variant, qty);
    // The first add of a visit opens the side cart; later adds fly.
    if (!afterAdd(product.id, variant?.id ?? null)) flyToCart(e.currentTarget, flyImage);
    trackAddToCart({ id: product.id, name: product.name, price: mainPrice }, qty);
    tapHaptic();
    setPickQty(1);
    setJustAdded(true);
    if (addedTimer.current !== null) window.clearTimeout(addedTimer.current);
    addedTimer.current = window.setTimeout(() => setJustAdded(false), 1300);
  };

  const increase = (e: MouseEvent<HTMLButtonElement>) => {
    tapHaptic();
    if (inCart >= limit) {
      setLimitPopup(sell.reasonFor(stockFacts));
      return;
    }
    updateQuantity(product.id, inCart + 1, lineVariantId);
    // + is an add too: it flies (it never re-opens the side cart).
    if (!afterAdd(product.id, lineVariantId)) flyToCart(e.currentTarget, flyImage);
    trackAddToCart({ id: product.id, name: product.name, price: mainPrice }, 1);
  };

  const decrease = () => {
    tapHaptic();
    setLimitPopup(null);
    updateQuantity(product.id, inCart - 1, lineVariantId);
  };

  return (
    <div className="product-detail">
      {images.length > 0 ? (
        <div
          ref={galleryRef}
          className={`product-detail__gallery${
            outOfStock ? ' product-media--out' : ''
          }`}
          style={{ viewTransitionName: productHeroName(product.id) } as CSSProperties}
        >
          {/* Batch 36 Part 4: under the photo, its own bottom edge mirrored
              (a sharp copy with a softly blurred one over it), so the colour
              where photo and strip meet is the same and the sheet's rounded
              corners show no band. It slides with the photos. */}
          <div className="product-detail__mirror" aria-hidden="true" data-testid="photo-mirror">
            <div ref={mirrorRef} className="product-detail__mirror-track">
              {images.map((url, index) => (
                <span key={`mirror-${url}`} className="product-detail__mirror-slide">
                  {(['sharp', 'soft'] as const).map((layer) => (
                    <img
                      key={layer}
                      src={url}
                      alt=""
                      {...protectedImageProps}
                      className={`product-detail__mirror-img product-detail__mirror-img--${layer} ${PROTECTED_IMAGE_CLASS}`}
                      loading={index === 0 ? 'eager' : 'lazy'}
                    />
                  ))}
                </span>
              ))}
            </div>
          </div>
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
                alt={`${product.name}, image ${index + 1}`}
                {...protectedImageProps}
                className={`product-detail__image ${PROTECTED_IMAGE_CLASS}`}
                loading={index === 0 ? 'eager' : 'lazy'}
              />
            ))}
          </div>
          {/* Fix 72.2: "2 / 5" in a dark glass pill whenever there is more
              than one photo; nothing for a single photo. */}
          {images.length > 1 && (
            <div
              className="pdp-count"
              role="img"
              aria-label={`Photo ${activeImage + 1} of ${images.length}`}
              data-testid="image-counter"
            >
              {activeImage + 1} / {images.length}
            </div>
          )}
          {/* Batch 70: the heart, bottom-right of the photo. */}
          <span className="b70-photo-heart" data-testid="photo-heart">
            <HeartButton productId={product.id} productName={product.name} />
          </span>
        </div>
      ) : (
        <div
          ref={galleryRef}
          className="product-detail__gallery product-card__placeholder"
          style={{ viewTransitionName: productHeroName(product.id) } as CSSProperties}
        >
          <span aria-hidden="true">
            <PlaceholderIcon />
          </span>
          <span className="b70-photo-heart" data-testid="photo-heart">
            <HeartButton productId={product.id} productName={product.name} />
          </span>
        </div>
      )}

      {/* The rounded sheet (Batch 28 Part 2): sits over the bottom of the
          photo, page-coloured, never part of the morphing picture. */}
      <div className={`pdp-sheet${settleSheet ? ' pdp-sheet--settle' : ''}`} data-testid="pdp-sheet">
        <span className="pdp-sheet__notch" aria-hidden="true" data-testid="pdp-sheet-notch" />
        <div className="product-detail__info">
          {brand !== '' &&
            (brandSlug ? (
              <p className="product-detail__brand" data-sheet-part="brand">
                <Link to={`/brand/${brandSlug}`} className="product-detail__brand-link" data-testid="product-brand-link">
                  {brand}
                </Link>
                <svg
                  className="product-detail__brand-chevron"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </p>
            ) : (
              <p className="product-detail__brand" data-sheet-part="brand">{brand}</p>
            ))}

          <h1 className="product-detail__name" data-sheet-part="name">{product.name}</h1>

          <div className={`price-block${outOfStock ? ' price-block--out' : ''}`} data-sheet-part="price">
            <PriceRoll text={formatTaka(mainPrice)} className="product-detail__price" />
            {strikePrice !== null && (
              <span className="price-block__strike">{formatTaka(strikePrice)}</span>
            )}
            {strikePrice !== null && savePercent !== null && !outOfStock && (
              <span className="save-badge pdp-save">Save {savePercent}%</span>
            )}
          </div>

          {plainLabel !== '' && <p className="product-detail__variant-label">{plainLabel}</p>}

          {hasSelector && (
            <div data-sheet-part="options">
              <VariantSelector
                options={options}
                productName={product.name}
                selected={selectedOption}
                onSelect={handleSelectOption}
              />
            </div>
          )}

          {/* Batch 70: Add to Cart right on the page, under the options.
              Fix 72.1: a quantity picker beside it; "Added" for a moment. */}
          <div className="b70-buy" ref={buyRef} data-testid="pdp-buy">
            {outOfStock ? (
              <button type="button" className="b70-buy__out" disabled aria-label={`${product.name} is sold out`} data-testid="pdp-buy-out">
                Sold out
              </button>
            ) : (
              <div className="f721-buy">
                <div className="f721-qty" role="group" aria-label="Quantity" data-testid="pdp-qty">
                  <button
                    type="button"
                    onClick={() => setPickQty((n) => Math.max(1, n - 1))}
                    disabled={pickQty <= 1}
                    aria-label="One less"
                    data-testid="pdp-qty-minus"
                  >
                    <StepIcon plus={false} />
                  </button>
                  <span aria-live="polite" data-testid="pdp-qty-value">{pickQty}</span>
                  <button
                    type="button"
                    onClick={() => setPickQty((n) => Math.min(room, n + 1))}
                    disabled={pickQty >= room}
                    aria-label="One more"
                    data-testid="pdp-qty-plus"
                  >
                    <StepIcon plus />
                  </button>
                </div>
                <button
                  type="button"
                  className="b70-buy__add f721-add"
                  onClick={handleAddToCart}
                  aria-label={`Add ${product.name} to cart`}
                  data-testid="add-to-cart"
                >
                  <span key={justAdded ? 'added' : 'add'} className="f721-add__in">
                    {justAdded ? <TickIcon /> : <CartIcon />}
                    {justAdded ? 'Added' : 'Add to Cart'}
                  </span>
                </button>
                {limitPopup && !barShown && (
                  <LimitPopup
                    reason={limitPopup}
                    productName={product.name}
                    optionLabel={selectedLabel}
                    onClose={() => setLimitPopup(null)}
                  />
                )}
              </div>
            )}
          </div>

          {/* Fix 72.1: stock, delivery and the two trust lines in one 2 x 2
              block (replaces the stock capsule row and the trust plate). */}
          <ul className="f721-info" aria-label="Stock and delivery" data-sheet-part="trust" data-testid="pdp-info">
            <li data-testid="stock-chip">
              <i className={`f721-dot${outOfStock ? ' f721-dot--out' : lowText ? ' f721-dot--low' : ''}`} aria-hidden="true" />
              <b>{outOfStock ? 'Sold out' : lowText ?? 'In stock'}</b>
            </li>
            {arrivesBy !== null ? (
              <li data-testid="pdp-delivery">
                <TruckIcon />
                <span>Arrives by <b>{arrivesBy}</b></span>
              </li>
            ) : deliveryText ? (
              <li data-testid="pdp-delivery">
                <TruckIcon />
                <span>{deliveryText}</span>
              </li>
            ) : null}
            <li data-testid="trust-authentic">
              <TrustIcon kind="authentic" />
              <span>{siteText(settings, 'text_trust_authentic')}</span>
            </li>
            <li data-testid="trust-cod">
              <TrustIcon kind="cod" />
              <span>{siteText(settings, 'text_trust_cod')}</span>
            </li>
          </ul>
          {noteText !== '' && (
            <p className="pdp-note f721-note" data-testid="product-note">
              <svg
                className="pdp-note__icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5" />
                <path d="M12 7.6v.1" />
              </svg>
              <span className="pdp-note__text">{noteText}</span>
            </p>
          )}

          <WholesaleReveal hasWholesale={hasWholesale} price={wholesalePrice} />
        </div>

        {hasSections && (
          <Accordion>
            {about !== '' && (
              <AccordionItem title="About this product" defaultOpen>
                <ClampedAbout value={about} />
              </AccordionItem>
            )}
            {howToUse !== '' && (
              <AccordionItem title="How to use" defaultOpen={about === ''}>
                <RichTextView value={howToUse} testId="pdp-how-to-use" />
              </AccordionItem>
            )}
            {keyIngredients !== '' && (
              <AccordionItem title="Key ingredients">
                <RichTextView value={keyIngredients} testId="pdp-key-ingredients" />
              </AccordionItem>
            )}
            {youtubeUrl !== '' && (
              <AccordionItem title="Video review">
                <VideoReview url={youtubeUrl} />
              </AccordionItem>
            )}
          </Accordion>
        )}

        <RelatedProducts product={product} />
      </div>

      {createPortal(
        <div
          className={`buy-bar${barShown ? '' : ' buy-bar--hidden'}`}
          data-testid="buy-bar"
          data-shown={barShown}
          aria-hidden={!barShown}
        >
          <span className="buy-bar__price" data-testid="buy-bar-price">
            {formatTaka(mainPrice)}
          </span>
          <div className="buy-bar__action" data-testid="buy-bar-action">
            {outOfStock ? (
              <button
                type="button"
                className="buy-bar__pill buy-bar__pill--out"
                disabled
                tabIndex={barShown ? 0 : -1}
                aria-label={`${product.name} is sold out`}
                data-testid="buy-bar-out"
              >
                Sold out
              </button>
            ) : inCart > 0 ? (
              <div className="buy-bar__pill buy-bar__stepper" role="group" aria-label={`${product.name} in cart`} data-testid="buy-bar-stepper">
                <button
                  type="button"
                  className="buy-bar__step"
                  onClick={decrease}
                  tabIndex={barShown ? 0 : -1}
                  aria-label={inCart === 1 ? `Remove ${product.name} from cart` : `One less ${product.name}`}
                  data-testid="buy-bar-minus"
                >
                  <StepIcon plus={false} />
                </button>
                <span className="buy-bar__qty" aria-live="polite" data-testid="buy-bar-qty">
                  {inCart}
                </span>
                <button
                  type="button"
                  className={`buy-bar__step${inCart >= limit ? ' buy-bar__step--max' : ''}`}
                  onClick={increase}
                  tabIndex={barShown ? 0 : -1}
                  aria-label={`One more ${product.name}`}
                  data-testid="buy-bar-plus"
                >
                  <StepIcon plus />
                </button>
                {limitPopup && barShown && (
                  <LimitPopup
                    reason={limitPopup}
                    productName={product.name}
                    optionLabel={selectedLabel}
                    onClose={() => setLimitPopup(null)}
                  />
                )}
              </div>
            ) : (
              <button
                type="button"
                className="buy-bar__pill buy-bar__add"
                onClick={handleAddToCart}
                tabIndex={barShown ? 0 : -1}
                aria-label={`Add ${product.name} to cart`}
                data-testid="buy-bar-add"
              >
                <CartIcon className="buy-bar__add-icon" />
                Add to Cart
              </button>
            )}
          </div>
        </div>,
        document.body
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
  // The top bar turns solid with the product name once the picture has
  // scrolled away (reported by DetailContent).
  const [heroOffScreen, setHeroOffScreen] = useState(false);
  const handleHeroOffScreen = useCallback((off: boolean) => setHeroOffScreen(off), []);

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
      const { rows, error } = await fetchVariantRows(fetchedId);
      if (cancelled) return;
      if (error) {
        console.warn('Product variants unavailable:', error);
        return;
      }
      // Batch 62: a size hidden from the shop is left out here too.
      setFetchedVariants(shopVisibleVariants(sortVariants(rows)));
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

  // Scroll position (top on a fresh open, restored on Back/Forward) is set
  // for every page by PageTransition's ScrollRestorer, before first paint.

  // Lets a Back off this page (in-app <-: lib/viewTransition.ts's
  // navigateBack; phone back: lib/appHistory.ts) reverse-hero morph into, or
  // restore, the exact card this product was opened from — both read it the
  // moment the Back starts, before React has processed anything.
  useEffect(() => {
    setCurrentDetailProductId(product?.id ?? null);
    return () => setCurrentDetailProductId(null);
  }, [product?.id]);

  // Keep the og: tags in step with the product so a shared link previews it.
  useEffect(() => {
    if (!product) return;
    const mainPrice = getDisplayPrice(product).mainPrice;
    const price = formatTaka(mainPrice);
    const note = product.note ?? '';
    setOgTag('title', product.name);
    setOgTag('description', note === '' ? price : `${price}. ${note}`);
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

  useDocumentTitle(product ? `${product.name} | NAEEM'S` : "NAEEM'S");

  const showLoading = !product && (isLoading || isFetching);

  return (
    <div className="viewer-shell detail-shell pdp-shell">
      {/* Floats over the picture: two round crystal-glass buttons (← and
          Share, Batch 28 — the cart is the floating glass cart now); once
          the picture has scrolled away a neutral glass bar with the name
          fades in behind them. */}
      <header
        className={`pdp-header${product && heroOffScreen ? ' pdp-header--solid' : ''}${
          product ? '' : ' pdp-header--plain'
        }`}
        data-testid="pdp-header"
      >
        <span className="pdp-header__glass" aria-hidden="true" />
        <BackButton />
        <p className="pdp-header__title" aria-hidden={!heroOffScreen}>
          {product?.name ?? ''}
        </p>
        <div className="pdp-header__actions">
          {product && (
            <span className="pdp-header__share">
              <ShareButton product={product} variant="header" />
            </span>
          )}
        </div>
      </header>

      <main className="detail-main pdp-main">
        {product ? (
          <DetailContent
            key={product.id}
            product={product}
            variants={variants}
            onHeroOffScreen={handleHeroOffScreen}
          />
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
