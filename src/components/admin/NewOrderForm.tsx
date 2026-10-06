// "New order" — Admin -> Orders (Batch 22). Most of Naeem's real
// orders arrive over Facebook/WhatsApp, not the website, so he types them in
// here himself: pick where it came from, find or type the customer, add
// items (with an optional cut price or "Free" and a reason), set delivery and
// payment, and save. Saved through admin_create_order() (migration-028) —
// every price/stock check happens in the database, never trusted from this
// form; this component only shapes the input and shows a live preview.
import { useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { Toggle } from './edit-sheets/SheetChrome';
import { AddressFormFields, type AddressFieldErrors } from '../checkout/AddressFormFields';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { formatTaka, normalizeText } from '../../lib/format';
import { cardImage } from '../../lib/productImages';
import { zoneForAddress } from '../../lib/deliveryZones';
import { adminCreateOrder, findCustomerMatches, type ManualOrderItemInput } from '../../lib/orders';
import { useAuth } from '../../contexts/AuthContext';
import {
  MANUAL_ORDER_SOURCES,
  DISCOUNT_REASONS,
  computeManualOrderTotals,
  lineNeedsReason,
  type StockWarning,
} from '../../lib/manualOrders';
import { findCustomers, linkOrderCustomer, type CustomerSearchResult } from '../../lib/customers';
import { looksLikePhone } from '../../lib/phone';
import { FraudCheckCard } from './FraudCheckCard';
import { isTestCustomer, isTestViewer } from '../../lib/testData';
import type { DeliveryAddress } from '../../features/checkout/types';
import { PaymentSection } from './PaymentSection';
import { legacyPaymentMethod, planPayment, type CollectMode } from '../../lib/paymentPlan';
import { isCollectModeReady } from '../../lib/orders';
import type { PaymentMethodId } from '../../lib/payments';
import type { DiscountReason, OrderSource } from '../../types';

interface NewOrderFormProps {
  /** The page's Create order button submits this form by id. */
  formId: string;
  /** Tells the page whether its Create order button can be pressed. */
  onState: (state: { canSave: boolean; isSaving: boolean }) => void;
  /** Called with the new order's id once saved — the page opens its detail
   *  immediately so Naeem lands right on the invoice/Steadfast button. */
  onCreated: (orderId: string) => void | Promise<void>;
}

type DeliveryZoneChoice = 'inside_dhaka' | 'outside_dhaka' | 'hand_delivered';

interface OrderLine {
  key: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantLabel: string | null;
  imageUrl: string | null;
  listPrice: number;
  soldPrice: number;
  soldPriceInput: string;
  quantity: number;
  reason: DiscountReason | null;
  reasonNote: string;
  stockQuantity: number | null;
}

interface SellableOption {
  productId: string;
  variantId: string | null;
  key: string;
  label: string;
  productName: string;
  variantLabel: string | null;
  imageUrl: string | null;
  listPrice: number;
  stockQuantity: number | null;
}

function currentPrice(retailPrice: number, offerPrice: number | null): number {
  return offerPrice !== null && offerPrice < retailPrice ? offerPrice : retailPrice;
}

function emptyForm(): DeliveryAddress {
  return { fullName: '', phone: '', division: '', district: '', thana: '', fullAddress: '' };
}

const emptyErrors: AddressFieldErrors = {};

/**
 * Batch 32 Part 3: the form of the New order page (/admin/orders/new) —
 * the Batch 22 sheet's form, unchanged inside; the page around it has the
 * Back button and the Create order button.
 */
export function NewOrderForm({ formId, onState, onCreated }: NewOrderFormProps) {
  // Batch 24: custom prices, "Free" and order discounts are money changes —
  // Super Admin only. A moderator's manual order is always at the real
  // price (admin_create_order() refuses anything else from them).
  const { isAdmin, staff } = useAuth();
  const hideTestCustomers = !isTestViewer(staff);
  const { products, variantsFor, settings } = useProducts();
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

  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<OrderLine[]>([]);

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

  const [isSaving, setIsSaving] = useState(false);
  const [pendingWarnings, setPendingWarnings] = useState<StockWarning[] | null>(null);

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

  const sellableOptions = useMemo<SellableOption[]>(() => {
    const list: SellableOption[] = [];
    for (const p of products) {
      if (!p.is_active) continue;
      const variants = variantsFor(p.id);
      if (variants.length === 0) {
        list.push({
          productId: p.id,
          variantId: null,
          key: p.id,
          label: p.name,
          productName: p.name,
          variantLabel: null,
          imageUrl: cardImage(p),
          listPrice: currentPrice(p.retail_price, p.offer_price),
          stockQuantity: p.stock_quantity,
        });
      } else {
        for (const v of variants) {
          const variantLabel = [v.region, v.size].filter(Boolean).join(' · ');
          list.push({
            productId: p.id,
            variantId: v.id,
            key: `${p.id}::${v.id}`,
            label: variantLabel ? `${p.name} — ${variantLabel}` : p.name,
            productName: p.name,
            variantLabel: variantLabel || null,
            imageUrl: v.image_url ?? cardImage(p),
            listPrice: currentPrice(v.retail_price, v.offer_price),
            stockQuantity: v.stock_quantity,
          });
        }
      }
    }
    return list;
  }, [products, variantsFor]);

  const searchResults = useMemo(() => {
    const term = normalizeText(query.trim());
    if (term === '') return [];
    return sellableOptions.filter((opt) => normalizeText(opt.label).includes(term)).slice(0, 20);
  }, [query, sellableOptions]);

  const addLine = (option: SellableOption) => {
    setLines((current) => {
      const existing = current.find((l) => l.key === option.key);
      if (existing) {
        return current.map((l) => (l.key === option.key ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [
        ...current,
        {
          key: option.key,
          productId: option.productId,
          variantId: option.variantId,
          productName: option.productName,
          variantLabel: option.variantLabel,
          imageUrl: option.imageUrl,
          listPrice: option.listPrice,
          soldPrice: option.listPrice,
          soldPriceInput: String(option.listPrice),
          quantity: 1,
          reason: null,
          reasonNote: '',
          stockQuantity: option.stockQuantity,
        },
      ];
    });
    setQuery('');
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

  const handlePickZone = (next: DeliveryZoneChoice) => {
    setZoneTouched(true);
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
    if (customer.district) handleLocationChange(customer.district, customer.thana);
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

  const deliveryFee = zone === 'hand_delivered' ? 0 : Math.max(0, Number(feeInput) || 0);
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
    linkedCustomerId: null,
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
      setPendingWarnings(result.stockWarnings);
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
    showToast(`Order ${result.orderNumber} saved`, 'success');
    await onCreated(result.orderId);
  };

  useEffect(() => {
    onState({ canSave, isSaving });
  }, [canSave, isSaving, onState]);

  const warningMessage = pendingWarnings
    ? pendingWarnings
        .map(
          (w) =>
            `${w.product_name}${w.variant_label ? ` (${w.variant_label})` : ''}: only ${w.available} left, ${w.requested} requested`
        )
        .join('. ')
    : '';

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
        <div className="form-field customer-pick">
          <label className="form-label" htmlFor="manual-order-customer">
            Customer
          </label>
          {pickedCustomer ? (
            <div className="customer-pick__chosen" data-testid="customer-picked">
              <span className="customer-pick__chosen-main">
                <strong>{pickedCustomer === 'new' ? 'New customer' : pickedCustomer.fullName || pickedCustomer.phone}</strong>
                <span className="customer-pick__sub">
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
            <>
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
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  autoComplete="off"
                />
              </div>
              {customerQuery.trim().length >= 2 && (
                <ul className="picker-sheet__list customer-pick__results" data-testid="customer-results">
                  {customerResults.filter((c) => !hideTestCustomers || !isTestCustomer({ name: c.fullName })).map((c) => (
                    <li key={c.key}>
                      <button type="button" className="picker-sheet__row" onClick={() => handlePickCustomer(c)}>
                        <span className="picker-sheet__row-label customer-pick__row">
                          <span>
                            {c.fullName || c.phone}
                            {c.profileId && <span className="customer-pick__tag">Account</span>}
                          </span>
                          <span className="picker-sheet__row-sub">
                            {c.phone}
                            {c.thana || c.district ? ` · ${[c.thana, c.district].filter(Boolean).join(', ')}` : ''}
                            {c.orderCount > 0 ? ` · ${c.orderCount} order${c.orderCount === 1 ? '' : 's'}` : ''}
                            {c.totalDue ? ` · ${formatTaka(c.totalDue)} due` : ''}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                  <li>
                    <button type="button" className="picker-sheet__row customer-pick__new" onClick={handleNewCustomer}>
                      <span className="picker-sheet__row-label">
                        New customer
                        <span className="picker-sheet__row-sub">
                          {looksLikePhone(customerQuery) ? `With phone ${customerQuery.trim()}` : `Named ${customerQuery.trim()}`}
                        </span>
                      </span>
                    </button>
                  </li>
                </ul>
              )}
            </>
          )}
        </div>

        <div className="form-field">
          <span className="form-label">
            Source <span className="form-required" aria-hidden="true">*</span>
          </span>
          <div className="chip-group" role="group" aria-label="Order source">
            {MANUAL_ORDER_SOURCES.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`chip-select${source === opt.id ? ' chip-select--on' : ''}`}
                aria-pressed={source === opt.id}
                onClick={() => setSource(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <AddressFormFields form={address} errors={emptyErrors} onChange={(patch) => setAddress((c) => ({ ...c, ...patch }))} onLocationChange={handleLocationChange} idPrefix="manual-order" />

        <FraudCheckCard phone={address.phone} />

        {matches && (
          <div className="admin-panel manual-order-suggestion">
            {matches.fromProfile && (
              <>
                <p className="admin-panel__description">
                  Account found: {matches.fromProfile.fullName || address.phone}
                </p>
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

        <div className="form-field">
          <span className="form-label">Items <span className="form-required" aria-hidden="true">*</span></span>
          <div className="search-bar">
            <svg className="search-bar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="search"
              className="search-bar__input"
              placeholder="Search product name..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </div>
          {searchResults.length > 0 && (
            <ul className="picker-sheet__list">
              {searchResults.map((opt) => (
                <li key={opt.key}>
                  <button type="button" className="picker-sheet__row" onClick={() => addLine(opt)}>
                    <span className="picker-sheet__row-label">
                      {opt.label}
                      <span className="picker-sheet__row-sub">
                        {formatTaka(opt.listPrice)}
                        {opt.stockQuantity !== null ? ` · stock ${opt.stockQuantity}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {lines.length > 0 && (
          <ul className="checkout-cart__list manual-order-lines">
            {lines.map((line) => (
              <li key={line.key} className="checkout-cart__row">
                <span className="checkout-cart__thumb">
                  {line.imageUrl ? <img src={line.imageUrl} alt={line.productName} /> : <span className="checkout-cart__thumb-empty" aria-hidden="true" />}
                </span>
                <div className="checkout-cart__info">
                  <span className="checkout-cart__name">{line.productName}</span>
                  {line.variantLabel && <span className="checkout-cart__variant">{line.variantLabel}</span>}
                  {line.stockQuantity !== null && line.stockQuantity < line.quantity && (
                    <span className="checkout-cart__variant" style={{ color: 'var(--color-danger, #d33)' }}>
                      Only {line.stockQuantity} in stock
                    </span>
                  )}
                  {!isAdmin ? (
                    <span className="checkout-cart__variant">{formatTaka(line.listPrice)} each</span>
                  ) : (
                  <div className="manual-order-line__price-row">
                    {line.soldPrice !== line.listPrice && (
                      <span className="manual-order-line__list-price">{formatTaka(line.listPrice)}</span>
                    )}
                    <input
                      type="number"
                      min="0"
                      className="form-input manual-order-line__price-input"
                      value={line.soldPriceInput}
                      onChange={(e) => setLineSoldPrice(line.key, e.target.value)}
                    />
                    <button type="button" className="account-card__edit" onClick={() => setLineFree(line.key)}>
                      Free
                    </button>
                  </div>
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
                <div className="checkout-cart__row-end">
                  <div className="checkout-cart__stepper">
                    <button type="button" className="checkout-cart__step-btn" onClick={() => setLineQuantity(line.key, line.quantity - 1)} aria-label="Decrease quantity">
                      &minus;
                    </button>
                    <span className="checkout-cart__step-count">{line.quantity}</span>
                    <button type="button" className="checkout-cart__step-btn" onClick={() => setLineQuantity(line.key, line.quantity + 1)} aria-label="Increase quantity">
                      +
                    </button>
                  </div>
                  <span className="checkout-cart__line-total">{formatTaka(line.soldPrice * line.quantity)}</span>
                  <button type="button" className="account-card__edit" onClick={() => removeLine(line.key)}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {isAdmin && (
        <div className="form-row">
          <div className="form-field">
            <label className="form-label" htmlFor="manual-order-discount">Order discount (৳)</label>
            <input
              id="manual-order-discount"
              type="number"
              min="0"
              className="form-input"
              value={orderDiscountInput}
              onChange={(e) => setOrderDiscountInput(e.target.value)}
            />
          </div>
        </div>
        )}
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
          <span className="form-label">Delivery</span>
          <div className="chip-group" role="group" aria-label="Delivery zone">
            <button type="button" className={`chip-select${zone === 'inside_dhaka' ? ' chip-select--on' : ''}`} onClick={() => handlePickZone('inside_dhaka')}>
              Inside Dhaka
            </button>
            <button type="button" className={`chip-select${zone === 'outside_dhaka' ? ' chip-select--on' : ''}`} onClick={() => handlePickZone('outside_dhaka')}>
              Outside Dhaka
            </button>
            <button type="button" className={`chip-select${zone === 'hand_delivered' ? ' chip-select--on' : ''}`} onClick={() => handlePickZone('hand_delivered')}>
              No delivery (hand delivered)
            </button>
          </div>
          {zone !== 'hand_delivered' && (
            <input
              type="number"
              min="0"
              className="form-input"
              style={{ marginTop: 8 }}
              value={feeInput}
              onChange={(e) => setFeeInput(e.target.value)}
              aria-label="Delivery fee"
            />
          )}
        </div>

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
          />
        </div>

        {zone === 'hand_delivered' && isPaidNow && (
          <div className="form-field">
            <div className="order-admin-detail__field-row">
              <span className="form-label" style={{ margin: 0 }}>Mark as delivered right away</span>
              <Toggle checked={markDelivered} onChange={setMarkDelivered} label="Mark as delivered right away" />
            </div>
          </div>
        )}

        <div className="form-field">
          <label className="form-label" htmlFor="manual-order-note">Admin note (optional)</label>
          <input
            id="manual-order-note"
            type="text"
            className="form-input"
            value={adminNote}
            onChange={(e) => setAdminNote(e.target.value)}
          />
        </div>

        <div className="checkout-summary-card">
          <div className="checkout-summary-card__row">
            <span>Subtotal</span>
            <span>{formatTaka(totals.subtotal)}</span>
          </div>
          {totals.lineDiscount > 0 && (
            <div className="checkout-summary-card__row checkout-summary-card__row--discount">
              <span>Item discounts</span>
              <span>-{formatTaka(totals.lineDiscount)}</span>
            </div>
          )}
          {totals.freeValue > 0 && (
            <div className="checkout-summary-card__row checkout-summary-card__row--discount">
              <span>Free items (list value)</span>
              <span>{formatTaka(totals.freeValue)}</span>
            </div>
          )}
          <div className="checkout-summary-card__row">
            <span>Delivery</span>
            <span>{formatTaka(totals.deliveryFee)}</span>
          </div>
          {totals.orderDiscount > 0 && (
            <div className="checkout-summary-card__row checkout-summary-card__row--discount">
              <span>Order discount</span>
              <span>-{formatTaka(totals.orderDiscount)}</span>
            </div>
          )}
          <div className="checkout-summary-card__row checkout-summary-card__row--total">
            <span>Total</span>
            <span>{formatTaka(totals.total)}</span>
          </div>
        </div>

      </form>

      <ConfirmDialog
        isOpen={pendingWarnings !== null}
        title="Low stock"
        message={`${warningMessage} — continue anyway? Stock may go negative.`}
        confirmLabel="Continue anyway"
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
