import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/** One line item: a product id, how many, and the unit price it was added at. */
export interface CartItem {
  productId: string;
  quantity: number;
  /** Price per unit at the moment it was added, so a later price change on the
   *  product does not retroactively change what's already in the cart. */
  priceAtAdd: number;
}

interface CartContextValue {
  items: CartItem[];
  /** Adds one unit of a product, or increments its quantity if already present. */
  addItem: (productId: string, price: number) => void;
  removeItem: (productId: string) => void;
  /** Removes the item when quantity drops to 0 or below. */
  updateQuantity: (productId: string, quantity: number) => void;
  clearCart: () => void;
  /** Total units across all line items. */
  itemCount: number;
  subtotal: number;
}

const CART_KEY = 'nph_cart';

const CartContext = createContext<CartContextValue | null>(null);

function isCartItem(value: unknown): value is CartItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.productId === 'string' &&
    typeof item.quantity === 'number' &&
    typeof item.priceAtAdd === 'number'
  );
}

function loadCart(): CartItem[] {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isCartItem) : [];
  } catch {
    return [];
  }
}

/**
 * Cart state for the upcoming checkout flow. Persisted to localStorage so it
 * survives a reload; this provider only holds the data — the checkout pages
 * that consume it are built in a later session.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>(loadCart);

  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(items));
    } catch {
      // Non-persistent, but the cart still works for this session.
    }
  }, [items]);

  const addItem = useCallback((productId: string, price: number) => {
    setItems((prev) => {
      const existing = prev.find((item) => item.productId === productId);
      if (existing) {
        return prev.map((item) =>
          item.productId === productId ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...prev, { productId, quantity: 1, priceAtAdd: price }];
    });
  }, []);

  const removeItem = useCallback((productId: string) => {
    setItems((prev) => prev.filter((item) => item.productId !== productId));
  }, []);

  const updateQuantity = useCallback((productId: string, quantity: number) => {
    setItems((prev) => {
      if (quantity <= 0) return prev.filter((item) => item.productId !== productId);
      return prev.map((item) => (item.productId === productId ? { ...item, quantity } : item));
    });
  }, []);

  const clearCart = useCallback(() => setItems([]), []);

  const itemCount = useMemo(
    () => items.reduce((sum, item) => sum + item.quantity, 0),
    [items]
  );
  const subtotal = useMemo(
    () => items.reduce((sum, item) => sum + item.quantity * item.priceAtAdd, 0),
    [items]
  );

  const value = useMemo(
    () => ({ items, addItem, removeItem, updateQuantity, clearCart, itemCount, subtotal }),
    [items, addItem, removeItem, updateQuantity, clearCart, itemCount, subtotal]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return ctx;
}
