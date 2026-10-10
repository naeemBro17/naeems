import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

/**
 * Batch 38: which Inventory screen is open lives in the URL
 * (?tab=inventory&inv=<view>&lot=<id>), like Settings' sub-pages, so phone
 * Back returns to the list and a refresh keeps the place.
 */
export type InvView = 'home' | 'new' | 'lot' | 'edit' | 'weights' | 'compare' | 'opening';

const VIEWS: readonly InvView[] = ['home', 'new', 'lot', 'edit', 'weights', 'compare', 'opening'];

export function useInvNav() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const raw = searchParams.get('inv') ?? 'home';
  const view: InvView = (VIEWS as readonly string[]).includes(raw) ? (raw as InvView) : 'home';
  const lotId = searchParams.get('lot');

  const open = useCallback(
    (next: InvView, lot?: string, options: { replace?: boolean } = {}) => {
      const params = new URLSearchParams(location.search);
      params.set('tab', 'inventory');
      if (next === 'home') params.delete('inv');
      else params.set('inv', next);
      if (lot) params.set('lot', lot);
      else params.delete('lot');
      navigate({ search: `?${params.toString()}` }, { replace: options.replace });
      window.scrollTo(0, 0);
    },
    [location.search, navigate]
  );

  /** Back: the previous screen when there is one, else the Inventory list. */
  const back = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) {
      navigate(-1);
      return;
    }
    open('home', undefined, { replace: true });
  }, [navigate, open]);

  return { view, lotId, open, back };
}
