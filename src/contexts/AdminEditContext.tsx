import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import type { Product } from '../types';

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
 * Edit Mode for inline admin editing. Deliberately local state: it resets on
 * reload and on sign-out, so the admin always starts in the customer's view.
 *
 * The provider sits above the router so the mode survives moving between the
 * homepage and /contact. For a non-admin session every value is inert — the
 * edit controls read isEditMode and render nothing, and toggleEditMode can't
 * flip it on.
 */
export function AdminEditProvider({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  const toggleEditMode = useCallback(() => {
    setEnabled((current) => !current);
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
