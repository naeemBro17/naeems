import { Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { ProductProvider } from './contexts/ProductContext';
import { AdminEditProvider } from './contexts/AdminEditContext';
import { CartProvider } from './contexts/CartContext';
import { CheckoutStateProvider } from './features/checkout/useCheckoutState';
import { ToastContainer } from './components/shared/ToastContainer';
import { ProtectedRoute } from './components/shared/ProtectedRoute';
import { PageTransition } from './components/shared/PageTransition';
import { ViewerPage } from './pages/ViewerPage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { ContactExpertPage } from './pages/ContactExpertPage';
import { CartPage } from './features/checkout/CartPage';
import { DeliveryDetailsPage } from './features/checkout/DeliveryDetailsPage';
import { OrderSummaryPage } from './features/checkout/OrderSummaryPage';
import { OrderSuccessPage } from './features/checkout/OrderSuccessPage';
import { AdminPage } from './pages/AdminPage';
import { AdminAccessPage } from './pages/AdminAccessPage';
import { WholesalerAccessPage } from './pages/WholesalerAccessPage';

export default function App() {
  return (
    <ThemeProvider>
      <ToastContainer>
        <AuthProvider>
          <ProductProvider>
            <CartProvider>
              <CheckoutStateProvider>
                <AdminEditProvider>
                  <PageTransition>
                    <Routes>
                      <Route path="/" element={<ViewerPage />} />
                      {/* Slug-based; the page also resolves a legacy SKU in this slot. */}
                      <Route path="/product/:slug" element={<ProductDetailPage />} />
                      <Route path="/contact" element={<ContactExpertPage />} />
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
                            <AdminPage />
                          </ProtectedRoute>
                        }
                      />
                      <Route path="*" element={<Navigate to="/" replace />} />
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
