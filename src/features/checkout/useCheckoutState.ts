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
import { computePromoDiscount } from '../../lib/promoCodes';
import { smallImageFor } from '../../lib/productImages';
import { useProducts } from '../../contexts/ProductContext';
import { useLiveCampaigns } from '../../contexts/CampaignContext';
import { campaignSavings, normalPrice, promoBase as promoBaseOf, saleFor, type CampaignSavings } from '../../lib/campaigns';
import type { AppSettings } from '../../types';
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
  /** True until the product catalog has loaded at least once. Cart items
   *  resolve against `products`, which starts empty — on a COLD load
   *  straight onto /checkout/delivery or /checkout/summary (e.g. returning
   *  from the Google OAuth redirect), `items` is transiently [] before the
   *  catalog finishes loading. Pages must wait for this instead of reading
   *  items.length === 0 as "cart is empty" on their very first render. */
  isCatalogLoading: boolean;
  subtotal: number;
  /** Batch 66: the products' total a promo code / the advance discount
   *  works on (lines not in a campaign). Equals subtotal with no sale. */
  promoBase: number;
  /** Batch 66: "Summer Fest savings" and its amount, or null. */
  savings: CampaignSavings | null;
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
  /** Batch 48: the Order placed animation has played for lastOrder. */
  markCelebrated: () => void;
  /** Captures the current cart/zone/address/promo plus the real order id/
   *  number place_order() just returned into lastOrder — called the instant
   *  it succeeds, before the cart is cleared. */
  finalizeOrder: (result: {
    orderId: string;
    orderNumber: string;
    paymentMethod: OrderSnapshot['paymentMethod'];
    bkashTrxId: string | null;
    /** Batch 48: the advance discount shown at checkout, and the rule. */
    advanceDiscount: number;
    advanceRule: OrderSnapshot['advanceRule'];
    /** What the database saved (null before migration-049). */
    saved: { total: number; advanceDiscount: number; storeWallet?: number } | null;
    /** Batch 51: something in it is bought after the order. */
    buysLater: boolean;
  }) => OrderSnapshot;
  /** Empties the live cart and resets zone/address/promo for a fresh visit.
   *  Leaves lastOrder in place so OrderSuccessPage keeps its snapshot. */
  resetAfterOrder: () => void;
}

const CheckoutStateContext = createContext<CheckoutStateValue | null>(null);

export function CheckoutStateProvider({ children }: { children: ReactNode }) {
  const { items: rawItems, updateQuantity, removeItem, clearCart } = useCart();
  const { products, variantsFor, settings, isLoading: isCatalogLoading } = useProducts();
  // Batch 66: re-prices the cart when a campaign loads or ends.
  const campaigns = useLiveCampaigns();

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
        // Batch 66: the same price place_order_core() charges. A line in a
        // live campaign costs the sale price; a line added during a sale
        // that is over costs the normal price again; anything else keeps
        // the price it was added at (as before).
        const ownSize = item.variantId === null || item.variantId === item.productId;
        const prices = variant
          ? { retail: variant.retail_price, offer: variant.offer_price }
          : ownSize
            ? { retail: product.retail_price, offer: product.offer_price }
            : null;
        const sale = prices ? saleFor(product.id, ownSize ? null : item.variantId, prices.retail, prices.offer) : null;
        const unitPrice = sale
          ? sale.price
          : prices && item.saleCampaignId
            ? normalPrice(prices.retail, prices.offer)
            : item.priceAtAdd;
        return [
          {
            product,
            quantity: item.quantity,
            unitPrice,
            retail: prices ? prices.retail : null,
            sale: sale
              ? {
                  campaignId: sale.campaign.id,
                  campaignName: sale.campaign.name,
                  style: sale.campaign.style,
                  endsAt: sale.campaign.ends_at,
                  retail: sale.retail,
                }
              : null,
            variantId: item.variantId,
            variantLabel: item.variantLabel,
            // Batch 40: the option photo's small copy when it has one.
            variantImage: variant?.image_url ? smallImageFor(variant.image_url, product, [variant]) : null,
          },
        ];
      }),
    // campaigns: a sale starting / ending changes the prices above.
    [rawItems, products, variantsFor, campaigns]
  );

  const subtotal = useMemo(
    () => items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
    [items]
  );

  // app_settings (delivery_fee_inside_dhaka / _outside_dhaka) is the
  // authoritative fee — the same source place_order() reads server-side
  // (migration-021) — so a fee Naeem changes in Settings shows up here
  // immediately rather than needing a code change. DELIVERY_ZONES' own
  // numbers are only the fallback for the instant before settings load.
  const zone = useMemo(() => {
    const base = DELIVERY_ZONES.find((z) => z.id === zoneId) ?? DELIVERY_ZONES[0];
    const settingKey = `delivery_fee_${base.id}` as keyof AppSettings;
    const fromSettings = Number(settings[settingKey]);
    return Number.isFinite(fromSettings) && fromSettings >= 0
      ? { ...base, fee: fromSettings }
      : base;
  }, [zoneId, settings]);

  // Batch 33: follows the cart — when a sold-out line is removed or a
  // quantity lowered, a percent code's discount shrinks with it (the
  // database computes it the same way when the order is placed).
  // Batch 66: only on the lines not in a campaign (none left: no discount).
  const promoBase = useMemo(() => promoBaseOf(items), [items]);
  const savings = useMemo(() => campaignSavings(items), [items]);
  const discount = promo && promoBase > 0 ? computePromoDiscount(promo, promoBase) : 0;
  const total = Math.max(0, subtotal + zone.fee - discount);

  const finalizeOrder = useCallback(
    (result: {
      orderId: string;
      orderNumber: string;
      paymentMethod: OrderSnapshot['paymentMethod'];
      bkashTrxId: string | null;
      advanceDiscount: number;
      advanceRule: OrderSnapshot['advanceRule'];
      saved: { total: number; advanceDiscount: number; storeWallet?: number } | null;
      buysLater: boolean;
    }): OrderSnapshot => {
      // The saved amounts win: the database works the discount out itself.
      const advanceDiscount = result.saved ? result.saved.advanceDiscount : result.advanceDiscount;
      const snapshot: OrderSnapshot = {
        orderId: result.orderId,
        orderNumber: result.orderNumber,
        items,
        zone,
        address,
        promo,
        subtotal,
        discount,
        total: result.saved ? result.saved.total : Math.max(0, total - advanceDiscount),
        paymentMethod: result.paymentMethod,
        bkashTrxId: result.bkashTrxId,
        placedAt: new Date().toISOString(),
        advanceDiscount,
        advanceRule: advanceDiscount > 0 ? result.advanceRule : null,
        buysLater: result.buysLater,
        storeWallet: result.saved?.storeWallet ?? 0,
        celebrated: false,
      };
      setLastOrder(snapshot);
      return snapshot;
    },
    [items, zone, address, promo, subtotal, discount, total]
  );

  const markCelebrated = useCallback(() => {
    setLastOrder((order) => (order && !order.celebrated ? { ...order, celebrated: true } : order));
  }, []);

  const resetAfterOrder = useCallback(() => {
    clearCart();
    setZoneId(DEFAULT_ZONE_ID);
    setAddress(emptyDeliveryAddress());
    setPromo(null);
  }, [clearCart]);

  const value = useMemo<CheckoutStateValue>(
    () => ({
      items,
      isCatalogLoading,
      subtotal,
      promoBase,
      savings,
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
      markCelebrated,
      finalizeOrder,
      resetAfterOrder,
    }),
    [
      items,
      isCatalogLoading,
      subtotal,
      promoBase,
      savings,
      zoneId,
      zone,
      address,
      promo,
      discount,
      total,
      updateQuantity,
      removeItem,
      lastOrder,
      markCelebrated,
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
