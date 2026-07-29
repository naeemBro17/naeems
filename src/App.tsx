import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ProductProvider } from './contexts/ProductContext';
import { AuthModalProvider } from './contexts/AuthModalContext';
import { ToastContainer } from './components/shared/ToastContainer';
import { ProtectedRoute } from './components/shared/ProtectedRoute';
import { ViewerPage } from './pages/ViewerPage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { ContactExpertPage } from './pages/ContactExpertPage';
import { AdminPage } from './pages/AdminPage';

export default function App() {
  return (
    <ToastContainer>
      <AuthProvider>
        <ProductProvider>
          <AuthModalProvider>
            <Routes>
              <Route path="/" element={<ViewerPage />} />
              <Route path="/product/:sku" element={<ProductDetailPage />} />
              <Route path="/contact" element={<ContactExpertPage />} />
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
          </AuthModalProvider>
        </ProductProvider>
      </AuthProvider>
    </ToastContainer>
  );
}
