import { useCallback, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

/**
 * Page state that must survive a Back — a selected category chip, a typed
 * search, a list filter — lives in the URL's query string, not in component
 * state (which is thrown away the moment the page unmounts). Returns the
 * current params plus `update`, which edits them in place:
 *
 * - replacing the current history entry, never pushing, so picking a chip
 *   doesn't add a Back step;
 * - reading from the live URL rather than this render's params, so several
 *   updates in one tick (brand + skin type) all land instead of the last one
 *   overwriting the rest;
 * - skipping the navigation entirely when nothing actually changed;
 * - keeping the entry's location state (e.g. a product row handed along).
 */
export function useUrlParams() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const stateRef = useRef<unknown>(location.state);
  stateRef.current = location.state;

  const update = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const current = new URLSearchParams(window.location.search);
      const next = new URLSearchParams(current);
      mutate(next);
      const search = next.toString();
      if (search === current.toString()) return;
      navigate({ search: search === '' ? '' : `?${search}` }, { replace: true, state: stateRef.current });
    },
    [navigate]
  );

  return [searchParams, update] as const;
}

/**
 * One single-value filter kept in the URL (see useUrlParams). Reads back as
 * `fallback` when absent — or when the URL holds a value outside `allowed`,
 * e.g. a hand-edited link — and setting it back to `fallback` removes the
 * param, so an unfiltered list keeps a clean address.
 */
export function useUrlParam<T extends string>(
  name: string,
  fallback: T,
  allowed?: readonly T[]
): [T, (value: T) => void] {
  const [searchParams, update] = useUrlParams();
  const raw = searchParams.get(name);
  const isAllowed = (candidate: string): candidate is T =>
    allowed ? (allowed as readonly string[]).includes(candidate) : true;
  const value = raw !== null && isAllowed(raw) ? raw : fallback;

  const setValue = useCallback(
    (next: T) => {
      update((params) => {
        if (next === fallback) params.delete(name);
        else params.set(name, next);
      });
    },
    [update, name, fallback]
  );

  return [value, setValue];
}
