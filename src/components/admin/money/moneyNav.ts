import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

/**
 * Batch 41: which Money screen is open lives in the URL
 * (?tab=money&m=<view>&id=<id>), like Inventory's sub-pages, so phone Back
 * returns to the list and a refresh keeps the place.
 */
export type MoneyView =
  | 'home'
  | 'add'
  | 'accounts'
  | 'account'
  | 'entry'
  | 'expenses'
  | 'categories'
  | 'people'
  | 'opening'
  | 'count'
  | 'writeoffs';

const VIEWS: readonly MoneyView[] = ['home', 'add', 'accounts', 'account', 'entry', 'expenses', 'categories', 'people', 'opening', 'count', 'writeoffs'];

export function useMoneyNav() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const raw = searchParams.get('m') ?? 'home';
  const view: MoneyView = (VIEWS as readonly string[]).includes(raw) ? (raw as MoneyView) : 'home';
  const id = searchParams.get('id');

  const open = useCallback(
    (next: MoneyView, nextId?: string, options: { replace?: boolean } = {}) => {
      const params = new URLSearchParams(location.search);
      params.set('tab', 'money');
      if (next === 'home') params.delete('m');
      else params.set('m', next);
      if (nextId) params.set('id', nextId);
      else params.delete('id');
      navigate({ search: `?${params.toString()}` }, { replace: options.replace });
      window.scrollTo(0, 0);
    },
    [location.search, navigate]
  );

  /** Back: the previous screen when there is one, else the Money page. */
  const back = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) {
      navigate(-1);
      return;
    }
    open('home', undefined, { replace: true });
  }, [navigate, open]);

  return { view, id, open, back };
}

export type MoneyOpen = ReturnType<typeof useMoneyNav>['open'];
