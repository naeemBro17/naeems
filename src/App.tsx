import { Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { ProductProvider } from './contexts/ProductContext';
import { ToastContainer } from './components/shared/ToastContainer';
import { ProtectedRoute } from './components/shared/ProtectedRoute';
import { ViewerPage } from './pages/ViewerPage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { ContactExpertPage } from './pages/ContactExpertPage';
import { AdminPage } from './pages/AdminPage';
import { AdminAccessPage } from './pages/AdminAccessPage';
import { WholesalerAccessPage } from './pages/WholesalerAccessPage';

export default function App() {
  return (
    <ThemeProvider>
      <ToastContainer>
        <AuthProvider>
          <ProductProvider>
            <Routes>
              <Route path="/" element={<ViewerPage />} />
              <Route path="/product/:sku" element={<ProductDetailPage />} />
              <Route path="/contact" element={<ContactExpertPage />} />
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
          </ProductProvider>
        </AuthProvider>
      </ToastContainer>
    </ThemeProvider>
  );
}
