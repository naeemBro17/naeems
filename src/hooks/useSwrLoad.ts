import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isFresh, readSwr, writeSwr } from '../lib/swrCache';

/**
 * Batch 62: one screen's data, stale-while-revalidate. The last good copy
 * (saved under `key`) shows at once; the fresh answer replaces it as soon
 * as it arrives (fromCopy turns false). Back in the app after more than 60
 * seconds it is read again, quietly. A null key = no copy (just loads).
 *
 * The copy is for showing only: actions must always use fresh data.
 */
export function useSwrLoad<T>(
  key: string | null,
  load: () => Promise<T>,
  options: { keep?: (data: T) => boolean } = {}
): { data: T | null; fromCopy: boolean; reload: () => Promise<void> } {
  const [state, setState] = useState<{ key: string | null; data: T | null; fromCopy: boolean }>(() => {
    const copy = key ? readSwr<T>(key) : null;
    return { key, data: copy?.data ?? null, fromCopy: copy !== null };
  });
  const loadRef = useRef(load);
  loadRef.current = load;
  const keepRef = useRef(options.keep);
  keepRef.current = options.keep;
  const fetchedAtRef = useRef(0);
  const runRef = useRef(0);

  const reload = useCallback(async () => {
    const run = ++runRef.current;
    fetchedAtRef.current = Date.now();
    const fresh = await loadRef.current();
    if (run !== runRef.current) return;
    setState({ key, data: fresh, fromCopy: false });
    if (key && (keepRef.current ? keepRef.current(fresh) : true)) writeSwr<T>(key, fresh);
  }, [key]);

  // A new key (another period, another user): its own copy at once, then fresh.
  const copyForKey = useMemo(() => (key ? readSwr<T>(key) : null), [key]);
  useEffect(() => {
    setState((prev) => (prev.key === key ? prev : { key, data: copyForKey?.data ?? null, fromCopy: copyForKey !== null }));
    void reload();
  }, [key, copyForKey, reload]);

  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== 'visible' || fetchedAtRef.current === 0) return;
      if (isFresh(fetchedAtRef.current)) return;
      void reload();
    };
    document.addEventListener('visibilitychange', onReturn);
    return () => document.removeEventListener('visibilitychange', onReturn);
  }, [reload]);

  const shown = state.key === key ? state : { data: copyForKey?.data ?? null, fromCopy: copyForKey !== null };
  return { data: shown.data, fromCopy: shown.fromCopy, reload };
}
