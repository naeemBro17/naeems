import { useEffect, useMemo, useState } from 'react';
import { useUrlParam } from '../../hooks/useUrlParams';
import { formatTaka } from '../../lib/format';
import { ORDER_STATUS_LABELS, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from '../../lib/orderStatus';
import { ORDER_SOURCE_LABELS, computeMonthlySummary } from '../../lib/manualOrders';
import { adminDeleteOrders, isEarlyStageOrder, refreshSteadfastStatus, steadfastNeedsAttention } from '../../lib/orders';
import { fetchOrderItemCounts } from '../../lib/adminData';
import { fetchAllPayments, paymentStateText, summarizePayments, type OrderPayment } from '../../lib/payments';
import { formatTakaBd } from '../../lib/adminNav';
import { orderPaymentTag } from '../../lib/paymentPlan';
import { NewOrderSheet } from './NewOrderSheet';
import { useToast } from '../../hooks/useToast';
import { DeleteOrdersDialog } from './DeleteOrdersDialog';
import { useAuth } from '../../contexts/AuthContext';
import { useSafetyLock } from '../../contexts/SafetyLockContext';
import { OrderDetailSheet } from './OrderDetailSheet';
import { AdminPageHeader, AdminSearch, BulkBar, ChipRow, EmptyState, type MenuItem } from './ui/AdminUi';
import { AdminIcon } from './ui/AdminIcon';
import type { Order, OrderStatus } from '../../types';

// 'due' (Batch 30): orders with money still due, whatever their status.
type StatusFilter = OrderStatus | 'all' | 'due';
type SourceFilter = Order['source'] | 'all';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'To confirm' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'shipped', label: 'With courier' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'due', label: 'Due' },
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

/** Steadfast's own status words ("in_review") in plain English ("In review"). */
function courierLabel(status: string | null): string | null {
  if (!status) return null;
  const words = status.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

function orderTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface OrdersTabProps {
  orders: Order[];
  /** Same list AdminPage already loaded for the "to confirm" badge —
   *  re-fetched by the parent after any change. */
  onReload: () => Promise<void> | void;
  /** Order id from the ?order= URL param (e.g. a Telegram notification
   *  link) — opens that order's sheet immediately instead of the list. */
  initialOrderId?: string | null;
}

/**
 * Admin → Orders (Batch 25 Part 4): status chips (the "To confirm" count
 * matches the orange badge), then rows on a phone / a table on a computer:
 * order number, customer, items, total, status and Steadfast status.
 */
export function OrdersTab({ orders, onReload, initialOrderId }: OrdersTabProps) {
  const { showToast } = useToast();
  const { isAdmin, can } = useAuth();
  const { openUntil } = useSafetyLock();
  const canDeleteEarly = can('delete_early_orders');
  const canSeeSales = can('see_sales');
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
  const [itemCounts, setItemCounts] = useState<Map<string, number>>(() => new Map());
  // Batch 30: every order's payments (null until migration-033 is run —
  // the Payment column then shows the old method · status text).
  const [payments, setPayments] = useState<Map<string, OrderPayment[]> | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchAllPayments().then((map) => {
      if (alive) setPayments(map);
    });
    return () => {
      alive = false;
    };
  }, [orders]);

  const dueOf = useMemo(() => {
    const map = new Map<string, number>();
    if (!payments) return map;
    for (const o of orders) {
      if (o.status === 'cancelled') continue;
      const due = summarizePayments(o.total, payments.get(o.id) ?? []).due;
      if (due > 0) map.set(o.id, due);
    }
    return map;
  }, [orders, payments]);

  useEffect(() => {
    let alive = true;
    void fetchOrderItemCounts().then((counts) => {
      if (alive) setItemCounts(counts);
    });
    return () => {
      alive = false;
    };
  }, [orders]);

  const monthlySummary = useMemo(() => computeMonthlySummary(orders), [orders]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: orders.length };
    for (const o of orders) counts[o.status] = (counts[o.status] ?? 0) + 1;
    counts.due = dueOf.size;
    return counts;
  }, [orders, dueOf]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (statusFilter === 'due') {
        if (!dueOf.has(o.id)) return false;
      } else if (statusFilter !== 'all' && o.status !== statusFilter) return false;
      if (sourceFilter !== 'all' && o.source !== sourceFilter) return false;
      if (term === '') return true;
      return (
        o.order_number.toLowerCase().includes(term) ||
        o.customer_phone.toLowerCase().includes(term) ||
        o.customer_name.toLowerCase().includes(term)
      );
    });
  }, [orders, statusFilter, sourceFilter, search, dueOf]);

  // Batch 20: every shipped order that's actually been booked with
  // Steadfast (a shipped order without a consignment id was marked shipped
  // by hand, before this feature existed, or by a different courier).
  const shippedWithSteadfast = orders.filter((o) => o.status === 'shipped' && Boolean(o.steadfast_consignment_id));

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
        ? `Updated ${shippedWithSteadfast.length} order${shippedWithSteadfast.length === 1 ? '' : 's'}: ${delivered} now delivered`
        : `Updated ${shippedWithSteadfast.length - failed} order(s), ${failed} failed. Try again for those.`,
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

  const menu: MenuItem[] = [];
  if (shippedWithSteadfast.length > 0 && (can('book_steadfast') || can('change_order_status'))) {
    menu.push({
      label: isBulkUpdating ? 'Updating shipped orders…' : `Update all shipped (${shippedWithSteadfast.length})`,
      icon: 'truck',
      disabled: isBulkUpdating,
      onSelect: () => void handleBulkRefresh(),
    });
  }

  const anyDeletable = filtered.some(canDeleteNow);

  return (
    <section aria-label="Orders" className="adm-orders">
      <AdminPageHeader
        title="Orders"
        menu={menu}
        primary={
          can('create_orders') ? (
            <button type="button" className="adm-btn adm-btn--primary" onClick={() => setIsNewOrderOpen(true)}>
              <AdminIcon name="plus" />
              New order
            </button>
          ) : undefined
        }
      />

      <div className="adm-filter-row">
        <AdminSearch
          value={search}
          onChange={setSearch}
          placeholder="Search orders"
          label="Search orders by order number or phone"
        />
        <select
          className="adm-select adm-orders__source"
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

      <ChipRow
        label="Filter by status"
        active={statusFilter}
        onSelect={(id) => setStatusFilter(id as StatusFilter)}
        chips={STATUS_OPTIONS.filter((opt) => opt.value !== 'due' || payments !== null).map((opt) => ({
          id: opt.value,
          label: opt.label,
          count: statusCounts[opt.value] ?? 0,
        }))}
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon="orders"
          title={orders.length === 0 ? 'No orders yet' : 'No orders match'}
          hint={orders.length === 0 ? 'New orders from the shop appear here.' : 'Try another status or search.'}
        />
      ) : (
        <div className={`adm-list adm-olist${anyDeletable ? ' adm-olist--checks' : ''}`} role="list" aria-label="Orders">
          <div className="adm-thead" aria-hidden="true">
            <span />
            <span>ORDER</span>
            <span>CUSTOMER</span>
            <span>ITEMS</span>
            <span>TOTAL</span>
            <span>STATUS</span>
            <span>PAYMENT</span>
            <span>STEADFAST</span>
          </div>
          {filtered.map((order) => {
            const items = itemCounts.get(order.id);
            // Batch 32: "COD", "Paid", "Advance ৳1,000 · rest COD", "Due · pays later"…
            const summary = payments ? summarizePayments(order.total, payments.get(order.id) ?? []) : null;
            const payTag = summary ? orderPaymentTag(order, summary, formatTakaBd) : null;
            const courier = courierLabel(order.steadfast_status);
            const attention = steadfastNeedsAttention(order.steadfast_status);
            return (
              <div
                key={order.id}
                role="listitem"
                className="adm-lrow adm-orow"
                data-testid="order-row"
                onClick={() => setOpenOrderId(order.id)}
              >
                <span className="adm-orow__check" onClick={(e) => e.stopPropagation()}>
                  {canDeleteNow(order) && (
                    <input
                      type="checkbox"
                      className="adm-check admin-order-row__select"
                      checked={selectedForDelete.has(order.id)}
                      onChange={() => toggleSelected(order.id)}
                      aria-label={`Select order ${order.order_number} for deletion`}
                    />
                  )}
                </span>
                <div className="adm-lrow__main">
                  <button
                    type="button"
                    className="adm-lrow__open adm-orow__number"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenOrderId(order.id);
                    }}
                  >
                    {order.order_number}
                  </button>
                  <p className="adm-lrow__sub">
                    {orderTime(order.created_at)} · {ORDER_SOURCE_LABELS[order.source]}
                  </p>
                  <p className="adm-lrow__meta adm-mobile-meta">
                    <span className="adm-orow__customer">{order.customer_name}</span>
                    {items !== undefined && (
                      <span>
                        {items} item{items === 1 ? '' : 's'}
                      </span>
                    )}
                    <span className="adm-price">{formatTakaBd(order.total)}</span>
                  </p>
                  {payTag && (
                    <p className="adm-lrow__meta adm-mobile-meta">
                      <span className="adm-pay-tag" data-testid="order-pay-tag-mobile">{payTag}</span>
                    </p>
                  )}
                </div>
                <span className="adm-orow__pills adm-mobile-meta">
                  <span className={`adm-status adm-status--${order.status}`}>{ORDER_STATUS_LABELS[order.status]}</span>
                  {courier && (
                    <span className={`adm-orow__courier${attention ? ' adm-orow__courier--alert' : ''}`}>
                      <AdminIcon name="truck" className="adm-icon--sm" />
                      {courier}
                    </span>
                  )}
                </span>
                <span className="adm-cell">
                  <span className="adm-orow__name">{order.customer_name}</span>
                  <span className="adm-lrow__sub">{order.customer_phone}</span>
                </span>
                <span className="adm-cell">{items ?? '—'}</span>
                <span className="adm-cell adm-price">{formatTakaBd(order.total)}</span>
                <span className="adm-cell">
                  <span className={`adm-status adm-status--${order.status}`}>{ORDER_STATUS_LABELS[order.status]}</span>
                </span>
                <span className="adm-cell adm-cell--muted" data-testid="order-payment-cell">
                  {summary
                    ? paymentStateText(summary, formatTakaBd)
                    : `${PAYMENT_METHOD_LABELS[order.payment_method]} · ${PAYMENT_STATUS_LABELS[order.payment_status]}`}
                  {payTag && (
                    <>
                      <br />
                      <span className="adm-pay-tag" data-testid="order-pay-tag">{payTag}</span>
                    </>
                  )}
                </span>
                <span className={`adm-cell${attention ? ' adm-orow__courier--alert' : ' adm-cell--muted'}`}>
                  {attention ? 'Needs attention' : (courier ?? '—')}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {filtered.length > 0 && (
        <p className="adm-list-foot">
          {filtered.length} of {orders.length} order{orders.length === 1 ? '' : 's'}
        </p>
      )}

      <div className="admin-panel order-monthly-summary adm-orders__month">
        <h3 className="admin-panel__title">This month</h3>
        <div className="checkout-summary-card__row">
          <span>Orders</span>
          <span>{monthlySummary.orderCount}</span>
        </div>
        {/* Batch 25: money totals follow "See sales figures". */}
        {canSeeSales && (
          <>
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
          </>
        )}
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

      {selectedOrders.length > 0 && (
        <BulkBar count={selectedOrders.length} onClear={() => setSelectedForDelete(new Set())}>
          <button type="button" className="adm-btn adm-btn--danger adm-btn--sm" onClick={() => setIsConfirmingDelete(true)}>
            Delete selected ({selectedOrders.length})
          </button>
        </BulkBar>
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
