import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUrlParam } from '../../hooks/useUrlParams';
import { useAuth } from '../../contexts/AuthContext';
import { fetchCustomers, type CustomerRow } from '../../lib/adminData';
import { adminPath } from '../../lib/adminPages';
import { isTestCustomer, isTestViewer } from '../../lib/testData';
import { formatTakaBd } from '../../lib/adminNav';
import { AdminPageHeader, AdminSearch, EmptyState, SkeletonRows } from './ui/AdminUi';
import { CustomerTagChips } from './CustomerNotes';
import { fetchCustomerNotes, knownTags, type CustomerNote } from '../../lib/brandAdmin';

type SortKey = 'recent' | 'orders' | 'spent' | 'due' | 'joined' | 'name';
const SORT_KEYS: readonly SortKey[] = ['recent', 'orders', 'spent', 'due', 'joined', 'name'];

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Admin → Customers (Batch 25 Part 4). A read-only list of shopper accounts
 * with their order count, total spent and last order. Needs "View
 * customers"; the money column only appears with "See sales figures" (the
 * database leaves it out otherwise).
 */
export function CustomersTab() {
  const { staff } = useAuth();
  const navigate = useNavigate();
  // Batch 32 Part 3: the profile is a page of its own; Back returns here
  // with the search, sort and scroll kept.
  const openCustomer = (key: string) => navigate(adminPath.customer(key), { state: { fromList: true } });
  // Batch 31 Part 3: the automatic tests' own customers stay out of the
  // list for real staff (the test logins still see them).
  const hideTestCustomers = !isTestViewer(staff);
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useUrlParam<string>('cq', '');
  const [sort, setSort] = useUrlParam<SortKey>('csort', 'recent', SORT_KEYS);
  const [tagFilter, setTagFilter] = useUrlParam<string>('ctag', '');
  // Private notes and tags (Batch 26): staff only, read with "View
  // customers", changed with "Edit customer notes".
  const [notes, setNotes] = useState<Map<string, CustomerNote>>(() => new Map());

  useEffect(() => {
    let alive = true;
    void fetchCustomerNotes().then((map) => {
      if (alive) setNotes(map);
    });
    return () => {
      alive = false;
    };
  }, []);

  const tags = useMemo(() => knownTags(notes), [notes]);

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
  // Batch 30: what each customer still owes (registered or phone-only).
  const showDue = rows.some((r) => r.total_due !== null);
  const notesFor = (c: CustomerRow) => (c.id ? (notes.get(c.id)?.tags ?? []) : []);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const real = hideTestCustomers ? rows.filter((r) => !isTestCustomer({ name: r.full_name, email: r.email })) : rows;
    const tagged = tagFilter
      ? real.filter((r) => notesFor(r).some((t) => t.toLowerCase() === tagFilter.toLowerCase()))
      : real;
    const list = term
      ? tagged.filter(
          (r) =>
            r.full_name.toLowerCase().includes(term) ||
            r.email.toLowerCase().includes(term) ||
            r.phone.replace(/\s/g, '').includes(term.replace(/\s/g, ''))
        )
      : tagged;
    const sorted = [...list];
    const time = (iso: string | null) => (iso ? new Date(iso).getTime() : 0);
    sorted.sort((a, b) => {
      switch (sort) {
        case 'orders':
          return b.order_count - a.order_count;
        case 'spent':
          return (b.total_spent ?? 0) - (a.total_spent ?? 0);
        case 'due':
          return (b.total_due ?? 0) - (a.total_due ?? 0);
        case 'joined':
          return time(b.joined_at) - time(a.joined_at);
        case 'name':
          return (a.full_name || a.email).localeCompare(b.full_name || b.email);
        default:
          return time(b.last_order_at) - time(a.last_order_at) || time(b.joined_at) - time(a.joined_at);
      }
    });
    return sorted;
  }, [rows, search, sort, tagFilter, notes, hideTestCustomers]);

  return (
    <section aria-label="Customers" className="adm-customers">
      <AdminPageHeader title="Customers" />

      <div className="adm-filter-row">
        <AdminSearch value={search} onChange={setSearch} placeholder="Search name, email or phone" label="Search customers" />
        <select className="adm-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort customers">
          <option value="recent">Last order</option>
          <option value="orders">Most orders</option>
          {showMoney && <option value="spent">Most spent</option>}
          {showDue && <option value="due">Most due</option>}
          <option value="joined">Newest</option>
          <option value="name">Name A–Z</option>
        </select>
        {tags.length > 0 && (
          <select
            className="adm-select"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            aria-label="Filter by tag"
            data-testid="customer-tag-filter"
          >
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="adm-spacer" />

      {isLoading ? (
        <SkeletonRows rows={8} thumb={false} />
      ) : error ? (
        <EmptyState icon="alert" title={error} />
      ) : rows.length === 0 ? (
        <EmptyState icon="customers" title="No customers yet" hint="Shoppers appear here after they sign in at checkout or you enter an order for them." />
      ) : visible.length === 0 ? (
        <EmptyState icon="search" title={tagFilter ? 'No customer has that tag' : 'No customer matches that search'} />
      ) : (
        <div className={`adm-list adm-clist${showMoney ? ' adm-clist--money' : ''}${showDue ? ' adm-clist--due' : ''}`} role="list" aria-label="Customers">
          <div className="adm-thead" aria-hidden="true">
            <span>NAME</span>
            <span>EMAIL</span>
            <span>PHONE</span>
            <span>ORDERS</span>
            {showMoney && <span>TOTAL SPENT</span>}
            {showDue && <span>DUE</span>}
            <span>LAST ORDER</span>
            <span>JOINED</span>
          </div>
          {visible.map((c) => (
            <div key={c.key} role="listitem" className="adm-lrow adm-crow" data-testid="customer-row" onClick={() => openCustomer(c.key)}>
              <div className="adm-lrow__main">
                <button
                  type="button"
                  className="adm-lrow__open"
                  onClick={(e) => {
                    e.stopPropagation();
                    openCustomer(c.key);
                  }}
                >
                  <span className="adm-lrow__name">{c.full_name || c.email || c.phone}</span>
                </button>
                <CustomerTagChips tags={notesFor(c)} />
                <p className="adm-lrow__meta adm-mobile-meta">
                  <span>{c.phone || c.email}</span>
                  <span>
                    {c.order_count} order{c.order_count === 1 ? '' : 's'}
                  </span>
                  {c.last_order_at && <span>last {shortDate(c.last_order_at)}</span>}
                  {c.total_due ? <span className="adm-crow__due">{formatTakaBd(c.total_due)} due</span> : null}
                </p>
              </div>
              <span className="adm-crow__spent adm-price adm-mobile-meta">
                {c.total_spent !== null ? formatTakaBd(c.total_spent) : ''}
              </span>
              <span className="adm-cell adm-cell--muted">{c.email}</span>
              <span className="adm-cell">{c.phone || '—'}</span>
              <span className="adm-cell">{c.order_count}</span>
              {showMoney && <span className="adm-cell adm-price">{c.total_spent !== null ? formatTakaBd(c.total_spent) : '—'}</span>}
              {showDue && (
                <span className="adm-cell adm-price" data-testid="customer-due">
                  {c.total_due ? formatTakaBd(c.total_due) : '—'}
                </span>
              )}
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

    </section>
  );
}
