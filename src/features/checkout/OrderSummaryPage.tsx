// Step 3 of the checkout flow. Read-only review of the order (editing a
// quantity happens back on CartPage) plus promo code entry (unchanged from
// before) and, new in Batch 18, the payment method choice. "Place order"
// calls place_order() (migration-021) — the database re-checks every price
// and stock level itself, so nothing here is trusted once it reaches the
// server. On success the real order id/number becomes the lastOrder
// snapshot and the cart is cleared; on failure the cart is left exactly as
// it was so the customer can fix whatever was wrong (out of stock, a promo
// that just expired) and try again.
//
// Batch 48: this is the "Payment" step. Cash on Delivery first, then the
// "Pay in advance" group (bKash and Nagad — same shop number). Paying in
// advance takes the advance-payment discount off the products (after the
// promo code; never off delivery). The amount shown here is only a
// preview: place_order() works it out again from the setting.
//
// Batch 60: "Use wallet balance" (the customer's store wallet, shown when
// it has money; off each time). The wallet pays first; the advance discount
// works only on the part paid in advance, and only when that part is
// ৳1,000 or more. place_order_wallet() checks the balance again.
import { useState, type FormEvent, type ReactNode } from 'react';
import { PAY_ON_DELIVERY_LABEL } from '../../lib/checkoutCopy';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { BackButton } from '../../components/shared/BackButton';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useProducts } from '../../contexts/ProductContext';
import { cardImage } from '../../lib/productImages';
import { formatTaka } from '../../lib/format';
import { computePromoDiscount, findValidPromoCode } from '../../lib/promoCodes';
import { placeOrder } from '../../lib/orders';
import { isStockError } from '../../lib/cartStock';
import { StockNotice } from '../../components/checkout/StockNotice';
import { useCartStockCheck } from '../../hooks/useCartStockCheck';
import { useCheckoutState } from './useCheckoutState';
import type { CartItem } from './types';
import { supabase } from '../../lib/supabase';
import { liveCampaignsNow, parseCampaigns, setLiveCampaigns, type LiveCampaign } from '../../lib/campaigns';
import { CheckoutProgressBar } from './CheckoutProgressBar';
import {
  WALLET_NAMES,
  advanceLineLabel,
  advanceOfferActive,
  advanceOfferBadge,
  advanceRuleFromSettings,
  isWalletMethod,
  promoDiscountRounded,
  type WalletMethod,
} from '../../lib/advanceDiscount';
import { useCountTo } from '../../hooks/useCountTo';
import { useMyStoreWallet } from '../../hooks/useMyStoreWallet';
import { Switch } from '../../components/shared/Switch';
import { advanceDiscountFor, advanceQualifies, splitStoreWallet } from '../../lib/storeWallet';
import '../../styles/checkoutFinish.css';

type CheckoutPaymentMethod = 'cod' | WalletMethod;

const ALL_ON_SALE = "Every item in your cart is already on sale, so this code can't be used.";

/** Batch 66: asks the database again which campaigns are live. False (and
 *  the shop's prices refreshed) when a campaign touching this cart ended,
 *  started or changed since the screen was drawn. */
async function salesUnchanged(items: CartItem[]): Promise<boolean> {
  const { data, error } = await supabase.rpc('live_campaigns');
  if (error) return true;
  const fresh = parseCampaigns(data);
  const now = Date.now();
  const ids = new Set(items.map((item) => item.product.id));
  const touching = (list: LiveCampaign[]) =>
    JSON.stringify(
      list
        .filter((c) => new Date(c.starts_at).getTime() <= now && now < new Date(c.ends_at).getTime())
        .filter((c) => c.items.some((i) => ids.has(i.product_id)))
        .map((c) => ({ id: c.id, mode: c.discount_mode, percent: c.percent, items: c.items.filter((i) => ids.has(i.product_id)) }))
        .sort((a, b) => a.id.localeCompare(b.id))
    );
  const same = touching(fresh) === touching(liveCampaignsNow(now));
  if (!same) setLiveCampaigns(fresh);
  return same;
}

const WALLET_LOGOS: Record<WalletMethod, string> = {
  bkash: '/payment/bkash.png',
  nagad: '/payment/nagad.png',
};

function CashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6 9.5v5M18 9.5v5" />
    </svg>
  );
}

/** One payment row: icon or logo on the left, the name, the round select
 *  button on the right. */
function PaymentOption({
  method,
  checked,
  onSelect,
  icon,
  label,
}: {
  method: CheckoutPaymentMethod;
  checked: boolean;
  onSelect: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={`cf-opt cf-opt--${method}`}
      onClick={onSelect}
      data-testid={`pay-option-${method}`}
    >
      {icon}
      <span>{label}</span>
      <i className="cf-opt__radio" aria-hidden="true" />
    </button>
  );
}

/** BD mobile numbers only — same rule as the delivery phone field
 *  (components/checkout/AddressFormFields.tsx), kept local here since a
 *  bKash sender number is a distinct field, not the delivery contact. */
function isValidBangladeshiPhone(raw: string): boolean {
  const digitsOnly = raw.replace(/[\s-]/g, '');
  return /^(\+?880|0)1[3-9]\d{8}$/.test(digitsOnly);
}

export function OrderSummaryPage() {
  useDocumentTitle("Order Summary | NAEEM'S");
  const {
    items,
    isCatalogLoading,
    subtotal,
    promoBase,
    savings,
    zone,
    address,
    promo,
    setPromo,
    discount,
    finalizeOrder,
    resetAfterOrder,
  } = useCheckoutState();
  const { settings } = useProducts();
  const navigate = useNavigate();

  const [promoInput, setPromoInput] = useState('');
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoSuccess, setPromoSuccess] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);

  const [paymentMethod, setPaymentMethod] = useState<CheckoutPaymentMethod>('cod');
  const [bkashTrxId, setBkashTrxId] = useState('');
  const [bkashSender, setBkashSender] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ trxId?: string; sender?: string }>({});
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [isPlacing, setIsPlacing] = useState(false);
  // Batch 33: stock is checked again before this last step, and after an
  // order is refused because someone else just bought the last one.
  const { recheck } = useCartStockCheck();

  const bkashAvailable = settings.shop_bkash_number.trim() !== '';
  // Nagad arrives with migration-049 (its setting rows); before that
  // place_order() refuses it, so it is not offered.
  const nagadAvailable = bkashAvailable && settings.advance_discount_type.trim() !== '';
  const rule = advanceRuleFromSettings(settings);
  const offer = advanceOfferActive(rule);
  // The promo code first (to the paisa, as the database keeps it), then the
  // advance discount on what is left of the products.
  const promoPart = promoDiscountRounded(discount);
  // Batch 60: the store wallet pays first (only when switched on).
  const { wallet: myStore, reload: reloadStore } = useMyStoreWallet({ toast: false, cache: false });
  // Batch 62: only an open wallet (a closed one never holds money anyway).
  const storeBalance = myStore.available && myStore.open ? myStore.balance : 0;
  const [useStore, setUseStore] = useState(false);
  const payTotalBeforeStore = Math.max(0, subtotal + zone.fee - promoPart);
  const split = splitStoreWallet(payTotalBeforeStore, storeBalance, useStore && storeBalance > 0);
  const fromStore = split.fromStore;
  const fullyPaid = split.fullyPaid;
  const method: CheckoutPaymentMethod = fullyPaid ? 'cod' : paymentMethod;
  // Batch 66: like the promo code, only on the items not in a campaign.
  const advance = advanceDiscountFor({ rule, productsAfterPromo: promoBase - promoPart, leftAfterStore: split.rest, method });
  const offerShown = offer && advanceQualifies(split.rest);
  const payTotal = Math.max(0, subtotal + zone.fee - promoPart - advance);
  // What is still to pay after the wallet (the total line).
  const payLeft = Math.max(0, Math.round((payTotal - fromStore) * 100) / 100);
  const shownTotal = useCountTo(payLeft);
  const wallet = isWalletMethod(method) ? method : null;

  const choose = (method: CheckoutPaymentMethod) => {
    setPaymentMethod(method);
    setFieldErrors({});
  };

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

    // Batch 66: every item is already on sale: the code is not applied
    // (not an "invalid code" message — the code itself is fine).
    if (promoBase <= 0) {
      setPromoError(ALL_ON_SALE);
      setPromoInput('');
      return;
    }
    const computedDiscount = computePromoDiscount(valid, promoBase);
    setPromo({
      code: valid.code,
      discountType: valid.discountType,
      discountAmount: valid.discountAmount,
      computedDiscount,
    });
    setPromoSuccess(`${valid.code} applied, ${formatTaka(computedDiscount)} off`);
    setPromoInput('');
  };

  const handlePlaceOrder = async () => {
    if (isPlacing) return; // guards against a double-tap firing two orders
    setPlaceError(null);

    if (wallet) {
      const errors: { trxId?: string; sender?: string } = {};
      if (bkashTrxId.trim() === '') errors.trxId = 'Transaction ID is required';
      if (bkashSender.trim() === '') {
        errors.sender = `Your ${WALLET_NAMES[wallet]} number is required`;
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

    // Batch 66: a sale that ended (or was switched off) since this screen
    // was drawn would change the total: check before placing.
    if (!(await salesUnchanged(items))) {
      setIsPlacing(false);
      setPlaceError('Prices changed because a sale ended. Please check your total.');
      return;
    }

    const result = await placeOrder({
      items,
      address,
      deliveryZone: zone.id,
      paymentMethod: method,
      bkashTrxId: wallet ? bkashTrxId.trim() : undefined,
      bkashSender: wallet ? bkashSender.trim() : undefined,
      promoCode: promo?.code ?? null,
      storeWallet: fromStore,
    });

    if (result.error && isStockError(result.error)) {
      // Never the database's own words: correct the cart to what is left
      // and show the calm "just sold out" message instead.
      const changed = await recheck();
      setIsPlacing(false);
      setPlaceError(
        changed ? null : 'Something in your cart just changed. Please check your cart and try again.'
      );
      return;
    }

    setIsPlacing(false);

    if (result.error || !result.orderId || !result.orderNumber) {
      setPlaceError(result.error ?? 'Could not place your order. Please try again.');
      // Batch 60: the balance changed somewhere else; show the new one.
      if (fromStore > 0) void reloadStore();
      return;
    }

    finalizeOrder({
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      paymentMethod: method,
      bkashTrxId: wallet ? bkashTrxId.trim() : null,
      advanceDiscount: advance,
      advanceRule: advance > 0 ? { type: rule.type, value: rule.value } : null,
      saved: result.saved
        ? { total: result.saved.total, advanceDiscount: result.saved.advanceDiscount, storeWallet: result.saved.storeWallet }
        : null,
      buysLater: result.buysLater,
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
        <StockNotice />
        <div className="checkout-summary-card">
          <h2 className="checkout-summary-card__title">My Order</h2>

          <ul className="checkout-summary-card__items">
            {items.map((item) => (
              <li
                key={`${item.product.id}::${item.variantId ?? ''}`}
                className="checkout-summary-card__item"
              >
                <span className="checkout-summary-card__thumb">
                  {item.variantImage ?? cardImage(item.product) ? (
                    <img
                      src={item.variantImage ?? cardImage(item.product) ?? ''}
                      alt={item.product.name}
                      width={64}
                      height={64}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <span className="checkout-summary-card__thumb-empty" aria-hidden="true" />
                  )}
                </span>
                {/* Batch 47: the name wraps to two lines (never cut on one),
                    and the quantity sits under the price. */}
                <span className="checkout-summary-card__item-text">
                  <span className="checkout-summary-card__item-name" data-testid="summary-item-name">
                    {item.product.name}
                  </span>
                  {item.variantLabel && (
                    <span className="checkout-summary-card__item-variant">
                      {item.variantLabel}
                    </span>
                  )}
                </span>
                <span className="checkout-summary-card__item-side">
                  <span className="checkout-summary-card__item-price">
                    {formatTaka(item.unitPrice * item.quantity)}
                  </span>
                  <span className="checkout-summary-card__item-qty" data-testid="summary-item-qty">
                    &times; {item.quantity}
                  </span>
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
          {promoSuccess && !promoError && (!promo || discount > 0) && (
            <p className="checkout-summary-card__promo-message checkout-summary-card__promo-message--success">
              {promoSuccess}
            </p>
          )}
          {promo && promoBase <= 0 && !promoError && (
            <p className="cmp-promo-hint" data-testid="promo-all-on-sale">
              {ALL_ON_SALE}
            </p>
          )}
          {promo && discount > 0 && savings && (
            <p className="cmp-promo-hint" data-testid="promo-sale-hint">
              {promo.code} took {formatTaka(promoPart)} off. {savings.name === 'Sale' ? 'Sale' : savings.name} items already have their
              sale price, so the code skips them.
            </p>
          )}

          <div className="checkout-summary-card__divider" />

          <div className="checkout-summary-card__row">
            <span>Subtotal</span>
            {/* Batch 66: at normal prices when items are on sale, so the
                savings row below adds up to the total. */}
            <span data-testid="summary-subtotal">{formatTaka(subtotal + (savings?.amount ?? 0))}</span>
          </div>
          {savings && savings.amount > 0 && (
            <div className="checkout-summary-card__row" data-testid="summary-campaign-savings">
              <span>{savings.label}</span>
              <span>&minus;{formatTaka(savings.amount)}</span>
            </div>
          )}
          {promo && discount > 0 && (
            <div className="checkout-summary-card__row checkout-summary-card__row--discount">
              <span>Promo ({promo.code})</span>
              <span>&minus;{formatTaka(promoPart)}</span>
            </div>
          )}
          {advance > 0 && (
            <div className="checkout-summary-card__row checkout-summary-card__row--advance cf-row-in" data-testid="summary-advance">
              <span>{advanceLineLabel(rule.type, rule.value)}</span>
              <span>&minus;{formatTaka(advance)}</span>
            </div>
          )}
          <div className="checkout-summary-card__row">
            <span>Delivery ({zone.label})</span>
            <span>{formatTaka(zone.fee)}</span>
          </div>
          {fromStore > 0 && (
            <div className="checkout-summary-card__row cf-row-in" data-testid="summary-store-wallet">
              <span>Paid from wallet</span>
              <span>&minus;{formatTaka(fromStore)}</span>
            </div>
          )}
          <div className="checkout-summary-card__row checkout-summary-card__row--total" data-testid="summary-total">
            {/* Batch 47: cash on delivery is paid to the rider, not now. */}
            <span>{fullyPaid ? 'Left to pay' : method === 'cod' ? PAY_ON_DELIVERY_LABEL : 'Total payment'}</span>
            <span data-total={payLeft}>{formatTaka(shownTotal)}</span>
          </div>
        </div>

        {storeBalance > 0 && (
          <div className={`mw-use${useStore ? ' mw-use--on' : ''}`} data-testid="checkout-use-wallet">
            <div className="mw-use__row">
              <span>
                <span className="mw-use__title">Use wallet balance</span>
                <br />
                <span className="mw-use__have">You have {formatTaka(storeBalance)}</span>
              </span>
              <Switch checked={useStore} onChange={setUseStore} label="Use wallet balance" />
            </div>
            {useStore && !fullyPaid && (
              <div className="mw-use__split" data-testid="checkout-wallet-split">
                <div>
                  <span>From wallet</span>
                  <b>{formatTaka(fromStore)}</b>
                </div>
                <div>
                  <span>{method === 'cod' ? 'On delivery' : 'Pay now'}</span>
                  <b>{formatTaka(payLeft)}</b>
                </div>
              </div>
            )}
            {useStore && fullyPaid && (
              <div className="mw-paid" data-testid="checkout-wallet-full">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                Fully paid from your wallet
              </div>
            )}
          </div>
        )}

        {!fullyPaid && (
        <section className="cf-pay" aria-label="Payment method">
          <h2 className="cf-pay__title">Payment method</h2>

          <div className="cf-pay__opts" role="radiogroup" aria-label="Payment method">
            <PaymentOption
              method="cod"
              checked={paymentMethod === 'cod'}
              onSelect={() => choose('cod')}
              label="Cash on Delivery"
              icon={
                <span className="cf-opt__icon">
                  <CashIcon />
                </span>
              }
            />

            {bkashAvailable && (
              <div
                className={`cf-adv${offerShown ? '' : ' cf-adv--plain'}${wallet ? ' cf-adv--picked' : ''}`}
                data-testid="pay-advance-group"
              >
                {offerShown && (
                  <div className="cf-adv__head">
                    <b>Pay in advance</b>
                    <span className="cf-adv__badge" data-testid="advance-badge">
                      {advanceOfferBadge(rule)}
                    </span>
                  </div>
                )}
                <PaymentOption
                  method="bkash"
                  checked={paymentMethod === 'bkash'}
                  onSelect={() => choose('bkash')}
                  label={WALLET_NAMES.bkash}
                  icon={
                    <span className="cf-opt__icon cf-opt__icon--logo">
                      <img src={WALLET_LOGOS.bkash} alt="" width={22} height={22} />
                    </span>
                  }
                />
                {nagadAvailable && (
                  <PaymentOption
                    method="nagad"
                    checked={paymentMethod === 'nagad'}
                    onSelect={() => choose('nagad')}
                    label={WALLET_NAMES.nagad}
                    icon={
                      <span className="cf-opt__icon cf-opt__icon--logo">
                        <img src={WALLET_LOGOS.nagad} alt="" width={22} height={22} />
                      </span>
                    }
                  />
                )}

                {wallet && (
                  <div key={wallet} className={`cf-wallet cf-wallet--${wallet} cf-row-in`} data-testid="wallet-box">
                    <p className="cf-wallet__head">
                      <img src={WALLET_LOGOS[wallet]} alt="" width={20} height={20} />
                      Pay with {WALLET_NAMES[wallet]}
                    </p>
                    <p className="cf-wallet__text">
                      Send Money <b data-testid="wallet-amount">{formatTaka(payLeft)}</b> to this number, then enter the
                      Transaction ID below.
                    </p>
                    <div className="cf-wallet__number">{settings.shop_bkash_number}</div>

                    <div className="cf-wallet__field">
                      <label htmlFor="wallet-trx-id">
                        Transaction ID <i aria-hidden="true">*</i>
                      </label>
                      <input
                        id="wallet-trx-id"
                        type="text"
                        autoComplete="off"
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

                    <div className="cf-wallet__field">
                      <label htmlFor="wallet-sender">
                        Your {WALLET_NAMES[wallet]} number <i aria-hidden="true">*</i>
                      </label>
                      <input
                        id="wallet-sender"
                        type="tel"
                        inputMode="tel"
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
              </div>
            )}
          </div>
        </section>
        )}

        {placeError && (
          <p className="checkout-summary-page__error" role="alert">
            {placeError}
          </p>
        )}

        <p className="checkout-summary-page__consent">
          By placing this order you agree to our <Link to="/terms">Terms</Link> and{' '}
          <Link to="/return-policy">Return policy</Link>.
        </p>

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
