import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type UIEvent } from 'react';
import { PROTECTED_IMAGE_CLASS, protectedImageProps } from '../lib/protectImage';
import { createPortal } from 'react-dom';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useCart } from '../contexts/CartContext';
import { useProducts, PRODUCT_SELECT, PRODUCTS_VIEW } from '../contexts/ProductContext';
import { coverImage, productImages } from '../lib/productImages';
import { formatTaka } from '../lib/format';
import { getDisplayPrice } from '../lib/pricing';
import { isOutOfStock, stockLimit } from '../lib/stockStatus';
import { siteText } from '../lib/editableTexts';
import { useToast } from '../hooks/useToast';
import { stockLimitMessage } from '../hooks/useCartLine';
import {
  isVariantInStock,
  optionGalleryImages,
  sortVariants,
  VARIANT_SELECT,
  VARIANTS_VIEW,
  variantDisplayPrice,
  variantOptionLabel,
  variantOptionsFor,
} from '../lib/variants';
import { prefersReducedMotion, productHeroName } from '../lib/viewTransition';
import { isTransitionRunning, setCurrentDetailProductId } from '../lib/heroTransition';
import { trackAddToCart, trackViewContent } from '../lib/analytics';
import { setBuyBarState } from '../lib/buyBarState';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { BackButton } from '../components/shared/BackButton';
import { ShareButton } from '../components/viewer/ShareButton';
import { CartIcon, tapHaptic } from '../components/viewer/CartButton';
import { RelatedProducts } from '../components/viewer/RelatedProducts';
import { WholesaleReveal } from '../components/viewer/WholesaleReveal';
import { VariantSelector } from '../components/viewer/VariantSelector';
import { VideoReview } from '../components/viewer/VideoReview';
import { extractYouTubeId } from '../lib/youtube';
import { Accordion, AccordionItem } from '../components/viewer/Accordion';
import { RichTextView } from '../components/shared/RichTextView';
import { richTextToPlain } from '../lib/richTextPlain';
import type { Product, ProductVariant, VariantOption } from '../types';

/** The URL query param a shared variant link uses, e.g. /product/x?variant=<id>. */
const VARIANT_PARAM = 'variant';

/** App-wide og: values from index.html, restored when the detail page unmounts. */
const DEFAULT_OG = {
  title: "NAEEM'S",
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

/** Buy bar scroll behaviour (Batch 28 Part 4): always shown within this many
 *  px of the top or the bottom of the page; hidden after a scroll down of
 *  BUY_BAR_HIDE_AFTER_PX, shown again after a scroll up of BUY_BAR_SHOW_AFTER_PX. */
const BUY_BAR_TOP_ZONE_PX = 24;
const BUY_BAR_BOTTOM_ZONE_PX = 8;
const BUY_BAR_HIDE_AFTER_PX = 12;
const BUY_BAR_SHOW_AFTER_PX = 10;

function TrustIcon({ kind }: { kind: 'authentic' | 'cod' | 'delivery' }) {
  return (
    <svg
      className="trust-plate__icon"
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
      {kind === 'delivery' && (
        <>
          <path d="M2.5 6.5h11v9h-11z" />
          <path d="M13.5 9.5h4l3 3v3h-7" />
          <circle cx="7" cy="17.5" r="1.8" />
          <circle cx="17" cy="17.5" r="1.8" />
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

/**
 * The buy bar's scroll behaviour (Batch 28 Part 4): slides away while the
 * shopper scrolls down, comes back on a scroll up of 10 px or more, and is
 * always shown at the top of the page, at the very bottom, and right after
 * a cart change. Tiny jitters (a few px either way) never toggle it, and it
 * never hides while a finger is on it.
 */
function useBuyBarVisibility(cartCount: number): {
  shown: boolean;
  onPressStart: () => void;
} {
  const [shown, setShown] = useState(true);
  const pressedRef = useRef(false);

  useEffect(() => {
    let lastY = window.scrollY;
    // Distance travelled in the current direction (+ down, − up); reset
    // whenever the direction flips, so jitter never adds up to a toggle.
    let travelled = 0;
    const onScroll = () => {
      const y = window.scrollY;
      const delta = y - lastY;
      lastY = y;
      if (delta === 0) return;
      const atTop = y <= BUY_BAR_TOP_ZONE_PX;
      const atBottom =
        window.innerHeight + y >= document.documentElement.scrollHeight - BUY_BAR_BOTTOM_ZONE_PX;
      if (atTop || atBottom) {
        travelled = 0;
        setShown(true);
        return;
      }
      travelled = Math.sign(delta) === Math.sign(travelled) ? travelled + delta : delta;
      if (travelled >= BUY_BAR_HIDE_AFTER_PX && !pressedRef.current) setShown(false);
      else if (travelled <= -BUY_BAR_SHOW_AFTER_PX) setShown(true);
    };
    const onRelease = () => {
      pressedRef.current = false;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointerup', onRelease);
    window.addEventListener('pointercancel', onRelease);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointerup', onRelease);
      window.removeEventListener('pointercancel', onRelease);
    };
  }, []);

  // Any cart change (this product, an option, a "You may also like" card)
  // brings the bar back.
  const firstQuantity = useRef(true);
  useEffect(() => {
    if (firstQuantity.current) {
      firstQuantity.current = false;
      return;
    }
    setShown(true);
  }, [cartCount]);

  const onPressStart = useCallback(() => {
    pressedRef.current = true;
    setShown(true);
  }, []);

  return { shown, onPressStart };
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
  const { addItem, updateQuantity, items, itemCount } = useCart();
  const { brands, settings } = useProducts();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeImage, setActiveImage] = useState(0);
  const carouselRef = useRef<HTMLDivElement>(null);
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
  // Batch 35 Part 8: the blurred copy behind the photo follows the photo on
  // screen. Only photos already shown get a copy (the same file the slide
  // already loaded — nothing extra is downloaded), so they can crossfade.
  const currentImage = images[activeImage] ?? images[0] ?? null;
  const [blurredShown, setBlurredShown] = useState<string[]>([]);
  useEffect(() => {
    if (!currentImage) return;
    setBlurredShown((shown) => (shown.includes(currentImage) ? shown : [...shown, currentImage]));
  }, [currentImage]);
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
  const limit = stockLimit(hasSelector ? selectedOption.stock_quantity : product.stock_quantity);
  const { shown: barShown, onPressStart } = useBuyBarVisibility(itemCount);

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
    const index = Math.round(el.scrollLeft / el.clientWidth);
    setActiveImage(Math.max(0, Math.min(images.length - 1, index)));
  };

  const handleAddToCart = () => {
    if (outOfStock || inCart > 0) return;
    if (limit < 1) {
      showToast(stockLimitMessage(limit), 'info');
      return;
    }
    const variant = hasSelector
      ? { id: selectedOption.id, label: variantOptionLabel(selectedOption, product.name) }
      : null;
    addItem(product.id, mainPrice, variant, 1);
    trackAddToCart({ id: product.id, name: product.name, price: mainPrice }, 1);
    tapHaptic();
  };

  const increase = () => {
    tapHaptic();
    if (inCart >= limit) {
      showToast(stockLimitMessage(limit), 'info');
      return;
    }
    updateQuantity(product.id, inCart + 1, lineVariantId);
    trackAddToCart({ id: product.id, name: product.name, price: mainPrice }, 1);
  };

  const decrease = () => {
    tapHaptic();
    updateQuantity(product.id, inCart - 1, lineVariantId);
  };

  const trustTexts = [
    { kind: 'authentic' as const, text: siteText(settings, 'text_trust_authentic') },
    { kind: 'cod' as const, text: siteText(settings, 'text_trust_cod') },
    { kind: 'delivery' as const, text: siteText(settings, 'text_trust_delivery') },
  ];

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
          {blurredShown
            .filter((url) => images.includes(url))
            .map((url) => (
              <img
                key={`blur-${url}`}
                src={url}
                alt=""
                aria-hidden="true"
                draggable={false}
                className={`product-detail__backdrop${url === currentImage ? ' product-detail__backdrop--on' : ''}`}
                data-testid="photo-backdrop"
              />
            ))}
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
                {...protectedImageProps}
                className={`product-detail__image ${PROTECTED_IMAGE_CLASS}`}
                loading={index === 0 ? 'eager' : 'lazy'}
              />
            ))}
          </div>
          {images.length > 1 && (
            <span className="product-detail__counter" aria-hidden="true" data-testid="image-counter">
              {activeImage + 1} / {images.length}
            </span>
          )}
        </div>
      ) : (
        <div
          ref={galleryRef}
          className="product-detail__gallery product-card__placeholder"
          aria-hidden="true"
          style={{ viewTransitionName: productHeroName(product.id) } as CSSProperties}
        >
          <PlaceholderIcon />
        </div>
      )}

      {/* The rounded sheet (Batch 28 Part 2): sits over the bottom of the
          photo, page-coloured, never part of the morphing picture. */}
      <div className={`pdp-sheet${settleSheet ? ' pdp-sheet--settle' : ''}`} data-testid="pdp-sheet">
        <span className="pdp-sheet__notch" aria-hidden="true" data-testid="pdp-sheet-notch" />
        {images.length > 1 && (
          <div className="pdp-sheet__dots" aria-hidden="true" data-testid="pdp-sheet-dots">
            {images.map((url, index) => (
              <span
                key={url}
                className={`pdp-sheet__dot${index === activeImage ? ' pdp-sheet__dot--active' : ''}`}
              />
            ))}
          </div>
        )}

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
            <span className="product-detail__price">{formatTaka(mainPrice)}</span>
            {strikePrice !== null && (
              <span className="price-block__strike">{formatTaka(strikePrice)}</span>
            )}
            {strikePrice !== null && savePercent !== null && !outOfStock && (
              <span className="save-badge pdp-save">Save {savePercent}%</span>
            )}
          </div>

          {/* The stock capsule and the note are one quiet group (Batch 29):
              the note is a plain caption with a small info icon, never a box. */}
          <div className="pdp-stock" data-sheet-part="chips">
            <span className="pdp-chip" data-testid="stock-chip">
              <span
                className={`pdp-chip__dot ${outOfStock ? 'pdp-chip__dot--out' : 'pdp-chip__dot--in'}`}
                aria-hidden="true"
              />
              {outOfStock ? 'Out of stock' : 'In stock'}
            </span>
            {noteText !== '' && (
              <p className="pdp-note" data-testid="product-note">
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

          <WholesaleReveal hasWholesale={hasWholesale} price={wholesalePrice} />

          <ul className="trust-plate" aria-label="Why buy here" data-sheet-part="trust" data-testid="trust-plate">
            {trustTexts.map((t) => (
              <li key={t.kind} className="trust-plate__item" data-testid={`trust-${t.kind}`}>
                <TrustIcon kind={t.kind} />
                <span className="trust-plate__text">{t.text}</span>
              </li>
            ))}
          </ul>
        </div>

        {hasSections && (
          <Accordion>
            {about !== '' && (
              <AccordionItem title="About this product" defaultOpen>
                <RichTextView value={about} testId="pdp-about" />
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
          onPointerDown={onPressStart}
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
                aria-label={`${product.name} is out of stock`}
                data-testid="buy-bar-out"
              >
                Out of stock
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
              </div>
            ) : (
              <button
                type="button"
                className="buy-bar__pill buy-bar__add"
                onClick={handleAddToCart}
                tabIndex={barShown ? 0 : -1}
                aria-label={`Add ${product.name} to cart`}
                data-testid="add-to-cart"
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

  useDocumentTitle(product ? `${product.name} — NAEEM'S` : "NAEEM'S");

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
