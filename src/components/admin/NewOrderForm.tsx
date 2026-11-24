// "New order" — Admin -> Orders (Batch 22). Most of Naeem's real
// orders arrive over Facebook/WhatsApp, not the website, so he types them in
// here himself: pick where it came from, find or type the customer, add
// items (with an optional cut price or "Free" and a reason), set delivery and
// payment, and save. Saved through admin_create_order() (migration-028) —
// every price/stock check happens in the database, never trusted from this
// form; this component only shapes the input and shows a live preview.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { MoneyInput } from '../shared/MoneyInput';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { productSearchGroups, searchProductGroups, type SellableOption, type SellableProduct } from '../../lib/manualOrderSearch';
import { BottleIcon, ProductResults } from './ManualOptionPicker';
import { Toggle } from './edit-sheets/SheetChrome';
import { type AddressFieldErrors } from '../checkout/AddressFormFields';
import { CustomerDetailsFields } from './CustomerDetailsFields';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { formatTaka } from '../../lib/format';
import { zoneForAddress } from '../../lib/deliveryZones';
import { adminCreateOrder, findCustomerMatches, type ManualOrderItemInput } from '../../lib/orders';
import { fetchPackUnits, packKey, type PackUnit } from '../../lib/inventory/api';
import { PackStockLine, useStockUnitsMap } from './PackStockLine';
import type { StockUnitWord } from '../../lib/inventory/types';
import { useAuth } from '../../contexts/AuthContext';
import { belowCostText, type BelowCostInput } from '../../lib/smart/belowCost';
import { useBelowCost } from '../../lib/smart/useBelowCost';
import '../../styles/adminSmart.css';
import {
  MANUAL_ORDER_SOURCES,
  DISCOUNT_REASONS,
  computeManualOrderTotals,
  isHandOverSource,
  lineNeedsReason,
  type StockWarning,
} from '../../lib/manualOrders';
import { findCustomers, linkOrderCustomer, type CustomerSearchResult } from '../../lib/customers';
import { looksLikePhone } from '../../lib/phone';
import { FraudCheckCard } from './FraudCheckCard';
import { SmartPasteCard, placeFor, type SmartPastePatch } from './SmartPasteCard';
import { useListKeyboard } from './useListKeyboard';
import { useLeaveGuard } from './LeaveGuard';
import {
  clearDraft,
  draftTimeLabel,
  droppedItemsText,
  loadDraft,
  restorableLines,
  saveDraft,
  type DraftLine,
  type NewOrderDraft,
  type NewOrderDraftData,
} from '../../lib/newOrderDraft';
import type { ParsedOrderMessage, ThanaOption } from '../../lib/smartPaste';
import { bdPhoneKey } from '../../lib/phone';
import { isTestCustomer, isTestViewer } from '../../lib/testData';
import type { DeliveryAddress } from '../../features/checkout/types';
import { PaymentSection, PaymentSummaryRows } from './PaymentSection';
import { customerInitials, itemsWord } from '../../lib/newOrderLook';
import { legacyPaymentMethod, planPayment, type CollectMode } from '../../lib/paymentPlan';
import { isCollectModeReady } from '../../lib/orders';
import type { PaymentMethodId } from '../../lib/payments';
import { applyStoreWalletToOrder, fetchCustomerStoreWalletBalance } from '../../lib/storeWallet';
import type { DiscountReason, OrderSource } from '../../types';

interface NewOrderFormProps {
  /** The page's Create order button submits this form by id. */
  formId: string;
  /** Tells the page whether its Create order button can be pressed (and,
   *  Batch 63, the item count and total for the phone's bottom bar). */
  onState: (state: NewOrderFormState) => void;
  /** Called with the new order's id once saved — the page opens its detail
   *  immediately so Naeem lands right on the invoice/Steadfast button. */
  onCreated: (orderId: string) => void | Promise<void>;
}

export interface NewOrderFormState {
  canSave: boolean;
  isSaving: boolean;
  itemCount: number;
  total: number;
}

type DeliveryZoneChoice = 'inside_dhaka' | 'outside_dhaka' | 'hand_delivered';

interface OrderLine {
  key: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantLabel: string | null;
  imageUrl: string | null;
  /** Batch 63: the small photo on the line (the full one only when the
   *  product has no small copy yet, as before). */
  thumbUrl: string | null;
  listPrice: number;
  soldPrice: number;
  soldPriceInput: string;
  quantity: number;
  reason: DiscountReason | null;
  reasonNote: string;
  stockQuantity: number | null;
  /** Batch 39: units in one pack, and the pack's own list price. */
  packSize: number;
  stockUnit: StockUnitWord;
  packListPrice: number;
  /** Sold in loose units (quantity = units, prices per unit), or null = packs. */
  soldUnit: StockUnitWord | null;
}


function emptyForm(): DeliveryAddress {
  return { fullName: '', phone: '', division: '', district: '', thana: '', fullAddress: '' };
}

const emptyErrors: AddressFieldErrors = {};

/**
 * Batch 63: a floating result list closes on Escape or a tap outside its
 * search box and list; typing in the box or tapping into it opens it again.
 */
function useFloatingList(ref: RefObject<HTMLElement | null>): {
  open: boolean;
  show: () => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
} {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && ref.current && !ref.current.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, ref]);
  return {
    open,
    show: () => setOpen(true),
    onKeyDown: (event) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        setOpen(false);
      }
    },
  };
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/**
 * Batch 32 Part 3: the form of the New order page (/admin/orders/new) —
 * the Batch 22 sheet's form, unchanged inside; the page around it has the
 * Back button and the Create order button.
 */
export function NewOrderForm({ formId, onState, onCreated }: NewOrderFormProps) {
  // Batch 24: custom prices, "Free" and order discounts are money changes —
  // Super Admin only. A moderator's manual order is always at the real
  // price (admin_create_order() refuses anything else from them).
  const { isAdmin, staff, can, session } = useAuth();
  const { markDirty, setOnDiscard } = useLeaveGuard();
  const canSeeCost = can('view_profit_costs');
  const hideTestCustomers = !isTestViewer(staff);
  const { products, adminVariantsFor, settings } = useProducts();
  const { showToast } = useToast();

  const [source, setSource] = useState<OrderSource | null>(null);
  const [address, setAddress] = useState<DeliveryAddress>(emptyForm);
  // Batch 30 Part 4: the Customer field. Picking a registered customer
  // links the order to them in admin only (admin_link_order_customer) —
  // never through customer_id, so it never shows in their own My Orders.
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState<CustomerSearchResult[]>([]);
  const [customerSearchReady, setCustomerSearchReady] = useState(true);
  const [pickedCustomer, setPickedCustomer] = useState<CustomerSearchResult | 'new' | null>(null);
  const [matches, setMatches] = useState<{
    fromProfile: Awaited<ReturnType<typeof findCustomerMatches>>['fromProfile'];
    fromOrder: Awaited<ReturnType<typeof findCustomerMatches>>['fromOrder'];
  } | null>(null);
  const [lookedUpPhone, setLookedUpPhone] = useState('');

  // Batch 32 Part 4: the same customer form as Add customer.
  const [altPhone, setAltPhone] = useState('');
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<OrderLine[]>([]);
  // Batch 43 Part 3: "Below cost" under a line whose price is under the
  // landed cost of the lot that sells next. It never blocks saving.
  const belowInputs = useMemo<BelowCostInput[]>(
    () =>
      lines.map((l) => ({
        key: l.key,
        product_id: l.productId,
        variant_id: l.variantId,
        sold_unit: l.soldUnit,
        price: l.soldPrice,
        quantity: l.quantity,
      })),
    [lines]
  );
  const belowCost = useBelowCost(belowInputs, true);

  const [zone, setZone] = useState<DeliveryZoneChoice>('inside_dhaka');
  const [feeInput, setFeeInput] = useState(() => settings.delivery_fee_inside_dhaka || '70');
  const [zoneTouched, setZoneTouched] = useState(false);

  const [orderDiscountInput, setOrderDiscountInput] = useState('0');
  const [discountReason, setDiscountReason] = useState<DiscountReason | null>(null);
  const [discountNote, setDiscountNote] = useState('');

  // Batch 32 Part 1: Paid now, then what happens to the rest.
  const [paidNowInput, setPaidNowInput] = useState('');
  const [paidMethod, setPaidMethod] = useState<PaymentMethodId | null>(null);
  const [paidTrxId, setPaidTrxId] = useState('');
  const [collectMode, setCollectMode] = useState<CollectMode>('cod');
  const [payLaterReady, setPayLaterReady] = useState(true);
  const [markDelivered, setMarkDelivered] = useState(false);
  const [adminNote, setAdminNote] = useState('');

  // Batch 36 Part 3: Smart paste — what it filled, which fields were
  // guesses (orange outline), the form before it (Undo fill) and a saved
  // customer with the same phone.
  const [smart, setSmart] = useState<ParsedOrderMessage | null>(null);
  const [guesses, setGuesses] = useState<{ name: boolean; address: boolean; thana: boolean }>({ name: false, address: false, thana: false });
  const [beforeFill, setBeforeFill] = useState<{
    address: DeliveryAddress;
    altPhone: string;
    pickedCustomer: CustomerSearchResult | 'new' | null;
    customerQuery: string;
  } | null>(null);
  const [savedMatch, setSavedMatch] = useState<CustomerSearchResult | null>(null);

  const [isSaving, setIsSaving] = useState(false);
  const [pendingWarnings, setPendingWarnings] = useState<StockWarning[] | null>(null);

  // Batch 39: stock unit and pack size (staff only). A product with a pack
  // size above 1 can be sold in whole packs or in loose units.
  const [packs, setPacks] = useState<Map<string, PackUnit>>(new Map());
  useEffect(() => {
    let alive = true;
    void fetchPackUnits().then((map) => {
      if (alive) setPacks(map);
    });
    return () => {
      alive = false;
    };
  }, []);
  const inventoryOn = settings.inventory_mode === 'true';
  // Batch 62: units in lots for the "Stock: 1 bottle (473 ml)" line.
  const stockUnits = useStockUnitsMap();

  // A fresh form every time the page opens — a manual order is a one-shot
  // entry, not a draft worth remembering between sessions.
  useEffect(() => {
    // Is the Batch 30 customer search there yet? (Before migration-033 the
    // old phone lookup below takes over.)
    void findCustomers('').then((rows) => setCustomerSearchReady(rows !== null));
    void isCollectModeReady().then(setPayLaterReady);
  }, []);

  // The delivery fee follows the shop setting (it may arrive after the page
  // opens) until a zone is picked by hand.
  useEffect(() => {
    if (zoneTouched) return;
    setFeeInput(
      (zone === 'inside_dhaka' ? settings.delivery_fee_inside_dhaka : settings.delivery_fee_outside_dhaka) || '70'
    );
    // zone is read, not watched: picking a zone sets the fee itself.
  }, [settings.delivery_fee_inside_dhaka, settings.delivery_fee_outside_dhaka, zoneTouched]);

  // Customer search: phone (any prefix or spacing) or name.
  useEffect(() => {
    const term = customerQuery.trim();
    if (pickedCustomer !== null || term.length < 2) {
      setCustomerResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void findCustomers(term).then((rows) => {
        if (cancelled) return;
        setCustomerSearchReady(rows !== null);
        setCustomerResults(rows ?? []);
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [customerQuery, pickedCustomer]);

  // Phone lookup (before migration-033 only) — offers to fill in details
  // from a past order or an existing account, never applies anything
  // automatically. See findCustomerMatches's own header comment.
  useEffect(() => {
    const digits = address.phone.replace(/\D/g, '');
    if (customerSearchReady || digits.length < 10 || address.phone === lookedUpPhone) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void findCustomerMatches(address.phone).then((result) => {
        if (cancelled) return;
        setLookedUpPhone(address.phone);
        const hasMatch = result.fromProfile || result.fromOrder;
        setMatches(hasMatch ? result : null);
      });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [address.phone, lookedUpPhone, customerSearchReady]);

  // Batch 45 Part 4: each product once in the search. A product with
  // options opens a picker (its own size first, then each option with its
  // own price and stock).
  const sellableProducts = useMemo<SellableProduct[]>(() => productSearchGroups(products, adminVariantsFor), [products, adminVariantsFor]);
  const searchResults = useMemo(() => searchProductGroups(sellableProducts, query), [query, sellableProducts]);

  const addLine = (option: SellableOption, quantity = 1) => {
    setLines((current) => {
      const existing = current.find((l) => l.key === option.key);
      if (existing) {
        return current.map((l) => (l.key === option.key ? { ...l, quantity: l.quantity + quantity } : l));
      }
      const pack = packs.get(packKey(option.productId, option.variantId));
      return [
        ...current,
        {
          key: option.key,
          productId: option.productId,
          variantId: option.variantId,
          productName: option.productName,
          variantLabel: option.variantLabel,
          imageUrl: option.imageUrl,
          thumbUrl: option.thumbUrl ?? option.imageUrl,
          listPrice: option.listPrice,
          soldPrice: option.listPrice,
          soldPriceInput: String(option.listPrice),
          quantity,
          reason: null,
          reasonNote: '',
          stockQuantity: option.stockQuantity,
          packSize: pack?.pack_size ?? 1,
          stockUnit: pack?.stock_unit ?? 'pcs',
          packListPrice: option.listPrice,
          soldUnit: null,
        },
      ];
    });
    setQuery('');
  };

  /** Batch 39: switch a line between whole packs and loose units. The list
   *  price follows (one unit = pack price ÷ pack size); the line starts
   *  again at that price and quantity 1. */
  const setLineSoldUnit = (key: string, unit: StockUnitWord | null) => {
    setLines((current) =>
      current.map((l) => {
        if (l.key !== key) return l;
        const listPrice = unit ? Math.round((l.packListPrice / l.packSize) * 100) / 100 : l.packListPrice;
        return { ...l, soldUnit: unit, listPrice, soldPrice: listPrice, soldPriceInput: String(listPrice), quantity: 1, reason: null };
      })
    );
  };

  const updateLine = (key: string, patch: Partial<OrderLine>) => {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const setLineQuantity = (key: string, quantity: number) => {
    updateLine(key, { quantity: Math.max(1, quantity) });
  };

  const setLineSoldPrice = (key: string, raw: string) => {
    const value = Number(raw);
    updateLine(key, {
      soldPriceInput: raw,
      soldPrice: Number.isFinite(value) && value >= 0 ? value : 0,
    });
  };

  const setLineFree = (key: string) => {
    updateLine(key, { soldPrice: 0, soldPriceInput: '0' });
  };

  const removeLine = (key: string) => {
    setLines((current) => current.filter((l) => l.key !== key));
  };

  const handleLocationChange = (district: string, thana: string) => {
    if (zoneTouched) return; // admin already picked a zone by hand — don't fight them
    const nextZone = zoneForAddress(district || null, thana || null);
    setZone(nextZone);
    setFeeInput(
      nextZone === 'inside_dhaka' ? settings.delivery_fee_inside_dhaka : settings.delivery_fee_outside_dhaka
    );
  };

  // Batch 47: Shop/in person is handed over by hand — no courier, so the
  // delivery becomes "No delivery (hand delivered)" at ৳0 (he can still
  // type another amount). Picking another source afterwards puts back the
  // zone the address gives, unless he had picked a zone himself.
  const [zoneFromSource, setZoneFromSource] = useState(false);
  const handlePickSource = (next: OrderSource) => {
    setSource(next);
    if (isHandOverSource(next)) {
      if (zone !== 'hand_delivered') {
        handlePickZone('hand_delivered');
        setZoneFromSource(true);
      }
      return;
    }
    if (zoneFromSource && zone === 'hand_delivered') {
      setZoneFromSource(false);
      setZoneTouched(false);
      const back = zoneForAddress(address.district || null, address.thana || null);
      setZone(back);
      setFeeInput(back === 'inside_dhaka' ? settings.delivery_fee_inside_dhaka : settings.delivery_fee_outside_dhaka);
    }
  };

  const handlePickZone = (next: DeliveryZoneChoice) => {
    setZoneTouched(true);
    setZoneFromSource(false);
    setZone(next);
    if (next === 'hand_delivered') {
      setFeeInput('0');
    } else {
      setFeeInput(next === 'inside_dhaka' ? settings.delivery_fee_inside_dhaka : settings.delivery_fee_outside_dhaka);
    }
  };

  const handleUseSuggestion = (matchKind: 'profile' | 'order') => {
    const match = matchKind === 'profile' ? matches?.fromProfile : matches?.fromOrder;
    if (!match) return;
    setAddress((current) => ({
      ...current,
      fullName: match.fullName || current.fullName,
      division: match.division || current.division,
      district: match.district || current.district,
      thana: match.thana || current.thana,
      fullAddress: match.addressLine || current.fullAddress,
    }));
    if (match.division || match.district) {
      handleLocationChange(match.district, match.thana);
    }
  };

  const handlePickCustomer = (customer: CustomerSearchResult) => {
    setPickedCustomer(customer);
    setAddress({
      fullName: customer.fullName,
      phone: customer.phone,
      division: customer.division,
      district: customer.district,
      thana: customer.thana,
      fullAddress: customer.addressLine,
    });
    setAltPhone(customer.altPhone ?? '');
    if (customer.district) handleLocationChange(customer.district, customer.thana);
  };

  const handleSmartStart = () => {
    setBeforeFill({ address, altPhone, pickedCustomer, customerQuery });
    setSmart(null);
    setSavedMatch(null);
    setGuesses({ name: false, address: false, thana: false });
    setPickedCustomer('new');
  };

  const handleSmartPatch = (patch: SmartPastePatch) => {
    const { altPhone: alt, ...fields } = patch;
    setAddress((current) => ({ ...current, ...fields }));
    if (alt !== undefined) setAltPhone(alt);
  };

  const handleSmartFilled = (parsed: ParsedOrderMessage) => {
    setSmart(parsed);
    setGuesses({ name: parsed.name !== null, address: parsed.address !== '', thana: parsed.thana !== null });
    if (parsed.thana) {
      const place = placeFor(parsed.thana);
      handleLocationChange(place.district, place.thana);
    } else if (parsed.district) {
      handleLocationChange(parsed.district, '');
    }
    // A saved customer with this phone? Offer their details (never applied
    // by itself).
    const key = parsed.phone ? bdPhoneKey(parsed.phone) : null;
    if (key) {
      void findCustomers(parsed.phone ?? '').then((rows) => {
        const match = (rows ?? []).find((c) => bdPhoneKey(c.phone) === key) ?? null;
        setSavedMatch(match);
      });
    }
  };

  const handleSmartUndo = () => {
    if (beforeFill) {
      setAddress(beforeFill.address);
      setAltPhone(beforeFill.altPhone);
      setPickedCustomer(beforeFill.pickedCustomer);
      setCustomerQuery(beforeFill.customerQuery);
    }
    setBeforeFill(null);
    setSmart(null);
    setSavedMatch(null);
    setGuesses({ name: false, address: false, thana: false });
  };

  const handleUseSaved = () => {
    if (!savedMatch) return;
    handlePickCustomer(savedMatch);
    setGuesses({ name: false, address: false, thana: false });
    setSavedMatch(null);
  };

  const handlePickThanaChip = (option: ThanaOption) => {
    const place = placeFor(option);
    setAddress((current) => ({ ...current, ...place }));
    handleLocationChange(place.district, place.thana);
    setGuesses((g) => ({ ...g, thana: false }));
  };

  /** Typing in a guessed field (or picking a thana) confirms it. */
  const handleAddressEdit = (patch: Partial<DeliveryAddress>) => {
    setAddress((c) => ({ ...c, ...patch }));
    setGuesses((g) => ({
      name: g.name && patch.fullName === undefined,
      address: g.address && patch.fullAddress === undefined,
      thana: g.thana && patch.thana === undefined && patch.district === undefined && patch.division === undefined,
    }));
  };

  const handleNewCustomer = () => {
    const typed = customerQuery.trim();
    setPickedCustomer('new');
    setAddress({ ...emptyForm(), ...(looksLikePhone(typed) ? { phone: typed } : { fullName: typed }) });
  };

  const handleChangeCustomer = () => {
    setPickedCustomer(null);
    setCustomerResults([]);
  };

  const deliveryFee = Math.max(0, Number(feeInput) || 0);
  const orderDiscount = Math.max(0, Number(orderDiscountInput) || 0);

  const totals = useMemo(
    () =>
      computeManualOrderTotals(
        lines.map((l) => ({ listPrice: l.listPrice, soldPrice: l.soldPrice, quantity: l.quantity })),
        orderDiscount,
        deliveryFee
      ),
    [lines, orderDiscount, deliveryFee]
  );

  const plan = planPayment({ total: totals.total, paidNowInput, mode: collectMode, formatMoney: formatTaka });
  const methodMissing = plan.paidNow > 0 && paidMethod === null;
  // "Mark as delivered right away" only for a hand-delivered order paid in full.
  const isPaidNow = totals.total > 0 && plan.paidNow >= totals.total;

  // Batch 60: the customer's wallet (by their login, else their phone).
  // "Use wallet balance" takes it right after the order is saved, up to
  // what is still owed after the money paid now.
  const walletProfileId = pickedCustomer && pickedCustomer !== 'new' ? pickedCustomer.profileId : null;
  const walletPhone = address.phone.trim();
  const [storeBalance, setStoreBalance] = useState(0);
  const [useStore, setUseStore] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!walletProfileId && !looksLikePhone(walletPhone)) {
      setStoreBalance(0);
      return;
    }
    const timer = window.setTimeout(() => {
      void fetchCustomerStoreWalletBalance(walletProfileId, walletPhone).then((balance) => {
        if (alive) setStoreBalance(balance);
      });
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [walletProfileId, walletPhone]);
  const fromStore = useStore ? Math.max(0, Math.min(storeBalance, Math.round((totals.total - plan.paidNow) * 100) / 100)) : 0;

  const canSave =
    plan.error === null &&
    !methodMissing &&
    source !== null &&
    lines.length > 0 &&
    address.fullName.trim() !== '' &&
    address.fullAddress.trim() !== '' &&
    !isSaving;

  const buildInput = (allowNegativeStock: boolean) => ({
    source: source as OrderSource,
    items: lines.map<ManualOrderItemInput>((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      quantity: l.quantity,
      soldPrice: l.soldPrice === l.listPrice ? null : l.soldPrice,
      soldUnit: l.soldUnit,
      reason: l.reason,
      reasonNote: l.reasonNote.trim() || null,
    })),
    fullName: address.fullName.trim(),
    phone: address.phone.trim(),
    division: address.division,
    district: address.district,
    thana: address.thana,
    addressLine: address.fullAddress.trim(),
    deliveryZone: zone,
    deliveryFee,
    orderDiscount,
    discountReason: orderDiscount > 0 ? discountReason ?? 'other' : null,
    discountNote: discountNote.trim() || null,
    paymentMethod: legacyPaymentMethod({ total: totals.total, paidNow: plan.paidNow, method: paidMethod, mode: collectMode }),
    paidNow: plan.paidNow,
    paidMethod,
    paidTrxId: paidTrxId.trim() || null,
    collectMode: plan.remaining > 0 ? collectMode : 'cod',
    altPhone: altPhone.trim() || null,
    // Batch 47: a picked customer with an account owns the order, so it
    // shows in her My Orders (Batch 30 linked it in the admin only).
    linkedCustomerId: pickedCustomer && pickedCustomer !== 'new' ? pickedCustomer.profileId : null,
    markDelivered: zone === 'hand_delivered' && isPaidNow && markDelivered,
    adminNote: adminNote.trim() || null,
    allowNegativeStock,
  });

  const handleSave = async (allowNegativeStock: boolean) => {
    if (!canSave && !allowNegativeStock) return;
    setIsSaving(true);
    const result = await adminCreateOrder(buildInput(allowNegativeStock));
    setIsSaving(false);

    if (result.stockWarnings) {
      // Batch 33: someone may have bought the last units since a line was
      // added — the line itself now says how many are really left (it stays
      // after "Go back"), next to the "continue anyway?" question.
      const warnings = result.stockWarnings;
      setLines((prev) =>
        prev.map((line) => {
          const sameName = warnings.filter((w) => w.product_name === line.productName);
          const match =
            sameName.find((w) => (w.variant_label ?? null) === (line.variantLabel ?? null)) ??
            (sameName.length === 1 ? sameName[0] : undefined);
          return match ? { ...line, stockQuantity: match.available } : line;
        })
      );
      setPendingWarnings(warnings);
      return;
    }
    if (result.error || !result.orderId) {
      showToast(result.error ?? 'Could not save this order.', 'error');
      return;
    }
    if (pickedCustomer && pickedCustomer !== 'new' && pickedCustomer.profileId) {
      const link = await linkOrderCustomer(result.orderId, pickedCustomer.profileId);
      if (link.error) showToast(`Saved, but not linked to the customer: ${link.error}`, 'error');
    }
    if (fromStore > 0) {
      const used = await applyStoreWalletToOrder(result.orderId, fromStore);
      if (!used.ok) showToast(`Saved, but the wallet was not used: ${used.error ?? 'try again from Edit order'}`, 'error');
    }
    showToast(`Order ${result.orderNumber} saved`, 'success');
    // Batch 64: saved, so the draft on this device goes.
    if (draftUser) {
      draftDone.current = true;
      window.clearTimeout(draftTimer.current);
      clearDraft(draftUser);
    }
    await onCreated(result.orderId);
  };

  useEffect(() => {
    onState({ canSave, isSaving, itemCount: lines.length, total: totals.total });
  }, [canSave, isSaving, lines.length, totals.total, onState]);

  const customerBox = useRef<HTMLDivElement>(null);
  const productBox = useRef<HTMLDivElement>(null);
  const customerList = useFloatingList(customerBox);
  const productList = useFloatingList(productBox);

  const warningMessage = pendingWarnings
    ? pendingWarnings
        .map((w) => {
          const unit = w.unit ? ` ${w.unit}` : '';
          return `${w.product_name}${w.variant_label ? ` (${w.variant_label})` : ''}: only ${w.available}${unit} left, ${w.requested}${unit} requested`;
        })
        .join('. ')
    : '';
  // Batch 39: while Inventory mode is On the database counts units in lots;
  // selling anyway records the missing units as "Sold without stock".
  const warningInUnits = pendingWarnings?.some((w) => w.unit) ?? false;

  const thanaChips =
    smart && smart.thanaChoices.length > 0 ? (
      <div className="smart-thana" data-testid="smart-thana">
        {smart.thanaMatchedText && <p className="smart-thana__matched">matched “{smart.thanaMatchedText}”</p>}
        <div className="smart-thana__chips" role="group" aria-label="Thana suggestions">
          {smart.thanaChoices.map((option) => {
            const on = address.thana === option.name && address.district === placeFor(option).district;
            return (
              <button
                key={`${option.name}|${option.district}`}
                type="button"
                className={`smart-thana__chip${on ? ' is-on' : ''}`}
                aria-pressed={on}
                onClick={() => handlePickThanaChip(option)}
              >
                {option.name}
                {smart.thanaChoices.some((o) => o !== option && o.name === option.name) ? `, ${option.district}` : ''}
              </button>
            );
          })}
        </div>
      </div>
    ) : null;

  const customerFieldProps = {
    idPrefix: 'manual-order',
    address,
    errors: emptyErrors,
    onAddressChange: handleAddressEdit,
    onLocationChange: handleLocationChange,
    altPhone,
    onAltPhoneChange: setAltPhone,
  };

  const shownCustomers = customerResults.filter((c) => !hideTestCustomers || !isTestCustomer({ name: c.fullName }));
  // Batch 64: arrow keys and Enter in both result lists. The customer list
  // is its rows plus "New customer" at the end.
  const customerKeys = useListKeyboard(
    shownCustomers.length + 1,
    customerList.open && customerQuery.trim().length >= 2,
    (index) => (index < shownCustomers.length ? handlePickCustomer(shownCustomers[index]) : handleNewCustomer())
  );
  const productKeys = useListKeyboard(searchResults.length, productList.open);

  // Batch 64 Part 6b: the form is kept on this device while he types (at
  // most once a second, and when the page is hidden), one draft per staff
  // login. A draft found on opening is offered, never filled silently;
  // nothing is saved while that offer is open.
  const draftUser = session?.user.id ?? null;
  const [draftOffer, setDraftOffer] = useState<NewOrderDraft | null>(() => (draftUser ? loadDraft(draftUser) : null));
  const draftDone = useRef(false);
  const draftJson = JSON.stringify({
    source,
    address,
    altPhone,
    pickedCustomer,
    customerQuery,
    lines: lines.map(
      (l): DraftLine => ({
        productId: l.productId,
        variantId: l.variantId,
        quantity: l.quantity,
        soldUnit: l.soldUnit,
        soldPriceInput: l.soldPriceInput,
        reason: l.reason,
        reasonNote: l.reasonNote,
      })
    ),
    zone,
    zoneTouched,
    zoneFromSource,
    feeInput,
    orderDiscountInput,
    discountReason,
    discountNote,
    paidNowInput,
    paidMethod,
    paidTrxId,
    collectMode,
    markDelivered,
    adminNote,
  } satisfies NewOrderDraftData);
  const latestDraft = useRef(draftJson);
  latestDraft.current = draftJson;
  const draftTimer = useRef<number>();
  const draftPaused = draftOffer !== null;
  useEffect(() => {
    if (!draftUser || draftPaused || draftDone.current) return;
    const flush = () => {
      window.clearTimeout(draftTimer.current);
      draftTimer.current = undefined;
      if (!draftDone.current) saveDraft(draftUser, JSON.parse(latestDraft.current) as NewOrderDraftData);
    };
    if (draftTimer.current === undefined) draftTimer.current = window.setTimeout(flush, 1000);
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [draftJson, draftUser, draftPaused]);
  useEffect(() => () => window.clearTimeout(draftTimer.current), []);
  useEffect(() => {
    if (!draftUser) return;
    setOnDiscard(() => {
      draftDone.current = true;
      clearDraft(draftUser);
    });
    return () => setOnDiscard(null);
  }, [draftUser, setOnDiscard]);

  const handleRestoreDraft = () => {
    if (!draftOffer) return;
    const d = draftOffer.data;
    const options = sellableProducts.flatMap((g) => g.options);
    const { kept, dropped } = restorableLines(
      d.lines,
      (dl) => options.find((o) => o.productId === dl.productId && o.variantId === dl.variantId) ?? null
    );
    setLines(
      kept.map(({ line: dl, option }) => {
        const pack = packs.get(packKey(option.productId, option.variantId));
        const packSize = pack?.pack_size ?? 1;
        const soldUnit = packSize > 1 ? dl.soldUnit : null;
        // His typed price is kept; the list price is today's.
        const listPrice = soldUnit ? Math.round((option.listPrice / packSize) * 100) / 100 : option.listPrice;
        const typed = Number(dl.soldPriceInput);
        return {
          key: option.key,
          productId: option.productId,
          variantId: option.variantId,
          productName: option.productName,
          variantLabel: option.variantLabel,
          imageUrl: option.imageUrl,
          thumbUrl: option.thumbUrl ?? option.imageUrl,
          listPrice,
          soldPrice: Number.isFinite(typed) && typed >= 0 ? typed : listPrice,
          soldPriceInput: dl.soldPriceInput,
          quantity: Math.max(1, Math.floor(dl.quantity) || 1),
          reason: dl.reason,
          reasonNote: dl.reasonNote,
          stockQuantity: option.stockQuantity,
          packSize,
          stockUnit: pack?.stock_unit ?? 'pcs',
          packListPrice: option.listPrice,
          soldUnit,
        };
      })
    );
    setSource(d.source);
    setAddress(d.address);
    setAltPhone(d.altPhone);
    setPickedCustomer(d.pickedCustomer);
    setCustomerQuery(d.customerQuery);
    setZone(d.zone);
    setZoneTouched(d.zoneTouched);
    setZoneFromSource(d.zoneFromSource);
    setFeeInput(d.feeInput);
    setOrderDiscountInput(d.orderDiscountInput);
    setDiscountReason(d.discountReason);
    setDiscountNote(d.discountNote);
    setPaidNowInput(d.paidNowInput);
    setPaidMethod(d.paidMethod);
    setPaidTrxId(d.paidTrxId);
    setCollectMode(d.collectMode);
    setMarkDelivered(d.markDelivered);
    setAdminNote(d.adminNote);
    setDraftOffer(null);
    markDirty();
    if (dropped > 0) showToast(droppedItemsText(dropped), 'error');
  };

  const handleDiscardDraft = () => {
    if (draftUser) clearDraft(draftUser);
    setDraftOffer(null);
  };

  return (
    <>
      <form
        id={formId}
        className="form manual-order-form"
        data-testid="new-order-form"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave(false);
        }}
      >
        {draftOffer && products.length > 0 && (
          <div className="nord-draft" role="status" data-testid="new-order-draft-bar">
            <p className="nord-draft__text">You have an unsaved order from {draftTimeLabel(draftOffer.savedAt)}.</p>
            <div className="nord-draft__actions">
              <button type="button" className="adm-btn adm-btn--ghost nord-draft__restore" onClick={handleRestoreDraft} data-own-save>
                Restore
              </button>
              <button type="button" className="nord-draft__discard" onClick={handleDiscardDraft} data-own-save>
                Discard
              </button>
            </div>
          </div>
        )}
        <div className="nord-grid">
          <div
            className="nord-col smart-guess"
            data-guess-name={guesses.name ? '' : undefined}
            data-guess-address={guesses.address ? '' : undefined}
            data-guess-thana={guesses.thana ? '' : undefined}
          >
            <section className="nord-card" data-testid="nord-card-customer">
              <div className="nord-card__head">
                <span className="nord-step" aria-hidden="true">1</span>
                <h2 className="nord-card__title" id="nord-card-customer">Customer</h2>
              </div>

              <SmartPasteCard
                startCollapsed
                onStart={handleSmartStart}
                onPatch={handleSmartPatch}
                onFilled={handleSmartFilled}
                onUndo={handleSmartUndo}
                savedCustomer={
                  savedMatch
                    ? { name: savedMatch.fullName || savedMatch.phone, place: [savedMatch.thana, savedMatch.district].filter(Boolean).join(', ') }
                    : null
                }
                onUseSaved={handleUseSaved}
              />
              {smart && (smart.codHint || smart.productHint) && (
                <p className="smart-paste__hints" data-testid="smart-paste-hints">
                  In the message (not added):{' '}
                  {[smart.codHint ? `COD ${smart.codHint}` : null, smart.productHint ? `Product: ${smart.productHint}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}

              <div className="form-field customer-pick">
                <label className="form-label visually-hidden" htmlFor="manual-order-customer">
                  Customer
                </label>
                {pickedCustomer ? (
                  <div className="nord-picked" data-testid="customer-picked">
                    {pickedCustomer === 'new' ? (
                      <span className="nord-av nord-av--new">
                        <PlusIcon />
                      </span>
                    ) : (
                      <span className="nord-av" aria-hidden="true">
                        {customerInitials(pickedCustomer.fullName, pickedCustomer.phone)}
                      </span>
                    )}
                    <span className="nord-picked__main">
                      <strong>{pickedCustomer === 'new' ? 'New customer' : pickedCustomer.fullName || pickedCustomer.phone}</strong>
                      <span className="nord-picked__sub">
                        {pickedCustomer === 'new'
                          ? 'Fill in the details below'
                          : `${pickedCustomer.phone}${pickedCustomer.orderCount > 0 ? ` · ${pickedCustomer.orderCount} order${pickedCustomer.orderCount === 1 ? '' : 's'}` : ''}${pickedCustomer.totalDue ? ` · ${formatTaka(pickedCustomer.totalDue)} due` : ''}`}
                      </span>
                    </span>
                    <button type="button" className="account-card__edit" onClick={handleChangeCustomer}>
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="nord-search" ref={customerBox} onKeyDown={customerList.onKeyDown}>
                    <div className="search-bar">
                      <svg className="search-bar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="11" cy="11" r="8" />
                        <path d="M21 21l-4.35-4.35" />
                      </svg>
                      <input
                        id="manual-order-customer"
                        type="search"
                        className="search-bar__input"
                        placeholder="Type a phone number or name"
                        value={customerQuery}
                        onChange={(e) => {
                          setCustomerQuery(e.target.value);
                          customerList.show();
                          customerKeys.reset();
                        }}
                        onFocus={customerList.show}
                        onClick={customerList.show}
                        autoComplete="off"
                        {...customerKeys.inputProps}
                      />
                    </div>
                    {customerList.open && customerQuery.trim().length >= 2 && (
                      <ul className="nord-drop" data-testid="customer-results" id={customerKeys.listId} role="listbox" aria-label="Customers">
                        {shownCustomers.length > 0 && (
                          <li className="nord-drop__label" aria-hidden="true" role="presentation">
                            Customers
                          </li>
                        )}
                        {shownCustomers.map((c, index) => (
                          <li key={c.key} role="presentation">
                            <button
                              type="button"
                              className={`nord-res${customerKeys.active === index ? ' is-active' : ''}`}
                              onClick={() => handlePickCustomer(c)}
                              data-testid="customer-result"
                              id={customerKeys.optionId(index)}
                              role="option"
                              aria-selected={customerKeys.active === index}
                              tabIndex={-1}
                            >
                              <span className="nord-av" aria-hidden="true">
                                {customerInitials(c.fullName, c.phone)}
                              </span>
                              <span className="nord-res__main">
                                <span className="nord-res__name">
                                  {c.fullName || c.phone}
                                  {c.profileId && <span className="nord-tag">Account</span>}
                                </span>
                                <span className="nord-res__sub">
                                  {c.phone}
                                  {c.thana || c.district ? ` · ${[c.thana, c.district].filter(Boolean).join(', ')}` : ''}
                                  {c.orderCount > 0 ? ` · ${c.orderCount} order${c.orderCount === 1 ? '' : 's'}` : ''}
                                  {c.totalDue ? (
                                    <>
                                      {' · '}
                                      <span className="nord-due" data-testid="customer-result-due">
                                        {formatTaka(c.totalDue)} due
                                      </span>
                                    </>
                                  ) : null}
                                </span>
                              </span>
                            </button>
                          </li>
                        ))}
                        <li role="presentation">
                          <button
                            type="button"
                            className={`nord-res customer-pick__new${customerKeys.active === shownCustomers.length ? ' is-active' : ''}`}
                            onClick={handleNewCustomer}
                            data-testid="customer-new"
                            id={customerKeys.optionId(shownCustomers.length)}
                            role="option"
                            aria-selected={customerKeys.active === shownCustomers.length}
                            tabIndex={-1}
                          >
                            <span className="nord-av nord-av--new">
                              <PlusIcon />
                            </span>
                            <span className="nord-res__main">
                              <span className="nord-res__name">New customer</span>
                              <span className="nord-res__sub">
                                {looksLikePhone(customerQuery) ? `With phone ${customerQuery.trim()}` : `Named ${customerQuery.trim()}`}
                              </span>
                            </span>
                          </button>
                        </li>
                      </ul>
                    )}
                  </div>
                )}
              </div>

              <div className="form-field">
                <span className="form-label">
                  Where did this order come from? <span className="form-required" aria-hidden="true">*</span>
                </span>
                <div className="chip-group" role="group" aria-label="Order source">
                  {MANUAL_ORDER_SOURCES.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`chip-select${source === opt.id ? ' chip-select--on' : ''}`}
                      aria-pressed={source === opt.id}
                      onClick={() => handlePickSource(opt.id)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <CustomerDetailsFields
                {...customerFieldProps}
                part="contact"
                afterPhone={
                  <>
                    <FraudCheckCard phone={address.phone} />
                    {matches && (
                      <div className="admin-panel manual-order-suggestion">
                        {matches.fromProfile && (
                          <>
                            <p className="admin-panel__description">Account found: {matches.fromProfile.fullName || address.phone}</p>
                            <div className="admin-section-header__actions">
                              <button type="button" className="button button--secondary button--small" onClick={() => handleUseSuggestion('profile')}>
                                Fill in details
                              </button>
                            </div>
                          </>
                        )}
                        {matches.fromOrder && !matches.fromProfile && (
                          <>
                            <p className="admin-panel__description">
                              Previous order found: {matches.fromOrder.fullName}, {matches.fromOrder.addressLine}
                            </p>
                            <button type="button" className="button button--secondary button--small" onClick={() => handleUseSuggestion('order')}>
                              Fill in details
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </>
                }
              />
            </section>

            <section className="nord-card" data-testid="nord-card-address">
              <div className="nord-card__head">
                <span className="nord-step" aria-hidden="true">2</span>
                <h2 className="nord-card__title" id="nord-card-address">Delivery address</h2>
              </div>
              <CustomerDetailsFields {...customerFieldProps} part="address" thanaExtra={thanaChips} />
            </section>

            <section className="nord-card" data-testid="nord-card-items">
              <div className="nord-card__head">
                <span className="nord-step" aria-hidden="true">3</span>
                <h2 className="nord-card__title" id="nord-card-items">Items</h2>
                {lines.length > 0 && (
                  <span className="nord-card__hint" data-testid="nord-items-hint">
                    {itemsWord(lines.length)}
                  </span>
                )}
              </div>
              <div className="nord-search" ref={productBox} onKeyDown={productList.onKeyDown}>
                <div className="search-bar">
                  <svg className="search-bar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" />
                  </svg>
                  <input
                    type="search"
                    className="search-bar__input"
                    placeholder="Search product name..."
                    aria-label="Search products"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      productList.show();
                      productKeys.reset();
                    }}
                    onFocus={productList.show}
                    onClick={productList.show}
                    autoComplete="off"
                    {...productKeys.inputProps}
                  />
                </div>
                <ProductResults
                  results={productList.open ? searchResults : []}
                  onAdd={addLine}
                  className="nord-drop"
                  photos
                  label="Products"
                  keyboard={productKeys}
                />
              </div>

              {lines.length > 0 && (
                <ul className="nord-lines manual-order-lines">
                  {lines.map((line) => (
                    <li key={line.key} className="nord-line" data-testid="new-order-line">
                      <span className="nord-thumb nord-thumb--sm">
                        {line.thumbUrl ? (
                          <img src={line.thumbUrl} alt={line.productName} width={44} height={44} loading="lazy" decoding="async" />
                        ) : (
                          <BottleIcon />
                        )}
                      </span>
                      <div className="nord-line__mid">
                        <span className="nord-line__name">{line.productName}</span>
                        {line.variantLabel && <span className="checkout-cart__variant">{line.variantLabel}</span>}
                        <PackStockLine units={stockUnits} productId={line.productId} variantId={line.variantId} />
                        {line.packSize > 1 && (
                          <div className="chip-group" role="group" aria-label={`Sell ${line.productName} in`} data-testid="line-sold-unit">
                            <button
                              type="button"
                              className={`chip-select${line.soldUnit === null ? ' chip-select--on' : ''}`}
                              aria-pressed={line.soldUnit === null}
                              onClick={() => setLineSoldUnit(line.key, null)}
                            >
                              Packs ({line.packSize} {line.stockUnit})
                            </button>
                            <button
                              type="button"
                              className={`chip-select${line.soldUnit !== null ? ' chip-select--on' : ''}`}
                              aria-pressed={line.soldUnit !== null}
                              onClick={() => setLineSoldUnit(line.key, line.stockUnit)}
                            >
                              Loose {line.stockUnit}
                            </button>
                          </div>
                        )}
                        {line.soldUnit !== null && !inventoryOn && (
                          <span className="checkout-cart__variant" data-testid="line-units-note">
                            Loose {line.soldUnit} don&apos;t change the stock number while Inventory mode is Off.
                          </span>
                        )}
                        {line.soldUnit === null && line.stockQuantity !== null && line.stockQuantity < line.quantity && (
                          <span
                            className="checkout-cart__variant"
                            style={{ color: 'var(--color-danger, #d33)' }}
                            role="alert"
                            data-testid="line-stock-error"
                          >
                            {line.stockQuantity <= 0 ? 'Sold out — none left in stock' : `Only ${line.stockQuantity} in stock`}
                          </span>
                        )}
                        {!isAdmin ? (
                          <span className="checkout-cart__variant">
                            {formatTaka(line.listPrice)} {line.soldUnit ? `per ${line.soldUnit}` : 'each'}
                          </span>
                        ) : (
                          <div className="manual-order-line__price-row">
                            {line.soldPrice !== line.listPrice && (
                              <span className="manual-order-line__list-price">{formatTaka(line.listPrice)}</span>
                            )}
                            <MoneyInput
                              min="0"
                              className="manual-order-line__price-input"
                              value={line.soldPriceInput}
                              onChange={(e) => setLineSoldPrice(line.key, e.target.value)}
                              aria-label={line.soldUnit ? `Price per ${line.soldUnit}` : undefined}
                            />
                            {line.soldUnit && <span className="checkout-cart__variant">per {line.soldUnit}</span>}
                            <button type="button" className="account-card__edit" onClick={() => setLineFree(line.key)}>
                              Free
                            </button>
                          </div>
                        )}
                        {belowCostText(belowCost.get(line.key), canSeeCost) && (
                          <span className="smart-below" role="status" data-testid="line-below-cost">
                            {belowCostText(belowCost.get(line.key), canSeeCost)}
                          </span>
                        )}
                        {isAdmin && lineNeedsReason(line.listPrice, line.soldPrice) && (
                          <div className="chip-group" role="group" aria-label="Reason for discount">
                            {DISCOUNT_REASONS.map((r) => (
                              <button
                                key={r.id}
                                type="button"
                                className={`chip-select${line.reason === r.id ? ' chip-select--on' : ''}`}
                                onClick={() => updateLine(line.key, { reason: r.id })}
                              >
                                {r.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="nord-line__end">
                        <span className="nord-line__total" data-testid="new-order-line-total">
                          {formatTaka(line.soldPrice * line.quantity)}
                        </span>
                        {line.soldUnit ? (
                          <label className="manual-order-line__units">
                            <input
                              className="form-input"
                              type="number"
                              min="1"
                              step="1"
                              inputMode="numeric"
                              value={line.quantity}
                              onChange={(e) => setLineQuantity(line.key, Math.floor(Number(e.target.value) || 1))}
                              aria-label={`Loose ${line.soldUnit} of ${line.productName}`}
                              data-testid="line-units-input"
                            />
                            <span className="checkout-cart__variant">{line.soldUnit}</span>
                          </label>
                        ) : (
                          <div className="checkout-cart__stepper">
                            <button type="button" className="checkout-cart__step-btn" onClick={() => setLineQuantity(line.key, line.quantity - 1)} aria-label="Decrease quantity">
                              &minus;
                            </button>
                            <span className="checkout-cart__step-count">{line.quantity}</span>
                            <button type="button" className="checkout-cart__step-btn" onClick={() => setLineQuantity(line.key, line.quantity + 1)} aria-label="Increase quantity">
                              +
                            </button>
                          </div>
                        )}
                        <button type="button" className="nord-line__remove" onClick={() => removeLine(line.key)}>
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="nord-card" data-testid="nord-card-note">
              <div className="nord-card__head">
                <span className="nord-step" aria-hidden="true">4</span>
                <h2 className="nord-card__title" id="nord-card-note">
                  <label htmlFor="manual-order-note">Admin note</label>
                </h2>
                <span className="nord-card__hint">Only you see this</span>
              </div>
              <div className="form-field">
                <input
                  id="manual-order-note"
                  type="text"
                  className="form-input"
                  value={adminNote}
                  onChange={(e) => setAdminNote(e.target.value)}
                  placeholder="Anything to remember about this order"
                />
              </div>
            </section>
          </div>

          <div className="nord-side">
            <section className="nord-card" data-testid="nord-card-pay">
              <div className="nord-card__head">
                <h2 className="nord-card__title" id="nord-card-pay">Delivery and payment</h2>
              </div>

              <div className="form-field">
                <span className="form-label">Delivery</span>
                <div className="chip-group" role="group" aria-label="Delivery zone">
                  <button type="button" className={`chip-select${zone === 'inside_dhaka' ? ' chip-select--on' : ''}`} onClick={() => handlePickZone('inside_dhaka')}>
                    Inside Dhaka
                  </button>
                  <button type="button" className={`chip-select${zone === 'outside_dhaka' ? ' chip-select--on' : ''}`} onClick={() => handlePickZone('outside_dhaka')}>
                    Outside Dhaka
                  </button>
                  <button type="button" className={`chip-select${zone === 'hand_delivered' ? ' chip-select--on' : ''}`} onClick={() => handlePickZone('hand_delivered')}>
                    Hand delivered
                  </button>
                </div>
              </div>

              {/* Batch 47: shown for hand delivered too (৳0 by default, any
                  other amount may be typed). */}
              <div className={isAdmin ? 'nord-pair nord-pair--keep' : undefined}>
                <div className="form-field">
                  <label className="form-label" htmlFor="manual-order-fee">
                    Delivery fee
                  </label>
                  <MoneyInput id="manual-order-fee" min="0" value={feeInput} onChange={(e) => setFeeInput(e.target.value)} aria-label="Delivery fee" />
                </div>
                {isAdmin && (
                  <div className="form-field">
                    <label className="form-label" htmlFor="manual-order-discount">
                      Order discount
                    </label>
                    <MoneyInput id="manual-order-discount" min="0" value={orderDiscountInput} onChange={(e) => setOrderDiscountInput(e.target.value)} />
                  </div>
                )}
              </div>
              {isAdmin && orderDiscount > 0 && (
                <>
                  <div className="form-field">
                    <span className="form-label">Reason for order discount</span>
                    <div className="chip-group" role="group" aria-label="Reason for order discount">
                      {DISCOUNT_REASONS.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          className={`chip-select${discountReason === r.id ? ' chip-select--on' : ''}`}
                          onClick={() => setDiscountReason(r.id)}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="form-field">
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Optional note"
                      value={discountNote}
                      onChange={(e) => setDiscountNote(e.target.value)}
                    />
                  </div>
                </>
              )}

              <div className="form-field">
                <span className="form-label">Payment</span>
                <PaymentSection
                  idPrefix="manual-order"
                  total={totals.total}
                  plan={plan}
                  paidNowInput={paidNowInput}
                  onPaidNowInput={setPaidNowInput}
                  method={paidMethod}
                  onMethod={setPaidMethod}
                  trxId={paidTrxId}
                  onTrxId={setPaidTrxId}
                  mode={collectMode}
                  onMode={setCollectMode}
                  payLaterAvailable={payLaterReady}
                  methodMissing={methodMissing}
                  summaryOutside
                />
              </div>

              {storeBalance > 0 && (
                <div className="form-field" data-testid="new-order-use-wallet">
                  <div className="order-admin-detail__field-row">
                    <span className="form-label" style={{ margin: 0 }}>
                      Use wallet balance ({formatTaka(storeBalance)})
                    </span>
                    <Toggle checked={useStore} onChange={setUseStore} label="Use wallet balance" />
                  </div>
                  {useStore && (
                    <p className="form-hint">
                      From wallet {formatTaka(fromStore)} · still to collect {formatTaka(Math.max(0, totals.total - plan.paidNow - fromStore))}
                    </p>
                  )}
                </div>
              )}

              {zone === 'hand_delivered' && isPaidNow && (
                <div className="form-field">
                  <div className="order-admin-detail__field-row">
                    <span className="form-label" style={{ margin: 0 }}>Mark as delivered right away</span>
                    <Toggle checked={markDelivered} onChange={setMarkDelivered} label="Mark as delivered right away" />
                  </div>
                </div>
              )}

              <div className="nord-div" />

              <div data-testid="new-order-totals">
                <div className="nord-kv">
                  <span>Subtotal</span>
                  <b>{formatTaka(totals.subtotal)}</b>
                </div>
                {totals.lineDiscount > 0 && (
                  <div className="nord-kv">
                    <span>Item discounts</span>
                    <b>-{formatTaka(totals.lineDiscount)}</b>
                  </div>
                )}
                {totals.freeValue > 0 && (
                  <div className="nord-kv">
                    <span>Free items (list value)</span>
                    <b>{formatTaka(totals.freeValue)}</b>
                  </div>
                )}
                <div className="nord-kv">
                  <span>Delivery</span>
                  <b>{formatTaka(totals.deliveryFee)}</b>
                </div>
                {totals.orderDiscount > 0 && (
                  <div className="nord-kv">
                    <span>Order discount</span>
                    <b>-{formatTaka(totals.orderDiscount)}</b>
                  </div>
                )}
                <div className="nord-kv nord-kv--total">
                  <span>Total</span>
                  <b data-testid="new-order-total">{formatTaka(totals.total)}</b>
                </div>
              </div>

              <div className="nord-cod" aria-live="polite" data-testid="payment-summary">
                <PaymentSummaryRows plan={plan} rowClass="nord-kv" strongClass="nord-kv--strong" />
              </div>

              <div className="nord-create-wrap">
                <button
                  type="submit"
                  className="adm-btn adm-btn--primary nord-create"
                  disabled={!canSave || isSaving}
                  aria-busy={isSaving || undefined}
                  data-testid="nord-create"
                >
                  {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Create order'}
                </button>
                <p className="nord-fine">Nothing is saved until you tap Create order</p>
              </div>
            </section>
          </div>
        </div>
      </form>

      <ConfirmDialog
        isOpen={pendingWarnings !== null}
        title={warningInUnits ? 'Not in stock — sell anyway?' : 'Low stock'}
        message={
          warningInUnits
            ? `${warningMessage}. Sell anyway? The units that are there are taken; the missing ones are listed in Inventory → Sold without stock until the next lot arrives.`
            : `${warningMessage} — continue anyway? Stock may go negative.`
        }
        confirmLabel={warningInUnits ? 'Sell anyway' : 'Continue anyway'}
        cancelLabel="Go back"
        danger={false}
        onConfirm={async () => {
          setPendingWarnings(null);
          await handleSave(true);
        }}
        onClose={() => setPendingWarnings(null)}
      />
    </>
  );
}
