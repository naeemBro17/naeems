import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminPath } from '../../lib/adminPages';
import { useUrlParam } from '../../hooks/useUrlParams';
import { formatTaka } from '../../lib/format';
import { ORDER_SOURCE_LABELS, computeMonthlySummary } from '../../lib/manualOrders';
import { adminDeleteOrders, isEarlyStageOrder, refreshSteadfastStatus } from '../../lib/orders';
import { fetchOrderNumberById } from '../../lib/adminData';
import { fetchAllPayments, summarizePayments, type OrderPayment } from '../../lib/payments';
import { formatTakaBd } from '../../lib/adminNav';
import { normalizeCollectMode } from '../../lib/paymentPlan';
import { TRACK_STATUS, fetchLatestSteps, savedTrack, type TrackStatus } from '../../lib/orderTracking';
import { phoneSearchCore } from '../../lib/phone';
import { useToast } from '../../hooks/useToast';
import { DeleteOrdersDialog } from './DeleteOrdersDialog';
import { useAuth } from '../../contexts/AuthContext';
import { useSafetyLock } from '../../contexts/SafetyLockContext';
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

/** Batch 35 Part 4: the common filters as chips; every filter stays in
 *  the "All statuses" menu beside the search. */
const CHIP_FILTERS: StatusFilter[] = ['all', 'pending', 'shipped', 'due'];

function orderDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short' });
}

/** The small neutral money pill — only when something is still owed. */
function owedText(order: Order, due: number): string | null {
  if (order.status === 'cancelled' || due <= 0) return null;
  if (order.status === 'delivered') return `${formatTakaBd(due)} due`;
  if (normalizeCollectMode(order.collect_mode) === 'pay_later') return 'Due, pays later';
  return `COD ${formatTakaBd(due)}`;
}

const SCROLL_KEY = 'admin-orders-scroll';

interface OrdersTabProps {
  orders: Order[];
  /** Same list AdminPage already loaded for the "to confirm" badge —
   *  re-fetched by the parent after any change. */
  onReload: () => Promise<void> | void;
  /** Order id from the ?order= URL param (a Telegram notification link,
   *  or after New / Edit order) — Batch 35: replaced by the order's page. */
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
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [selectedForDelete, setSelectedForDelete] = useState<Set<string>>(new Set());
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const navigate = useNavigate();
  const [latestSteps, setLatestSteps] = useState<Map<string, TrackStatus>>(() => new Map());
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
    void fetchLatestSteps().then((steps) => {
      if (alive) setLatestSteps(steps);
    });
    return () => {
      alive = false;
    };
  }, [orders]);

  // An old ?order=<id> link opens that order's own page instead.
  useEffect(() => {
    if (!initialOrderId) return;
    let alive = true;
    const known = orders.find((o) => o.id === initialOrderId)?.order_number;
    void (known ? Promise.resolve(known) : fetchOrderNumberById(initialOrderId)).then((orderNumber) => {
      if (!alive) return;
      if (orderNumber) navigate(adminPath.order(orderNumber), { replace: true });
      else navigate('/admin?tab=orders', { replace: true });
    });
    return () => {
      alive = false;
    };
  }, [initialOrderId, orders, navigate]);

  // Back from an order keeps the list where it was (filters live in the
  // URL; the scroll is put back once the rows are there).
  const restoredScroll = useRef(false);
  useLayoutEffect(() => {
    if (restoredScroll.current || orders.length === 0) return;
    restoredScroll.current = true;
    try {
      const saved = window.sessionStorage.getItem(SCROLL_KEY);
      window.sessionStorage.removeItem(SCROLL_KEY);
      if (saved !== null) window.scrollTo(0, Number(saved));
    } catch {
      // Storage blocked: the list simply starts at the top.
    }
  }, [orders.length]);

  const openOrder = (order: Order) => {
    try {
      window.sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
    } catch {
      // Storage blocked: Back starts at the top of the list.
    }
    navigate(adminPath.order(order.order_number), { state: { fromList: true } });
  };

  const monthlySummary = useMemo(() => computeMonthlySummary(orders), [orders]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: orders.length };
    for (const o of orders) counts[o.status] = (counts[o.status] ?? 0) + 1;
    counts.due = dueOf.size;
    return counts;
  }, [orders, dueOf]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    // "+880 17…", "017…" and "17…" all find the same phone number.
    const digits = phoneSearchCore(term);
    return orders.filter((o) => {
      if (statusFilter === 'due') {
        if (!dueOf.has(o.id)) return false;
      } else if (statusFilter !== 'all' && o.status !== statusFilter) return false;
      if (sourceFilter !== 'all' && o.source !== sourceFilter) return false;
      if (term === '') return true;
      return (
        o.order_number.toLowerCase().includes(term) ||
        o.customer_phone.toLowerCase().includes(term) ||
        (digits.length >= 3 && phoneSearchCore(o.customer_phone).includes(digits)) ||
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
            <button
              type="button"
              className="adm-btn adm-btn--primary"
              onClick={() => navigate(adminPath.newOrder(), { state: { fromList: true } })}
            >
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
          placeholder="Search order, name or phone"
          label="Search orders by order number, name or phone"
        />
        <select
          className="adm-select adm-orders__status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          aria-label="Filter by status"
        >
          {STATUS_OPTIONS.filter((opt) => opt.value !== 'due' || payments !== null).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.value === 'all' ? 'All statuses' : opt.label} ({statusCounts[opt.value] ?? 0})
            </option>
          ))}
        </select>
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
        label="Common filters"
        active={statusFilter}
        onSelect={(id) => setStatusFilter(id as StatusFilter)}
        chips={STATUS_OPTIONS.filter((opt) => CHIP_FILTERS.includes(opt.value) && (opt.value !== 'due' || payments !== null)).map(
          (opt) => ({
            id: opt.value,
            label: opt.label,
            count: statusCounts[opt.value] ?? 0,
          })
        )}
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon="orders"
          title={orders.length === 0 ? 'No orders yet' : 'No orders match'}
          hint={orders.length === 0 ? 'New orders from the shop appear here.' : 'Try another status or search.'}
        />
      ) : (
        <div className={`adm-list adm-olist2${anyDeletable ? ' adm-olist2--checks' : ''}`} role="list" aria-label="Orders">
          {filtered.map((order) => {
            // Batch 35 Part 4: one status pill, and a money pill only when
            // something is still owed.
            const summary = payments ? summarizePayments(order.total, payments.get(order.id) ?? []) : null;
            const due = summary ? summary.due : order.payment_status === 'paid' ? 0 : order.total;
            const owed = owedText(order, due);
            const info = TRACK_STATUS[savedTrack(order, { storedStep: latestSteps.get(order.id) ?? null }).status];
            return (
              <div
                key={order.id}
                role="listitem"
                className="adm-lrow adm-orow2"
                data-testid="order-row"
                onClick={() => openOrder(order)}
              >
                {anyDeletable && (
                  <span className="adm-orow2__check" onClick={(e) => e.stopPropagation()}>
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
                )}
                <button
                  type="button"
                  className="adm-orow2__open"
                  onClick={(e) => {
                    e.stopPropagation();
                    openOrder(order);
                  }}
                  aria-label={`Open order ${order.order_number}`}
                >
                  <span className="adm-orow2__line">
                    <span className="adm-orow2__name">{order.customer_name}</span>
                    <span className="adm-orow2__total adm-price">{formatTakaBd(order.total)}</span>
                  </span>
                  <span className="adm-orow2__line">
                    <span className="adm-orow2__sub">
                      <span className="adm-orow__number">{order.order_number}</span>, {orderDay(order.created_at)},{' '}
                      {ORDER_SOURCE_LABELS[order.source]}
                    </span>
                    <span className={`track-pill track-pill--${info.tone}`} data-testid="order-status-pill">
                      {info.admin}
                    </span>
                  </span>
                  {owed && (
                    <span className="adm-orow2__money" data-testid="order-money-pill">
                      {owed}
                    </span>
                  )}
                </button>
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

      <DeleteOrdersDialog
        isOpen={isConfirmingDelete}
        orders={selectedOrders}
        onConfirm={handleDeleteSelected}
        onClose={() => setIsConfirmingDelete(false)}
      />
    </section>
  );
}
