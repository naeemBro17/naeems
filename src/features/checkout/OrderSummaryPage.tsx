// Step 3 of the checkout flow. Read-only review of the order (editing a
// quantity happens back on CartPage) plus promo code entry — promo codes
// live ONLY on this screen, never on the cart page. Validates the code
// against Supabase (never hardcoded client-side) via lib/promoCodes.
// "Pay and Order" finalizes the order snapshot via useCheckoutState and
// routes to OrderSuccessPage; there is no payment gateway.
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { BackButton } from '../../components/shared/BackButton';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { coverImage } from '../../lib/productImages';
import { formatTaka } from '../../lib/format';
import { computePromoDiscount, findValidPromoCode } from '../../lib/promoCodes';
import { useCheckoutState } from './useCheckoutState';
import { CheckoutProgressBar } from './CheckoutProgressBar';

export function OrderSummaryPage() {
  useDocumentTitle("Order Summary — Naeem's");
  const { items, subtotal, zone, address, promo, setPromo, discount, total, finalizeOrder } =
    useCheckoutState();
  const navigate = useNavigate();

  const [promoInput, setPromoInput] = useState('');
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoSuccess, setPromoSuccess] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);

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

  const handlePayAndOrder = () => {
    finalizeOrder();
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

        <button
          type="button"
          className="button button--primary checkout-summary-page__pay"
          onClick={handlePayAndOrder}
        >
          Pay and Order
        </button>
      </main>
    </div>
  );
}
