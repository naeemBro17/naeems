// "New order" — Admin -> Orders (Batch 22). Most of Naeem's real
// orders arrive over Facebook/WhatsApp, not the website, so he types them in
// here himself: pick where it came from, find or type the customer, add
// items (with an optional cut price or "Free" and a reason), set delivery and
// payment, and save. Saved through admin_create_order() (migration-028) —
// every price/stock check happens in the database, never trusted from this
// form; this component only shapes the input and shows a live preview.
import { useEffect, useMemo, useState } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
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
  MANUAL_PAYMENT_METHODS,
  computeManualOrderTotals,
  lineNeedsReason,
  type StockWarning,
} from '../../lib/manualOrders';
import type { DeliveryAddress } from '../../features/checkout/types';
import type { DiscountReason, OrderPaymentMethod, OrderSource } from '../../types';

interface NewOrderSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the new order's id once saved — the parent opens its detail
   *  sheet immediately so Naeem lands right on the invoice/Steadfast button. */
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

export function NewOrderSheet({ isOpen, onClose, onCreated }: NewOrderSheetProps) {
  // Batch 24: custom prices, "Free" and order discounts are money changes —
  // Super Admin only. A moderator's manual order is always at the real
  // price (admin_create_order() refuses anything else from them).
  const { isAdmin } = useAuth();
  const { products, variantsFor, settings } = useProducts();
  const { showToast } = useToast();

  const [source, setSource] = useState<OrderSource | null>(null);
  const [address, setAddress] = useState<DeliveryAddress>(emptyForm);
  const [linkedCustomerId, setLinkedCustomerId] = useState<string | null>(null);
  const [linkedCustomerLabel, setLinkedCustomerLabel] = useState<string | null>(null);
  const [matches, setMatches] = useState<{
    fromProfile: Awaited<ReturnType<typeof findCustomerMatches>>['fromProfile'];
    fromOrder: Awaited<ReturnType<typeof findCustomerMatches>>['fromOrder'];
  } | null>(null);
  const [lookedUpPhone, setLookedUpPhone] = useState('');

  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<OrderLine[]>([]);

  const [zone, setZone] = useState<DeliveryZoneChoice>('inside_dhaka');
  const [feeInput, setFeeInput] = useState('70');
  const [zoneTouched, setZoneTouched] = useState(false);

  const [orderDiscountInput, setOrderDiscountInput] = useState('0');
  const [discountReason, setDiscountReason] = useState<DiscountReason | null>(null);
  const [discountNote, setDiscountNote] = useState('');

  const [paymentMethod, setPaymentMethod] = useState<OrderPaymentMethod>('cod');
  const [bkashTrxId, setBkashTrxId] = useState('');
  const [bkashSender, setBkashSender] = useState('');
  const [markDelivered, setMarkDelivered] = useState(false);
  const [adminNote, setAdminNote] = useState('');

  const [isSaving, setIsSaving] = useState(false);
  const [pendingWarnings, setPendingWarnings] = useState<StockWarning[] | null>(null);

  // Fresh form every time the sheet opens — a manual order is a one-shot
  // entry, not a draft worth remembering between sessions.
  useEffect(() => {
    if (!isOpen) return;
    setSource(null);
    setAddress(emptyForm());
    setLinkedCustomerId(null);
    setLinkedCustomerLabel(null);
    setMatches(null);
    setLookedUpPhone('');
    setQuery('');
    setLines([]);
    setZone('inside_dhaka');
    setFeeInput(settings.delivery_fee_inside_dhaka || '70');
    setZoneTouched(false);
    setOrderDiscountInput('0');
    setDiscountReason(null);
    setDiscountNote('');
    setPaymentMethod('cod');
    setBkashTrxId('');
    setBkashSender('');
    setMarkDelivered(false);
    setAdminNote('');
    setPendingWarnings(null);
  }, [isOpen, settings.delivery_fee_inside_dhaka]);

  // Phone lookup — offers to fill in details from a past order or an
  // existing account, never applies anything automatically. See
  // findCustomerMatches's own header comment for the privacy rule.
  useEffect(() => {
    const digits = address.phone.replace(/\D/g, '');
    if (digits.length < 10 || address.phone === lookedUpPhone) return;
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
  }, [address.phone, lookedUpPhone]);

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

  const handleLinkAccount = () => {
    if (!matches?.fromProfile?.profileId) return;
    setLinkedCustomerId(matches.fromProfile.profileId);
    setLinkedCustomerLabel(matches.fromProfile.fullName || address.phone);
  };

  const isPaidNow =
    paymentMethod === 'cash' || (paymentMethod === 'bkash' && bkashTrxId.trim() !== '');

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

  const canSave =
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
    paymentMethod,
    bkashTrxId: paymentMethod === 'bkash' ? bkashTrxId.trim() || null : null,
    bkashSender: paymentMethod === 'bkash' ? bkashSender.trim() || null : null,
    linkedCustomerId,
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
    showToast(`Order ${result.orderNumber} saved`, 'success');
    await onCreated(result.orderId);
  };

  const warningMessage = pendingWarnings
    ? pendingWarnings
        .map(
          (w) =>
            `${w.product_name}${w.variant_label ? ` (${w.variant_label})` : ''}: only ${w.available} left, ${w.requested} requested`
        )
        .join('. ')
    : '';

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="New order">
      <form
        className="form manual-order-form"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave(false);
        }}
      >
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
                  {linkedCustomerId ? (
                    <>
                      <span className="status-badge status-badge--success">
                        Linked: {linkedCustomerLabel}
                      </span>
                      <button
                        type="button"
                        className="account-card__edit"
                        onClick={() => {
                          setLinkedCustomerId(null);
                          setLinkedCustomerLabel(null);
                        }}
                      >
                        Unlink
                      </button>
                    </>
                  ) : (
                    <button type="button" className="button button--secondary button--small" onClick={handleLinkAccount}>
                      Link to this account
                    </button>
                  )}
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
          <div className="chip-group" role="group" aria-label="Payment method">
            {MANUAL_PAYMENT_METHODS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`chip-select${paymentMethod === opt.id ? ' chip-select--on' : ''}`}
                onClick={() => setPaymentMethod(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {paymentMethod === 'bkash' && (
            <div className="form-row" style={{ marginTop: 8 }}>
              <input
                type="text"
                className="form-input"
                placeholder="TrxID (optional)"
                value={bkashTrxId}
                onChange={(e) => setBkashTrxId(e.target.value)}
              />
              <input
                type="text"
                className="form-input"
                placeholder="Sender number (optional)"
                value={bkashSender}
                onChange={(e) => setBkashSender(e.target.value)}
              />
            </div>
          )}
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

        <div className="edit-sheet__footer">
          <button type="button" className="edit-sheet__cancel" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button type="submit" className="edit-sheet__save" disabled={!canSave}>
            {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
          </button>
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
    </BottomSheet>
  );
}
