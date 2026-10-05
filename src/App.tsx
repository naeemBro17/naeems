import { lazy, Suspense } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { useAppNavigate } from './hooks/useAppNavigate';
import { BottomNav } from './components/viewer/BottomNav';
import { GlassCartButton } from './components/viewer/GlassCartButton';
import { CartUndoToast } from './components/viewer/CartUndoToast';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { ProductProvider } from './contexts/ProductContext';
import { AdminEditProvider } from './contexts/AdminEditContext';
import { CartProvider } from './contexts/CartContext';
import { CheckoutStateProvider } from './features/checkout/useCheckoutState';
import { ToastContainer } from './components/shared/ToastContainer';
import { AnalyticsTracker } from './components/shared/AnalyticsTracker';
import { ProtectedRoute } from './components/shared/ProtectedRoute';
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
  OrdersListPage,
  OrderDetailPage,
  NotFoundPage,
  ReturnPolicyPage,
  DeliveryPolicyPage,
  TermsPage,
  PrivacyPolicyPage,
  AboutPage,
} from './lib/routePages';
import { forgetScroll } from './lib/scrollMemory';

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
      onAccount={() => navigate('/account')}
    />
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastContainer>
        <AuthProvider>
          <ProductProvider>
            <CartProvider>
              <CheckoutStateProvider>
                <AdminEditProvider>
                  <AnalyticsTracker />
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
                        <Route path="/orders" element={<OrdersListPage />} />
                        <Route path="/orders/:orderId" element={<OrderDetailPage />} />
                        {/* Cart & checkout flow — see src/features/checkout. */}
                        <Route path="/cart" element={<CartPage />} />
                        <Route path="/checkout/delivery" element={<DeliveryDetailsPage />} />
                        <Route path="/checkout/summary" element={<OrderSummaryPage />} />
                        <Route path="/checkout/success" element={<OrderSuccessPage />} />
                        {/* Unlisted sign-in routes — never linked from the public UI. */}
                        <Route path="/admin-access" element={<AdminAccessPage />} />
                        <Route path="/wholesaler-access" element={<WholesalerAccessPage />} />
                        <Route
                          path="/admin"
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
                </AdminEditProvider>
              </CheckoutStateProvider>
            </CartProvider>
          </ProductProvider>
        </AuthProvider>
      </ToastContainer>
    </ThemeProvider>
  );
}
