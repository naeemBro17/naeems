/**
 * Remembers the scroll position of every history entry the shopper has
 * left, keyed by react-router's per-entry `location.key` — the same key a
 * Back (phone or in-app) lands on again, so "come back to exactly where you
 * were" works for every page and every list without each page keeping its
 * own flag. Written by lib/appHistory.ts at the moment a navigation leaves an
 * entry (before the new page renders, so window.scrollY is still the old
 * page's), read by PageTransition's ScrollRestorer when a page mounts from a
 * Back. Mirrored into sessionStorage so a reload in the middle of browsing
 * still finds it; a storage failure (private mode, quota) just means memory-
 * only for this tab.
 */
const STORAGE_KEY = 'nph_scroll_by_entry';
/** Plenty for any real browsing session; oldest entries are dropped first. */
const MAX_ENTRIES = 60;

function load(): Map<string, number> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    const entries = parsed.filter(
      (item): item is [string, number] =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === 'string' &&
        typeof item[1] === 'number'
    );
    return new Map(entries);
  } catch {
    return new Map();
  }
}

const memory = load();

function persist(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(memory.entries())));
  } catch {
    // Memory-only for this tab — still correct until a reload.
  }
}

export function rememberScroll(entryKey: string, y: number): void {
  // Delete first so re-saving an entry moves it to the newest end.
  memory.delete(entryKey);
  memory.set(entryKey, Math.max(0, Math.round(y)));
  while (memory.size > MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
  persist();
}

export function recallScroll(entryKey: string): number | null {
  return memory.get(entryKey) ?? null;
}
