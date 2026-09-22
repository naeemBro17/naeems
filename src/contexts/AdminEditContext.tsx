import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from './AuthContext';
import type { Product } from '../types';

/** Persists the toggle so a reload doesn't silently drop an admin back into
 *  Edit Mode off — see loadStoredEditMode's doc comment for the trust rule. */
const EDIT_MODE_KEY = 'nph_edit_mode';

function loadStoredEditMode(): boolean {
  try {
    return localStorage.getItem(EDIT_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

function storeEditMode(value: boolean): void {
  try {
    localStorage.setItem(EDIT_MODE_KEY, value ? '1' : '0');
  } catch {
    // Non-persistent, but Edit Mode still works for this session.
  }
}

interface AdminEditContextValue {
  /** True only while an approved admin has switched Edit Mode on. */
  isEditMode: boolean;
  /** Flips Edit Mode. A no-op for anyone who isn't an approved admin. */
  toggleEditMode: () => void;
  /** The product whose inline edit sheet is open, if any. */
  editingProduct: Product | null;
  openProductEdit: (product: Product) => void;
  closeProductEdit: () => void;
}

const INERT: AdminEditContextValue = {
  isEditMode: false,
  toggleEditMode: () => undefined,
  editingProduct: null,
  openProductEdit: () => undefined,
  closeProductEdit: () => undefined,
};

const AdminEditContext = createContext<AdminEditContextValue>(INERT);

/**
 * Edit Mode for inline admin editing. The on/off toggle persists to
 * localStorage so a logged-in admin's choice survives a reload instead of
 * silently reverting — it used to reset every time, which looked like the
 * button itself was broken. Still cleared the moment the session isn't a
 * real approved admin (sign-out, or someone else on the same device), so
 * Edit Mode can never leak to a customer view.
 *
 * The provider sits above the router so the mode survives moving between the
 * homepage and /contact. For a non-admin session every value is inert — the
 * edit controls read isEditMode and render nothing, and toggleEditMode can't
 * flip it on.
 */
export function AdminEditProvider({ children }: { children: ReactNode }) {
  const { isAdmin, isLoading: authLoading } = useAuth();
  const [enabled, setEnabled] = useState(loadStoredEditMode);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  // A signed-out or non-admin session must never carry a stale "on" through
  // to whoever uses this browser next. Gated on authLoading: isAdmin reads
  // false for the first render or two of every load (session/profile still
  // resolving — see AuthContext), and clearing on that transient false wiped
  // a real admin's stored preference before it ever got a chance to resolve.
  useEffect(() => {
    if (!authLoading && !isAdmin && enabled) {
      setEnabled(false);
      storeEditMode(false);
    }
  }, [authLoading, isAdmin, enabled]);

  const toggleEditMode = useCallback(() => {
    setEnabled((current) => {
      const next = !current;
      storeEditMode(next);
      return next;
    });
  }, []);

  const openProductEdit = useCallback((product: Product) => setEditingProduct(product), []);
  const closeProductEdit = useCallback(() => setEditingProduct(null), []);

  const value = useMemo<AdminEditContextValue>(() => {
    if (!isAdmin) return INERT;
    return {
      isEditMode: enabled,
      toggleEditMode,
      editingProduct: enabled ? editingProduct : null,
      openProductEdit,
      closeProductEdit,
    };
  }, [isAdmin, enabled, toggleEditMode, editingProduct, openProductEdit, closeProductEdit]);

  return <AdminEditContext.Provider value={value}>{children}</AdminEditContext.Provider>;
}

export function useAdminEdit(): AdminEditContextValue {
  return useContext(AdminEditContext);
}
