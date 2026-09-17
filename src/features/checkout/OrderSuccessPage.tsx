// Step 4 of the checkout flow — the final confirmation screen. Reads the
// order snapshot useCheckoutState captured when "Pay and Order" was tapped
// (not the live cart, which this screen clears on mount). Offers a PDF
// export and a WhatsApp handoff to the shop; there is no payment gateway,
// so this is the actual end of the flow. If a promo code was used, its
// usage count is committed here (not when it was typed in) via the
// increment_promo_usage SECURITY DEFINER function.
import { useEffect, useRef } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useProducts } from '../../contexts/ProductContext';
import { whatsAppUrl, openExternal } from '../../lib/expertLinks';
import { buildOrderPdf, buildOrderWhatsAppText } from '../../lib/orderExport';
import { useCheckoutState } from './useCheckoutState';
import { CheckoutProgressBar } from './CheckoutProgressBar';

export function OrderSuccessPage() {
  const { lastOrder, resetAfterOrder } = useCheckoutState();
  const { settings } = useProducts();
  const navigate = useNavigate();
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (hasRunRef.current || !lastOrder) return;
    hasRunRef.current = true;

    if (lastOrder.promo) {
      void supabase.rpc('increment_promo_usage', { promo_code: lastOrder.promo.code }).then(({ error }) => {
        // The discount already shown to this customer is honored regardless
        // of whether the code was still valid at this exact moment — see
        // migration-014's increment_promo_usage for the re-check. We only
        // log here so a missing/failed function isn't silently invisible.
        if (error) console.error('increment_promo_usage failed:', error.message);
      });
    }
    resetAfterOrder();
    // resetAfterOrder is stable (useCallback) but intentionally excluded so
    // this effect never re-fires from a state change it itself causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastOrder]);

  if (!lastOrder) {
    return <Navigate to="/cart" replace />;
  }

  const handleSavePdf = async () => {
    const doc = await buildOrderPdf(lastOrder);
    doc.save(`order-summary-${Date.now()}.pdf`);
  };

  const handleSendWhatsApp = () => {
    const base = whatsAppUrl(settings.shop_whatsapp_number);
    if (!base) return;
    const separator = base.includes('?') ? '&' : '?';
    const url = `${base}${separator}text=${encodeURIComponent(buildOrderWhatsAppText(lastOrder))}`;
    openExternal(url);
  };

  const whatsAppConfigured = whatsAppUrl(settings.shop_whatsapp_number) !== null;

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
        <p className="checkout-success__subtext">Just one more step to confirm it with us.</p>

        <div className="checkout-success__instructions">
          Tap "Save as PDF" to keep a copy of your order summary, then tap "Send on WhatsApp"
          to send it to us so we can confirm it.
        </div>

        <div className="checkout-success__actions">
          <button type="button" className="button button--secondary" onClick={handleSavePdf}>
            Save as PDF
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={handleSendWhatsApp}
            disabled={!whatsAppConfigured}
          >
            Send on WhatsApp
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
