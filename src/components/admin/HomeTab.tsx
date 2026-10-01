import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { fetchDashboard, type DashboardData } from '../../lib/adminData';
import { formatTakaBd, greeting, greetingName, type AdminSection } from '../../lib/adminNav';
import { AdminPageHeader, EmptyState, ListGroup, ListRow } from './ui/AdminUi';
import { AdminIcon } from './ui/AdminIcon';

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
  const { staff, profile } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    const result = await fetchDashboard();
    setData(result.data);
    setError(result.error);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const name = greetingName(staff?.full_name || profile?.full_name, staff?.username);
  const sales = data?.can_see_sales === true;

  const attention: { key: string; icon: 'orders' | 'low-stock' | 'reviews' | 'wholesalers'; count: number; text: string; open: () => void }[] = [];
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

  const hasOrderCards = data?.today_orders !== undefined;

  return (
    <section aria-label="Home" className="adm-home">
      <AdminPageHeader eyebrow={title} kicker={`${greeting()},`} title={name} />

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
          {hasOrderCards && data && (
            <div className="adm-kpis">
              <button type="button" className="adm-kpi adm-kpi--hi" onClick={() => onOpen('orders')} data-testid="kpi-today">
                <span className="adm-kpi__label">Today's orders</span>
                <span className="adm-kpi__value" data-testid="kpi-today-count">{data.today_orders}</span>
                <span className="adm-kpi__sub" data-testid="kpi-today-total">
                  {sales && data.today_total !== undefined ? formatTakaBd(data.today_total) : 'placed today'}
                </span>
              </button>
              <button
                type="button"
                className="adm-kpi"
                onClick={() => onOpen('orders', { ostatus: 'pending' })}
                data-testid="kpi-confirm"
              >
                <span className="adm-kpi__label">To confirm</span>
                <span className="adm-kpi__value adm-kpi__value--accent" data-testid="kpi-confirm-count">{data.to_confirm}</span>
                <span className="adm-kpi__sub">waiting</span>
              </button>
              <button
                type="button"
                className="adm-kpi"
                onClick={() => onOpen('orders', { ostatus: 'shipped' })}
                data-testid="kpi-way"
              >
                <span className="adm-kpi__label">On the way</span>
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

          <ListGroup title="NEEDS ATTENTION">
            {attention.length === 0 ? (
              <p className="adm-caught-up">
                <AdminIcon name="check" />
                All caught up. Nothing is waiting for you.
              </p>
            ) : (
              attention.map((row) => (
                <ListRow key={row.key} icon={row.icon} count={row.count} label={row.text} onClick={row.open} />
              ))
            )}
          </ListGroup>
        </>
      )}
    </section>
  );
}
