import { useMemo, useState } from 'react';
import { formatTaka } from '../../lib/format';
import { ORDER_STATUS_LABELS, ORDER_STATUS_TONE, PAYMENT_STATUS_LABELS, PAYMENT_STATUS_TONE } from '../../lib/orderStatus';
import { refreshSteadfastStatus } from '../../lib/orders';
import { useToast } from '../../hooks/useToast';
import { OrderDetailSheet } from './OrderDetailSheet';
import type { Order, OrderStatus } from '../../types';

type StatusFilter = OrderStatus | 'all';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
];

interface OrdersTabProps {
  orders: Order[];
  /** Same list AdminPage already loaded for the sidebar's pending-count
   *  badge — re-fetched by the parent after any change, same pattern as
   *  WholesalerList/onReload. */
  onReload: () => Promise<void> | void;
  /** Order id from the ?order= URL param (e.g. a Telegram notification
   *  link) — opens that order's sheet immediately instead of the list. */
  initialOrderId?: string | null;
}

export function OrdersTab({ orders, onReload, initialOrderId }: OrdersTabProps) {
  const { showToast } = useToast();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [openOrderId, setOpenOrderId] = useState<string | null>(initialOrderId ?? null);
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (statusFilter !== 'all' && o.status !== statusFilter) return false;
      if (term === '') return true;
      return (
        o.order_number.toLowerCase().includes(term) ||
        o.customer_phone.toLowerCase().includes(term)
      );
    });
  }, [orders, statusFilter, search]);

  // Batch 20: every shipped order that's actually been booked with
  // Steadfast (a shipped order without a consignment id was marked shipped
  // by hand, before this feature existed, or by a different courier).
  const shippedWithSteadfast = orders.filter(
    (o) => o.status === 'shipped' && Boolean(o.steadfast_consignment_id)
  );

  const handleBulkRefresh = async () => {
    setIsBulkUpdating(true);
    let delivered = 0;
    let failed = 0;
    for (const order of shippedWithSteadfast) {
      const result = await refreshSteadfastStatus(order.id);
      if (result.error) {
        failed += 1;
      } else if (result.markedDelivered) {
        delivered += 1;
      }
    }
    setIsBulkUpdating(false);
    await onReload();
    showToast(
      failed === 0
        ? `Updated ${shippedWithSteadfast.length} order${shippedWithSteadfast.length === 1 ? '' : 's'} — ${delivered} now delivered`
        : `Updated ${shippedWithSteadfast.length - failed} order(s), ${failed} failed — try again for those`,
      failed === 0 ? 'success' : 'error'
    );
  };

  return (
    <section aria-label="Orders">
      <header className="admin-section-header">
        <h2 className="admin-section-title">Orders</h2>
        {shippedWithSteadfast.length > 0 && (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={handleBulkRefresh}
            disabled={isBulkUpdating}
          >
            {isBulkUpdating ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              `Update all shipped (${shippedWithSteadfast.length})`
            )}
          </button>
        )}
      </header>

      <div className="admin-filter-bar">
        <input
          type="search"
          className="form-input admin-filter-bar__search"
          placeholder="Search order number or phone..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search orders by order number or phone"
        />
        <select
          className="form-input form-select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          aria-label="Filter by status"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <p className="admin-panel__description">No orders match.</p>
      ) : (
        <ul className="admin-list">
          {filtered.map((order) => (
            <li key={order.id}>
              <button
                type="button"
                className="admin-order-row"
                onClick={() => setOpenOrderId(order.id)}
              >
                <div className="admin-order-row__main">
                  <span className="admin-order-row__number">{order.order_number}</span>
                  <span className="admin-order-row__customer">
                    {order.customer_name} &middot; {order.customer_phone}
                  </span>
                  <span className="admin-order-row__time">
                    {new Date(order.created_at).toLocaleString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <div className="admin-order-row__end">
                  <span className="admin-order-row__total">{formatTaka(order.total)}</span>
                  <span className={`status-badge status-badge--${ORDER_STATUS_TONE[order.status]}`}>
                    {ORDER_STATUS_LABELS[order.status]}
                  </span>
                  <span className={`status-badge status-badge--${PAYMENT_STATUS_TONE[order.payment_status]}`}>
                    {order.payment_method === 'bkash' ? 'bKash' : 'COD'} · {PAYMENT_STATUS_LABELS[order.payment_status]}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      <OrderDetailSheet orderId={openOrderId} onClose={() => setOpenOrderId(null)} onChanged={onReload} />
    </section>
  );
}
