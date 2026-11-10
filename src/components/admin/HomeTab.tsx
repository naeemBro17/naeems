import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { fetchCustomersV3, fetchDashboard, type DashboardData } from '../../lib/adminData';
import { isTestCustomer, isTestViewer } from '../../lib/testData';
import { dueSummary, homeDateLabel, type DueSummary } from '../../lib/homeStats';
import { formatTakaBd, greeting, greetingName, type AdminSection } from '../../lib/adminNav';
import { AdminPageHeader, EmptyState, ListGroup, ListRow } from './ui/AdminUi';
import { AdminIcon } from './ui/AdminIcon';
import { SalesChart } from './SalesChart';
import { fetchUnpaidOrders, overdueOrders, UNPAID_AFTER_DAYS } from '../../lib/payouts';
import { fetchDashboard as fetchMoneyDashboard } from '../../lib/reports/api';
import { dashboardRanges, type DashboardPeriod } from '../../lib/reports/periods';
import type { DashboardData as MoneyDashboard } from '../../lib/reports/types';
import { dhakaToday } from '../../lib/inventory/api';
import { DashboardTop } from './DashboardTop';
import '../../styles/adminInventory.css';
import '../../styles/adminMoney.css';
import '../../styles/adminReports.css';

interface HomeTabProps {
  /** "NAEEM'S SUPER ADMIN" / "NAEEM'S <ROLE>". */
  title: string;
  onOpen: (section: AdminSection, params?: Record<string, string>) => void;
}

/**
 * Admin → Home (Batch 25 Part 2, mockup screen 3): what happened today and
 * what is waiting. Every number comes from one database call
 * (admin_dashboard); a card only shows when this person may see that
 * section, and money only with "See sales figures".
 */
export function HomeTab({ title, onOpen }: HomeTabProps) {
  const { staff, profile, can } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Batch 32 Part 5: "৳X due from N customers" — the same numbers as the
  // Customers page's Due filter (hidden customers included: money owed is
  // still owed; the tests' own customers left out for real staff).
  const [due, setDue] = useState<DueSummary | null>(null);
  const canSeeCustomers = can('view_customers');
  const hideTests = !isTestViewer(staff);
  // Batch 36 Part 1: Steadfast orders not paid after 7 days (only with
  // "View profit & costs"; the database answers nobody else).
  const canSeeCosts = can('view_profit_costs');
  const [unpaidCount, setUnpaidCount] = useState(0);

  // Batch 42 Part 1: for "View profit & costs" Home is the Dashboard — the
  // Money page's own numbers (money_summary) for Today / This month / This
  // year, and more "Needs attention" lines. Everyone else keeps this Home.
  const [period, setPeriod] = useState<DashboardPeriod>('month');
  const [money, setMoney] = useState<MoneyDashboard | null>(null);
  const [moneyError, setMoneyError] = useState<string | null>(null);
  useEffect(() => {
    if (!canSeeCosts) return;
    let alive = true;
    setMoney(null);
    setMoneyError(null);
    const ranges = dashboardRanges(period, dhakaToday());
    void fetchMoneyDashboard(ranges.current, ranges.previous).then((answer) => {
      if (!alive) return;
      if (answer.kind === 'ready') setMoney(answer.data);
      else setMoneyError(answer.kind === 'error' ? answer.message : 'The Batch 42 database step has not been run.');
    });
    return () => {
      alive = false;
    };
  }, [canSeeCosts, period]);

  const load = useCallback(async () => {
    const [result, customers, unpaid] = await Promise.all([
      fetchDashboard(),
      canSeeCustomers ? fetchCustomersV3() : Promise.resolve(null),
      canSeeCosts ? fetchUnpaidOrders() : Promise.resolve([]),
    ]);
    setUnpaidCount(overdueOrders(unpaid).length);
    setData(result.data);
    setError(result.error);
    setDue(
      customers && !customers.error
        ? dueSummary(customers.rows.filter((r) => !hideTests || !isTestCustomer({ name: r.full_name, email: r.email })))
        : null
    );
    setIsLoading(false);
  }, [canSeeCustomers, canSeeCosts, hideTests]);

  useEffect(() => {
    void load();
  }, [load]);

  const name = greetingName(staff?.full_name || profile?.full_name, staff?.username);
  const sales = data?.can_see_sales === true;

  const attention: {
    key: string;
    icon: 'orders' | 'low-stock' | 'reviews' | 'wholesalers' | 'receipt' | 'payouts' | 'clock' | 'alert' | 'restock' | 'products' | 'customers';
    count?: number;
    text: string;
    open: () => void;
  }[] = [];
  if (data?.to_confirm !== undefined && data.to_confirm > 0) {
    attention.push({
      key: 'orders',
      icon: 'orders',
      count: data.to_confirm,
      text: `order${data.to_confirm === 1 ? '' : 's'} waiting to confirm`,
      open: () => onOpen('orders', { ostatus: 'pending' }),
    });
  }
  if (data?.low_stock !== undefined && data.low_stock > 0) {
    attention.push({
      key: 'stock',
      icon: 'low-stock',
      count: data.low_stock,
      text: `product${data.low_stock === 1 ? '' : 's'} low on stock`,
      open: () => onOpen('products', { pstock: 'low' }),
    });
  }
  const att = money?.attention;
  if (att && att.expiring > 0) {
    attention.push({
      key: 'expiring',
      icon: 'clock',
      count: att.expiring,
      text: `product${att.expiring === 1 ? '' : 's'} expiring before ${att.expiring === 1 ? 'it sells' : 'they sell'}`,
      open: () => onOpen('reports', { r: 'stock' }),
    });
  }
  if (att && att.sold_without_stock > 0) {
    attention.push({
      key: 'shortfalls',
      icon: 'alert',
      count: att.sold_without_stock,
      text: `sold without stock (still open)`,
      open: () => onOpen('inventory', { inv: 'shortfalls' }),
    });
  }
  if (att && att.dues_over_30 > 0) {
    attention.push({
      key: 'dues30',
      icon: 'customers',
      count: att.dues_over_30,
      text: `customer${att.dues_over_30 === 1 ? '' : 's'} owing for over 30 days (${formatTakaBd(att.dues_over_30_amount)})`,
      open: () => onOpen('reports', { r: 'customers' }),
    });
  }
  if (att && att.no_buy_price > 0) {
    attention.push({
      key: 'nocost',
      icon: 'products',
      count: att.no_buy_price,
      text: `product${att.no_buy_price === 1 ? '' : 's'} with no buy price (in no lot yet)`,
      open: () => onOpen('inventory'),
    });
  }
  if (att && att.no_weight > 0) {
    attention.push({
      key: 'noweight',
      icon: 'products',
      count: att.no_weight,
      text: `product${att.no_weight === 1 ? '' : 's'} with no weight`,
      open: () => onOpen('inventory', { inv: 'weights' }),
    });
  }
  if (att && att.count_due) {
    attention.push({
      key: 'count',
      icon: 'restock',
      text:
        att.count_planned > 0
          ? `Monthly stock count: ${att.count_done} of ${att.count_planned} counted`
          : 'Monthly stock count is due',
      open: () => onOpen('money', { m: 'stock-count' }),
    });
  }
  if (due && due.customers > 0) {
    attention.push({
      key: 'due',
      icon: 'receipt',
      text: `${formatTakaBd(due.total)} due from ${due.customers} customer${due.customers === 1 ? '' : 's'}`,
      open: () => onOpen('customers', { cshow: 'due', csort: 'due' }),
    });
  }
  if (unpaidCount > 0) {
    attention.push({
      key: 'payouts',
      icon: 'payouts',
      count: unpaidCount,
      text: `order${unpaidCount === 1 ? '' : 's'} not paid by Steadfast after ${UNPAID_AFTER_DAYS} days`,
      open: () => onOpen('payouts'),
    });
  }
  if (data?.reviews_pending !== undefined && data.reviews_pending > 0) {
    attention.push({
      key: 'reviews',
      icon: 'reviews',
      count: data.reviews_pending,
      text: `new review${data.reviews_pending === 1 ? '' : 's'} to approve`,
      open: () => onOpen('reviews'),
    });
  }
  if (data?.wholesalers_pending !== undefined && data.wholesalers_pending > 0) {
    attention.push({
      key: 'wholesalers',
      icon: 'wholesalers',
      count: data.wholesalers_pending,
      text: `wholesaler${data.wholesalers_pending === 1 ? '' : 's'} to approve`,
      open: () => onOpen('wholesalers', { wstatus: 'pending' }),
    });
  }

  const attentionList = (
    <>
      <h2 className="adm-home__section-title">Needs attention</h2>
      <ListGroup>
        {attention.length === 0 ? (
          <p className="adm-caught-up" data-testid="home-nothing">
            <AdminIcon name="check" />
            Nothing needs attention
          </p>
        ) : (
          attention.map((row) => (
            <ListRow
              key={row.key}
              icon={row.icon}
              count={row.count}
              label={
                row.key === 'due' ? (
                  <span data-testid="home-due-row">{row.text}</span>
                ) : row.key === 'payouts' ? (
                  <span data-testid="home-unpaid-row">{row.text}</span>
                ) : (
                  row.text
                )
              }
              onClick={row.open}
            />
          ))
        )}
      </ListGroup>
    </>
  );

  const hasOrderCards = data?.today_orders !== undefined;

  return (
    <section aria-label="Home" className="adm-home">
      <AdminPageHeader eyebrow={title} title={`${greeting()}, ${name}`} subtitle={homeDateLabel()} />

      {isLoading ? (
        <div className="adm-kpis" aria-label="Loading" role="status">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="adm-kpi adm-kpi--loading" />
          ))}
        </div>
      ) : error ? (
        <EmptyState
          icon="alert"
          title={error}
          action={
            <button type="button" className="adm-btn adm-btn--ghost" onClick={() => void load()}>
              Try again
            </button>
          }
        />
      ) : (
        <>
          {canSeeCosts && (
            <DashboardTop data={money} error={moneyError} period={period} onPeriod={setPeriod} onOpen={onOpen} />
          )}
          {canSeeCosts && attentionList}
          {canSeeCosts && hasOrderCards && <h2 className="adm-home__section-title">Orders</h2>}
          {hasOrderCards && data && (
            <div className="adm-kpis">
              <button type="button" className="adm-kpi" onClick={() => onOpen('orders')} data-testid="kpi-today">
                <span className="adm-kpi__label">Today</span>
                <span className="adm-kpi__value" data-testid="kpi-today-count">{data.today_orders}</span>
                <span className="adm-kpi__sub" data-testid="kpi-today-total">
                  {sales && data.today_total !== undefined
                    ? `order${data.today_orders === 1 ? '' : 's'} · ${formatTakaBd(data.today_total)}`
                    : `order${data.today_orders === 1 ? '' : 's'} placed`}
                </span>
              </button>
              <button
                type="button"
                className={`adm-kpi${data.to_confirm ? ' adm-kpi--attn' : ''}`}
                onClick={() => onOpen('orders', { ostatus: 'pending' })}
                data-testid="kpi-confirm"
              >
                <span className="adm-kpi__label">To confirm</span>
                <span className="adm-kpi__value" data-testid="kpi-confirm-count">{data.to_confirm}</span>
                {data.to_confirm ? (
                  <span className="adm-kpi__sub">waiting for you</span>
                ) : (
                  <span className="adm-kpi__sub adm-kpi__sub--ok" data-testid="kpi-confirm-clear">
                    all clear
                  </span>
                )}
              </button>
              <button
                type="button"
                className="adm-kpi"
                onClick={() => onOpen('orders', { ostatus: 'shipped' })}
                data-testid="kpi-way"
              >
                <span className="adm-kpi__label">With courier</span>
                <span className="adm-kpi__value" data-testid="kpi-way-count">{data.on_the_way}</span>
                <span className="adm-kpi__sub">Steadfast</span>
              </button>
              <button type="button" className="adm-kpi" onClick={() => onOpen('orders')} data-testid="kpi-month">
                <span className="adm-kpi__label">This month</span>
                {sales && data.month_total !== undefined ? (
                  <>
                    <span className="adm-kpi__value adm-kpi__value--money" data-testid="kpi-month-total">
                      {formatTakaBd(data.month_total)}
                    </span>
                    <span className="adm-kpi__sub" data-testid="kpi-month-count">
                      {data.month_orders} order{data.month_orders === 1 ? '' : 's'}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="adm-kpi__value" data-testid="kpi-month-count">{data.month_orders}</span>
                    <span className="adm-kpi__sub">orders</span>
                  </>
                )}
              </button>
            </div>
          )}

          {sales && <SalesChart />}

          {!canSeeCosts && attentionList}
        </>
      )}
    </section>
  );
}
