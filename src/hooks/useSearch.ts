import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Fuse, { type IFuseOptions } from 'fuse.js';
import { trackSearch } from '../lib/analytics';
import type { Product } from '../types';

/** localStorage key for the recent-search list (newest first, max 5). */
export const RECENT_SEARCHES_KEY = 'nph_recent_searches';
const RECENT_LIMIT = 5;
const SUGGESTION_LIMIT = 5;
/** Mirrors FUSE_OPTIONS.minMatchCharLength. */
const MIN_QUERY_LENGTH = 2;

/**
 * Fuse.js tuning per the Session 7 brief. ignoreLocation lets a match sit
 * anywhere in a long product name ("Eco-Recharge Refill 473mL") instead of
 * only near the start.
 */
const FUSE_OPTIONS: IFuseOptions<Product> = {
  keys: ['name', 'brand', 'category.name'],
  threshold: 0.35,
  includeScore: true,
  minMatchCharLength: 2,
  ignoreLocation: true,
};

interface UseSearchOptions {
  /** Every searchable product (already restricted to active ones). */
  products: Product[];
  /** The list to show when the query is empty — carries the default ordering. */
  defaultOrdered: Product[];
  /** Category filter applied on top of the search. */
  categoryId: string | null;
  /** Runs after a suggestion is chosen (tap or Enter) — the page navigates. */
  onSelectSuggestion: (product: Product) => void;
  /** Seeds the query on first render — SearchPage restores this from the
   *  ?q= URL param so a deep link or Back lands on the same search. */
  initialQuery?: string;
}

export interface SearchState {
  query: string;
  setQuery: (value: string) => void;
  /** Products for the grid: Fuse-ranked when searching, default order otherwise. */
  results: Product[];
  /** Top matches for the autocomplete dropdown. */
  suggestions: Product[];
  /** Index highlighted by the arrow keys, or -1. */
  highlightIndex: number;
  isFocused: boolean;
  /** Autocomplete is showing: focused, query non-empty, and not dismissed. */
  isDropdownOpen: boolean;
  /** Recent panel is showing: focused, query empty, and there is history. */
  isRecentOpen: boolean;
  recent: string[];
  /** Fill the bar with a term, run the search, and record it. */
  applyTerm: (term: string) => void;
  /** Record the current query as a recent search (Enter / suggestion tap). */
  commitQuery: () => void;
  /** Pick a suggestion: fills the bar, records it, closes the dropdown. */
  selectSuggestion: (product: Product) => void;
  removeRecent: (term: string) => void;
  clearRecent: () => void;
  clear: () => void;
  closeDropdown: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function saveRecent(list: string[]): void {
  try {
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable (private mode / quota) — history is a convenience.
  }
}

/**
 * All search state for the homepage bar: the query, Fuse-ranked results,
 * autocomplete suggestions, recent-search history and the open/closed state
 * of the two panels. One Fuse index is built per products array and reused
 * across keystrokes.
 */
export function useSearch({
  products,
  defaultOrdered,
  categoryId,
  onSelectSuggestion,
  initialQuery = '',
}: UseSearchOptions): SearchState {
  const [query, setQueryState] = useState(initialQuery);
  const [isFocused, setIsFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [recent, setRecentState] = useState<string[]>(() => loadRecent());
  // Mirrors `recent` so a write can be computed and persisted synchronously.
  // Choosing a suggestion navigates away at once, and React drops state
  // updaters queued on a component that is unmounting — so the localStorage
  // write must not live inside one.
  const recentRef = useRef(recent);
  const setRecent = useCallback((next: string[]) => {
    recentRef.current = next;
    saveRecent(next);
    setRecentState(next);
  }, []);

  // Only rebuilt when the products array itself changes, never per keystroke.
  const fuse = useMemo(() => new Fuse(products, FUSE_OPTIONS), [products]);

  const trimmed = query.trim();
  // Below Fuse's minMatchCharLength nothing can match, so a single character
  // is treated like an empty query for the grid rather than showing nothing.
  const isSearching = trimmed.length >= MIN_QUERY_LENGTH;

  const ranked = useMemo<Product[]>(() => {
    if (!isSearching) return [];
    return fuse.search(trimmed).map((hit) => hit.item);
  }, [fuse, trimmed, isSearching]);

  const results = useMemo<Product[]>(() => {
    const base = isSearching ? ranked : defaultOrdered;
    return categoryId === null ? base : base.filter((p) => p.category_id === categoryId);
  }, [isSearching, defaultOrdered, ranked, categoryId]);

  const suggestions = useMemo(
    () => (isSearching ? results.slice(0, SUGGESTION_LIMIT) : []),
    [isSearching, results]
  );

  const isDropdownOpen = isFocused && isSearching && !dismissed && suggestions.length > 0;
  const isRecentOpen = isFocused && trimmed === '' && !dismissed && recent.length > 0;

  // The highlight can't outlive the list it pointed into.
  useEffect(() => {
    setHighlightIndex(-1);
  }, [trimmed, suggestions.length]);

  const setQuery = useCallback((value: string) => {
    setQueryState(value);
    setDismissed(false);
  }, []);

  const pushRecent = useCallback(
    (term: string) => {
      const value = term.trim();
      if (value === '') return;
      const current = recentRef.current;
      setRecent([value, ...current.filter((t) => t !== value)].slice(0, RECENT_LIMIT));
    },
    [setRecent]
  );

  const commitQuery = useCallback(() => {
    pushRecent(query);
    trackSearch(query);
    setDismissed(true);
  }, [pushRecent, query]);

  const applyTerm = useCallback(
    (term: string) => {
      setQueryState(term);
      pushRecent(term);
      trackSearch(term);
      setDismissed(true);
    },
    [pushRecent]
  );

  const selectSuggestion = useCallback(
    (product: Product) => {
      setQueryState(product.name);
      pushRecent(product.name);
      setDismissed(true);
      onSelectSuggestion(product);
    },
    [pushRecent, onSelectSuggestion]
  );

  const removeRecent = useCallback(
    (term: string) => setRecent(recentRef.current.filter((t) => t !== term)),
    [setRecent]
  );

  const clearRecent = useCallback(() => setRecent([]), [setRecent]);

  const clear = useCallback(() => {
    setQueryState('');
    setDismissed(false);
  }, []);

  const closeDropdown = useCallback(() => setDismissed(true), []);

  const onFocus = useCallback(() => {
    setIsFocused(true);
    setDismissed(false);
  }, []);

  const onBlur = useCallback(() => setIsFocused(false), []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        setDismissed(true);
        return;
      }
      if (!isDropdownOpen) {
        if (e.key === 'Enter' && trimmed !== '') {
          e.preventDefault();
          commitQuery();
          e.currentTarget.blur();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIndex((i) => (i + 1) % suggestions.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const chosen = highlightIndex >= 0 ? suggestions[highlightIndex] : null;
        if (chosen) {
          selectSuggestion(chosen);
        } else {
          commitQuery();
          e.currentTarget.blur();
        }
      }
    },
    [isDropdownOpen, trimmed, commitQuery, suggestions, highlightIndex, selectSuggestion]
  );

  return {
    query,
    setQuery,
    results,
    suggestions,
    highlightIndex,
    isFocused,
    isDropdownOpen,
    isRecentOpen,
    recent,
    applyTerm,
    commitQuery,
    selectSuggestion,
    removeRecent,
    clearRecent,
    clear,
    closeDropdown,
    onFocus,
    onBlur,
    onKeyDown,
  };
}
