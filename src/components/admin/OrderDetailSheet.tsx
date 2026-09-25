import { useEffect, useState } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { useToast } from '../../hooks/useToast';
import { fetchOrderDetail, adminSetOrderStatus, adminUpdateOrder } from '../../lib/orders';
import { formatTaka } from '../../lib/format';
import { buildOrderPdf } from '../../lib/orderExport';
import { copyToClipboard } from '../../lib/clipboard';
import {
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TONE,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONE,
} from '../../lib/orderStatus';
import type { OrderStatus, OrderWithDetails } from '../../types';
import type { AppliedPromo, CartItem, DeliveryZoneOption } from '../../features/checkout/types';

interface OrderDetailSheetProps {
  orderId: string | null;
  onClose: () => void;
  /** Refreshes the list behind the sheet after any change. */
  onChanged: () => void;
}

/** The buttons offered for "next status", given the current one — a simple
 *  forward-only ladder plus Cancel, matching CLAUDE.md's status flow. */
const NEXT_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  pending: 'confirmed',
  confirmed: 'shipped',
  shipped: 'delivered',
};

function addressText(order: OrderWithDetails): string {
  return `${order.customer_name}, ${order.customer_phone}\n${order.address_line}, ${order.thana}, ${order.district}, ${order.division}`;
}

/** Reuses the existing PDF builder, which expects a checkout OrderSnapshot —
 *  this reshapes a saved Order into that same shape rather than duplicating
 *  the PDF layout code for admin's "Download invoice". */
function toOrderSnapshot(order: OrderWithDetails) {
  const items: CartItem[] = order.items.map((item) => ({
    product: {
      id: item.product_id ?? item.id,
      name: item.product_name,
    } as CartItem['product'],
    quantity: item.quantity,
    unitPrice: item.unit_price,
    variantId: item.variant_id,
    variantLabel: item.variant_label,
    variantImage: null,
  }));
  const zone: DeliveryZoneOption = {
    id: order.delivery_zone,
    label: order.delivery_zone === 'inside_dhaka' ? 'Inside Dhaka' : 'Outside Dhaka',
    fee: order.delivery_fee,
  };
  const promo: AppliedPromo | null = order.promo_code
    ? {
        code: order.promo_code,
        discountType: 'fixed',
        discountAmount: order.discount,
        computedDiscount: order.discount,
      }
    : null;
  return {
    orderId: order.id,
    orderNumber: order.order_number,
    items,
    zone,
    address: {
      fullName: order.customer_name,
      phone: order.customer_phone,
      division: order.division,
      district: order.district,
      thana: order.thana,
      fullAddress: order.address_line,
    },
    promo,
    subtotal: order.subtotal,
    discount: order.discount,
    total: order.total,
    paymentMethod: order.payment_method,
    bkashTrxId: order.bkash_trx_id,
    placedAt: order.created_at,
  };
}

export function OrderDetailSheet({ orderId, onClose, onChanged }: OrderDetailSheetProps) {
  const { showToast } = useToast();
  const [order, setOrder] = useState<OrderWithDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [trackingInput, setTrackingInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [isSavingField, setIsSavingField] = useState<'tracking' | 'note' | 'paid' | null>(null);
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  useEffect(() => {
    if (!orderId) {
      setOrder(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void fetchOrderDetail(orderId).then((data) => {
      if (cancelled) return;
      setOrder(data);
      setTrackingInput(data?.tracking_number ?? '');
      setNoteInput(data?.admin_note ?? '');
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  const reload = async () => {
    if (!orderId) return;
    const data = await fetchOrderDetail(orderId);
    setOrder(data);
    onChanged();
  };

  const handleStatusChange = async (status: OrderStatus) => {
    if (!order) return;
    setIsChangingStatus(true);
    const { error } = await adminSetOrderStatus(order.id, status);
    setIsChangingStatus(false);
    if (error) {
      showToast('Could not update status. Please try again.', 'error');
      return;
    }
    showToast(`Order marked ${ORDER_STATUS_LABELS[status]}`);
    await reload();
  };

  const handleCancel = async () => {
    if (!order) return;
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

  const handleCopyAddress = async () => {
    if (!order) return;
    const ok = await copyToClipboard(addressText(order));
    showToast(ok ? 'Address copied' : 'Could not copy', ok ? 'success' : 'error');
  };

  const handleDownloadInvoice = async () => {
    if (!order) return;
    const doc = await buildOrderPdf(toOrderSnapshot(order));
    doc.save(`${order.order_number}.pdf`);
  };

  const nextStatus = order ? NEXT_STATUS[order.status] : undefined;

  return (
    <BottomSheet isOpen={orderId !== null} onClose={onClose} title={order?.order_number ?? 'Order'}>
      {isLoading || !order ? (
        <div className="full-screen-center" style={{ minHeight: 200 }}>
          <span className="spinner spinner--large" aria-hidden="true" />
        </div>
      ) : (
        <div className="order-admin-detail">
          <div className="order-admin-detail__head">
            <span className={`status-badge status-badge--${ORDER_STATUS_TONE[order.status]}`}>
              {ORDER_STATUS_LABELS[order.status]}
            </span>
            <span className="order-detail__date">
              {new Date(order.created_at).toLocaleString('en-GB', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>

          <div className="order-admin-detail__actions-row">
            <a className="button button--secondary button--small" href={`tel:${order.customer_phone}`}>
              Call
            </a>
            <a
              className="button button--secondary button--small"
              href={`https://wa.me/${order.customer_phone.replace(/[^\d]/g, '')}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              WhatsApp
            </a>
            <button type="button" className="button button--secondary button--small" onClick={handleDownloadInvoice}>
              Invoice
            </button>
          </div>

          <section className="order-detail__section">
            <h2 className="order-detail__section-title">Items</h2>
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
            <div className="checkout-summary-card__row checkout-summary-card__row--total">
              <span>Total</span>
              <span>{formatTaka(order.total)}</span>
            </div>
          </section>

          <section className="order-detail__section">
            <div className="order-detail__section-title-row">
              <h2 className="order-detail__section-title">Address</h2>
              <button type="button" className="account-card__edit" onClick={handleCopyAddress}>
                Copy address
              </button>
            </div>
            <p className="order-detail__address">{addressText(order)}</p>
          </section>

          <section className="order-detail__section">
            <h2 className="order-detail__section-title">Payment</h2>
            <div className="order-detail__payment-row">
              <span>{order.payment_method === 'bkash' ? 'bKash' : 'Cash on Delivery'}</span>
              <span className={`status-badge status-badge--${PAYMENT_STATUS_TONE[order.payment_status]}`}>
                {PAYMENT_STATUS_LABELS[order.payment_status]}
              </span>
            </div>
            {order.payment_method === 'bkash' && (
              <>
                {order.bkash_trx_id && <p className="order-detail__trx">TrxID: {order.bkash_trx_id}</p>}
                {order.bkash_sender && <p className="order-detail__trx">Sender: {order.bkash_sender}</p>}
                {order.payment_status !== 'paid' && (
                  <button
                    type="button"
                    className="button button--secondary button--small"
                    onClick={handleMarkPaid}
                    disabled={isSavingField === 'paid'}
                    style={{ marginTop: 8 }}
                  >
                    {isSavingField === 'paid' ? <span className="spinner" aria-hidden="true" /> : 'Mark as paid'}
                  </button>
                )}
              </>
            )}
          </section>

          {order.customer_note && (
            <section className="order-detail__section">
              <h2 className="order-detail__section-title">Customer note</h2>
              <p className="order-detail__address">{order.customer_note}</p>
            </section>
          )}

          <section className="order-detail__section">
            <h2 className="order-detail__section-title">Tracking number</h2>
            <div className="order-admin-detail__field-row">
              <input
                type="text"
                className="form-input"
                value={trackingInput}
                onChange={(e) => setTrackingInput(e.target.value)}
                placeholder="Steadfast consignment ID"
              />
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={handleSaveTracking}
                disabled={isSavingField === 'tracking'}
              >
                {isSavingField === 'tracking' ? <span className="spinner" aria-hidden="true" /> : 'Save'}
              </button>
            </div>
          </section>

          <section className="order-detail__section">
            <h2 className="order-detail__section-title">Admin note</h2>
            <div className="order-admin-detail__field-row">
              <input
                type="text"
                className="form-input"
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                placeholder="Private note, customer never sees this"
              />
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={handleSaveNote}
                disabled={isSavingField === 'note'}
              >
                {isSavingField === 'note' ? <span className="spinner" aria-hidden="true" /> : 'Save'}
              </button>
            </div>
          </section>

          {order.history.length > 0 && (
            <section className="order-detail__section">
              <h2 className="order-detail__section-title">History</h2>
              <ul className="order-admin-detail__history">
                {order.history.map((row) => (
                  <li key={row.id}>
                    {row.old_status ? `${ORDER_STATUS_LABELS[row.old_status]} → ` : ''}
                    {ORDER_STATUS_LABELS[row.new_status]} —{' '}
                    {new Date(row.changed_at).toLocaleString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {order.status !== 'cancelled' && order.status !== 'delivered' && (
            <div className="order-admin-detail__status-actions">
              {nextStatus && (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => handleStatusChange(nextStatus)}
                  disabled={isChangingStatus}
                >
                  {isChangingStatus ? <span className="spinner" aria-hidden="true" /> : `Mark ${ORDER_STATUS_LABELS[nextStatus]}`}
                </button>
              )}
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setCancelOpen(true)}
                disabled={isChangingStatus}
              >
                Cancel order
              </button>
            </div>
          )}
        </div>
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
    </BottomSheet>
  );
}
