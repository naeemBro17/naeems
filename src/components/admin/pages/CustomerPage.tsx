import { useEffect, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { AdminFormPage } from '../AdminFormPage';
import { useLeaveGuard } from '../LeaveGuard';
import { fetchCustomerOrders, fetchCustomers, type CustomerOrderRow, type CustomerRow } from '../../../lib/adminData';
import { formatTakaBd } from '../../../lib/adminNav';
import { formatDhakaTime } from '../../../lib/staff';
import { ORDER_STATUS_LABELS } from '../../../lib/orderStatus';
import { SkeletonRows } from '../ui/AdminUi';
import { AdminIcon } from '../ui/AdminIcon';
import { CustomerNotesEditor } from '../CustomerNotes';
import { fetchCustomerNotes, knownTags, type CustomerNote } from '../../../lib/brandAdmin';
import type { OrderStatus } from '../../../types';

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric' });
}

function isOrderStatus(value: string): value is OrderStatus {
  return value in ORDER_STATUS_LABELS;
}

interface CustomerPageProps {
  customerKey: string;
  onBack: () => void;
  onOpenOrder: (orderId: string) => void;
}

/**
 * Batch 32 Part 3: /admin/customers/:key — the customer profile as a page
 * (it used to be a pop-up on the Customers list): contact, totals, private
 * notes and tags, and every order.
 */
export function CustomerPage({ customerKey, onBack, onOpenOrder }: CustomerPageProps) {
  const { can } = useAuth();
  const { markClean } = useLeaveGuard();
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [orders, setOrders] = useState<CustomerOrderRow[] | null>(null);
  const [notes, setNotes] = useState<Map<string, CustomerNote>>(() => new Map());

  useEffect(() => {
    let alive = true;
    void Promise.all([fetchCustomers(), fetchCustomerNotes()]).then(([result, noteMap]) => {
      if (!alive) return;
      const found = result.rows.find((r) => r.key === customerKey) ?? null;
      setCustomer(found);
      setNotes(noteMap);
      setStatus(found ? 'ready' : 'missing');
      if (found) {
        void fetchCustomerOrders(found).then((list) => {
          if (alive) setOrders(list);
        });
      }
    });
    return () => {
      alive = false;
    };
  }, [customerKey]);

  const canOpenOrders = can('view_orders');
  const note = customer?.id ? (notes.get(customer.id) ?? null) : null;
  const title = customer ? customer.full_name || customer.email || customer.phone : 'Customer';

  return (
    <AdminFormPage title={title} backLabel="Back to customers" onBack={onBack} testId="customer-page">
      {status === 'loading' && <SkeletonRows rows={4} thumb={false} />}
      {status === 'missing' && <p className="adm-fpage__notice">This customer was not found.</p>}
      {customer && (
        <div className="adm-customer">
          <ul className="adm-customer__facts">
            {customer.id && (
              <li>
                <AdminIcon name="mail" />
                <span>{customer.email || '—'}</span>
              </li>
            )}
            <li>
              <AdminIcon name="phone" />
              <span>{customer.phone || '—'}</span>
            </li>
            <li>
              <AdminIcon name="clock" />
              <span>{customer.joined_at ? `Joined ${formatDhakaTime(customer.joined_at)}` : 'No account — orders entered by you'}</span>
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
            {customer.total_due !== null && (
              <div>
                <span className="adm-kpi__label">Due</span>
                <span className="adm-customer__stat adm-price" data-testid="customer-sheet-due">
                  {formatTakaBd(customer.total_due)}
                </span>
              </div>
            )}
          </div>

          {customer.id && (
            <CustomerNotesEditor
              key={customer.id}
              customerId={customer.id}
              note={note}
              knownTags={knownTags(notes)}
              canEdit={can('edit_customer_notes')}
              onSaved={(saved) => {
                markClean();
                setNotes((prev) => {
                  const next = new Map(prev);
                  next.set(customer.id ?? '', saved);
                  return next;
                });
              }}
            />
          )}

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
                    onClick={() => onOpenOrder(o.id)}
                  >
                    <span className="adm-row__label">
                      <b>{o.order_number}</b>
                      <span className="adm-row__sub">
                        {shortDate(o.created_at)} · {o.item_count} item{o.item_count === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span className={`adm-status adm-status--${o.status}`}>{label}</span>
                    {o.total !== null && <span className="adm-price">{formatTakaBd(o.total)}</span>}
                    {o.due ? <span className="adm-customer__order-due">{formatTakaBd(o.due)} due</span> : null}
                    {canOpenOrders && <AdminIcon name="chevron-right" className="adm-row__chevron adm-row__chevron--tight" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </AdminFormPage>
  );
}
