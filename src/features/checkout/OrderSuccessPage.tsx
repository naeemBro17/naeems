// Step 4 of the checkout flow — the final confirmation screen. Reads the
// order snapshot useCheckoutState captured the instant place_order()
// succeeded (not the live cart, which is already cleared and reset by the
// time this page is reached — see OrderSummaryPage). The order itself is
// already saved in the database with a real order number; this screen is
// just a receipt, "what happens next", and a way to the order's own page
// or back to shopping. Promo usage is committed server-side inside
// place_order() now, not here.
import { useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { formatTaka } from '../../lib/format';
import { buildOrderPdf } from '../../lib/orderExport';
import { trackPurchase } from '../../lib/analytics';
import { useCheckoutState } from './useCheckoutState';
import { CheckoutProgressBar } from './CheckoutProgressBar';

export function OrderSuccessPage() {
  useDocumentTitle("Order Placed — Naeem's");
  const { lastOrder } = useCheckoutState();
  const navigate = useNavigate();

  // The order number is passed as both trackers' event/transaction id, so
  // even if this effect (or a page refresh landing back here) fires twice,
  // Meta/GA4 de-duplicate by that id instead of double-counting the sale.
  useEffect(() => {
    if (!lastOrder) return;
    trackPurchase(lastOrder.orderNumber, lastOrder.total);
  }, [lastOrder?.orderNumber, lastOrder?.total]);

  if (!lastOrder) {
    return <Navigate to="/cart" replace />;
  }

  const handleDownloadInvoice = async () => {
    const doc = await buildOrderPdf(lastOrder);
    doc.save(`${lastOrder.orderNumber}.pdf`);
  };

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <h1 className="detail-header__title">Order Placed</h1>
      </header>

      <CheckoutProgressBar currentStep={4} />

      <main className="detail-main checkout-success">
        <div className="checkout-success__badge" aria-hidden="true">
          <span className="checkout-success__ring" />
          <svg
            className="checkout-success__check"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>

        <h2 className="checkout-success__heading">Order has been placed!</h2>
        <p className="checkout-success__order-number">{lastOrder.orderNumber}</p>
        <p className="checkout-success__subtext">Thank you, {lastOrder.address.fullName.split(' ')[0]}!</p>

        <div className="checkout-success__receipt">
          <div className="checkout-success__receipt-row">
            <span>Items</span>
            <span>
              {lastOrder.items.reduce((sum, item) => sum + item.quantity, 0)} item
              {lastOrder.items.reduce((sum, item) => sum + item.quantity, 0) === 1 ? '' : 's'}
            </span>
          </div>
          <div className="checkout-success__receipt-row">
            <span>Payment</span>
            <span>{lastOrder.paymentMethod === 'bkash' ? 'bKash' : 'Cash on Delivery'}</span>
          </div>
          <div className="checkout-success__receipt-row checkout-success__receipt-row--total">
            <span>Total paid</span>
            <span>{formatTaka(lastOrder.total)}</span>
          </div>
        </div>

        <div className="checkout-success__instructions">
          আমরা শীঘ্রই আপনার অর্ডার confirm করব। কোনো প্রশ্ন থাকলে "সাহায্য দরকার?" থেকে
          যোগাযোগ করুন।
        </div>

        <div className="checkout-success__actions">
          <button type="button" className="button button--secondary" onClick={handleDownloadInvoice}>
            Download invoice
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => navigate(`/orders/${lastOrder.orderId}`)}
          >
            আমার অর্ডার দেখুন
          </button>
        </div>

        <button
          type="button"
          className="button button--secondary button--full checkout-success__continue"
          onClick={() => navigate('/')}
        >
          Continue Shopping
        </button>
      </main>
    </div>
  );
}
