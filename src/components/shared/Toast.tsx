import type { Toast as ToastData } from '../../types';

interface ToastProps {
  toast: ToastData;
  /** True for one last animation frame before removal — fades/slides the
   *  toast back out instead of it vanishing. */
  isLeaving?: boolean;
}

const TOAST_ICONS: Record<ToastData['type'], string> = {
  success: 'M20 6L9 17l-5-5',
  error: 'M18 6L6 18M6 6l12 12',
  info: 'M12 16v-4m0-4h.01',
};

export function Toast({ toast, isLeaving = false }: ToastProps) {
  return (
    <div className={`toast toast--${toast.type}${isLeaving ? ' toast--leaving' : ''}`}>
      <svg
        className="toast__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {toast.type === 'info' && <circle cx="12" cy="12" r="9" />}
        <path d={TOAST_ICONS[toast.type]} />
      </svg>
      <span className="toast__message">{toast.message}</span>
    </div>
  );
}
