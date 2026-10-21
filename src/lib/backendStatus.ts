import { useSyncExternalStore } from 'react';

/* Batch 40 Part 3: when the shop cannot reach Supabase at all (the plan was
   blocked with "402 Service restricted" on 11 Oct 2026, a server error, or
   no answer), customers get a calm page with WhatsApp and Messenger instead
   of an empty or broken shop, and the admin sign-in page a short note.

   Every Supabase call from the site goes through `watchedFetch` (set on the
   Supabase client in lib/supabase.ts), so this sees the real answers:
   - 402 from anywhere: the project is blocked — down.
   - before the shop's first data has loaded: a server error (5xx), no
     answer (with the phone online), or 8 seconds without it — down.
   - any answer that isn't a 402 or a server error — reachable again.
   While down, it asks once every 30 seconds whether Supabase is back (one
   tiny request, only while the page is visible), never in a tight loop. */

export const FIRST_LOAD_TIMEOUT_MS = 8_000;
export const RECHECK_EVERY_MS = 30_000;

type Listener = () => void;

let down = false;
let firstLoadDone = false;
let firstLoadTimer: number | null = null;
let recheckTimer: number | null = null;
let recheck: (() => Promise<boolean>) | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function stopRecheck(): void {
  if (recheckTimer !== null) window.clearInterval(recheckTimer);
  recheckTimer = null;
}

function startRecheck(): void {
  if (recheckTimer !== null || !recheck) return;
  recheckTimer = window.setInterval(() => {
    if (document.visibilityState === 'hidden' || !recheck) return;
    void recheck().catch(() => false);
  }, RECHECK_EVERY_MS);
}

function setDown(next: boolean): void {
  if (down === next) return;
  down = next;
  if (down) startRecheck();
  else stopRecheck();
  emit();
}

/** The shop can't reach Supabase (see the top of this file). */
export function isBackendDown(): boolean {
  return down;
}

export function subscribeBackend(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while Supabase can't be reached; re-renders when that changes. */
export function useBackendDown(): boolean {
  return useSyncExternalStore(subscribeBackend, isBackendDown, () => false);
}

/** The shop's first data (products, categories, settings) arrived. */
export function markFirstLoadDone(): void {
  firstLoadDone = true;
  if (firstLoadTimer !== null) window.clearTimeout(firstLoadTimer);
  firstLoadTimer = null;
  setDown(false);
}

/** Starts the 8-second wait for the first data. Called once when the
 *  Supabase client is made (page start). */
export function startFirstLoadWatch(check: () => Promise<boolean>): void {
  // Not in a browser (the invoice code also runs in Node): nothing to watch.
  if (typeof window === 'undefined') return;
  recheck = async () => {
    const ok = await check();
    if (ok) setDown(false);
    return ok;
  };
  if (firstLoadTimer !== null || firstLoadDone) return;
  firstLoadTimer = window.setTimeout(() => {
    firstLoadTimer = null;
    if (!firstLoadDone && navigator.onLine !== false) setDown(true);
  }, FIRST_LOAD_TIMEOUT_MS);
}

/** What one answer from Supabase says about it. */
export function judgeAnswer(status: number | null, phoneOnline: boolean, beforeFirstLoad: boolean): 'down' | 'up' | 'unknown' {
  if (status === 402) return 'down';
  if (status === null) return phoneOnline && beforeFirstLoad ? 'down' : 'unknown';
  if (status >= 500) return beforeFirstLoad ? 'down' : 'unknown';
  return 'up';
}

/** Supabase's own functions (Steadfast etc.) answer for themselves; their
 *  errors say nothing about the shop's data. */
function isFunctionCall(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return url.includes('/functions/v1/');
}

/** fetch() for the Supabase client: the same, but it reports (above). */
export const watchedFetch: typeof fetch = async (input, init) => {
  const functionCall = isFunctionCall(input);
  try {
    const response = await fetch(input, init);
    if (!functionCall) {
      const verdict = judgeAnswer(response.status, true, !firstLoadDone);
      if (verdict === 'down') setDown(true);
      else if (verdict === 'up') setDown(false);
    }
    return response;
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    if (!functionCall && !aborted && judgeAnswer(null, navigator.onLine !== false, !firstLoadDone) === 'down') setDown(true);
    throw err;
  }
};
