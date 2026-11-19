import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';
import { useToast } from '../hooks/useToast';

/**
 * Batch 51 Part 4: the customer's wishlist — product ids saved in the
 * database (wishlist_items: a customer reads and writes only their own
 * rows). It never touches stock, orders or money. Logged out, the heart
 * asks to log in and, back from Google on the same product, saves it.
 */
export interface WishlistToastState {
  id: number;
  kind: 'saved' | 'removed';
  productId: string;
}

interface WishlistValue {
  /** Saved product ids, newest first. */
  ids: string[];
  has: (productId: string) => boolean;
  /** True once this session's list has been read. */
  ready: boolean;
  /** Heart tapped: save / remove (or ask to log in). */
  toggle: (productId: string) => void;
  toast: WishlistToastState | null;
  dismissToast: () => void;
  undo: () => void;
  /** The product a logged-out shopper tried to save (the log-in sheet). */
  loginFor: string | null;
  closeLogin: () => void;
}

const PENDING_KEY = 'wishlist-pending-save';

const WishlistContext = createContext<WishlistValue | null>(null);

function readPending(): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}

export function rememberPendingSave(productId: string): void {
  try {
    window.sessionStorage.setItem(PENDING_KEY, productId);
  } catch {
    // Storage blocked: after logging in the heart is simply tapped again.
  }
}

function clearPending(): void {
  try {
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function WishlistProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const { showToast } = useToast();
  const userId = session?.user.id ?? null;
  const [ids, setIds] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState<WishlistToastState | null>(null);
  const [loginFor, setLoginFor] = useState<string | null>(null);
  const toastIdRef = useRef(0);
  const idsRef = useRef(ids);
  idsRef.current = ids;

  const showWishToast = useCallback((kind: WishlistToastState['kind'], productId: string) => {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, kind, productId });
  }, []);

  const add = useCallback(
    async (productId: string, quiet = false) => {
      setIds((prev) => (prev.includes(productId) ? prev : [productId, ...prev]));
      if (!quiet) showWishToast('saved', productId);
      const { error } = await supabase.from('wishlist_items').insert({ product_id: productId });
      if (error && error.code !== '23505') {
        setIds((prev) => prev.filter((id) => id !== productId));
        setToast(null);
        showToast('Could not save it. Please try again.', 'error');
      }
    },
    [showToast, showWishToast]
  );

  const remove = useCallback(
    async (productId: string) => {
      setIds((prev) => prev.filter((id) => id !== productId));
      showWishToast('removed', productId);
      const { error } = await supabase.from('wishlist_items').delete().eq('product_id', productId);
      if (error) {
        setIds((prev) => (prev.includes(productId) ? prev : [productId, ...prev]));
        setToast(null);
        showToast('Could not remove it. Please try again.', 'error');
      }
    },
    [showToast, showWishToast]
  );

  // The signed-in customer's list; then a save asked for before logging in.
  useEffect(() => {
    setReady(false);
    if (!userId) {
      setIds([]);
      return;
    }
    let alive = true;
    void supabase
      .from('wishlist_items')
      .select('product_id, created_at')
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!alive) return;
        const saved = error ? [] : ((data ?? []) as { product_id: string }[]).map((r) => r.product_id);
        setIds(saved);
        setReady(true);
        const pending = readPending();
        if (pending) {
          clearPending();
          if (!saved.includes(pending)) void add(pending);
        }
      });
    return () => {
      alive = false;
    };
  }, [userId, add]);

  const toggle = useCallback(
    (productId: string) => {
      if (!userId) {
        setLoginFor(productId);
        return;
      }
      if (idsRef.current.includes(productId)) void remove(productId);
      else void add(productId);
    },
    [userId, add, remove]
  );

  const undo = useCallback(() => {
    if (!toast) return;
    const { kind, productId } = toast;
    setToast(null);
    if (kind === 'removed') void add(productId, true);
    else void remove(productId).then(() => setToast(null));
  }, [toast, add, remove]);

  const value = useMemo<WishlistValue>(
    () => ({
      ids,
      has: (productId: string) => ids.includes(productId),
      ready,
      toggle,
      toast,
      dismissToast: () => setToast(null),
      undo,
      loginFor,
      closeLogin: () => setLoginFor(null),
    }),
    [ids, ready, toggle, toast, undo, loginFor]
  );

  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>;
}

export function useWishlist(): WishlistValue {
  const ctx = useContext(WishlistContext);
  if (!ctx) throw new Error('useWishlist must be used within a WishlistProvider');
  return ctx;
}
