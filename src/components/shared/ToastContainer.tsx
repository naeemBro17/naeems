import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ToastContext } from '../../hooks/useToast';
import { Toast } from './Toast';
import type { Toast as ToastData, ToastType } from '../../types';

const TOAST_DURATION_MS = 2500;
/** Must match .toast--leaving's animation duration in app.css. */
const LEAVE_ANIMATION_MS = 200;

/**
 * Provides the toast API to the whole app and renders the live region
 * where toasts appear (bottom of screen, thumb-reach safe).
 */
export function ToastContainer({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  // Ids currently fading out — kept mounted (but marked) for one more
  // animation instead of being spliced out of `toasts` immediately, so a
  // toast's exit animates the same as its entrance did.
  const [leavingIds, setLeavingIds] = useState<Set<string>>(new Set());

  const showToast = useCallback((message: string, type: ToastType = 'success') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    window.setTimeout(() => {
      setLeavingIds((prev) => new Set(prev).add(id));
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        setLeavingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, LEAVE_ANIMATION_MS);
    }, TOAST_DURATION_MS);
  }, []);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-container" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} isLeaving={leavingIds.has(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
