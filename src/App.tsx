import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
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
import { SearchPage } from './pages/SearchPage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { ContactExpertPage } from './pages/ContactExpertPage';
import { CartPage } from './features/checkout/CartPage';
import { DeliveryDetailsPage } from './features/checkout/DeliveryDetailsPage';
import { OrderSummaryPage } from './features/checkout/OrderSummaryPage';
import { OrderSuccessPage } from './features/checkout/OrderSuccessPage';
import { AdminAccessPage } from './pages/AdminAccessPage';
import { WholesalerAccessPage } from './pages/WholesalerAccessPage';
import { AccountPage } from './pages/AccountPage';
import { OrdersListPage } from './pages/OrdersListPage';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ReturnPolicyPage } from './pages/policy/ReturnPolicyPage';
import { DeliveryPolicyPage } from './pages/policy/DeliveryPolicyPage';
import { TermsPage } from './pages/policy/TermsPage';
import { PrivacyPolicyPage } from './pages/policy/PrivacyPolicyPage';
import { AboutPage } from './pages/policy/AboutPage';

// Admin panel (product editor, CSV import, image editors, banner/bento
// editors, etc.) is the single biggest chunk of this app's JS — a customer
// who never opens /admin should never have to download it (Batch 15 audit /
// Batch 19 Part 1). React.lazy splits it into its own file, fetched only
// when someone actually navigates to /admin.
const AdminPage = lazy(() => import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })));

function AdminPageFallback() {
  return (
    <div className="full-screen-center" aria-label="Loading admin panel">
      <span className="spinner spinner--large" aria-hidden="true" />
    </div>
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
                    <Routes>
                      <Route path="/" element={<ViewerPage />} />
                      <Route path="/search" element={<SearchPage />} />
                      {/* Slug-based; the page also resolves a legacy SKU in this slot. */}
                      <Route path="/product/:slug" element={<ProductDetailPage />} />
                      <Route path="/contact" element={<ContactExpertPage />} />
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
                  </PageTransition>
                </AdminEditProvider>
              </CheckoutStateProvider>
            </CartProvider>
          </ProductProvider>
        </AuthProvider>
      </ToastContainer>
    </ThemeProvider>
  );
}
