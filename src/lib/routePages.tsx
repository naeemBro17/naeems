import { lazy, type ComponentType } from 'react';

/* Every page except Home is its own small file, downloaded only when needed
   (Batch 29 Part 7) — the first visit to Home no longer downloads the
   product page, checkout, account, orders, policies or admin.

   A page made here renders instantly once its file has arrived: until then
   it is a normal React.lazy page (Suspense shows the plain page background),
   but after preload() it renders the real component directly, with no
   loading step at all. That matters for the card → product morph: the
   transition's "after" picture must be the real product page, never a
   placeholder. whenRouteReady() makes every in-app navigation wait for the
   page's file first (normally already there — see preloadShopPages). */

export interface RoutePage {
  (props: object): JSX.Element;
  /** Downloads the page's file (once); resolves when it can render. */
  preload: () => Promise<void>;
  /** True once the file has arrived. */
  isReady: () => boolean;
}

function routePage<M>(load: () => Promise<M>, pick: (module: M) => ComponentType): RoutePage {
  let Ready: ComponentType | null = null;
  let loading: Promise<void> | null = null;

  const preload = (): Promise<void> => {
    if (!loading) {
      loading = load().then(
        (module) => {
          Ready = pick(module);
        },
        (error: unknown) => {
          // A failed download (offline, a new deploy) may be retried.
          loading = null;
          throw error;
        }
      );
    }
    return loading;
  };

  const Lazy = lazy(() => preload().then(() => ({ default: Ready as ComponentType })));

  const Page = ((props: object) => (Ready ? <Ready {...props} /> : <Lazy {...props} />)) as RoutePage;
  Page.preload = preload;
  Page.isReady = () => Ready !== null;
  return Page;
}

export const SearchPage = routePage(() => import('../pages/SearchPage'), (m) => m.SearchPage);
export const ProductDetailPage = routePage(() => import('../pages/ProductDetailPage'), (m) => m.ProductDetailPage);
export const ContactExpertPage = routePage(() => import('../pages/ContactExpertPage'), (m) => m.ContactExpertPage);
export const BrandsPage = routePage(() => import('../pages/BrandsPage'), (m) => m.BrandsPage);
export const BrandPage = routePage(() => import('../pages/BrandPage'), (m) => m.BrandPage);
export const CartPage = routePage(() => import('../features/checkout/CartPage'), (m) => m.CartPage);
export const DeliveryDetailsPage = routePage(
  () => import('../features/checkout/DeliveryDetailsPage'),
  (m) => m.DeliveryDetailsPage
);
export const OrderSummaryPage = routePage(() => import('../features/checkout/OrderSummaryPage'), (m) => m.OrderSummaryPage);
export const OrderSuccessPage = routePage(() => import('../features/checkout/OrderSuccessPage'), (m) => m.OrderSuccessPage);
export const AdminAccessPage = routePage(() => import('../pages/AdminAccessPage'), (m) => m.AdminAccessPage);
export const WholesalerAccessPage = routePage(() => import('../pages/WholesalerAccessPage'), (m) => m.WholesalerAccessPage);
export const AccountPage = routePage(() => import('../pages/AccountPage'), (m) => m.AccountPage);
export const OrdersListPage = routePage(() => import('../pages/OrdersListPage'), (m) => m.OrdersListPage);
export const OrderDetailPage = routePage(() => import('../pages/OrderDetailPage'), (m) => m.OrderDetailPage);
export const NotFoundPage = routePage(() => import('../pages/NotFoundPage'), (m) => m.NotFoundPage);
export const ReturnPolicyPage = routePage(() => import('../pages/policy/ReturnPolicyPage'), (m) => m.ReturnPolicyPage);
export const DeliveryPolicyPage = routePage(() => import('../pages/policy/DeliveryPolicyPage'), (m) => m.DeliveryPolicyPage);
export const TermsPage = routePage(() => import('../pages/policy/TermsPage'), (m) => m.TermsPage);
export const PrivacyPolicyPage = routePage(() => import('../pages/policy/PrivacyPolicyPage'), (m) => m.PrivacyPolicyPage);
export const AboutPage = routePage(() => import('../pages/policy/AboutPage'), (m) => m.AboutPage);

/** The page a path opens (null = Home, which is always loaded, or admin,
 *  which has its own loading screen). Mirrors the routes in App.tsx. */
export function pageForPath(pathname: string): RoutePage | null {
  if (pathname === '/' || pathname === '/admin' || pathname.startsWith('/admin/')) return null;
  if (pathname.startsWith('/product/')) return ProductDetailPage;
  if (pathname.startsWith('/brand/')) return BrandPage;
  if (pathname.startsWith('/orders/')) return OrderDetailPage;
  const exact: Record<string, RoutePage> = {
    '/search': SearchPage,
    '/contact': ContactExpertPage,
    '/brands': BrandsPage,
    '/cart': CartPage,
    '/checkout/delivery': DeliveryDetailsPage,
    '/checkout/summary': OrderSummaryPage,
    '/checkout/success': OrderSuccessPage,
    '/admin-access': AdminAccessPage,
    '/wholesaler-access': WholesalerAccessPage,
    '/account': AccountPage,
    '/orders': OrdersListPage,
    '/return-policy': ReturnPolicyPage,
    '/delivery': DeliveryPolicyPage,
    '/terms': TermsPage,
    '/privacy': PrivacyPolicyPage,
    '/about': AboutPage,
  };
  return exact[pathname] ?? NotFoundPage;
}

/**
 * Runs `go` (a navigation) once the target page can render without a
 * loading step — at once when its file is already here (the usual case),
 * else right after it arrives (or fails: then the page's own loading state
 * handles it, as before).
 */
export function whenRouteReady(path: string, go: () => void): void {
  const pathname = path.split(/[?#]/)[0];
  const page = pageForPath(pathname);
  if (!page || page.isReady()) {
    go();
    return;
  }
  page.preload().then(go, go);
}

/** The pages a shopper reaches from Home, most likely first. */
const SHOP_PAGES: RoutePage[] = [ProductDetailPage, SearchPage, BrandPage, BrandsPage, CartPage];

let shopPreloadStarted = false;

/**
 * After Home has rendered and the phone is idle, download the shop pages'
 * files (the product page first) so every tap from Home opens at once.
 * They're small and the offline helper keeps them.
 */
export function preloadShopPages(): void {
  if (shopPreloadStarted) return;
  shopPreloadStarted = true;
  const run = () => {
    void SHOP_PAGES.reduce<Promise<void>>(
      (chain, page) => chain.then(() => page.preload().catch(() => undefined)),
      Promise.resolve()
    );
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 2500 });
  else window.setTimeout(run, 1200);
}
