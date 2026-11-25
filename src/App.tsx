import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { useAppNavigate } from './hooks/useAppNavigate';
import { BottomNav } from './components/viewer/BottomNav';
import { GlassCartButton } from './components/viewer/GlassCartButton';
import { CartUndoToast } from './components/viewer/CartUndoToast';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { CustomerOrderNotePopup } from './components/orders/OrderNotePopup';
import { ProductProvider } from './contexts/ProductContext';
import { CampaignProvider } from './contexts/CampaignContext';
import { AdminEditProvider } from './contexts/AdminEditContext';
import { CartProvider } from './contexts/CartContext';
import { WishlistProvider } from './contexts/WishlistContext';
import { WishlistLoginSheet, WishlistToast } from './components/viewer/Wishlist';
import { CheckoutStateProvider } from './features/checkout/useCheckoutState';
import { ToastContainer } from './components/shared/ToastContainer';
import { AnalyticsTracker } from './components/shared/AnalyticsTracker';
import { ProtectedRoute } from './components/shared/ProtectedRoute';
import { ShopDownGate } from './components/shared/ShopDown';
import { InAppBrowserBar } from './components/shared/InAppBrowserBar';
import { PageTransition } from './components/shared/PageTransition';
import { ViewerPage } from './pages/ViewerPage';
import {
  SearchPage,
  ProductDetailPage,
  ContactExpertPage,
  BrandsPage,
  BrandPage,
  CartPage,
  DeliveryDetailsPage,
  OrderSummaryPage,
  OrderSuccessPage,
  AdminAccessPage,
  WholesalerAccessPage,
  AccountPage,
  WishlistPage,
  ComboPage,
  OrdersListPage,
  OrderDetailPage,
  WalletPage,
  NotFoundPage,
  ReturnPolicyPage,
  DeliveryPolicyPage,
  TermsPage,
  PrivacyPolicyPage,
  AboutPage,
  CampaignPage,
} from './lib/routePages';
import { forgetScroll } from './lib/scrollMemory';
import { rememberShopPage } from './lib/loginReturn';
import { useToast } from './hooks/useToast';
import { consumeUpdatedFlag } from './lib/appUpdate';

// Admin panel (product editor, CSV import, image editors, banner/bento
// editors, etc.) is the single biggest chunk of this app's JS — a customer
// who never opens /admin should never have to download it (Batch 15 audit /
// Batch 19 Part 1). React.lazy splits it into its own file, fetched only
// when someone actually navigates to /admin.
const AdminPage = lazy(() => import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })));

/**
 * Shown only while a page's file is still downloading — the plain page
 * background, no spinner (Batch 29 Part 7). In-app navigation waits for the
 * file first (lib/routePages.tsx whenRouteReady), so this mostly appears on
 * a direct visit to a page's link, for a moment.
 */
function RouteFallback() {
  return <div className="route-fallback" aria-hidden="true" />;
}

/** Batch 31 Part 7: one quiet "Updated" after the app switched to a new
 *  version (src/lib/appUpdate.ts). */
function AppUpdatedToast() {
  const { showToast } = useToast();
  useEffect(() => {
    if (consumeUpdatedFlag()) showToast('Updated');
  }, [showToast]);
  return null;
}

function AdminPageFallback() {
  return (
    <div className="full-screen-center" aria-label="Loading admin panel">
      <span className="spinner spinner--large" aria-hidden="true" />
    </div>
  );
}

/**
 * Rendered as a sibling of PageTransition, not inside it — a `transform`
 * applied to an ancestor breaks a `position: fixed` descendant's containing
 * block (a standard CSS behaviour), which used to make this bar vanish or
 * jump for the ~350ms a "deeper" slide played (reports/fix-animation-audit.txt
 * "found along the way" #1; reports/batch-21.txt Part 1, point 6). Living
 * outside the animated subtree — and, for any navigation the native View
 * Transition path drives, being just part of a whole-page bitmap snapshot
 * rather than a live positioned element — means there is no transformed
 * ancestor to be broken by in the first place.
 *
 * Only shown on Home for now, matching the tab bar's existing scope; a
 * future page that wants it too just needs adding to the path check here.
 */
function GlobalBottomNav() {
  const location = useLocation();
  const navigate = useAppNavigate();
  if (location.pathname !== '/') return null;
  return (
    <BottomNav
      activeTab="home"
      onHome={() => {
        // Back to the top, and forget the old spot so nothing (a reload, a
        // later Back) can jump down to it again.
        forgetScroll(location.key);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }}
      onAccount={() => navigate('/account', { state: { from: `${location.pathname}${location.search}` } })}
    />
  );
}

/** Batch 47: remembers the last shop page, so logging in from the account
 *  page returns there. */
function LoginReturnTracker() {
  const location = useLocation();
  useEffect(() => {
    rememberShopPage(`${location.pathname}${location.search}`);
  }, [location.pathname, location.search]);
  return null;
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastContainer>
        <AppUpdatedToast />
        <AuthProvider>
          <ProductProvider>
            <CampaignProvider>
            <CartProvider>
              <WishlistProvider>
              <CheckoutStateProvider>
                <AdminEditProvider>
                  {/* Batch 40 Part 3: a calm "shop is being updated" page
                      while the database can't be reached. */}
                  <ShopDownGate>
                    <AnalyticsTracker />
                    <LoginReturnTracker />
                    {/* Batch 52 Part 4: only inside Facebook / Messenger / Instagram. */}
                    <InAppBrowserBar />
                    <PageTransition>
                      <Suspense fallback={<RouteFallback />}>
                        <Routes>
                          <Route path="/" element={<ViewerPage />} />
                          <Route path="/search" element={<SearchPage />} />
                          {/* Slug-based; the page also resolves a legacy SKU in this slot. */}
                          <Route path="/product/:slug" element={<ProductDetailPage />} />
                          <Route path="/contact" element={<ContactExpertPage />} />
                          {/* Brands — Batch 26. */}
                          <Route path="/brands" element={<BrandsPage />} />
                          <Route path="/brand/:slug" element={<BrandPage />} />
                          {/* Policy/trust pages — Batch 19 Part 4. /privacy is
                              already registered with Google for login, must stay
                              exactly this path. */}
                          <Route path="/return-policy" element={<ReturnPolicyPage />} />
                          <Route path="/delivery" element={<DeliveryPolicyPage />} />
                          <Route path="/terms" element={<TermsPage />} />
                          <Route path="/privacy" element={<PrivacyPolicyPage />} />
                          <Route path="/about" element={<AboutPage />} />
                          <Route path="/account" element={<AccountPage />} />
                          {/* Batch 51: the customer's saved products. */}
                          <Route path="/wishlist" element={<WishlistPage />} />
                          {/* Batch 52: a combo Naeem shared (only people with the link). */}
                          <Route path="/c/:code" element={<ComboPage />} />
                          {/* Batch 66: a live campaign (timed sale). */}
                          <Route path="/campaign/:slug" element={<CampaignPage />} />
                          <Route path="/orders" element={<OrdersListPage />} />
                          {/* Batch 60: My Wallet (signed-in customers; others go to /account). */}
                          <Route path="/wallet" element={<WalletPage />} />
                          <Route path="/orders/:orderId" element={<OrderDetailPage />} />
                          {/* Cart & checkout flow — see src/features/checkout. */}
                          <Route path="/cart" element={<CartPage />} />
                          <Route path="/checkout/delivery" element={<DeliveryDetailsPage />} />
                          <Route path="/checkout/summary" element={<OrderSummaryPage />} />
                          <Route path="/checkout/success" element={<OrderSuccessPage />} />
                          {/* Unlisted sign-in routes — never linked from the public UI. */}
                          <Route path="/admin-access" element={<AdminAccessPage />} />
                          <Route path="/wholesaler-access" element={<WholesalerAccessPage />} />
                          {/* /admin and its pages (Batch 32: /admin/orders/new, …). */}
                          <Route
                            path="/admin/*"
                            element={
                              <ProtectedRoute>
                                <Suspense fallback={<AdminPageFallback />}>
                                  <AdminPage />
                                </Suspense>
                              </ProtectedRoute>
                            }
                          />
                          <Route path="*" element={<NotFoundPage />} />
                        </Routes>
                      </Suspense>
                    </PageTransition>
                    <GlobalBottomNav />
                    <GlassCartButton />
                    <CartUndoToast />
                    <WishlistToast />
                    <WishlistLoginSheet />
                    {/* Batch 65: a note about her order, once per app load. */}
                    <CustomerOrderNotePopup />
                  </ShopDownGate>
                </AdminEditProvider>
              </CheckoutStateProvider>
              </WishlistProvider>
            </CartProvider>
            </CampaignProvider>
          </ProductProvider>
        </AuthProvider>
      </ToastContainer>
    </ThemeProvider>
  );
}
