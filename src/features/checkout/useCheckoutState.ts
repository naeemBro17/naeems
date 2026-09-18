// Shared state for the 4-step checkout flow (cart -> delivery -> summary ->
// success). Reads cart items from the existing CartContext/ProductContext
// (this hook does NOT duplicate cart storage) and owns everything specific
// to checkout: delivery zone, address, applied promo code, and the derived
// totals every screen reads. Delivery/address/promo/lastOrder are persisted
// to sessionStorage so a reload mid-flow doesn't lose them.
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useCart } from '../../contexts/CartContext';
import { useProducts } from '../../contexts/ProductContext';
import {
  DELIVERY_ZONES,
  emptyDeliveryAddress,
  type AppliedPromo,
  type CartItem,
  type DeliveryAddress,
  type DeliveryZoneId,
  type DeliveryZoneOption,
  type OrderSnapshot,
} from './types';

const STORAGE_KEY = 'nph_checkout_state';
const DEFAULT_ZONE_ID: DeliveryZoneId = 'inside_dhaka';

interface PersistedState {
  zoneId: DeliveryZoneId;
  address: DeliveryAddress;
  promo: AppliedPromo | null;
  lastOrder: OrderSnapshot | null;
}

function defaultPersisted(): PersistedState {
  return {
    zoneId: DEFAULT_ZONE_ID,
    address: emptyDeliveryAddress(),
    promo: null,
    lastOrder: null,
  };
}

function loadPersisted(): PersistedState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPersisted();
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return { ...defaultPersisted(), ...parsed };
  } catch {
    return defaultPersisted();
  }
}

interface CheckoutStateValue {
  /** Live cart resolved against the product catalog. */
  items: CartItem[];
  subtotal: number;
  zoneId: DeliveryZoneId;
  zone: DeliveryZoneOption;
  setZoneId: (id: DeliveryZoneId) => void;
  address: DeliveryAddress;
  setAddress: (address: DeliveryAddress) => void;
  promo: AppliedPromo | null;
  setPromo: (promo: AppliedPromo | null) => void;
  discount: number;
  total: number;
  updateQuantity: (productId: string, quantity: number, variantId?: string | null) => void;
  removeItem: (productId: string, variantId?: string | null) => void;
  lastOrder: OrderSnapshot | null;
  /** Captures the current cart/zone/address/promo into lastOrder. Called the
   *  instant "Pay and Order" is tapped, before the cart is touched. */
  finalizeOrder: () => OrderSnapshot;
  /** Empties the live cart and resets zone/address/promo for a fresh visit.
   *  Leaves lastOrder in place so OrderSuccessPage keeps its snapshot. */
  resetAfterOrder: () => void;
}

const CheckoutStateContext = createContext<CheckoutStateValue | null>(null);

export function CheckoutStateProvider({ children }: { children: ReactNode }) {
  const { items: rawItems, updateQuantity, removeItem, clearCart } = useCart();
  const { products, variantsFor } = useProducts();

  const [zoneId, setZoneId] = useState<DeliveryZoneId>(() => loadPersisted().zoneId);
  const [address, setAddress] = useState<DeliveryAddress>(() => loadPersisted().address);
  const [promo, setPromo] = useState<AppliedPromo | null>(() => loadPersisted().promo);
  const [lastOrder, setLastOrder] = useState<OrderSnapshot | null>(
    () => loadPersisted().lastOrder
  );

  useEffect(() => {
    try {
      const payload: PersistedState = { zoneId, address, promo, lastOrder };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Non-persistent, but the current session still works.
    }
  }, [zoneId, address, promo, lastOrder]);

  // Line items whose product no longer exists (deleted since it was added)
  // are skipped rather than crashing the checkout flow.
  const items: CartItem[] = useMemo(
    () =>
      rawItems.flatMap((item) => {
        const product = products.find((p) => p.id === item.productId);
        if (!product) return [];
        // The variant may be the product's own base option (id === productId,
        // no image of its own) or a real row that's since been deleted —
        // either way, no match just means "use the product's cover image".
        const variant =
          item.variantId !== null
            ? variantsFor(item.productId).find((v) => v.id === item.variantId)
            : undefined;
        return [
          {
            product,
            quantity: item.quantity,
            unitPrice: item.priceAtAdd,
            variantId: item.variantId,
            variantLabel: item.variantLabel,
            variantImage: variant?.image_url ?? null,
          },
        ];
      }),
    [rawItems, products, variantsFor]
  );

  const subtotal = useMemo(
    () => items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
    [items]
  );

  const zone = useMemo(
    () => DELIVERY_ZONES.find((z) => z.id === zoneId) ?? DELIVERY_ZONES[0],
    [zoneId]
  );

  const discount = promo?.computedDiscount ?? 0;
  const total = Math.max(0, subtotal + zone.fee - discount);

  const finalizeOrder = useCallback((): OrderSnapshot => {
    const snapshot: OrderSnapshot = {
      items,
      zone,
      address,
      promo,
      subtotal,
      discount,
      total,
      placedAt: new Date().toISOString(),
    };
    setLastOrder(snapshot);
    return snapshot;
  }, [items, zone, address, promo, subtotal, discount, total]);

  const resetAfterOrder = useCallback(() => {
    clearCart();
    setZoneId(DEFAULT_ZONE_ID);
    setAddress(emptyDeliveryAddress());
    setPromo(null);
  }, [clearCart]);

  const value = useMemo<CheckoutStateValue>(
    () => ({
      items,
      subtotal,
      zoneId,
      zone,
      setZoneId,
      address,
      setAddress,
      promo,
      setPromo,
      discount,
      total,
      updateQuantity,
      removeItem,
      lastOrder,
      finalizeOrder,
      resetAfterOrder,
    }),
    [
      items,
      subtotal,
      zoneId,
      zone,
      address,
      promo,
      discount,
      total,
      updateQuantity,
      removeItem,
      lastOrder,
      finalizeOrder,
      resetAfterOrder,
    ]
  );

  // Plain createElement (not JSX) so this stays a .ts file, matching the
  // hook-file naming Part 0 specifies for this module.
  return createElement(CheckoutStateContext.Provider, { value }, children);
}

export function useCheckoutState(): CheckoutStateValue {
  const ctx = useContext(CheckoutStateContext);
  if (!ctx) {
    throw new Error('useCheckoutState must be used within a CheckoutStateProvider');
  }
  return ctx;
}
