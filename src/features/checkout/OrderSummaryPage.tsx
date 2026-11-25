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
import '../../styles/batch67.css';
import { CheckIcon, ChevronRightIcon, CopyIcon, PinIcon, TagIcon, WalletIcon } from '../../components/checkout/b67Icons';
import { countPieces, summaryAddressLine } from '../../lib/cartTotals';

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

/** One payment row: icon or logo on the left, the name (and an optional
 *  line under it), the round select button on the right. */
function PaymentOption({
  method,
  checked,
  onSelect,
  icon,
  label,
  sub,
}: {
  method: CheckoutPaymentMethod;
  checked: boolean;
  onSelect: () => void;
  icon: ReactNode;
  label: string;
  sub?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={`b67-opt cf-opt--${method}`}
      onClick={onSelect}
      data-testid={`pay-option-${method}`}
    >
      {icon}
      <span>
        <b>{label}</b>
        {sub && <small>{sub}</small>}
      </span>
      <i className="b67-opt__radio" aria-hidden="true" />
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
  const [isApplying, setIsApplying] = useState(false);
  // Batch 67: the promo box opens from its row; "Copy" for the shop number.
  const [promoOpen, setPromoOpen] = useState(false);
  const [copied, setCopied] = useState(false);

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
    setPromoInput('');
    setPromoOpen(false);
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

  const totalLabel = fullyPaid ? 'Left to pay' : method === 'cod' ? PAY_ON_DELIVERY_LABEL : 'Total payment';
  const pieceCount = countPieces(items);
  const addressLine = summaryAddressLine(address);
  const copyNumber = () => {
    const number = settings.shop_bkash_number.trim();
    if (!navigator.clipboard) return;
    navigator.clipboard
      .writeText(number)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  };

  // Batch 67: the bKash / Nagad steps right under the chosen wallet.
  const renderWalletBox = (which: WalletMethod) => (
    <div key={which} className={`b67-pay b67-pay--${which} b67-row-in`} data-testid="wallet-box">
      <p className="b67-pay__head">
        <img src={WALLET_LOGOS[which]} alt="" width={20} height={20} />
        Pay with {WALLET_NAMES[which]}
      </p>
      <p className="b67-pay__step">
        <i>1</i>
        <span>
          Send Money <b data-testid="wallet-amount">{formatTaka(payLeft)}</b> to this number
        </span>
      </p>
      <div className="b67-pay__num">
        <b>{settings.shop_bkash_number}</b>
        <button type="button" className="b67-copy" onClick={copyNumber} data-testid="wallet-copy">
          {copied ? <CheckIcon size={13} /> : <CopyIcon />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="b67-pay__step">
        <i>2</i>
        <span>Enter the details below</span>
      </p>
      <div className="b67-pay__field">
        <label htmlFor="wallet-trx-id">Transaction ID *</label>
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
      <div className="b67-pay__field">
        <label htmlFor="wallet-sender">Your {WALLET_NAMES[which]} number *</label>
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
  );

  return (
    <div className="viewer-shell detail-shell b67">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">Order Summary</h1>
        <div className="detail-header__actions" />
      </header>

      <CheckoutProgressBar currentStep={3} />

      <main className="b67-main">
        <StockNotice />

        <section className="b67-card" data-testid="summary-address">
          <div className="b67-ch">
            <h2>Delivering to</h2>
            <Link to="/checkout/delivery">Change</Link>
          </div>
          <div className="b67-addr">
            <span className="b67-icon">
              <PinIcon />
            </span>
            <div>
              <b>{address.fullName}</b>
              <p>
                {address.phone}
                <br />
                {addressLine}
              </p>
              <span className="b67-zone">{zone.label}</span>
            </div>
          </div>
        </section>

        <section className="b67-card">
          <div className="b67-ch" style={{ marginBottom: 2 }}>
            <h2>
              Your order · {pieceCount} {pieceCount === 1 ? 'item' : 'items'}
            </h2>
            <Link to="/cart">Edit</Link>
          </div>
          <ul className="b67-items">
            {items.map((item) => {
              const image = item.variantImage ?? cardImage(item.product);
              return (
                <li key={`${item.product.id}::${item.variantId ?? ''}`} className="b67-it" data-testid="summary-item">
                  <span className="b67-it__th">
                    {image && <img src={image} alt={item.product.name} width={52} height={52} loading="lazy" decoding="async" />}
                    <span className="b67-it__q" data-testid="summary-item-qty">
                      {item.quantity}
                    </span>
                  </span>
                  <span>
                    <span className="b67-it__n" data-testid="summary-item-name">
                      {item.product.name}
                    </span>
                    {item.variantLabel && <span className="b67-it__v">{item.variantLabel}</span>}
                    {item.sale && <span className="b67-it__sale">{item.sale.campaignName} price</span>}
                  </span>
                  <span className="b67-it__p">{formatTaka(item.unitPrice * item.quantity)}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="b67-card b67-card--flush" data-testid="summary-promo">
          {promo && discount > 0 ? (
            <button type="button" className="b67-promo b67-promo--ok" onClick={() => setPromoOpen((open) => !open)} aria-expanded={promoOpen}>
              <span className="b67-promo__ic">
                <CheckIcon size={18} />
              </span>
              <span className="b67-promo__tx">
                {promo.code} applied
                <small>Tap to change</small>
              </span>
              <span className="b67-promo__amt">&minus;{formatTaka(promoPart)}</span>
            </button>
          ) : (
            <button type="button" className="b67-promo" onClick={() => setPromoOpen((open) => !open)} aria-expanded={promoOpen}>
              <span className="b67-promo__ic">
                <TagIcon />
              </span>
              <span className="b67-promo__tx">Add a promo code</span>
              <span className="b67-promo__chev">
                <ChevronRightIcon />
              </span>
            </button>
          )}

          {promoOpen && (
            <form onSubmit={handleApplyPromo} className="b67-promo-form b67-row-in">
              <input
                type="text"
                placeholder="Enter code"
                value={promoInput}
                onChange={(e) => setPromoInput(e.target.value)}
                aria-label="Promo code"
                autoFocus
              />
              <button type="submit" disabled={isApplying || promoInput.trim() === ''}>
                {isApplying ? <span className="spinner" aria-hidden="true" /> : 'Apply'}
              </button>
            </form>
          )}
          {promoError && (
            <p className="b67-promo-msg b67-promo-msg--error" role="alert">
              {promoError}
            </p>
          )}
          {promo && promoBase <= 0 && !promoError && (
            <p className="b67-hint" data-testid="promo-all-on-sale">
              {ALL_ON_SALE}
            </p>
          )}
          {promo && discount > 0 && savings && (
            <p className="b67-hint" data-testid="promo-sale-hint">
              {savings.name === 'Sale' ? 'Sale' : savings.name} items already have their sale price, so the code skips them.
            </p>
          )}
        </section>

        {storeBalance > 0 && (
          <section className="b67-card" data-testid="checkout-use-wallet">
            <div className="b67-wal">
              <span className="b67-icon">
                <WalletIcon />
              </span>
              <span className="b67-wal__tx">
                <b>Use wallet balance</b>
                <small>You have {formatTaka(storeBalance)}</small>
              </span>
              <Switch checked={useStore} onChange={setUseStore} label="Use wallet balance" />
            </div>
            {useStore && !fullyPaid && (
              <div className="b67-split b67-row-in" data-testid="checkout-wallet-split">
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
              <div className="b67-paid b67-row-in" data-testid="checkout-wallet-full">
                <CheckIcon size={16} />
                Fully paid from your wallet
              </div>
            )}
          </section>
        )}

        {!fullyPaid && (
          <section className="b67-card cf-pay" aria-label="Payment method">
            <div className="b67-ch">
              <h2>Payment method</h2>
            </div>
            <div role="radiogroup" aria-label="Payment method">
              <PaymentOption
                method="cod"
                checked={paymentMethod === 'cod'}
                onSelect={() => choose('cod')}
                label="Cash on Delivery"
                sub="Pay the rider when it arrives"
                icon={
                  <span className="b67-opt__logo">
                    <CashIcon />
                  </span>
                }
              />

              {bkashAvailable && (
                <div className="b67-adv" data-testid="pay-advance-group">
                  <div className="b67-adv__head">
                    <b>Pay in advance</b>
                    {offerShown && (
                      <span className="b67-badge" data-testid="advance-badge">
                        {advanceOfferBadge(rule)}
                      </span>
                    )}
                  </div>
                  <PaymentOption
                    method="bkash"
                    checked={paymentMethod === 'bkash'}
                    onSelect={() => choose('bkash')}
                    label={WALLET_NAMES.bkash}
                    icon={
                      <span className="b67-opt__logo b67-opt__logo--brand">
                        <img src={WALLET_LOGOS.bkash} alt="" width={26} height={26} />
                      </span>
                    }
                  />
                  {wallet === 'bkash' && renderWalletBox('bkash')}
                  {nagadAvailable && (
                    <PaymentOption
                      method="nagad"
                      checked={paymentMethod === 'nagad'}
                      onSelect={() => choose('nagad')}
                      label={WALLET_NAMES.nagad}
                      icon={
                        <span className="b67-opt__logo b67-opt__logo--brand">
                          <img src={WALLET_LOGOS.nagad} alt="" width={26} height={26} />
                        </span>
                      }
                    />
                  )}
                  {wallet === 'nagad' && renderWalletBox('nagad')}
                </div>
              )}
            </div>
          </section>
        )}

        <section className="b67-card b67-bill" aria-label="Bill details">
          <div className="b67-ch">
            <h2>Bill details</h2>
          </div>
          <div className="b67-bill__r">
            <span>Subtotal</span>
            {/* Batch 66: at normal prices when items are on sale, so the
                savings row below adds up to the total. */}
            <span data-testid="summary-subtotal">{formatTaka(subtotal + (savings?.amount ?? 0))}</span>
          </div>
          {savings && savings.amount > 0 && (
            <div className="b67-bill__r b67-bill__r--save" data-testid="summary-campaign-savings">
              <span>{savings.label}</span>
              <span>&minus;{formatTaka(savings.amount)}</span>
            </div>
          )}
          {promo && discount > 0 && (
            <div className="b67-bill__r b67-bill__r--save" data-testid="summary-promo-row">
              <span>Promo ({promo.code})</span>
              <span>&minus;{formatTaka(promoPart)}</span>
            </div>
          )}
          {advance > 0 && (
            <div className="b67-bill__r b67-bill__r--save b67-row-in" data-testid="summary-advance">
              <span>{advanceLineLabel(rule.type, rule.value)}</span>
              <span>&minus;{formatTaka(advance)}</span>
            </div>
          )}
          <div className="b67-bill__r">
            <span>Delivery ({zone.label})</span>
            <span>{formatTaka(zone.fee)}</span>
          </div>
          {fromStore > 0 && (
            <div className="b67-bill__r b67-row-in" data-testid="summary-store-wallet">
              <span>Paid from wallet</span>
              <span>&minus;{formatTaka(fromStore)}</span>
            </div>
          )}
          <hr />
          <div className="b67-bill__total" data-testid="summary-total">
            {/* Batch 47: cash on delivery is paid to the rider, not now. */}
            <span>{totalLabel}</span>
            <b data-total={payLeft}>{formatTaka(shownTotal)}</b>
          </div>
        </section>

        {placeError && (
          <p className="b67-error" role="alert">
            {placeError}
          </p>
        )}

        <p className="b67-consent">
          By placing this order you agree to our <Link to="/terms">Terms</Link> and{' '}
          <Link to="/return-policy">Return policy</Link>.
        </p>
      </main>

      <div className="b67-bar" data-testid="summary-bar">
        <div className="b67-bar__total">
          <small>{totalLabel}</small>
          <strong data-testid="summary-bar-total">{formatTaka(shownTotal)}</strong>
        </div>
        <button type="button" className="b67-cta" onClick={handlePlaceOrder} disabled={isPlacing}>
          {isPlacing ? <span className="spinner" aria-hidden="true" /> : 'Place order'}
        </button>
      </div>
    </div>
  );
}
