import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/** One line item: a product id, how many, and the unit price it was added at.
 *  variantId is null for a product with no variants; two lines for the same
 *  product but different variants stay separate rows in the cart. */
export interface CartItem {
  productId: string;
  variantId: string | null;
  /** Snapshot label ("AU · 340g") so the cart/summary/WhatsApp text can show
   *  which variant was chosen without needing the variant to still exist. */
  variantLabel: string | null;
  quantity: number;
  /** Price per unit at the moment it was added, so a later price change on the
   *  product does not retroactively change what's already in the cart. */
  priceAtAdd: number;
}

/** The one variant field addItem/removeItem/updateQuantity take, when the
 *  line is for a specific product variant rather than the product itself. */
export interface CartLineVariant {
  id: string;
  label: string;
}

interface CartContextValue {
  items: CartItem[];
  /** Adds one unit of a product (optionally a specific variant), or
   *  increments its quantity if that exact product+variant is already present. */
  addItem: (productId: string, price: number, variant?: CartLineVariant | null) => void;
  removeItem: (productId: string, variantId?: string | null) => void;
  /** Removes the item when quantity drops to 0 or below. */
  updateQuantity: (productId: string, quantity: number, variantId?: string | null) => void;
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
    typeof item.priceAtAdd === 'number' &&
    (item.variantId === null || typeof item.variantId === 'string') &&
    (item.variantLabel === null || typeof item.variantLabel === 'string')
  );
}

/** Cart rows saved before variants existed have no variantId/variantLabel
 *  fields at all — treat that as "no variant" rather than dropping the row. */
function normalizeCartItem(raw: unknown): CartItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.productId !== 'string' || typeof item.quantity !== 'number') return null;
  if (typeof item.priceAtAdd !== 'number') return null;
  const candidate: CartItem = {
    productId: item.productId,
    quantity: item.quantity,
    priceAtAdd: item.priceAtAdd,
    variantId: typeof item.variantId === 'string' ? item.variantId : null,
    variantLabel: typeof item.variantLabel === 'string' ? item.variantLabel : null,
  };
  return isCartItem(candidate) ? candidate : null;
}

function sameLine(item: CartItem, productId: string, variantId: string | null): boolean {
  return item.productId === productId && item.variantId === variantId;
}

function loadCart(): CartItem[] {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeCartItem)
      .filter((item): item is CartItem => item !== null);
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

  const addItem = useCallback(
    (productId: string, price: number, variant?: CartLineVariant | null) => {
      const variantId = variant?.id ?? null;
      setItems((prev) => {
        const existing = prev.find((item) => sameLine(item, productId, variantId));
        if (existing) {
          return prev.map((item) =>
            sameLine(item, productId, variantId)
              ? { ...item, quantity: item.quantity + 1 }
              : item
          );
        }
        return [
          ...prev,
          {
            productId,
            variantId,
            variantLabel: variant?.label ?? null,
            quantity: 1,
            priceAtAdd: price,
          },
        ];
      });
    },
    []
  );

  const removeItem = useCallback((productId: string, variantId: string | null = null) => {
    setItems((prev) => prev.filter((item) => !sameLine(item, productId, variantId)));
  }, []);

  const updateQuantity = useCallback(
    (productId: string, quantity: number, variantId: string | null = null) => {
      setItems((prev) => {
        if (quantity <= 0) return prev.filter((item) => !sameLine(item, productId, variantId));
        return prev.map((item) =>
          sameLine(item, productId, variantId) ? { ...item, quantity } : item
        );
      });
    },
    []
  );

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
