import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AdminFormPage, type PagePrimaryAction } from '../AdminFormPage';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { useToast } from '../../../hooks/useToast';
import {
  adminSetOrderStatus,
  adminUpdateOrder,
  bookSteadfastShipment,
  refreshSteadfastStatus,
  steadfastNeedsAttention,
  adminDeleteOrders,
  isEarlyStageOrder,
} from '../../../lib/orders';
import { useAuth } from '../../../contexts/AuthContext';
import { useSafetyLock } from '../../../contexts/SafetyLockContext';
import { DeleteOrdersDialog } from '../DeleteOrdersDialog';
import { formatTakaBd } from '../../../lib/adminNav';
import { formatTaka } from '../../../lib/format';
import { invoiceFromOrder } from '../../../lib/invoice/invoiceData';
import { InvoiceDialog } from '../InvoiceDialog';
import { copyToClipboard } from '../../../lib/clipboard';
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS, PAYMENT_STATUS_TONE } from '../../../lib/orderStatus';
import { DISCOUNT_REASON_LABELS, ORDER_SOURCE_LABELS } from '../../../lib/manualOrders';
import type { OrderStatus, OrderWithDetails } from '../../../types';
import { hasOwnTrackingLink, steadfastTrackingUrl } from '../../../lib/steadfastLink';
import { orderHistoryNote } from '../../../lib/orderHistoryNotes';
import { fetchAdminOrderDetail, fetchCustomersV3, fetchOrderIdByNumber } from '../../../lib/adminData';
import { OrderPaymentBlock } from '../OrderPaymentBlock';
import { fetchOrderPayments, PAYMENT_METHOD_NAMES, summarizePayments, type OrderPayment } from '../../../lib/payments';
import { markSteadfastUpdated, steadfastBanner, steadfastParcelUrl } from '../../../lib/orderEdit';
import { fetchTracking, type TrackingAnswer } from '../../../lib/orderSteps';
import {
  SAVED_STATUS_NAME,
  TRACK_STATUS,
  formatDhakaDateTime,
  latestRider,
  paidByMethod,
  savedTrack,
  translateCourierText,
} from '../../../lib/orderTracking';
import { CourierTimeline } from '../../orders/OrderSteps';
import { AdminIcon } from '../ui/AdminIcon';
import { FraudCheckCard } from '../FraudCheckCard';
import { bdPhoneKey, telHref, whatsAppChatUrl } from '../../../lib/phone';
import { codAmountFor } from '../../../../supabase/functions/_shared/cod';
import { toPaisa } from '../../../../supabase/functions/_shared/steadfastPayouts';
import '../../../styles/adminPayouts.css';
import { fetchOrderPayout, shortDhakaDate, takaExact, takaWhole, type LoadState, type OrderPayoutInfo } from '../../../lib/payouts';
import { adminPath } from '../../../lib/adminPages';

interface OrderPageProps {
  orderNumber: string;
  onBack: () => void;
  /** Refreshes the Orders list (and its badge) after any change. */
  onChanged: () => void;
}

function addressText(order: OrderWithDetails): string {
  return `${order.customer_name}, ${order.customer_phone}\n${order.address_line}, ${order.thana}, ${order.district}, ${order.division}`;
}

/** "bKash ·1234": the last four characters of a TrxID are enough to match it. */
function shortTrx(trx: string | null): string {
  if (!trx) return '';
  const clean = trx.trim();
  return clean.length > 6 ? ` ·${clean.slice(-4)}` : ` · ${clean}`;
}

/**
 * Batch 35 Part 3: /admin/orders/:orderNumber — the order as a page of its
 * own (it used to be a pop-up): status, customer, items and money,
 * Steadfast, history (folded), and ONE main action at the bottom
 * (Processing → Confirm order, Confirmed → Book with Steadfast). Every
 * other action of the old pop-up is still here, under "Other actions".
 * Every action is checked again by the database.
 */
export function OrderPage({ orderNumber, onBack, onChanged }: OrderPageProps) {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const { isAdmin, can } = useAuth();
  const { openUntil } = useSafetyLock();
  const canChangeStatus = can('change_order_status');
  const canBook = can('book_steadfast');
  const canDeleteEarly = can('delete_early_orders');
  const canEditOrder = can('edit_orders');
  const canViewCustomers = can('view_customers');
  // Batch 36 Part 1: "Steadfast paid ৳X on 8 Oct" — only with View profit
  // & costs (the database refuses everyone else).
  const canSeeCosts = can('view_profit_costs');
  const [payoutInfo, setPayoutInfo] = useState<LoadState<OrderPayoutInfo | null> | null>(null);

  const [orderId, setOrderId] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [order, setOrder] = useState<OrderWithDetails | null>(null);
  const [payments, setPayments] = useState<OrderPayment[] | null>(null);
  const [tracking, setTracking] = useState<TrackingAnswer | null>(null);
  const [trackingInput, setTrackingInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [isSavingField, setIsSavingField] = useState<'tracking' | 'note' | 'paid' | null>(null);
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [steadfastConfirmOpen, setSteadfastConfirmOpen] = useState(false);
  const [isBookingSteadfast, setIsBookingSteadfast] = useState(false);
  const [isRefreshingSteadfast, setIsRefreshingSteadfast] = useState(false);
  const [isMarkingDone, setIsMarkingDone] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    void (async () => {
      const id = await fetchOrderIdByNumber(orderNumber);
      const [data, pays] = id ? await Promise.all([fetchAdminOrderDetail(id), fetchOrderPayments(id)]) : [null, null];
      if (!alive) return;
      setOrderId(id);
      setOrder(data);
      setPayments(pays);
      setTrackingInput(data?.tracking_number ?? '');
      setNoteInput(data?.admin_note ?? '');
      setStatus(data ? 'ready' : 'missing');
      if (data?.steadfast_consignment_id) {
        void fetchTracking(data.id).then((answer) => {
          if (alive) setTracking(answer);
        });
        if (canSeeCosts) {
          void fetchOrderPayout(data.id).then((answer) => {
            if (alive) setPayoutInfo(answer);
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [orderNumber, canSeeCosts]);

  const reload = useCallback(async () => {
    if (!orderId) return;
    const [data, pays] = await Promise.all([fetchAdminOrderDetail(orderId), fetchOrderPayments(orderId)]);
    setOrder(data);
    setPayments(pays);
    onChanged();
  }, [orderId, onChanged]);

  const openEditPage = () => {
    if (!order) return;
    navigate(adminPath.editOrder(order.order_number), { state: { returnTo: adminPath.order(order.order_number) } });
  };

  const openProfile = async () => {
    if (!order) return;
    const { rows } = await fetchCustomersV3();
    const linked = order.customer_id ?? order.admin_customer_id;
    const phone = bdPhoneKey(order.customer_phone);
    const found =
      (linked ? rows.find((r) => r.key === `p:${linked}`) : undefined) ??
      rows.find((r) => phone !== null && bdPhoneKey(r.phone) === phone);
    if (!found) {
      showToast('No customer profile found for this order.', 'error');
      return;
    }
    navigate(adminPath.customer(found.key), { state: { fromList: true } });
  };

  const handleSteadfastDone = async () => {
    if (!order) return;
    setIsMarkingDone(true);
    const { error } = await markSteadfastUpdated(order.id);
    setIsMarkingDone(false);
    if (error) {
      showToast(error, 'error');
      return;
    }
    showToast('Noted: Steadfast is up to date');
    await reload();
  };

  const handleStatusChange = async (next: OrderStatus) => {
    if (!order) return;
    setIsChangingStatus(true);
    const { error } = await adminSetOrderStatus(order.id, next);
    setIsChangingStatus(false);
    if (error) {
      showToast('Could not update status. Please try again.', 'error');
      return;
    }
    showToast(`Order marked ${SAVED_STATUS_NAME[next]}`);
    await reload();
  };

  const handleCancel = async () => {
    setCancelOpen(false);
    await handleStatusChange('cancelled');
  };

  const handleMarkPaid = async () => {
    if (!order) return;
    setIsSavingField('paid');
    const { error } = await adminUpdateOrder(order.id, { payment_status: 'paid' });
    setIsSavingField(null);
    if (error) {
      showToast('Could not update payment status.', 'error');
      return;
    }
    showToast('Marked as paid');
    await reload();
  };

  const handleSaveTracking = async () => {
    if (!order) return;
    setIsSavingField('tracking');
    const { error } = await adminUpdateOrder(order.id, { tracking_number: trackingInput.trim() || null });
    setIsSavingField(null);
    if (error) {
      showToast('Could not save the tracking number.', 'error');
      return;
    }
    showToast('Tracking number saved');
    await reload();
  };

  const handleSaveNote = async () => {
    if (!order) return;
    setIsSavingField('note');
    const { error } = await adminUpdateOrder(order.id, { admin_note: noteInput.trim() || null });
    setIsSavingField(null);
    if (error) {
      showToast('Could not save the note.', 'error');
      return;
    }
    showToast('Note saved');
    await reload();
  };

  const handleBookSteadfast = async () => {
    if (!order) return;
    setSteadfastConfirmOpen(false);
    setIsBookingSteadfast(true);
    const result = await bookSteadfastShipment(order.id);
    setIsBookingSteadfast(false);
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    showToast('Booked with Steadfast');
    await reload();
    void fetchTracking(order.id).then(setTracking);
  };

  const handleRefreshSteadfastStatus = async () => {
    if (!order) return;
    setIsRefreshingSteadfast(true);
    const [result, answer] = await Promise.all([refreshSteadfastStatus(order.id), fetchTracking(order.id)]);
    if (answer) setTracking(answer);
    setIsRefreshingSteadfast(false);
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    if (result.needsAttention) {
      showToast(`Needs your attention — courier status: ${result.courierStatus}`, 'error');
    } else {
      showToast(result.markedDelivered ? 'Marked delivered' : `Courier status: ${result.courierStatus}`);
    }
    await reload();
  };

  const handleDelete = async () => {
    if (!order) return;
    const { results, error } = await adminDeleteOrders([order.id]);
    setDeleteOpen(false);
    const result = results[0];
    if (error || !result?.deleted) {
      showToast(error ?? result?.reason ?? 'Could not delete this order.', 'error');
      return;
    }
    showToast(`Order ${order.order_number} deleted`);
    onChanged();
    onBack();
  };

  const handleCopyAddress = async () => {
    if (!order) return;
    const ok = await copyToClipboard(addressText(order));
    showToast(ok ? 'Address copied' : 'Could not copy', ok ? 'success' : 'error');
  };

  // Batch 37: the A4 fold-to-label invoice (Print / Download / Share).
  const buildInvoice = useCallback(async () => {
    if (!order) return { invoices: [], orderIds: [] };
    return { invoices: [invoiceFromOrder(order, payments)], orderIds: [order.id] };
  }, [order, payments]);

  // Batch 30/32: with payments recorded, COD = what is still due (the
  // steadfast function sends exactly this); null = blocked, an unverified
  // bKash payment.
  const summary = order && payments ? summarizePayments(order.total, payments) : null;
  const steadfastCodAmount = order
    ? order.payment_method === 'bkash' && order.payment_status !== 'paid' && (summary?.paid ?? 0) <= 0
      ? null
      : codAmountFor(order, summary ? summary.due : null)
    : null;
  const banner = order ? steadfastBanner(order, summary) : null;
  const track = order ? savedTrack(order, { events: tracking?.events, courierStatus: tracking?.courierStatus ?? null }) : null;
  const info = track ? TRACK_STATUS[track.status] : null;
  const latestUpdate = tracking && tracking.events.length > 0 ? tracking.events[tracking.events.length - 1] : null;
  const rider = tracking ? latestRider(tracking.events) : null;
  const due = summary ? summary.due : order?.payment_status === 'paid' ? 0 : (order?.total ?? 0);
  const ended = order?.status === 'cancelled' || order?.status === 'delivered';
  const payLater = order?.collect_mode === 'pay_later';

  // The one main action (orange) for this status.
  let primary: PagePrimaryAction | undefined;
  if (order && canChangeStatus && order.status === 'pending') {
    primary = { label: 'Confirm order', onClick: () => void handleStatusChange('confirmed'), busy: isChangingStatus };
  } else if (order && canBook && order.status === 'confirmed' && !order.steadfast_consignment_id && steadfastCodAmount !== null) {
    primary = { label: 'Book with Steadfast', onClick: () => setSteadfastConfirmOpen(true), busy: isBookingSteadfast };
  }

  const canDeleteNow = order ? (isAdmin && openUntil !== null) || (canDeleteEarly && isEarlyStageOrder(order)) : false;

  return (
    <AdminFormPage
      title={orderNumber}
      backLabel="Back to orders"
      onBack={onBack}
      testId="admin-order-page"
      guard={false}
      className="adm-opage"
      primary={primary}
      headerExtra={
        canEditOrder && order ? (
          <button type="button" className="sheet-icon-button adm-opage__pen" onClick={openEditPage} aria-label="Edit order" data-testid="edit-order">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
          </button>
        ) : null
      }
    >
      {status === 'loading' && (
        <div className="adm-fpage__notice" role="status" aria-label="Loading">
          <span className="spinner spinner--large" aria-hidden="true" />
        </div>
      )}
      {status === 'missing' && <p className="adm-fpage__notice">Order {orderNumber} was not found.</p>}
      {order && track && info && (
        <div className="adm-opage__grid">
          <div className="adm-opage__col">
            {/* 1. Status */}
            <section className="adm-ocard adm-ocard--status" aria-label="Status">
              <div className="adm-ocard__row">
                <span className={`track-pill track-pill--${info.tone}`} data-testid="order-step-label">
                  {info.admin}
                </span>
                <span className="adm-ocard__muted">
                  Placed {formatDhakaDateTime(order.created_at)} · {ORDER_SOURCE_LABELS[order.source]}
                </span>
              </div>
              <p className="adm-ocard__total">{formatTakaBd(order.total)}</p>
              <div className="adm-ocard__pills" data-testid="order-money-pills">
                {paidByMethod(payments ?? []).map((row) => (
                  <span key={row.method} className="track-pill track-pill--green">
                    Paid {formatTakaBd(row.amount)} ({PAYMENT_METHOD_NAMES[row.method]})
                  </span>
                ))}
                {order.status !== 'cancelled' && due > 0 && (
                  <span className={`track-pill ${!ended && !payLater ? 'track-pill--amber' : 'track-pill--grey'}`}>
                    {ended ? `${formatTakaBd(due)} due` : payLater ? 'Due · pays later' : `Courier collects ${formatTakaBd(due)}`}
                  </span>
                )}
              </div>
              {track.note === 'awaiting_confirmation' && (
                <p className="adm-ocard__muted">Delivered, waiting for Steadfast to confirm.</p>
              )}
            </section>

            {/* 2. Customer */}
            <section className="adm-ocard" aria-label="Customer">
              <div className="adm-ocard__head">
                <h2 className="adm-ocard__title">Customer</h2>
                <button type="button" className="account-card__edit" onClick={handleCopyAddress}>
                  Copy address
                </button>
              </div>
              <p className="adm-ocard__name">{order.customer_name}</p>
              <p className="adm-ocard__muted">{order.customer_phone}</p>
              <p className="adm-ocard__address">
                {order.address_line}, {order.thana}, {order.district}, {order.division}
              </p>
              <div className="adm-ocard__buttons">
                <a className="adm-btn adm-btn--sm" href={telHref(order.customer_phone) ?? undefined}>
                  <AdminIcon name="phone" className="adm-icon--sm" />
                  Call
                </a>
                <a
                  className="adm-btn adm-btn--sm"
                  href={whatsAppChatUrl(order.customer_phone) ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  WhatsApp
                </a>
                {canViewCustomers && (
                  <button type="button" className="adm-btn adm-btn--sm" onClick={() => void openProfile()}>
                    Profile
                  </button>
                )}
              </div>
              {order.customer_note && (
                <p className="adm-ocard__note">
                  <b>Customer note:</b> {order.customer_note}
                </p>
              )}
            </section>

            <FraudCheckCard phone={order.customer_phone} />

            {banner && order.steadfast_consignment_id && (
              <div className="steadfast-banner" role="status" data-testid="steadfast-banner">
                <AdminIcon name="alert" className="steadfast-banner__icon" />
                <div className="steadfast-banner__body">
                  {banner.fields.length > 0 && (
                    <p className="steadfast-banner__text">
                      Steadfast still has the old details: <strong>{banner.fields.join(', ')}</strong>. Update them on Steadfast.
                    </p>
                  )}
                  {banner.codShouldBe !== null && (
                    <p className="steadfast-banner__text" data-testid="steadfast-banner-cod">
                      COD on Steadfast should now be <strong>{formatTaka(banner.codShouldBe)}</strong>
                      {order.steadfast_cod_amount !== null ? ` (it has ${formatTaka(order.steadfast_cod_amount)})` : ''}.
                    </p>
                  )}
                  <div className="steadfast-banner__actions">
                    <a
                      className="button button--secondary button--small"
                      href={steadfastParcelUrl(order.steadfast_consignment_id)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open on Steadfast
                      <AdminIcon name="external" className="adm-icon--sm" />
                    </a>
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={handleSteadfastDone}
                      disabled={isMarkingDone}
                    >
                      {isMarkingDone ? <span className="spinner" aria-hidden="true" /> : 'Done, I updated Steadfast'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 3. Items and money */}
            <section className="adm-ocard" aria-label="Items">
              <h2 className="adm-ocard__title">Items</h2>
              <ul className="adm-oitems">
                {order.items.map((item) => (
                  <li key={item.id} className="adm-oitem">
                    <span className="adm-oitem__thumb">
                      {item.image_url ? <img src={item.image_url} alt="" width={44} height={44} loading="lazy" /> : null}
                    </span>
                    <span className="adm-oitem__main">
                      <span className="adm-oitem__name">{item.product_name}</span>
                      <span className="adm-oitem__sub">
                        {item.variant_label ? `${item.variant_label} · ` : ''}
                        {item.quantity} × {formatTakaBd(item.unit_price)}
                        {item.list_price !== item.unit_price &&
                          ` · ${item.unit_price === 0 ? 'Free' : `List ${formatTakaBd(item.list_price)}`}${
                            item.reason ? ` (${DISCOUNT_REASON_LABELS[item.reason]})` : ''
                          }`}
                      </span>
                    </span>
                    <span className="adm-oitem__price">{formatTakaBd(item.line_total)}</span>
                  </li>
                ))}
              </ul>
              <div className="adm-ototals">
                <div className="adm-ototals__row">
                  <span>Subtotal</span>
                  <span>{formatTakaBd(order.subtotal)}</span>
                </div>
                <div className="adm-ototals__row">
                  <span>Delivery</span>
                  <span>{formatTakaBd(order.delivery_fee)}</span>
                </div>
                {order.discount > 0 && (
                  <div className="adm-ototals__row">
                    <span>
                      Discount
                      {order.discount_reason ? ` (${DISCOUNT_REASON_LABELS[order.discount_reason]})` : order.promo_code ? ` (${order.promo_code})` : ''}
                    </span>
                    <span>&minus;{formatTakaBd(order.discount)}</span>
                  </div>
                )}
                <div className="adm-ototals__row adm-ototals__row--strong">
                  <span>Total</span>
                  <span>{formatTakaBd(order.total)}</span>
                </div>
                {(payments ?? []).map((p) => (
                  <div key={p.id} className={`adm-ototals__row ${p.kind === 'refund' ? '' : 'adm-ototals__row--paid'}`}>
                    <span>
                      {p.kind === 'refund' ? 'Refund' : 'Paid'} · {PAYMENT_METHOD_NAMES[p.method]}
                      {shortTrx(p.trx_id)}
                    </span>
                    <span>
                      {p.kind === 'refund' ? '+' : '−'}
                      {formatTakaBd(p.amount)}
                    </span>
                  </div>
                ))}
                {order.status !== 'cancelled' && (
                  <div className="adm-ototals__row adm-ototals__row--final" data-testid="courier-collects">
                    <span>{order.status === 'delivered' ? 'Still due' : payLater ? 'Courier collects (pays later)' : 'Courier collects'}</span>
                    <span>{formatTakaBd(payLater && order.status !== 'delivered' ? 0 : due)}</span>
                  </div>
                )}
              </div>
            </section>

            {payments && summary ? (
              <div className="adm-ocard">
                <OrderPaymentBlock
                  order={order}
                  payments={payments}
                  summary={summary}
                  canRecord={canChangeStatus}
                  isAdmin={isAdmin}
                  onChanged={reload}
                  onConfirmBkash={handleMarkPaid}
                  isConfirmingBkash={isSavingField === 'paid'}
                />
              </div>
            ) : (
              <section className="adm-ocard" aria-label="Payment">
                <h2 className="adm-ocard__title">Payment</h2>
                <div className="order-detail__payment-row">
                  <span>{PAYMENT_METHOD_LABELS[order.payment_method]}</span>
                  <span className={`status-badge status-badge--${PAYMENT_STATUS_TONE[order.payment_status]}`}>
                    {PAYMENT_STATUS_LABELS[order.payment_status]}
                  </span>
                </div>
                {order.payment_method === 'bkash' && (
                  <>
                    {order.bkash_trx_id && <p className="order-detail__trx">TrxID: {order.bkash_trx_id}</p>}
                    {order.bkash_sender && <p className="order-detail__trx">Sender: {order.bkash_sender}</p>}
                    {canChangeStatus && order.payment_status !== 'paid' && (
                      <button
                        type="button"
                        className="adm-btn adm-btn--sm"
                        onClick={handleMarkPaid}
                        disabled={isSavingField === 'paid'}
                      >
                        {isSavingField === 'paid' ? <span className="spinner" aria-hidden="true" /> : 'Mark as paid'}
                      </button>
                    )}
                  </>
                )}
              </section>
            )}
          </div>

          <div className="adm-opage__col">
            {/* 4. Steadfast */}
            {(order.steadfast_consignment_id || order.status === 'confirmed') && (
              <section className="adm-ocard" aria-label="Steadfast">
                <h2 className="adm-ocard__title">Steadfast</h2>
                {order.steadfast_consignment_id ? (
                  <>
                    <div className="adm-ototals__row">
                      <span>Consignment ID</span>
                      <span className="adm-ocard__mono">{order.steadfast_consignment_id}</span>
                    </div>
                    {order.steadfast_tracking_code && (
                      <div className="adm-ototals__row">
                        <span>Tracking code</span>
                        <span className="adm-ocard__mono">{order.steadfast_tracking_code}</span>
                      </div>
                    )}
                    {order.steadfast_status && (
                      <div className="adm-ototals__row">
                        <span>Courier status</span>
                        <span>
                          {order.steadfast_status}
                          {steadfastNeedsAttention(order.steadfast_status) && (
                            <span className="track-pill track-pill--red adm-ocard__inline-pill">Needs attention</span>
                          )}
                        </span>
                      </div>
                    )}
                    {latestUpdate && (
                      <p className="adm-ocard__latest" data-testid="admin-latest-update">
                        <span className="adm-ocard__latest-text">
                          {translateCourierText(latestUpdate.text).friendly ?? latestUpdate.text}
                        </span>
                        {latestUpdate.at && <span className="adm-ocard__muted">{formatDhakaDateTime(latestUpdate.at)}</span>}
                      </p>
                    )}
                    {rider && (
                      <p className="adm-ocard__muted">
                        Rider: {rider.name} · {rider.phone}
                      </p>
                    )}
                    {canSeeCosts && payoutInfo?.kind === 'ready' && (
                      payoutInfo.data ? (
                        <p className="adm-payouts__paid" data-testid="order-steadfast-paid">
                          Steadfast paid{' '}
                          <b title={takaExact(toPaisa(payoutInfo.data.net_received))}>{takaWhole(toPaisa(payoutInfo.data.net_received))}</b>
                          {payoutInfo.data.paid_at ? ` on ${shortDhakaDate(payoutInfo.data.paid_at)}` : ''} (fees{' '}
                          <span title={takaExact(toPaisa(payoutInfo.data.total_kept))}>{takaWhole(toPaisa(payoutInfo.data.total_kept))}</span>)
                          {payoutInfo.data.payout_id && (
                            <>
                              {' · '}
                              <button
                                type="button"
                                className="adm-payouts__link"
                                onClick={() => navigate(adminPath.payout(payoutInfo.data?.payout_id ?? ''), { state: { fromList: true } })}
                              >
                                Payout{payoutInfo.data.payment_id ? ` #${payoutInfo.data.payment_id}` : ''}
                              </button>
                            </>
                          )}
                        </p>
                      ) : (
                        <p className="adm-payouts__paid adm-payouts__paid--none" data-testid="order-steadfast-paid">
                          Steadfast: not paid yet
                        </p>
                      )
                    )}
                    <div className="adm-ocard__buttons">
                      <a
                        href={steadfastTrackingUrl(order.steadfast_tracking_link)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="adm-btn adm-btn--sm order-detail__tracking-link"
                      >
                        {hasOwnTrackingLink(order.steadfast_tracking_link) ? 'Track on Steadfast' : 'Track on Steadfast (enter the code)'}
                        <AdminIcon name="external" className="adm-icon--sm" />
                      </a>
                      {order.status === 'shipped' && (canBook || canChangeStatus) && (
                        <button
                          type="button"
                          className="adm-btn adm-btn--sm"
                          onClick={handleRefreshSteadfastStatus}
                          disabled={isRefreshingSteadfast}
                        >
                          {isRefreshingSteadfast ? <span className="spinner" aria-hidden="true" /> : 'Check delivery status'}
                        </button>
                      )}
                    </div>
                  </>
                ) : !canBook ? (
                  <p className="admin-panel__description">Not booked on Steadfast yet.</p>
                ) : steadfastCodAmount === null ? (
                  <p className="admin-panel__description">
                    This bKash payment has not been verified yet — mark it as paid before booking with Steadfast.
                  </p>
                ) : (
                  <p className="admin-panel__description">
                    Not booked yet. Courier will collect {formatTakaBd(steadfastCodAmount)}.
                  </p>
                )}
              </section>
            )}

            {/* Tracking number and private note */}
            <section className="adm-ocard" aria-label="Tracking number and note">
              <h2 className="adm-ocard__title">Tracking number and note</h2>
              {!canChangeStatus ? (
                <p className="adm-ocard__address">
                  Tracking: {order.tracking_number ?? '—'}
                  <br />
                  Note: {order.admin_note ?? '—'}
                </p>
              ) : (
                <>
                  <div className="order-admin-detail__field-row">
                    <input
                      type="text"
                      className="form-input"
                      value={trackingInput}
                      onChange={(e) => setTrackingInput(e.target.value)}
                      placeholder="Steadfast consignment ID"
                      aria-label="Tracking number"
                    />
                    <button
                      type="button"
                      className="adm-btn adm-btn--sm"
                      onClick={handleSaveTracking}
                      disabled={isSavingField === 'tracking'}
                    >
                      {isSavingField === 'tracking' ? <span className="spinner" aria-hidden="true" /> : 'Save'}
                    </button>
                  </div>
                  <div className="order-admin-detail__field-row">
                    <input
                      type="text"
                      className="form-input"
                      value={noteInput}
                      onChange={(e) => setNoteInput(e.target.value)}
                      placeholder="Private note, customer never sees this"
                      aria-label="Admin note"
                    />
                    <button
                      type="button"
                      className="adm-btn adm-btn--sm"
                      onClick={handleSaveNote}
                      disabled={isSavingField === 'note'}
                    >
                      {isSavingField === 'note' ? <span className="spinner" aria-hidden="true" /> : 'Save'}
                    </button>
                  </div>
                </>
              )}
            </section>

            {/* 5. History and updates (folded) */}
            <section className="adm-ocard" aria-label="History and updates">
              <button
                type="button"
                className="adm-ocard__fold"
                onClick={() => setHistoryOpen((v) => !v)}
                aria-expanded={historyOpen}
                data-testid="history-toggle"
              >
                <span className="adm-ocard__title">
                  History and updates ({order.history.length + (tracking?.events.length ?? 0)})
                </span>
                <AdminIcon name="chevron-down" className={`adm-icon--sm adm-ocard__chev${historyOpen ? ' adm-ocard__chev--open' : ''}`} />
              </button>
              {historyOpen && (
                <div className="adm-ocard__fold-body">
                  {order.history.length > 0 && (
                    <ul className="order-admin-detail__history">
                      {[...order.history].reverse().map((row) => (
                        <li key={row.id}>
                          {row.old_status && row.old_status !== row.new_status
                            ? `${SAVED_STATUS_NAME[row.old_status]} → ${SAVED_STATUS_NAME[row.new_status]}`
                            : SAVED_STATUS_NAME[row.new_status]}
                          {' — '}
                          {formatDhakaDateTime(row.changed_at)}
                          {row.changed_by_username && <span className="order-admin-detail__history-by"> · by {row.changed_by_username}</span>}
                          {row.note && <span className="order-admin-detail__history-note">{orderHistoryNote(row.note)}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {tracking && (
                    <>
                      <h3 className="adm-ocard__subtitle">Steadfast updates</h3>
                      <CourierTimeline events={tracking.events} />
                    </>
                  )}
                </div>
              )}
            </section>

            {/* Every other action of the old pop-up. */}
            <section className="adm-ocard" aria-label="Other actions">
              <h2 className="adm-ocard__title">Other actions</h2>
              <div className="adm-ocard__buttons">
                <button type="button" className="adm-btn adm-btn--sm" onClick={() => setInvoiceOpen(true)}>
                  Invoice
                </button>
                {canChangeStatus && order.status === 'confirmed' && !order.steadfast_consignment_id && (
                  <button
                    type="button"
                    className="adm-btn adm-btn--sm"
                    onClick={() => void handleStatusChange('shipped')}
                    disabled={isChangingStatus}
                  >
                    Mark In transit (other courier)
                  </button>
                )}
                {canChangeStatus && order.status === 'shipped' && (
                  <button
                    type="button"
                    className="adm-btn adm-btn--sm"
                    onClick={() => void handleStatusChange('delivered')}
                    disabled={isChangingStatus}
                  >
                    Mark Delivered
                  </button>
                )}
                {canChangeStatus && !ended && (
                  <button
                    type="button"
                    className="adm-btn adm-btn--sm"
                    onClick={() => setCancelOpen(true)}
                    disabled={isChangingStatus}
                  >
                    Cancel order
                  </button>
                )}
                {(isAdmin || canDeleteEarly) && canDeleteNow && (
                  <button type="button" className="button button--danger-outline button--small" onClick={() => setDeleteOpen(true)}>
                    Delete order
                  </button>
                )}
              </div>
              {(isAdmin || canDeleteEarly) && !canDeleteNow && (
                <p className="admin-panel__description order-admin-detail__locked">
                  {isAdmin
                    ? "Delete is locked: turn on 'Allow deleting orders at any stage' in Safety Locks."
                    : 'Only Processing orders, or Cancelled orders never booked on Steadfast, can be deleted.'}
                </p>
              )}
            </section>
          </div>
        </div>
      )}

      {order && (
        <InvoiceDialog
          isOpen={invoiceOpen}
          onClose={() => setInvoiceOpen(false)}
          title={`Invoice ${order.order_number}`}
          fileName={`Invoice-${order.order_number}.pdf`}
          build={buildInvoice}
          onPrinted={() => void reload()}
        />
      )}

      {order && (
        <DeleteOrdersDialog isOpen={deleteOpen} orders={[order]} onConfirm={handleDelete} onClose={() => setDeleteOpen(false)} />
      )}

      <ConfirmDialog
        isOpen={cancelOpen}
        title="Cancel this order?"
        message={`${order?.order_number ?? ''} will be cancelled and any reserved stock restored.`}
        confirmLabel="Cancel order"
        cancelLabel="Keep order"
        danger
        onConfirm={handleCancel}
        onClose={() => setCancelOpen(false)}
      />

      <ConfirmDialog
        isOpen={steadfastConfirmOpen}
        title="Book with Steadfast?"
        message={
          order
            ? `${order.customer_name} · ${order.customer_phone} · ${order.address_line}, ${order.thana}, ${order.district} · COD amount: ${formatTaka(steadfastCodAmount ?? 0)}${
                order.collect_mode === 'pay_later' ? ` · Courier will collect ${formatTaka(0)} — customer pays later` : ''
              }`
            : ''
        }
        confirmLabel="Book parcel"
        cancelLabel="Cancel"
        onConfirm={handleBookSteadfast}
        onClose={() => setSteadfastConfirmOpen(false)}
      />
    </AdminFormPage>
  );
}
