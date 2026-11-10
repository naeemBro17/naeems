import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

/**
 * Batch 42: which report is open lives in the URL (?tab=reports&r=<id>),
 * so phone Back returns to the list and a refresh keeps the place.
 */
export type ReportId =
  | 'list'
  | 'pnl'
  | 'sales'
  | 'products'
  | 'lots'
  | 'stock'
  | 'expenses'
  | 'customers'
  | 'daybook'
  | 'investors'
  | 'charts';

export const REPORTS: readonly { id: Exclude<ReportId, 'list'>; label: string; hint: string }[] = [
  { id: 'pnl', label: 'Profit & loss', hint: 'Every step from sales to Left in the business' },
  { id: 'sales', label: 'Sales', hint: 'Orders placed: total, received, unpaid, by source' },
  { id: 'products', label: 'Products', hint: 'Best sellers, slow, low margin, not moving' },
  { id: 'lots', label: 'Lots', hint: 'Bought, sold, left, profit so far per lot' },
  { id: 'stock', label: 'Stock', hint: 'Units by lot and expiry; what expires in 90 days' },
  { id: 'expenses', label: 'Expenses', hint: 'By category and month, with share' },
  { id: 'customers', label: 'Customers', hint: 'Dues by age; top customers' },
  { id: 'daybook', label: 'Day book', hint: 'Every money movement with the running balance' },
  { id: 'investors', label: 'Investors', hint: 'Capital in, returned, owed, profit share' },
  { id: 'charts', label: 'Charts', hint: 'Profit and money in vs out, last 12 months' },
];

const IDS = new Set<string>(REPORTS.map((r) => r.id));

export function useReportsNav() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const raw = searchParams.get('r') ?? 'list';
  const report: ReportId = IDS.has(raw) ? (raw as ReportId) : 'list';

  const open = useCallback(
    (next: ReportId, extra: Record<string, string> = {}) => {
      const params = new URLSearchParams(location.search);
      params.set('tab', 'reports');
      if (next === 'list') params.delete('r');
      else params.set('r', next);
      for (const key of ['rp', 'rf', 'rt', 'rtab']) params.delete(key);
      for (const [k, v] of Object.entries(extra)) params.set(k, v);
      navigate({ search: `?${params.toString()}` });
      window.scrollTo(0, 0);
    },
    [location.search, navigate]
  );

  const back = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) {
      navigate(-1);
      return;
    }
    navigate({ search: '?tab=reports' }, { replace: true });
  }, [navigate]);

  return { report, open, back };
}
