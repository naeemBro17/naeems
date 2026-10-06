// "Edit order" (Batch 30 Part 2): everything on an order, at any stage —
// customer, phone, alternative phone, address (with the full thana list),
// items (quantity, remove, add, price), delivery fee (0 allowed), order
// discount with a reason, and a note for the courier. Saved through
// admin_edit_order() (migration-033), which checks "Edit orders" in the
// database, keeps stock right and writes every change to History and the
// Activity Log. Prices and the discount are Super Admin only.
import { useEffect, useMemo, useState } from 'react';
import { AddressFormFields } from '../checkout/AddressFormFields';
import { useToast } from '../../hooks/useToast';
import { formatTaka, normalizeText } from '../../lib/format';
import { useSellableOptions, type SellableOption } from '../../lib/sellable';
import {
  adminEditOrder,
  buildOrderChanges,
  draftFromOrder,
  draftTotals,
  stockProblems,
  type EditDraft,
} from '../../lib/orderEdit';
import { PaymentSection } from './PaymentSection';
import { planPayment, type CollectMode } from '../../lib/paymentPlan';
import { addOrderPayment, summarizePayments, type OrderPayment, type PaymentMethodId } from '../../lib/payments';
import { adminSetCollectMode, isCollectModeReady } from '../../lib/orders';
import type { DeliveryAddress } from '../../features/checkout/types';
import type { OrderWithDetails } from '../../types';

interface EditOrderFormProps {
  order: OrderWithDetails;
  isAdmin: boolean;
  /** The page's Save changes button submits this form by id. */
  formId: string;
  onState: (state: { canSave: boolean; isSaving: boolean }) => void;
  /** Batch 32: the order's payments (null before migration-033) and whether
   *  this person may record one ("Change order status"). */
  payments: OrderPayment[] | null;
  canAddPayment: boolean;
  /** Nothing changed: leave without saving. */
  onUnchanged: () => void;
  onSaved: () => Promise<void> | void;
}

const emptyErrors = {};

/**
 * Batch 32 Part 3: the form of the Edit order page
 * (/admin/orders/:orderNumber/edit) — the Batch 30 sheet's form, unchanged
 * inside; the page around it has the Back and Save changes buttons.
 */
export function EditOrderForm({ order, isAdmin, formId, onState, payments, canAddPayment, onUnchanged, onSaved }: EditOrderFormProps) {
  const { showToast } = useToast();
  const { options, stockFor } = useSellableOptions();
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [query, setQuery] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Batch 32 Part 1: the payment section.
  const [paidNowInput, setPaidNowInput] = useState('');
  const [paidMethod, setPaidMethod] = useState<PaymentMethodId | null>(null);
  const [paidTrxId, setPaidTrxId] = useState('');
  const [collectMode, setCollectMode] = useState<CollectMode>('cod');
  const [payLaterReady, setPayLaterReady] = useState(true);

  // A fresh draft for the order the page opened.
  useEffect(() => {
    setDraft(draftFromOrder(order, stockFor));
    setQuery('');
    setError(null);
    setPaidNowInput('');
    setPaidMethod(null);
    setPaidTrxId('');
    setCollectMode(order.collect_mode);
    void isCollectModeReady().then(setPayLaterReady);
    // stockFor changes identity with the product list; the draft is only
    // built when the page opens, never under Naeem's fingers.
  }, [order]);

  const holdsStock = order.status !== 'cancelled';
  const problems = useMemo(() => (draft ? stockProblems(draft, holdsStock) : new Map<string, number>()), [draft, holdsStock]);
  const totals = draft ? draftTotals(draft) : null;
  const results = useMemo(() => {
    const term = normalizeText(query.trim());
    if (term === '') return [];
    return options.filter((o) => normalizeText(o.label).includes(term)).slice(0, 12);
  }, [query, options]);

  const alreadyPaid = payments ? summarizePayments(order.total, payments).paid : 0;
  const plan = totals
    ? planPayment({ total: totals.total, paidNowInput, mode: collectMode, alreadyPaid, formatMoney: formatTaka })
    : null;
  const methodMissing = plan !== null && plan.paidNow > 0 && paidMethod === null;
  const paymentReady = payments !== null;

  const update = (patch: Partial<EditDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const updateItem = (key: string, patch: Partial<EditDraft['items'][number]>) =>
    setDraft((d) => (d ? { ...d, items: d.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) } : d));
  const removeItem = (key: string) => setDraft((d) => (d ? { ...d, items: d.items.filter((i) => i.key !== key) } : d));

  const addItem = (opt: SellableOption) => {
    setDraft((d) => {
      if (!d) return d;
      const existing = d.items.find((i) => i.productId === opt.productId && i.variantId === opt.variantId);
      if (existing) {
        return { ...d, items: d.items.map((i) => (i.key === existing.key ? { ...i, quantity: i.quantity + 1 } : i)) };
      }
      return {
        ...d,
        items: [
          ...d.items,
          {
            key: `new-${opt.key}-${Date.now()}`,
            id: null,
            productId: opt.productId,
            variantId: opt.variantId,
            productName: opt.productName,
            variantLabel: opt.variantLabel,
            imageUrl: opt.imageUrl,
            listPrice: opt.listPrice,
            unitPrice: opt.listPrice,
            quantity: 1,
            originalQuantity: 0,
            originalUnitPrice: opt.listPrice,
            stockQuantity: opt.stockQuantity,
          },
        ],
      };
    });
    setQuery('');
  };

  const address: DeliveryAddress = draft
    ? {
        fullName: draft.customerName,
        phone: draft.phone,
        division: draft.division,
        district: draft.district,
        thana: draft.thana,
        fullAddress: draft.addressLine,
      }
    : { fullName: '', phone: '', division: '', district: '', thana: '', fullAddress: '' };

  const canSave =
    draft !== null &&
    !isSaving &&
    draft.items.length > 0 &&
    problems.size === 0 &&
    draft.customerName.trim() !== '' &&
    draft.addressLine.trim() !== '' &&
    Number.isFinite(Number(draft.deliveryFee)) &&
    Number(draft.deliveryFee) >= 0 &&
    Number.isFinite(Number(draft.discount)) &&
    Number(draft.discount) >= 0 &&
    (plan === null || plan.error === null) &&
    !methodMissing;

  const save = async () => {
    if (!draft || !canSave) return;
    const changes = buildOrderChanges(order, draft);
    const modeChanged = collectMode !== order.collect_mode;
    const paidNow = plan?.paidNow ?? 0;
    if (Object.keys(changes).length === 0 && !modeChanged && paidNow <= 0) {
      showToast('Nothing changed');
      onUnchanged();
      return;
    }
    setIsSaving(true);
    setError(null);
    const fail = (message: string) => {
      setIsSaving(false);
      setError(message);
      showToast(message, 'error');
    };
    if (Object.keys(changes).length > 0) {
      const result = await adminEditOrder(order.id, changes);
      if (result.error) return fail(result.error);
    }
    if (modeChanged) {
      const result = await adminSetCollectMode(order.id, collectMode);
      if (result.error) return fail(result.error);
    }
    if (paidNow > 0 && paidMethod) {
      const result = await addOrderPayment(order.id, {
        amount: paidNow,
        method: paidMethod,
        trxId: paidTrxId,
        paidAt: null,
        note: '',
        kind: 'payment',
      });
      if (result.error) return fail(result.error);
    }
    setIsSaving(false);
    showToast('Order updated');
    await onSaved();
  };

  useEffect(() => {
    onState({ canSave, isSaving });
  }, [canSave, isSaving, onState]);

  return (
    <>
      {draft && totals && (
        <form
          id={formId}
          className="form edit-order"
          data-testid="edit-order-sheet"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h3 className="edit-order__heading">Customer and address</h3>
          <AddressFormFields
            form={address}
            errors={emptyErrors}
            idPrefix="edit-order"
            onChange={(patch) =>
              update({
                ...(patch.fullName !== undefined ? { customerName: patch.fullName } : {}),
                ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
                ...(patch.division !== undefined ? { division: patch.division } : {}),
                ...(patch.district !== undefined ? { district: patch.district } : {}),
                ...(patch.thana !== undefined ? { thana: patch.thana } : {}),
                ...(patch.fullAddress !== undefined ? { addressLine: patch.fullAddress } : {}),
              })
            }
          />
          <div className="form-field">
            <label className="form-label" htmlFor="edit-order-alt-phone">
              Alternative phone (optional)
            </label>
            <input
              id="edit-order-alt-phone"
              type="tel"
              inputMode="tel"
              className="form-input"
              value={draft.altPhone}
              onChange={(e) => update({ altPhone: e.target.value })}
            />
          </div>

          <h3 className="edit-order__heading">Items</h3>
          <ul className="edit-order__items">
            {draft.items.map((item) => {
              const limit = problems.get(item.key);
              return (
                <li key={item.key} className="edit-order__item" data-testid="edit-order-item">
                  <span className="checkout-cart__thumb">
                    {item.imageUrl ? <img src={item.imageUrl} alt="" /> : <span className="checkout-cart__thumb-empty" aria-hidden="true" />}
                  </span>
                  <div className="edit-order__item-main">
                    <span className="edit-order__item-name">{item.productName}</span>
                    {item.variantLabel && <span className="edit-order__item-sub">{item.variantLabel}</span>}
                    {isAdmin ? (
                      <label className="edit-order__price">
                        <span className="edit-order__item-sub">Price ৳</span>
                        <input
                          type="number"
                          min="0"
                          inputMode="decimal"
                          className="form-input edit-order__price-input"
                          value={item.unitPrice}
                          aria-label={`Price of ${item.productName}`}
                          onChange={(e) => {
                            const value = Number(e.target.value);
                            updateItem(item.key, { unitPrice: Number.isFinite(value) && value >= 0 ? value : 0 });
                          }}
                        />
                      </label>
                    ) : (
                      <span className="edit-order__item-sub">{formatTaka(item.unitPrice)} each</span>
                    )}
                    {limit !== undefined && (
                      <span className="edit-order__stock" role="alert">
                        Only {limit} in stock
                      </span>
                    )}
                  </div>
                  <div className="edit-order__item-end">
                    <div className="checkout-cart__stepper">
                      <button
                        type="button"
                        className="checkout-cart__step-btn"
                        aria-label={`Decrease quantity of ${item.productName}`}
                        onClick={() => updateItem(item.key, { quantity: Math.max(1, item.quantity - 1) })}
                      >
                        &minus;
                      </button>
                      <span className="checkout-cart__step-count" data-testid="edit-order-qty">
                        {item.quantity}
                      </span>
                      <button
                        type="button"
                        className="checkout-cart__step-btn"
                        aria-label={`Increase quantity of ${item.productName}`}
                        onClick={() => updateItem(item.key, { quantity: item.quantity + 1 })}
                      >
                        +
                      </button>
                    </div>
                    <span className="edit-order__line-total">{formatTaka(item.unitPrice * item.quantity)}</span>
                    <button
                      type="button"
                      className="account-card__edit"
                      onClick={() => removeItem(item.key)}
                      disabled={draft.items.length === 1}
                      aria-label={`Remove ${item.productName}`}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="search-bar edit-order__search">
            <svg className="search-bar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="search"
              className="search-bar__input"
              placeholder="Add a product..."
              aria-label="Add a product"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </div>
          {results.length > 0 && (
            <ul className="picker-sheet__list edit-order__results">
              {results.map((opt) => (
                <li key={opt.key}>
                  <button type="button" className="picker-sheet__row" onClick={() => addItem(opt)}>
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

          <h3 className="edit-order__heading">Delivery and money</h3>
          <div className="form-row">
            <div className="form-field">
              <label className="form-label" htmlFor="edit-order-fee">
                Delivery fee (৳)
              </label>
              <input
                id="edit-order-fee"
                type="number"
                min="0"
                inputMode="decimal"
                className="form-input"
                value={draft.deliveryFee}
                onChange={(e) => update({ deliveryFee: e.target.value })}
              />
            </div>
            {isAdmin && (
              <div className="form-field">
                <label className="form-label" htmlFor="edit-order-discount">
                  Order discount (৳)
                </label>
                <input
                  id="edit-order-discount"
                  type="number"
                  min="0"
                  inputMode="decimal"
                  className="form-input"
                  value={draft.discount}
                  onChange={(e) => update({ discount: e.target.value })}
                />
              </div>
            )}
          </div>
          {isAdmin && Number(draft.discount) > 0 && (
            <div className="form-field">
              <label className="form-label" htmlFor="edit-order-discount-note">
                Reason for the discount (optional)
              </label>
              <input
                id="edit-order-discount-note"
                type="text"
                className="form-input"
                value={draft.discountNote}
                onChange={(e) => update({ discountNote: e.target.value })}
              />
            </div>
          )}
          <div className="form-field">
            <label className="form-label" htmlFor="edit-order-courier-note">
              Note for the courier (optional)
            </label>
            <input
              id="edit-order-courier-note"
              type="text"
              className="form-input"
              placeholder="e.g. Call before delivery"
              value={draft.courierNote}
              onChange={(e) => update({ courierNote: e.target.value })}
            />
          </div>

          {paymentReady && plan && (
            <>
              <h3 className="edit-order__heading">Payment</h3>
              <PaymentSection
                idPrefix="edit-order"
                total={totals.total}
                plan={plan}
                alreadyPaid={alreadyPaid}
                canAddPayment={canAddPayment}
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
            </>
          )}

          <div className="checkout-summary-card edit-order__totals">
            <div className="checkout-summary-card__row">
              <span>Subtotal</span>
              <span>{formatTaka(totals.subtotal)}</span>
            </div>
            <div className="checkout-summary-card__row">
              <span>Delivery</span>
              <span>{formatTaka(totals.deliveryFee)}</span>
            </div>
            {totals.discount > 0 && (
              <div className="checkout-summary-card__row">
                <span>Discount</span>
                <span>-{formatTaka(totals.discount)}</span>
              </div>
            )}
            <div className="checkout-summary-card__row checkout-summary-card__row--total">
              <span>New total</span>
              <span data-testid="edit-order-total">{formatTaka(totals.total)}</span>
            </div>
          </div>
          {order.status === 'cancelled' && <p className="admin-panel__description">This order is cancelled, so no stock moves.</p>}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </>
  );
}
