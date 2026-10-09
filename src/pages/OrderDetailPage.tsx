// Customer order detail (/orders/:orderId) — Batch 35 Part 2: tracking
// (expected date, payment pill, five steps, all updates), the items with
// the money, where it is going, and help on WhatsApp; Cancel while still
// Processing. RLS already means fetchOrderDetail() can only ever return
// this customer's own order (or any order, for an admin browsing here), so
// a mismatched/foreign id resolves to null exactly like a missing one and
// gets the same "not found" state.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { BackButton } from '../components/shared/BackButton';
import { ConfirmDialog } from '../components/shared/ConfirmDialog';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { useProducts } from '../contexts/ProductContext';
import { fetchOrderDetail, cancelOrder } from '../lib/orders';
import { formatTakaBd } from '../lib/adminNav';
import { openExternal, whatsAppUrl } from '../lib/expertLinks';
import { whatsAppChatUrl } from '../lib/phone';
import { isCancellableByCustomer } from '../lib/orderStatus';
import type { OrderWithDetails } from '../types';
import { fetchTracking, type TrackingAnswer } from '../lib/orderSteps';
import { fetchPaymentSummary, PAYMENT_METHOD_NAMES, type PaymentSummary } from '../lib/payments';
import {
  customerPaymentPill,
  fetchOrderUpdates,
  friendlyUpdates,
  paidByMethod,
  paymentUpdates,
  savedTrack,
  stepTimes,
  translateCourierText,
  type FriendlyUpdate,
  type OrderUpdates,
  type TrackStatus,
} from '../lib/orderTracking';
import { OrderTrackingCard, type CustomerTrackingView } from '../components/orders/OrderTrackingCard';
import { LineIcon } from '../components/orders/TrackIcons';

function DetailSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="skeleton order-detail__skeleton-block" />
      <div className="skeleton order-detail__skeleton-block" />
      <div className="skeleton order-detail__skeleton-block" />
    </div>
  );
}

/** Live updates (the steadfast function) and stored ones (migration-037)
 *  as one list, oldest first, each update once. */
function mergeUpdates(live: TrackingAnswer | null, stored: OrderUpdates | null): FriendlyUpdate[] {
  const all = [
    ...friendlyUpdates(live?.events ?? []),
    ...(stored?.tracking ?? []).map((u) => ({ step: u.step, kind: translateCourierText(u.text).kind, text: u.text, at: u.at })),
  ];
  const seen = new Set<string>();
  return all
    .filter((u) => {
      const key = `${u.at ?? ''}|${u.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
}

/** The newest update that proves In transit / Out for delivery. */
function latestStep(updates: FriendlyUpdate[]): TrackStatus | null {
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const step = updates[i].step;
    if (step === 'in_transit' || step === 'out_for_delivery') return step;
  }
  return null;
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
  const [stored, setStored] = useState<OrderUpdates | null>(null);

  useDocumentTitle(order ? `${order.order_number} — NAEEM'S` : "Order — NAEEM'S");

  const load = useCallback(async () => {
    if (!orderId) return;
    setIsLoading(true);
    const data = await fetchOrderDetail(orderId);
    setOrder(data);
    setIsLoading(false);
    if (!data) return;
    void fetchPaymentSummary(data.id).then(setPayment);
    void fetchOrderUpdates(data.id).then(setStored);
    if (data.steadfast_consignment_id) void fetchTracking(data.id).then(setTracking);
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const view = useMemo<CustomerTrackingView | null>(() => {
    if (!order) return null;
    const updates = mergeUpdates(tracking, stored);
    const track = savedTrack(order, { courierStatus: tracking?.courierStatus ?? null, storedStep: latestStep(updates) });
    track.reachedArea = updates.some((u) => u.kind === 'area_hub');
    const ended = track.status === 'cancelled' || track.status === 'returned';
    const pill = ended
      ? null
      : customerPaymentPill({
          total: order.total,
          due: payment ? payment.due : order.payment_status === 'paid' ? 0 : order.total,
          paid: payment?.paid ?? 0,
          payLater: order.collect_mode === 'pay_later',
          fallbackPaid: payment === null && order.payment_status === 'paid',
          delivered: track.status === 'delivered',
        });
    const showRider = settings.show_rider_phone === 'true' && track.status === 'out_for_delivery';
    return {
      orderNumber: order.order_number,
      track,
      zone: order.delivery_zone,
      createdAt: order.created_at,
      times: stepTimes(order, order.history, updates, track),
      updates,
      payments: paymentUpdates(stored?.payments ?? []),
      pill,
      trackingLink: order.steadfast_tracking_link,
      booked: Boolean(order.steadfast_consignment_id),
      rider: showRider ? (tracking?.rider ?? null) : null,
    };
  }, [order, tracking, stored, payment, settings.show_rider_phone]);

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

  // The shop's WhatsApp number from settings (the existing phone helper),
  // else the expert's WhatsApp link as before.
  const chatBase = whatsAppChatUrl(settings.shop_whatsapp_number) ?? whatsAppUrl(settings.expert_whatsapp_url);
  const chatHref = order && chatBase
    ? `${chatBase}${chatBase.includes('?') ? '&' : '?'}text=${encodeURIComponent(`Hi, I have a question about order ${order.order_number}`)}`
    : null;

  const methodRows = paidByMethod(stored?.payments ?? []);
  const isDelivered = view?.track.status === 'delivered';
  const paidTotal = payment?.paid ?? 0;
  const due = payment ? payment.due : order?.payment_status === 'paid' ? 0 : (order?.total ?? 0);
  const finalLine = !order
    ? null
    : order.status === 'cancelled'
      ? { label: 'Total', amount: order.total }
      : due <= 0
        ? { label: 'Total paid', amount: order.total }
        : order.collect_mode === 'pay_later' || isDelivered
          ? { label: 'Balance due', amount: due }
          : { label: 'To pay on delivery', amount: due };

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">{order ? `Order ${order.order_number}` : 'Order'}</h1>
        <div className="detail-header__actions" />
      </header>

      <main className="detail-main ot-page">
        {isLoading ? (
          <DetailSkeleton />
        ) : !order || !view ? (
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
            <OrderTrackingCard view={view} />

            <section className="ot-card ot-items" aria-label="Your items">
              <h2 className="ot-card__title">Your items ({order.items.reduce((n, item) => n + item.quantity, 0)})</h2>
              <ul className="ot-items__list">
                {order.items.map((item) => (
                  <li key={item.id} className="ot-item">
                    <span className="ot-item__thumb">
                      {item.image_url ? (
                        <img src={item.image_url} alt="" width={54} height={54} loading="lazy" decoding="async" />
                      ) : (
                        <span className="ot-item__thumb-empty" aria-hidden="true" />
                      )}
                    </span>
                    <span className="ot-item__main">
                      <span className="ot-item__name">{item.product_name}</span>
                      <span className="ot-item__sub">
                        {item.variant_label ? `${item.variant_label} · ` : ''}Qty {item.quantity}
                      </span>
                    </span>
                    <span className="ot-item__price">{formatTakaBd(item.line_total)}</span>
                  </li>
                ))}
              </ul>
              <div className="ot-totals">
                <div className="ot-totals__row">
                  <span>Subtotal</span>
                  <span>{formatTakaBd(order.subtotal)}</span>
                </div>
                <div className="ot-totals__row">
                  <span>Delivery</span>
                  <span>{order.delivery_fee > 0 ? formatTakaBd(order.delivery_fee) : 'Free'}</span>
                </div>
                {order.discount > 0 && (
                  <div className="ot-totals__row">
                    <span>{order.promo_code ? `Discount (${order.promo_code})` : 'Discount'}</span>
                    <span>&minus;{formatTakaBd(order.discount)}</span>
                  </div>
                )}
                {order.status !== 'cancelled' &&
                  (methodRows.length > 0
                    ? methodRows.map((row) => (
                        <div key={row.method} className="ot-totals__row ot-totals__row--paid" data-testid="customer-payment-summary">
                          <span>Paid with {PAYMENT_METHOD_NAMES[row.method]}</span>
                          <span>&minus;{formatTakaBd(row.amount)}</span>
                        </div>
                      ))
                    : paidTotal > 0 &&
                      due > 0 && (
                        <div className="ot-totals__row ot-totals__row--paid" data-testid="customer-payment-summary">
                          <span>Paid</span>
                          <span>&minus;{formatTakaBd(paidTotal)}</span>
                        </div>
                      ))}
                {finalLine && (
                  <div className="ot-totals__row ot-totals__row--final" data-testid="final-line">
                    <span>{finalLine.label}</span>
                    <span>{formatTakaBd(finalLine.amount)}</span>
                  </div>
                )}
              </div>
            </section>

            <section className="ot-card ot-address" aria-label="Delivering to">
              <h2 className="ot-card__title">Delivering to</h2>
              <div className="ot-address__row">
                <span className="ot-address__icon">
                  <LineIcon name="pin" />
                </span>
                <p className="ot-address__text">
                  <span className="ot-address__name">
                    {order.customer_name} · {order.customer_phone}
                  </span>
                  <span>{order.address_line}</span>
                  <span>
                    {order.thana}, {order.district}
                  </span>
                </p>
              </div>
            </section>

            {chatHref && (
              <section className="ot-card ot-help" aria-label="Help">
                <div className="ot-help__row">
                  <span className="ot-help__icon">
                    <LineIcon name="chat" />
                  </span>
                  <span className="ot-help__text">
                    <span className="ot-help__title">Questions about this order?</span>
                    <span className="ot-help__sub">We usually reply within an hour.</span>
                  </span>
                </div>
                <button
                  type="button"
                  className="button button--secondary button--full ot-help__button"
                  onClick={() => openExternal(chatHref)}
                  data-testid="chat-whatsapp"
                  data-href={chatHref}
                >
                  Chat on WhatsApp
                </button>
              </section>
            )}

            {isCancellableByCustomer(order) && (
              <div className="order-detail__actions">
                <button type="button" className="button button--secondary button--full" onClick={() => setIsCancelOpen(true)}>
                  Cancel order
                </button>
              </div>
            )}
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
