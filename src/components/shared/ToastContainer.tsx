import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ToastContext } from '../../hooks/useToast';
import { Toast } from './Toast';
import type { Toast as ToastData, ToastType } from '../../types';

const TOAST_DURATION_MS = 2500;

/**
 * Provides the toast API to the whole app and renders the live region
 * where toasts appear (bottom of screen, thumb-reach safe).
 */
export function ToastContainer({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const showToast = useCallback((message: string, type: ToastType = 'success') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-container" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
