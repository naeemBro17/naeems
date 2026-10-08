import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../hooks/useToast';

// Only staff with an Authenticator ever see it — kept out of the shop bundle.
const TwoStepCodeScreen = lazy(() => import('./TwoStepCodeScreen'));

/**
 * Wraps /admin. Only an approved admin or an active moderator (Batch 24) may
 * enter — a logged-in wholesaler (or anonymous visitor) is redirected to the
 * viewer. A moderator only sees the sections they have permission for, and
 * the database checks the same permissions again on every action. If a previously valid admin
 * session disappears (expiry), shows a toast.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isStaff, isLoading, mfaPending } = useAuth();
  const location = useLocation();
  const { showToast } = useToast();
  const hadAdminRef = useRef(false);

  useEffect(() => {
    if (isStaff) {
      hadAdminRef.current = true;
    } else if (hadAdminRef.current) {
      hadAdminRef.current = false;
      showToast('Session expired. Please sign in again.', 'info');
    }
  }, [isStaff, showToast]);

  if (isLoading) {
    return (
      <div className="full-screen-center" aria-label="Checking sign-in status">
        <span className="spinner spinner--large" aria-hidden="true" />
      </div>
    );
  }

  // Batch 34: password given, 6-digit code not yet — the code screen, never
  // the admin. The database refuses admin work for such a session too.
  if (mfaPending) {
    return (
      <Suspense fallback={<div className="full-screen-center"><span className="spinner spinner--large" aria-hidden="true" /></div>}>
        <TwoStepCodeScreen />
      </Suspense>
    );
  }

  if (!isStaff) {
    // Batch 32: an admin page's own link (/admin/orders/new, …) opened while
    // signed out goes to the admin sign-in and comes back after it. /admin
    // itself keeps sending visitors to the shop, as before.
    if (location.pathname.startsWith('/admin/')) {
      const next = `${location.pathname}${location.search}`;
      return <Navigate to={`/admin-access?next=${encodeURIComponent(next)}`} replace />;
    }
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
