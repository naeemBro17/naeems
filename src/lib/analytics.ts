// Facebook Pixel + Google Analytics 4 (Batch 19 Part 2).
//
// Both load only once an ID is configured in Admin → Settings — a blank
// field means that tracker never loads, no errors, nothing in the network
// tab. Both scripts are injected async so they can never block or slow the
// page. Nothing here ever sends a customer's name, phone, address or email —
// only product id/name/price (BDT), quantities, an order's total/number,
// and a typed search term. Nothing fires at all while the visitor is on
// /admin or /wholesaler-access (enforced by the one router-level PageView
// listener in App.tsx — see useAnalyticsPageviews).

interface FbQ {
  (...args: unknown[]): void;
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  loaded: boolean;
  version: string;
}

declare global {
  interface Window {
    fbq?: FbQ;
    _fbq?: FbQ;
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let fbInitialized = false;
let gaInitialized = false;

/** True on /admin and /wholesaler-access — every tracking call is a no-op
 *  there, per CLAUDE.md's "never track admin/wholesaler areas" rule. */
function isExcludedPath(pathname: string): boolean {
  return pathname.startsWith('/admin') || pathname.startsWith('/wholesaler-access');
}

function initFbPixel(pixelId: string): void {
  if (fbInitialized || pixelId.trim() === '') return;
  fbInitialized = true;

  if (!window.fbq) {
    const fbq: FbQ = (...args: unknown[]) => {
      if (fbq.callMethod) {
        fbq.callMethod(...args);
      } else {
        fbq.queue.push(args);
      }
    };
    fbq.queue = [];
    fbq.loaded = true;
    fbq.version = '2.0';
    window.fbq = fbq;
    window._fbq = fbq;

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(script);
  }

  window.fbq?.('init', pixelId);
}

function initGa(measurementId: string): void {
  if (gaInitialized || measurementId.trim() === '') return;
  gaInitialized = true;

  window.dataLayer = window.dataLayer ?? [];
  window.gtag = (...args: unknown[]) => {
    window.dataLayer?.push(args);
  };
  // Newer gtag.js builds default analytics_storage to 'denied' (Google's
  // Consent Mode) until a page explicitly grants it — without this, the
  // script loads and even runs (dataLayer fills up, gtm.load/gtm.dom fire)
  // but never actually sends a hit to Google, which is exactly what looked
  // like "Realtime shows 0 users right after saving the ID" (reports/
  // batch-22.txt Part 4). This site never runs Google Ads, so ad-related
  // consent stays denied — only analytics_storage (needed for GA4 itself to
  // work at all) is granted.
  window.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'granted',
  });
  window.gtag('js', new Date());
  // send_page_view: false — PageView is sent manually on every route change
  // (see useAnalyticsPageviews) so it's excluded from /admin and
  // /wholesaler-access exactly like the Pixel is, and so a client-side
  // route change (this is a single-page app) counts as a real pageview.
  window.gtag('config', measurementId, { send_page_view: false });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.appendChild(script);
}

/** Called once settings are known (see useAnalyticsInit) — safe to call
 *  repeatedly, each tracker only ever initializes itself once. */
export function initAnalytics(fbPixelId: string, gaMeasurementId: string): void {
  initFbPixel(fbPixelId);
  initGa(gaMeasurementId);
}

export function trackPageView(pathname: string): void {
  if (isExcludedPath(pathname)) return;
  window.fbq?.('track', 'PageView');
  window.gtag?.('event', 'page_view', { page_path: pathname });
}

interface TrackedProduct {
  id: string;
  name: string;
  price: number;
}

export function trackViewContent(product: TrackedProduct): void {
  if (isExcludedPath(window.location.pathname)) return;
  window.fbq?.('track', 'ViewContent', {
    content_ids: [product.id],
    content_name: product.name,
    content_type: 'product',
    value: product.price,
    currency: 'BDT',
  });
  window.gtag?.('event', 'view_item', {
    currency: 'BDT',
    value: product.price,
    items: [{ item_id: product.id, item_name: product.name, price: product.price }],
  });
}

export function trackAddToCart(product: TrackedProduct, quantity: number): void {
  if (isExcludedPath(window.location.pathname)) return;
  const value = product.price * quantity;
  window.fbq?.('track', 'AddToCart', {
    content_ids: [product.id],
    content_name: product.name,
    content_type: 'product',
    value,
    currency: 'BDT',
  });
  window.gtag?.('event', 'add_to_cart', {
    currency: 'BDT',
    value,
    items: [{ item_id: product.id, item_name: product.name, price: product.price, quantity }],
  });
}

export function trackInitiateCheckout(
  items: { id: string; name: string; price: number; quantity: number }[],
  total: number
): void {
  if (isExcludedPath(window.location.pathname)) return;
  window.fbq?.('track', 'InitiateCheckout', {
    content_ids: items.map((i) => i.id),
    contents: items.map((i) => ({ id: i.id, quantity: i.quantity })),
    num_items: items.reduce((sum, i) => sum + i.quantity, 0),
    value: total,
    currency: 'BDT',
  });
  window.gtag?.('event', 'begin_checkout', {
    currency: 'BDT',
    value: total,
    items: items.map((i) => ({
      item_id: i.id,
      item_name: i.name,
      price: i.price,
      quantity: i.quantity,
    })),
  });
}

/** Order number doubles as the event/transaction id on both trackers, so a
 *  page refresh on the success page (or an accidental double-fire) can never
 *  count the same order twice — both Meta and GA4 de-duplicate by this id. */
export function trackPurchase(orderNumber: string, total: number): void {
  if (isExcludedPath(window.location.pathname)) return;
  window.fbq?.('track', 'Purchase', { value: total, currency: 'BDT' }, { eventID: orderNumber });
  window.gtag?.('event', 'purchase', {
    transaction_id: orderNumber,
    currency: 'BDT',
    value: total,
  });
}

export function trackSearch(searchTerm: string): void {
  const term = searchTerm.trim();
  if (term === '' || isExcludedPath(window.location.pathname)) return;
  window.fbq?.('track', 'Search', { search_string: term });
  window.gtag?.('event', 'search', { search_term: term });
}
