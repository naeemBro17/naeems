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
// stepper; a serum drop falls from a pipette, splashes and blooms into the
// green tick (transform and opacity only), then the customer's name rolls
// up letter by letter. It plays once, when the customer arrives from
// "Place order"; a reload (or reduced motion) shows the final state.
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
import '../../styles/checkoutFinish.css';

/** When the drop splashes (ms after the sequence starts). */
const SPLASH_AT_MS = 1420;
/** Names longer than this use the smaller hero size. */
const LONG_NAME = 16;

type CssVars = CSSProperties & Record<`--${string}`, string>;

interface Droplet {
  style: CssVars;
  tone: 1 | 2;
}

/** Nine small droplets thrown up and out by the splash. */
function makeDroplets(): Droplet[] {
  return Array.from({ length: 9 }, (_, i) => {
    const angle = Math.PI + (i / 8) * Math.PI + (Math.random() - 0.5) * 0.25;
    const distance = 34 + Math.random() * 30;
    const size = 4 + Math.round(Math.random() * 4);
    return {
      tone: i % 2 ? 1 : 2,
      style: {
        '--dx': `${(Math.cos(angle) * distance).toFixed(1)}px`,
        '--dy': `${(Math.sin(angle) * distance).toFixed(1)}px`,
        '--d': `${(1.42 + Math.random() * 0.08).toFixed(2)}s`,
        width: `${size}px`,
        height: `${size}px`,
        margin: `${-size / 2}px 0 0 ${-size / 2}px`,
      },
    };
  });
}

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
  const [droplets] = useState(makeDroplets);

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

  // A short buzz on Android as the drop lands. Never with reduced motion.
  useEffect(() => {
    if (!play) return;
    const timer = window.setTimeout(() => {
      try {
        if (typeof navigator.vibrate === 'function') navigator.vibrate([12, 70, 18]);
      } catch {
        // Some browsers refuse vibration outright; the screen is the same.
      }
    }, SPLASH_AT_MS);
    return () => window.clearTimeout(timer);
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

      <main className={`detail-main cf-placed${play ? ' cf-play' : ''}`} data-testid="order-placed" data-played={play ? 'yes' : 'no'}>
        <div className="cf-burst" aria-hidden="true">
          <i className="cf-halo" />
          <i className="cf-ring cf-ring--1" />
          <i className="cf-ring cf-ring--2" />
          <div className="cf-disc">
            <span className="cf-arm cf-arm--a">
              <i />
            </span>
            <span className="cf-arm cf-arm--b">
              <i />
            </span>
          </div>
          <i className="cf-pip" />
          <div className="cf-fallw">
            <div className="cf-drop">
              <svg viewBox="0 0 26 34">
                <path d="M13 1C13 1 2 14 2 21.5a11 11 0 0 0 22 0C24 14 13 1 13 1z" fill="var(--cf-good)" />
                <ellipse cx="9" cy="21" rx="2.2" ry="3.4" fill="#FFFFFF" opacity=".45" />
              </svg>
            </div>
          </div>
          <div className="cf-parts">
            {droplets.map((drop, i) => (
              <i key={i} className={`cf-pt cf-pt--${drop.tone}`} style={drop.style} />
            ))}
          </div>
        </div>

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
