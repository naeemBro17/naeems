import { appVersionNumber } from './appVersion';

/**
 * Batch 62: "faster when you come back". The last good copy of a screen's
 * data is kept in this browser (localStorage) so the screen shows it at
 * once and refreshes quietly in the background (stale-while-revalidate).
 *
 *  - Only for SHOWING. Nothing read from here is ever saved back or used
 *    for an action: placing an order, payments and stock always use fresh
 *    server data, as before.
 *  - Keyed by the app version: a new version starts with empty copies
 *    (their shape may have changed); older versions' copies are removed.
 *  - Keyed by who is signed in (callers pass the user id), and every copy
 *    is removed on sign-out.
 *  - Every read and write is wrapped: private mode, a full or blocked
 *    storage simply means no copy.
 */

const ROOT = 'nh-swr:';
const prefix = () => `${ROOT}${appVersionNumber()}:`;

/** A copy older than this is fetched again when the app comes back. */
export const SWR_MAX_AGE_MS = 60_000;

/** The older, unkeyed product cache (before Batch 62). */
const LEGACY_KEYS = ['price_hub_v1'];

export interface SwrCopy<T> {
  data: T;
  /** When it was saved (ms since 1970). */
  at: number;
}

export function readSwr<T>(key: string): SwrCopy<T> | null {
  try {
    const raw = window.localStorage.getItem(prefix() + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SwrCopy<T>>;
    if (typeof parsed.at !== 'number' || parsed.data === undefined) return null;
    return { data: parsed.data as T, at: parsed.at };
  } catch {
    return null;
  }
}

export function writeSwr<T>(key: string, data: T, at: number = Date.now()): void {
  try {
    window.localStorage.setItem(prefix() + key, JSON.stringify({ data, at }));
  } catch {
    // Full or unavailable: the screen simply has no copy next time.
  }
}

/** True while a copy saved at `at` is young enough not to fetch again. */
export function isFresh(at: number, now: number = Date.now(), maxAge: number = SWR_MAX_AGE_MS): boolean {
  return now - at >= 0 && now - at < maxAge;
}

function keysWhere(test: (key: string) => boolean): string[] {
  const out: string[] = [];
  try {
    const store = window.localStorage;
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && test(key)) out.push(key);
    }
  } catch {
    return [];
  }
  return out;
}

function removeAll(keys: string[]): void {
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Nothing more to do.
    }
  }
}

/** Sign-out: every copy goes (all versions, the old product cache too). */
export function clearSwr(): void {
  removeAll([...keysWhere((k) => k.startsWith(ROOT)), ...LEGACY_KEYS]);
}

/** App start: copies written by another app version are removed. */
export function dropOtherVersions(): void {
  const mine = prefix();
  removeAll(keysWhere((k) => k.startsWith(ROOT) && !k.startsWith(mine)));
}
