import { useEffect, useRef, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../hooks/useToast';

/**
 * Wraps /admin. Only an approved admin may enter — a logged-in wholesaler (or
 * anonymous visitor) is redirected to the viewer. If a previously valid admin
 * session disappears (expiry), shows a toast.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAdmin, isLoading } = useAuth();
  const { showToast } = useToast();
  const hadAdminRef = useRef(false);

  useEffect(() => {
    if (isAdmin) {
      hadAdminRef.current = true;
    } else if (hadAdminRef.current) {
      hadAdminRef.current = false;
      showToast('Session expired. Please sign in again.', 'info');
    }
  }, [isAdmin, showToast]);

  if (isLoading) {
    return (
      <div className="full-screen-center" aria-label="Checking sign-in status">
        <span className="spinner spinner--large" aria-hidden="true" />
      </div>
    );
  }

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
