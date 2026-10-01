import { useEffect, useMemo, useState } from 'react';
import { useUrlParam } from '../../hooks/useUrlParams';
import { useAuth } from '../../contexts/AuthContext';
import { BottomSheet } from '../shared/BottomSheet';
import { fetchCustomerOrders, fetchCustomers, type CustomerOrderRow, type CustomerRow } from '../../lib/adminData';
import { formatTakaBd } from '../../lib/adminNav';
import { formatDhakaTime } from '../../lib/staff';
import { ORDER_STATUS_LABELS } from '../../lib/orderStatus';
import { AdminPageHeader, AdminSearch, EmptyState, SkeletonRows } from './ui/AdminUi';
import { AdminIcon } from './ui/AdminIcon';
import type { OrderStatus } from '../../types';

type SortKey = 'recent' | 'orders' | 'spent' | 'joined' | 'name';
const SORT_KEYS: readonly SortKey[] = ['recent', 'orders', 'spent', 'joined', 'name'];

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric' });
}

function isOrderStatus(value: string): value is OrderStatus {
  return value in ORDER_STATUS_LABELS;
}

/**
 * Admin → Customers (Batch 25 Part 4). A read-only list of shopper accounts
 * with their order count, total spent and last order. Needs "View
 * customers"; the money column only appears with "See sales figures" (the
 * database leaves it out otherwise).
 */
export function CustomersTab({ onOpenOrder }: { onOpenOrder: (orderId: string) => void }) {
  const { can } = useAuth();
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useUrlParam<string>('cq', '');
  const [sort, setSort] = useUrlParam<SortKey>('csort', 'recent', SORT_KEYS);
  const [openId, setOpenId] = useState('');

  useEffect(() => {
    let alive = true;
    void fetchCustomers().then((result) => {
      if (!alive) return;
      setRows(result.rows);
      setError(result.error);
      setIsLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const showMoney = rows.some((r) => r.total_spent !== null);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = term
      ? rows.filter(
          (r) =>
            r.full_name.toLowerCase().includes(term) ||
            r.email.toLowerCase().includes(term) ||
            r.phone.replace(/\s/g, '').includes(term.replace(/\s/g, ''))
        )
      : rows;
    const sorted = [...list];
    const time = (iso: string | null) => (iso ? new Date(iso).getTime() : 0);
    sorted.sort((a, b) => {
      switch (sort) {
        case 'orders':
          return b.order_count - a.order_count;
        case 'spent':
          return (b.total_spent ?? 0) - (a.total_spent ?? 0);
        case 'joined':
          return time(b.joined_at) - time(a.joined_at);
        case 'name':
          return (a.full_name || a.email).localeCompare(b.full_name || b.email);
        default:
          return time(b.last_order_at) - time(a.last_order_at) || time(b.joined_at) - time(a.joined_at);
      }
    });
    return sorted;
  }, [rows, search, sort]);

  const open = rows.find((r) => r.id === openId) ?? null;

  return (
    <section aria-label="Customers" className="adm-customers">
      <AdminPageHeader title="Customers" />

      <div className="adm-filter-row">
        <AdminSearch value={search} onChange={setSearch} placeholder="Search name, email or phone" label="Search customers" />
        <select className="adm-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort customers">
          <option value="recent">Last order</option>
          <option value="orders">Most orders</option>
          {showMoney && <option value="spent">Most spent</option>}
          <option value="joined">Newest</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>

      <div className="adm-spacer" />

      {isLoading ? (
        <SkeletonRows rows={8} thumb={false} />
      ) : error ? (
        <EmptyState icon="alert" title={error} />
      ) : rows.length === 0 ? (
        <EmptyState icon="customers" title="No customer accounts yet" hint="Shoppers appear here after they sign in at checkout." />
      ) : visible.length === 0 ? (
        <EmptyState icon="search" title="No customer matches that search" />
      ) : (
        <div className={`adm-list adm-clist${showMoney ? ' adm-clist--money' : ''}`} role="list" aria-label="Customers">
          <div className="adm-thead" aria-hidden="true">
            <span>NAME</span>
            <span>EMAIL</span>
            <span>PHONE</span>
            <span>ORDERS</span>
            {showMoney && <span>TOTAL SPENT</span>}
            <span>LAST ORDER</span>
            <span>JOINED</span>
          </div>
          {visible.map((c) => (
            <div key={c.id} role="listitem" className="adm-lrow adm-crow" data-testid="customer-row" onClick={() => setOpenId(c.id)}>
              <div className="adm-lrow__main">
                <button
                  type="button"
                  className="adm-lrow__open"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenId(c.id);
                  }}
                >
                  <span className="adm-lrow__name">{c.full_name || c.email}</span>
                </button>
                <p className="adm-lrow__meta adm-mobile-meta">
                  <span>{c.phone || c.email}</span>
                  <span>
                    {c.order_count} order{c.order_count === 1 ? '' : 's'}
                  </span>
                  {c.last_order_at && <span>last {shortDate(c.last_order_at)}</span>}
                </p>
              </div>
              <span className="adm-crow__spent adm-price adm-mobile-meta">
                {c.total_spent !== null ? formatTakaBd(c.total_spent) : ''}
              </span>
              <span className="adm-cell adm-cell--muted">{c.email}</span>
              <span className="adm-cell">{c.phone || '—'}</span>
              <span className="adm-cell">{c.order_count}</span>
              {showMoney && <span className="adm-cell adm-price">{c.total_spent !== null ? formatTakaBd(c.total_spent) : '—'}</span>}
              <span className="adm-cell adm-cell--muted">{shortDate(c.last_order_at)}</span>
              <span className="adm-cell adm-cell--muted">{shortDate(c.joined_at)}</span>
            </div>
          ))}
        </div>
      )}
      {visible.length > 0 && (
        <p className="adm-list-foot">
          {visible.length} of {rows.length} customer{rows.length === 1 ? '' : 's'}
        </p>
      )}

      <CustomerSheet
        customer={open}
        canOpenOrders={can('view_orders')}
        onClose={() => setOpenId('')}
        onOpenOrder={onOpenOrder}
      />
    </section>
  );
}

function CustomerSheet({
  customer,
  canOpenOrders,
  onClose,
  onOpenOrder,
}: {
  customer: CustomerRow | null;
  canOpenOrders: boolean;
  onClose: () => void;
  onOpenOrder: (orderId: string) => void;
}) {
  const [orders, setOrders] = useState<CustomerOrderRow[] | null>(null);

  useEffect(() => {
    if (!customer) return;
    let alive = true;
    setOrders(null);
    void fetchCustomerOrders(customer.id).then((list) => {
      if (alive) setOrders(list);
    });
    return () => {
      alive = false;
    };
  }, [customer]);

  return (
    <BottomSheet isOpen={customer !== null} onClose={onClose} title={customer ? customer.full_name || customer.email : 'Customer'}>
      {customer && (
        <div className="adm-customer">
          <ul className="adm-customer__facts">
            <li>
              <AdminIcon name="mail" />
              <span>{customer.email || '—'}</span>
            </li>
            <li>
              <AdminIcon name="phone" />
              <span>{customer.phone || '—'}</span>
            </li>
            <li>
              <AdminIcon name="clock" />
              <span>Joined {formatDhakaTime(customer.joined_at)}</span>
            </li>
          </ul>
          <div className="adm-customer__stats">
            <div>
              <span className="adm-kpi__label">Orders</span>
              <span className="adm-customer__stat">{customer.order_count}</span>
            </div>
            {customer.total_spent !== null && (
              <div>
                <span className="adm-kpi__label">Total spent</span>
                <span className="adm-customer__stat adm-price">{formatTakaBd(customer.total_spent)}</span>
              </div>
            )}
          </div>

          <h3 className="adm-group__title adm-customer__heading">ORDERS</h3>
          {orders === null ? (
            <SkeletonRows rows={3} thumb={false} />
          ) : orders.length === 0 ? (
            <p className="admin-panel__description">No orders yet.</p>
          ) : (
            <div className="adm-group__box adm-group__box--inset">
              {orders.map((o) => {
                const label = isOrderStatus(o.status) ? ORDER_STATUS_LABELS[o.status] : o.status;
                return (
                  <button
                    key={o.id}
                    type="button"
                    className="adm-row"
                    disabled={!canOpenOrders}
                    onClick={() => {
                      onClose();
                      onOpenOrder(o.id);
                    }}
                  >
                    <span className="adm-row__label">
                      <b>{o.order_number}</b>
                      <span className="adm-row__sub">
                        {shortDate(o.created_at)} · {o.item_count} item{o.item_count === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span className={`adm-status adm-status--${o.status}`}>{label}</span>
                    {o.total !== null && <span className="adm-price">{formatTakaBd(o.total)}</span>}
                    {canOpenOrders && <AdminIcon name="chevron-right" className="adm-row__chevron adm-row__chevron--tight" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </BottomSheet>
  );
}
