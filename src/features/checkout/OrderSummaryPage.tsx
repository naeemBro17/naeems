// Step 3 of the checkout flow. Read-only review of the order (editing a
// quantity happens back on CartPage) plus promo code entry (unchanged from
// before) and, new in Batch 18, the payment method choice. "Place order"
// calls place_order() (migration-021) — the database re-checks every price
// and stock level itself, so nothing here is trusted once it reaches the
// server. On success the real order id/number becomes the lastOrder
// snapshot and the cart is cleared; on failure the cart is left exactly as
// it was so the customer can fix whatever was wrong (out of stock, a promo
// that just expired) and try again.
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { BackButton } from '../../components/shared/BackButton';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useProducts } from '../../contexts/ProductContext';
import { coverImage } from '../../lib/productImages';
import { formatTaka } from '../../lib/format';
import { computePromoDiscount, findValidPromoCode } from '../../lib/promoCodes';
import { placeOrder } from '../../lib/orders';
import { useCheckoutState } from './useCheckoutState';
import { CheckoutProgressBar } from './CheckoutProgressBar';
import type { OrderPaymentMethod } from './types';

/** BD mobile numbers only — same rule as the delivery phone field
 *  (components/checkout/AddressFormFields.tsx), kept local here since a
 *  bKash sender number is a distinct field, not the delivery contact. */
function isValidBangladeshiPhone(raw: string): boolean {
  const digitsOnly = raw.replace(/[\s-]/g, '');
  return /^(\+?880|0)1[3-9]\d{8}$/.test(digitsOnly);
}

export function OrderSummaryPage() {
  useDocumentTitle("Order Summary — Naeem's");
  const {
    items,
    isCatalogLoading,
    subtotal,
    zone,
    address,
    promo,
    setPromo,
    discount,
    total,
    finalizeOrder,
    resetAfterOrder,
  } = useCheckoutState();
  const { settings } = useProducts();
  const navigate = useNavigate();

  const [promoInput, setPromoInput] = useState('');
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoSuccess, setPromoSuccess] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);

  const [paymentMethod, setPaymentMethod] = useState<OrderPaymentMethod>('cod');
  const [bkashTrxId, setBkashTrxId] = useState('');
  const [bkashSender, setBkashSender] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ trxId?: string; sender?: string }>({});
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [isPlacing, setIsPlacing] = useState(false);

  const bkashAvailable = settings.shop_bkash_number.trim() !== '';

  // See DeliveryDetailsPage's identical guard — items resolve against the
  // product catalog, which is still empty on a cold load.
  if (isCatalogLoading) {
    return (
      <div className="full-screen-center" aria-label="Loading your order">
        <span className="spinner spinner--large" aria-hidden="true" />
      </div>
    );
  }

  if (items.length === 0 || address.fullName.trim() === '' || address.fullAddress.trim() === '') {
    return <Navigate to={items.length === 0 ? '/cart' : '/checkout/delivery'} replace />;
  }

  const handleApplyPromo = async (e: FormEvent) => {
    e.preventDefault();
    setPromoError(null);
    setPromoSuccess(null);
    const codeInput = promoInput.trim();
    if (codeInput === '') return;

    setIsApplying(true);
    const valid = await findValidPromoCode(codeInput);
    setIsApplying(false);

    if (!valid) {
      setPromoError('Invalid or expired code');
      return;
    }

    const computedDiscount = computePromoDiscount(valid, subtotal);
    setPromo({
      code: valid.code,
      discountType: valid.discountType,
      discountAmount: valid.discountAmount,
      computedDiscount,
    });
    setPromoSuccess(`${valid.code} applied — ${formatTaka(computedDiscount)} off`);
    setPromoInput('');
  };

  const handlePlaceOrder = async () => {
    if (isPlacing) return; // guards against a double-tap firing two orders
    setPlaceError(null);

    if (paymentMethod === 'bkash') {
      const errors: { trxId?: string; sender?: string } = {};
      if (bkashTrxId.trim() === '') errors.trxId = 'Transaction ID is required';
      if (bkashSender.trim() === '') {
        errors.sender = 'Your bKash number is required';
      } else if (!isValidBangladeshiPhone(bkashSender)) {
        errors.sender = 'Enter a valid Bangladeshi phone number';
      }
      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        return;
      }
    }
    setFieldErrors({});
    setIsPlacing(true);

    const result = await placeOrder({
      items,
      address,
      deliveryZone: zone.id,
      paymentMethod,
      bkashTrxId: paymentMethod === 'bkash' ? bkashTrxId.trim() : undefined,
      bkashSender: paymentMethod === 'bkash' ? bkashSender.trim() : undefined,
      promoCode: promo?.code ?? null,
    });

    setIsPlacing(false);

    if (result.error || !result.orderId || !result.orderNumber) {
      setPlaceError(result.error ?? 'Could not place your order. Please try again.');
      return;
    }

    finalizeOrder({
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      paymentMethod,
      bkashTrxId: paymentMethod === 'bkash' ? bkashTrxId.trim() : null,
    });
    resetAfterOrder();
    navigate('/checkout/success');
  };

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">Order Summary</h1>
        <div className="detail-header__actions" />
      </header>

      <CheckoutProgressBar currentStep={3} />

      <main className="detail-main">
        <div className="checkout-summary-card">
          <h2 className="checkout-summary-card__title">My Order</h2>

          <ul className="checkout-summary-card__items">
            {items.map((item) => (
              <li
                key={`${item.product.id}::${item.variantId ?? ''}`}
                className="checkout-summary-card__item"
              >
                <span className="checkout-summary-card__thumb">
                  {item.variantImage ?? coverImage(item.product) ? (
                    <img src={item.variantImage ?? coverImage(item.product) ?? ''} alt={item.product.name} />
                  ) : (
                    <span className="checkout-summary-card__thumb-empty" aria-hidden="true" />
                  )}
                </span>
                <span className="checkout-summary-card__item-name">
                  {item.product.name}
                  {item.variantLabel && (
                    <span className="checkout-summary-card__item-variant">
                      {item.variantLabel}
                    </span>
                  )}
                  <span className="checkout-summary-card__item-qty">&times;{item.quantity}</span>
                </span>
                <span className="checkout-summary-card__item-price">
                  {formatTaka(item.unitPrice * item.quantity)}
                </span>
              </li>
            ))}
          </ul>

          <form onSubmit={handleApplyPromo} className="checkout-summary-card__promo">
            <input
              type="text"
              className="checkout-summary-card__promo-input"
              placeholder="Have a promo code?"
              value={promoInput}
              onChange={(e) => setPromoInput(e.target.value)}
              aria-label="Promo code"
            />
            <button
              type="submit"
              className="checkout-summary-card__promo-apply"
              disabled={isApplying || promoInput.trim() === ''}
            >
              {isApplying ? <span className="spinner" aria-hidden="true" /> : 'Apply'}
            </button>
          </form>
          {promoError && (
            <p className="checkout-summary-card__promo-message checkout-summary-card__promo-message--error">
              {promoError}
            </p>
          )}
          {promoSuccess && !promoError && (
            <p className="checkout-summary-card__promo-message checkout-summary-card__promo-message--success">
              {promoSuccess}
            </p>
          )}

          <div className="checkout-summary-card__divider" />

          <div className="checkout-summary-card__row">
            <span>Subtotal</span>
            <span>{formatTaka(subtotal)}</span>
          </div>
          <div className="checkout-summary-card__row">
            <span>Delivery ({zone.label})</span>
            <span>{formatTaka(zone.fee)}</span>
          </div>
          {promo && (
            <div className="checkout-summary-card__row checkout-summary-card__row--discount">
              <span>Promo ({promo.code})</span>
              <span>&minus;{formatTaka(discount)}</span>
            </div>
          )}
          <div className="checkout-summary-card__row checkout-summary-card__row--total">
            <span>Total payment</span>
            <span>{formatTaka(total)}</span>
          </div>
        </div>

        <section className="checkout-payment" aria-label="Payment method">
          <h2 className="checkout-payment__title">Payment method</h2>

          <div className="checkout-payment__options">
            <button
              type="button"
              className={`checkout-payment__option${paymentMethod === 'cod' ? ' checkout-payment__option--selected' : ''}`}
              onClick={() => setPaymentMethod('cod')}
              aria-pressed={paymentMethod === 'cod'}
            >
              <span className="checkout-payment__option-radio" aria-hidden="true" />
              <span className="checkout-payment__option-label">Cash on Delivery</span>
            </button>

            {bkashAvailable && (
              <button
                type="button"
                className={`checkout-payment__option${paymentMethod === 'bkash' ? ' checkout-payment__option--selected' : ''}`}
                onClick={() => setPaymentMethod('bkash')}
                aria-pressed={paymentMethod === 'bkash'}
              >
                <span className="checkout-payment__option-radio" aria-hidden="true" />
                <span className="checkout-payment__option-label">bKash-এ আগাম পেমেন্ট</span>
              </button>
            )}
          </div>

          {paymentMethod === 'bkash' && bkashAvailable && (
            <div className="checkout-bkash">
              <p className="checkout-bkash__instructions">
                এই নম্বরে <strong>{formatTaka(total)}</strong> Send Money করুন, তারপর নিচে
                Transaction ID দিন।
              </p>
              <div className="checkout-bkash__number">{settings.shop_bkash_number}</div>

              <div className="form-field">
                <label className="form-label" htmlFor="bkash-trx-id">
                  Transaction ID <span className="form-required" aria-hidden="true">*</span>
                </label>
                <input
                  id="bkash-trx-id"
                  type="text"
                  className="form-input"
                  value={bkashTrxId}
                  onChange={(e) => setBkashTrxId(e.target.value.toUpperCase())}
                  placeholder="e.g. 9AK2XYZ1AB"
                />
                {fieldErrors.trxId && (
                  <p className="form-error" role="alert">
                    {fieldErrors.trxId}
                  </p>
                )}
              </div>

              <div className="form-field">
                <label className="form-label" htmlFor="bkash-sender">
                  Your bKash number <span className="form-required" aria-hidden="true">*</span>
                </label>
                <input
                  id="bkash-sender"
                  type="tel"
                  inputMode="tel"
                  className="form-input"
                  value={bkashSender}
                  onChange={(e) => setBkashSender(e.target.value)}
                  placeholder="01XXXXXXXXX"
                />
                {fieldErrors.sender && (
                  <p className="form-error" role="alert">
                    {fieldErrors.sender}
                  </p>
                )}
              </div>
            </div>
          )}
        </section>

        {placeError && (
          <p className="checkout-summary-page__error" role="alert">
            {placeError}
          </p>
        )}

        <button
          type="button"
          className="button button--primary checkout-summary-page__pay"
          onClick={handlePlaceOrder}
          disabled={isPlacing}
        >
          {isPlacing ? <span className="spinner" aria-hidden="true" /> : 'Place order'}
        </button>
      </main>
    </div>
  );
}
