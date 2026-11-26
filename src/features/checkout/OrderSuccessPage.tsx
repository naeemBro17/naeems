import { ActionLink } from '../../components/shared/ActionLink';
// The final confirmation screen after checkout. Reads the order snapshot
// useCheckoutState captured the instant place_order() succeeded (not the
// live cart, which is already cleared and reset by the time this page is
// reached — see OrderSummaryPage). The order itself is already saved in
// the database with a real order number; this screen is just a receipt,
// "what happens next", and a way to the order's own page or back to
// shopping. Promo usage is committed server-side inside place_order().
//
// Batch 48: rebuilt to docs/design/batch-48-checkout-mockup.html — no
// stepper; the customer's name rolls up letter by letter.
// Batch 69: the serum drop is replaced by the shop-to-home van scene
// (PlacedScene): a parcel leaves the NAEEM'S shop, hops into the van and the
// van drives toward the customer's home (transform and opacity only). It
// plays once, when the customer arrives from "Place order"; a reload (or
// reduced motion) shows the still final picture.
import { useEffect, useState, type CSSProperties } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { formatTaka } from '../../lib/format';
import { invoiceFromSnapshot } from '../../lib/invoice/invoiceData';
import { downloadInvoice, makeInvoiceFile } from '../../lib/invoice/invoiceOutput';
import { useProducts } from '../../contexts/ProductContext';
import { trackPurchase } from '../../lib/analytics';
import { placedPaymentLabel, placedTotalLabel } from '../../lib/checkoutCopy';
import { isWalletMethod } from '../../lib/advanceDiscount';
import { openExternal, orderHelpWhatsAppUrl } from '../../lib/expertLinks';
import { useCheckoutState } from './useCheckoutState';
import { arrivalText } from '../../lib/sellRules';
import { PlacedScene } from '../../components/checkout/PlacedScene';
import '../../styles/checkoutFinish.css';
import '../../styles/batch69.css';

/** Names longer than this use the smaller hero size. */
const LONG_NAME = 16;

type CssVars = CSSProperties & Record<`--${string}`, string>;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M4 19h16" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.5L3.5 20.5l1.6-5A8.5 8.5 0 1 1 21 11.5z" />
    </svg>
  );
}

/** "Ashraful Islam!" as words of letters that roll up one after another. */
function HeroName({ name }: { name: string }) {
  const text = `${name}!`;
  let index = 0;
  return (
    <h2 className={`cf-name${name.length > LONG_NAME ? ' cf-name--long' : ''}`} aria-label={text} data-testid="placed-name">
      {text.split(/\s+/).map((word, w) => (
        <span key={w} className="cf-name__w" aria-hidden="true">
          {Array.from(word).map((letter, l) => (
            <span key={l} style={{ '--i': String(index++) } as CssVars}>
              {letter}
            </span>
          ))}
        </span>
      ))}
    </h2>
  );
}

const fadeUp = (offset: string): CssVars => ({ '--o': offset });

export function OrderSuccessPage() {
  useDocumentTitle("Order Placed | NAEEM'S");
  const { lastOrder, markCelebrated } = useCheckoutState();
  const { settings } = useProducts();
  const [isMakingInvoice, setIsMakingInvoice] = useState(false);
  const [invoiceError, setInvoiceError] = useState(false);
  const navigate = useNavigate();
  // Decided once, on arrival: play only straight after "Place order".
  const [play] = useState(() => Boolean(lastOrder && !lastOrder.celebrated && !prefersReducedMotion()));

  // The order number is passed as both trackers' event/transaction id, so
  // even if this effect (or a page refresh landing back here) fires twice,
  // Meta/GA4 de-duplicate by that id instead of double-counting the sale.
  useEffect(() => {
    if (!lastOrder) return;
    trackPurchase(lastOrder.orderNumber, lastOrder.total);
  }, [lastOrder?.orderNumber, lastOrder?.total]);

  // Played (or skipped) once — a reload shows the final state.
  useEffect(() => {
    if (lastOrder && !lastOrder.celebrated) markCelebrated();
  }, [lastOrder, markCelebrated]);

  // Batch 69: a short buzz when the parcel lands in the van, a double one
  // as the van drives off. Never with reduced motion (play is off then).
  useEffect(() => {
    if (!play) return;
    const buzz = (pattern: number | number[]) => {
      try {
        if (typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
      } catch {
        // Some browsers refuse vibration outright; the screen is the same.
      }
    };
    const timers = [window.setTimeout(() => buzz(12), 1300), window.setTimeout(() => buzz([14, 60, 20]), 1650)];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [play]);

  if (!lastOrder) {
    return <Navigate to="/cart" replace />;
  }

  // Batch 47: no dead end — WhatsApp to the shop with the order number.
  const helpHref = orderHelpWhatsAppUrl(settings, lastOrder.orderNumber);
  const itemCount = lastOrder.items.reduce((sum, item) => sum + item.quantity, 0);
  const paidInAdvance = isWalletMethod(lastOrder.paymentMethod);
  const saved = lastOrder.advanceDiscount ?? 0;
  // Batch 60: the part paid from the customer's wallet.
  const fromStore = lastOrder.storeWallet ?? 0;
  const leftToPay = Math.max(0, Math.round((lastOrder.total - fromStore) * 100) / 100);
  // Batch 51: "Arriving Fri, 20 – Sat, 21 Nov" from the order date, the
  // delivery zone and the slowest item.
  const arriving = arrivalText(lastOrder.placedAt, lastOrder.zone.id, lastOrder.buysLater === true, settings);

  // Batch 37: the same A4 invoice the shop prints (the customer's copy).
  const handleDownloadInvoice = async () => {
    setIsMakingInvoice(true);
    setInvoiceError(false);
    try {
      const file = await makeInvoiceFile([invoiceFromSnapshot(lastOrder)], settings, `Invoice-${lastOrder.orderNumber}.pdf`);
      downloadInvoice(file);
    } catch {
      setInvoiceError(true);
    } finally {
      setIsMakingInvoice(false);
    }
  };

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <h1 className="detail-header__title">Order Placed</h1>
      </header>

      <main className={`detail-main cf-placed cf-b69${play ? ' cf-play' : ''}`} data-testid="order-placed" data-played={play ? 'yes' : 'no'}>
        <PlacedScene play={play} />

        <p className="cf-thx cf-fu" style={fadeUp('0s')}>
          Thank you,
        </p>
        <HeroName name={lastOrder.address.fullName.trim()} />
        <p className="cf-placed__text cf-fu" style={fadeUp('.44s')}>
          Your order has been placed.
        </p>
        <div className="cf-onum cf-fu" style={fadeUp('.52s')}>
          <span data-testid="placed-order-number">
            Order no. <b>{lastOrder.orderNumber}</b>
          </span>
        </div>
        {arriving && (
          <p className="cf-arrive cf-fu" style={fadeUp('.56s')} data-testid="placed-arriving">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2.5 6.5h11v9h-11z" />
              <path d="M13.5 9.5h4l3 3v3h-7z" />
              <circle cx="6.5" cy="17.5" r="1.6" />
              <circle cx="17" cy="17.5" r="1.6" />
            </svg>
            {arriving}
          </p>
        )}

        <div className="cf-sum cf-fu" style={fadeUp('.6s')}>
          <div className="cf-sr">
            <span>Items</span>
            <b>
              {itemCount} item{itemCount === 1 ? '' : 's'}
            </b>
          </div>
          <div className="cf-sr">
            <span>Payment</span>
            <b data-testid="placed-payment">{fromStore > 0 && leftToPay <= 0 ? 'Wallet' : placedPaymentLabel(lastOrder.paymentMethod)}</b>
          </div>
          {fromStore > 0 && (
            <div className="cf-sr" data-testid="placed-store-wallet">
              <span>Paid from wallet</span>
              <b>&minus;{formatTaka(fromStore)}</b>
            </div>
          )}
          {paidInAdvance && saved > 0 && (
            <div className="cf-sr cf-sr--saved" data-testid="placed-saved">
              <span>You saved</span>
              <b>{formatTaka(saved)}</b>
            </div>
          )}
          <div className="cf-sr cf-sr--due" data-testid="placed-total">
            <span>{fromStore > 0 && leftToPay <= 0 ? 'Left to pay' : placedTotalLabel(lastOrder.paymentMethod)}</span>
            <b>{formatTaka(fromStore > 0 ? leftToPay : lastOrder.total)}</b>
          </div>
        </div>

        <p className="cf-note cf-fu" style={fadeUp('.66s')}>
          We will confirm your order soon. Any questions? Tap &quot;Need help?&quot; to contact us.
        </p>

        <div className="cf-acts cf-fu" style={fadeUp('.72s')}>
          <ActionLink to={`/orders/${lastOrder.orderId}`} className="button button--primary button--full" onOpen={() => navigate(`/orders/${lastOrder.orderId}`)}>
            View my order
          </ActionLink>
          <div className="cf-pair" style={helpHref ? undefined : { gridTemplateColumns: '1fr' }}>
            <button type="button" className="cf-ghost" onClick={() => void handleDownloadInvoice()} disabled={isMakingInvoice}>
              {isMakingInvoice ? <span className="spinner" aria-hidden="true" /> : <DownloadIcon />}
              Invoice
            </button>
            {helpHref && (
              <button
                type="button"
                className="cf-ghost"
                onClick={() => openExternal(helpHref)}
                data-testid="placed-need-help"
                data-href={helpHref}
              >
                <ChatIcon />
                Need help?
              </button>
            )}
          </div>
          {invoiceError && (
            <p className="form-error cf-invoice-error" role="alert">
              Could not make the invoice. Check your connection and try again.
            </p>
          )}
          <ActionLink to="/" className="cf-link" onOpen={() => navigate('/')}>
            Continue shopping
          </ActionLink>
        </div>
      </main>
    </div>
  );
}
