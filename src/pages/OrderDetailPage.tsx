// Customer order detail (/orders/:orderId) — items, timeline, address,
// payment, and a Cancel action while still pending. RLS already means
// fetchOrderDetail() can only ever return this customer's own order (or any
// order, for an admin browsing here), so there's no separate ownership
// check needed client-side — a mismatched/foreign id just resolves to null
// exactly like a genuinely missing one, and gets the same "not found" state.
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { BackButton } from '../components/shared/BackButton';
import { ConfirmDialog } from '../components/shared/ConfirmDialog';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { useProducts } from '../contexts/ProductContext';
import { fetchOrderDetail, cancelOrder } from '../lib/orders';
import { formatTaka } from '../lib/format';
import { openExternal, whatsAppUrl } from '../lib/expertLinks';
import {
  ORDER_STATUS_TONE,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONE,
  isCancellableByCustomer,
} from '../lib/orderStatus';
import type { OrderWithDetails } from '../types';
import { steadfastTrackingUrl } from '../lib/steadfastLink';
import { deriveOrderStep, fetchTracking, stepLabel, stepTimesFrom, type TrackingAnswer } from '../lib/orderSteps';
import { fetchPaymentSummary, type PaymentSummary } from '../lib/payments';
import { OrderSteps } from '../components/orders/OrderSteps';
import { customerSafeText } from '../../supabase/functions/_shared/steadfastSteps';

function shortTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Batch 30 Part 5: the six real steps (Order Placed → Delivered). For a
 * parcel on Steadfast the page asks the steadfast function for its
 * tracking steps (cached a minute) — the latest one shows under the
 * current step, never with a rider's name or phone. Without that answer
 * (function not updated yet, or offline) the steps come from what is saved
 * on the order, with no error.
 */
function DeliveryProgressSection({ order, tracking }: { order: OrderWithDetails; tracking: TrackingAnswer | null }) {
  const step = deriveOrderStep({
    status: order.status,
    booked: Boolean(order.steadfast_consignment_id),
    courierStatus: tracking?.courierStatus ?? order.steadfast_status,
    events: tracking?.events ?? [],
  });
  const historyTimes = order.history.map((h) => h.changed_at).sort();
  const updatedAt =
    step.latest?.at ??
    order.steadfast_status_updated_at ??
    historyTimes[historyTimes.length - 1] ??
    order.updated_at ??
    order.created_at;
  return (
    <div className="delivery-progress" aria-label="Delivery progress">
      <OrderSteps
        step={step}
        audience="customer"
        labelTestId="delivery-status"
        stepTimes={stepTimesFrom(order.history, tracking?.events ?? [])}
      />
      {updatedAt && <p className="delivery-progress__time">Last update {shortTime(updatedAt)}</p>}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="skeleton order-detail__skeleton-block" />
      <div className="skeleton order-detail__skeleton-block" />
      <div className="skeleton order-detail__skeleton-block" />
    </div>
  );
}

export function OrderDetailPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const { settings } = useProducts();
  const { showToast } = useToast();

  const [order, setOrder] = useState<OrderWithDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [tracking, setTracking] = useState<TrackingAnswer | null>(null);
  const [payment, setPayment] = useState<PaymentSummary | null>(null);

  useDocumentTitle(order ? `${order.order_number} — NAEEM'S` : "Order — NAEEM'S");

  const load = useCallback(async () => {
    if (!orderId) return;
    setIsLoading(true);
    const data = await fetchOrderDetail(orderId);
    setOrder(data);
    setIsLoading(false);
    if (!data) return;
    void fetchPaymentSummary(data.id).then(setPayment);
    if (data.steadfast_consignment_id) {
      // The function already removes rider names and phones for a
      // customer; cleaned again here so the page never shows them anyway.
      void fetchTracking(data.id).then((answer) =>
        setTracking(answer ? { ...answer, events: answer.events.map((e) => ({ ...e, text: customerSafeText(e.text) })) } : null)
      );
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!orderId) {
    return <Navigate to="/orders" replace />;
  }

  const handleCancel = async () => {
    if (!order) return;
    // ConfirmDialog shows its own spinner on the confirm button while this
    // promise is pending — no separate loading state needed here.
    const { error } = await cancelOrder(order.id);
    setIsCancelOpen(false);
    if (error) {
      showToast(error, 'error');
      return;
    }
    showToast('Order cancelled');
    void load();
  };

  const handleHelp = () => {
    if (!order) return;
    const base = whatsAppUrl(settings.expert_whatsapp_url);
    if (!base) return;
    const separator = base.includes('?') ? '&' : '?';
    const text = `Hi, I need help with my order ${order.order_number}`;
    openExternal(`${base}${separator}text=${encodeURIComponent(text)}`);
  };

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">{order?.order_number ?? 'Order'}</h1>
        <div className="detail-header__actions" />
      </header>

      <main className="detail-main">
        {isLoading ? (
          <DetailSkeleton />
        ) : !order ? (
          <div className="empty-state">
            <div className="empty-state__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4m0 4h.01" />
              </svg>
            </div>
            <p className="empty-state__message">Order not found</p>
            <Link to="/orders" className="button button--secondary">
              Back to My Orders
            </Link>
          </div>
        ) : (
          <>
            <div className="order-detail__status-row">
              <span className={`status-badge status-badge--${ORDER_STATUS_TONE[order.status]}`}>
                {stepLabel(
                  deriveOrderStep({
                    status: order.status,
                    booked: Boolean(order.steadfast_consignment_id),
                    courierStatus: tracking?.courierStatus ?? order.steadfast_status,
                    events: tracking?.events ?? [],
                  }),
                  'customer'
                )}
              </span>
              <span className="order-detail__date">
                {new Date(order.created_at).toLocaleString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>

            <DeliveryProgressSection order={order} tracking={tracking} />

            {order.tracking_number && (
              <>
                <div className="order-detail__tracking">
                  <span>Tracking number</span>
                  <strong>{order.tracking_number}</strong>
                </div>
                {order.steadfast_consignment_id && (
                  <a
                    href={steadfastTrackingUrl(order.steadfast_tracking_link)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="order-detail__tracking-link"
                  >
                    Track parcel on Steadfast →
                  </a>
                )}
              </>
            )}

            <section className="checkout-summary-card">
              <h2 className="checkout-summary-card__title">Items</h2>
              <ul className="checkout-summary-card__items">
                {order.items.map((item) => (
                  <li key={item.id} className="checkout-summary-card__item">
                    <span className="checkout-summary-card__thumb">
                      {item.image_url ? (
                        <img src={item.image_url} alt={item.product_name} />
                      ) : (
                        <span className="checkout-summary-card__thumb-empty" aria-hidden="true" />
                      )}
                    </span>
                    <span className="checkout-summary-card__item-name">
                      {item.product_name}
                      {item.variant_label && (
                        <span className="checkout-summary-card__item-variant">{item.variant_label}</span>
                      )}
                      <span className="checkout-summary-card__item-qty">&times;{item.quantity}</span>
                    </span>
                    <span className="checkout-summary-card__item-price">{formatTaka(item.line_total)}</span>
                  </li>
                ))}
              </ul>

              <div className="checkout-summary-card__divider" />
              <div className="checkout-summary-card__row">
                <span>Subtotal</span>
                <span>{formatTaka(order.subtotal)}</span>
              </div>
              <div className="checkout-summary-card__row">
                <span>Delivery</span>
                <span>{formatTaka(order.delivery_fee)}</span>
              </div>
              {order.discount > 0 && (
                <div className="checkout-summary-card__row checkout-summary-card__row--discount">
                  <span>Promo {order.promo_code ? `(${order.promo_code})` : ''}</span>
                  <span>&minus;{formatTaka(order.discount)}</span>
                </div>
              )}
              <div className="checkout-summary-card__row checkout-summary-card__row--total">
                <span>Total</span>
                <span>{formatTaka(order.total)}</span>
              </div>
            </section>

            <section className="order-detail__section">
              <h2 className="order-detail__section-title">Delivery address</h2>
              <p className="order-detail__address">
                {order.customer_name} &middot; {order.customer_phone}
                <br />
                {order.address_line}, {order.thana}, {order.district}, {order.division}
              </p>
            </section>

            <section className="order-detail__section">
              <h2 className="order-detail__section-title">Payment</h2>
              <div className="order-detail__payment-row">
                <span>{order.payment_method === 'bkash' ? 'bKash' : 'Cash on Delivery'}</span>
                <span className={`status-badge status-badge--${PAYMENT_STATUS_TONE[order.payment_status]}`}>
                  {PAYMENT_STATUS_LABELS[order.payment_status]}
                </span>
              </div>
              {order.payment_method === 'bkash' && order.bkash_trx_id && (
                <p className="order-detail__trx">TrxID: {order.bkash_trx_id}</p>
              )}
              {payment && payment.paid > 0 && (
                <p className="order-detail__trx" data-testid="customer-payment-summary">
                  Paid {formatTaka(payment.paid)}
                  {payment.due > 0 ? ` · Due ${formatTaka(payment.due)}` : ''}
                </p>
              )}
            </section>

            <div className="order-detail__actions">
              {whatsAppUrl(settings.expert_whatsapp_url) && (
                <button type="button" className="account-row" onClick={handleHelp}>
                  <span>Need help?</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="account-row__chevron">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
              )}

              {isCancellableByCustomer(order) && (
                <button
                  type="button"
                  className="button button--secondary button--full"
                  onClick={() => setIsCancelOpen(true)}
                >
                  Cancel order
                </button>
              )}
            </div>
          </>
        )}
      </main>

      <ConfirmDialog
        isOpen={isCancelOpen}
        title="Cancel this order?"
        message={`${order?.order_number ?? ''} will be cancelled. This can't be undone.`}
        confirmLabel="Cancel order"
        cancelLabel="Keep order"
        danger
        onConfirm={handleCancel}
        onClose={() => setIsCancelOpen(false)}
      />
    </div>
  );
}
