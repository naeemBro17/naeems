import { useMemo, useState } from 'react';
import { useUrlParam } from '../../hooks/useUrlParams';
import { formatTaka } from '../../lib/format';
import {
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TONE,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONE,
} from '../../lib/orderStatus';
import { ORDER_SOURCE_LABELS, computeMonthlySummary } from '../../lib/manualOrders';
import { adminDeleteOrders, isEarlyStageOrder, refreshSteadfastStatus, steadfastNeedsAttention } from '../../lib/orders';
import { NewOrderSheet } from './NewOrderSheet';
import { useToast } from '../../hooks/useToast';
import { DeleteOrdersDialog } from './DeleteOrdersDialog';
import { useAuth } from '../../contexts/AuthContext';
import { useSafetyLock } from '../../contexts/SafetyLockContext';
import { OrderDetailSheet } from './OrderDetailSheet';
import type { Order, OrderStatus } from '../../types';

type StatusFilter = OrderStatus | 'all';
type SourceFilter = Order['source'] | 'all';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
];

const SOURCE_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: 'All sources' },
  { value: 'web', label: ORDER_SOURCE_LABELS.web },
  { value: 'facebook', label: ORDER_SOURCE_LABELS.facebook },
  { value: 'whatsapp', label: ORDER_SOURCE_LABELS.whatsapp },
  { value: 'phone', label: ORDER_SOURCE_LABELS.phone },
  { value: 'shop', label: ORDER_SOURCE_LABELS.shop },
  { value: 'family', label: ORDER_SOURCE_LABELS.family },
  { value: 'other', label: ORDER_SOURCE_LABELS.other },
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
  const { isAdmin, can } = useAuth();
  const { openUntil } = useSafetyLock();
  const canDeleteEarly = can('delete_early_orders');
  // Batch 24: a checkbox only on orders this person may delete right now —
  // early-stage orders, or any order for the Super Admin while his Safety
  // Lock is off. The database checks the same rule again.
  const canDeleteNow = (order: Order): boolean =>
    (isAdmin && openUntil !== null) || (canDeleteEarly && isEarlyStageOrder(order));
  // Filters live in the URL so leaving the admin panel and coming Back keeps
  // them (hooks/useUrlParams.ts); prefixed so they can't clash with the
  // Products tab's own.
  const [statusFilter, setStatusFilter] = useUrlParam<StatusFilter>(
    'ostatus',
    'all',
    STATUS_OPTIONS.map((opt) => opt.value)
  );
  const [sourceFilter, setSourceFilter] = useUrlParam<SourceFilter>(
    'osource',
    'all',
    SOURCE_OPTIONS.map((opt) => opt.value)
  );
  const [search, setSearch] = useUrlParam<string>('oq', '');
  const [openOrderId, setOpenOrderId] = useState<string | null>(initialOrderId ?? null);
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [selectedForDelete, setSelectedForDelete] = useState<Set<string>>(new Set());
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isNewOrderOpen, setIsNewOrderOpen] = useState(false);

  const monthlySummary = useMemo(() => computeMonthlySummary(orders), [orders]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (statusFilter !== 'all' && o.status !== statusFilter) return false;
      if (sourceFilter !== 'all' && o.source !== sourceFilter) return false;
      if (term === '') return true;
      return (
        o.order_number.toLowerCase().includes(term) ||
        o.customer_phone.toLowerCase().includes(term)
      );
    });
  }, [orders, statusFilter, sourceFilter, search]);

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

  const toggleSelected = (orderId: string) => {
    setSelectedForDelete((current) => {
      const next = new Set(current);
      if (next.has(orderId)) {
        next.delete(orderId);
      } else {
        next.add(orderId);
      }
      return next;
    });
  };

  const selectedOrders = orders.filter((o) => selectedForDelete.has(o.id) && canDeleteNow(o));

  const handleDeleteSelected = async () => {
    const { results, error } = await adminDeleteOrders(selectedOrders.map((o) => o.id));
    setIsConfirmingDelete(false);
    if (error) {
      showToast(error, 'error');
      return;
    }
    const deletedCount = results.filter((r) => r.deleted).length;
    const failed = results.filter((r) => !r.deleted);
    setSelectedForDelete(new Set());
    await onReload();
    if (failed.length === 0) {
      showToast(`${deletedCount} order${deletedCount === 1 ? '' : 's'} deleted permanently`, 'success');
    } else {
      showToast(
        `Deleted ${deletedCount}, could not delete ${failed.length} (${failed[0].reason ?? 'unknown reason'})`,
        'error'
      );
    }
  };

  return (
    <section aria-label="Orders">
      <header className="admin-section-header">
        <h2 className="admin-section-title">Orders</h2>
        {can('create_orders') && (
          <button
            type="button"
            className="button button--primary button--small"
            onClick={() => setIsNewOrderOpen(true)}
          >
            New order
          </button>
        )}
        {selectedOrders.length > 0 && (
          <button
            type="button"
            className="button button--danger button--small"
            onClick={() => setIsConfirmingDelete(true)}
          >
            Delete selected ({selectedOrders.length})
          </button>
        )}
        {shippedWithSteadfast.length > 0 && (can('book_steadfast') || can('change_order_status')) && (
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

      <div className="admin-panel order-monthly-summary">
        <span className="admin-panel__title">This month</span>
        <div className="checkout-summary-card__row">
          <span>Orders</span>
          <span>{monthlySummary.orderCount}</span>
        </div>
        <div className="checkout-summary-card__row">
          <span>Total sales</span>
          <span>{formatTaka(monthlySummary.totalSales)}</span>
        </div>
        <div className="checkout-summary-card__row">
          <span>Discount given</span>
          <span>{formatTaka(monthlySummary.totalDiscount)}</span>
        </div>
        <div className="checkout-summary-card__row">
          <span>Free items (list value)</span>
          <span>{formatTaka(monthlySummary.freeValue)}</span>
        </div>
        <div className="order-monthly-summary__sources">
          {SOURCE_OPTIONS.filter((opt) => opt.value !== 'all').map((opt) => {
            const count = monthlySummary.bySource[opt.value as Order['source']];
            if (count === 0) return null;
            return (
              <span key={opt.value} className="status-badge status-badge--neutral">
                {opt.label}: {count}
              </span>
            );
          })}
        </div>
      </div>

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
        <select
          className="form-input form-select"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
          aria-label="Filter by source"
        >
          {SOURCE_OPTIONS.map((opt) => (
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
            <li key={order.id} className={canDeleteNow(order) ? 'admin-order-row-wrap' : undefined}>
              {canDeleteNow(order) && (
                <input
                  type="checkbox"
                  className="admin-order-row__select"
                  checked={selectedForDelete.has(order.id)}
                  onChange={() => toggleSelected(order.id)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Select order ${order.order_number} for deletion`}
                />
              )}
              <button
                type="button"
                className="admin-order-row"
                onClick={() => setOpenOrderId(order.id)}
              >
                <div className="admin-order-row__main">
                  <span className="admin-order-row__number">
                    {order.order_number}
                    <span className="status-badge status-badge--neutral" style={{ marginLeft: 6 }}>
                      {ORDER_SOURCE_LABELS[order.source]}
                    </span>
                  </span>
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
                    {PAYMENT_METHOD_LABELS[order.payment_method]} · {PAYMENT_STATUS_LABELS[order.payment_status]}
                  </span>
                  {steadfastNeedsAttention(order.steadfast_status) && (
                    <span className="status-badge status-badge--danger">Steadfast: needs attention</span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      <OrderDetailSheet orderId={openOrderId} onClose={() => setOpenOrderId(null)} onChanged={onReload} />

      <NewOrderSheet
        isOpen={isNewOrderOpen}
        onClose={() => setIsNewOrderOpen(false)}
        onCreated={async (orderId) => {
          setIsNewOrderOpen(false);
          await onReload();
          setOpenOrderId(orderId);
        }}
      />

      <DeleteOrdersDialog
        isOpen={isConfirmingDelete}
        orders={selectedOrders}
        onConfirm={handleDeleteSelected}
        onClose={() => setIsConfirmingDelete(false)}
      />
    </section>
  );
}
