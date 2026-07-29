import { useMemo } from 'react';
import type { Product } from '../types';
import { normalizeText } from '../lib/format';
import { useDebounce } from './useDebounce';

const SEARCH_DEBOUNCE_MS = 150;

/**
 * Client-side product search — zero database calls per keystroke.
 * Matches against name, SKU, category name, and note,
 * case-insensitive and accent-insensitive. Also filters by category.
 */
export function useSearch(
  products: Product[],
  query: string,
  categoryId: string | null
): Product[] {
  const debouncedQuery = useDebounce(query, SEARCH_DEBOUNCE_MS);

  return useMemo(() => {
    let result = products;

    if (categoryId) {
      result = result.filter((p) => p.category_id === categoryId);
    }

    const q = normalizeText(debouncedQuery.trim());
    if (q) {
      result = result.filter((p) => {
        const haystack = [p.name, p.sku, p.category?.name ?? '', p.note ?? '']
          .map(normalizeText)
          .join(' ');
        return haystack.includes(q);
      });
    }

    return result;
  }, [products, debouncedQuery, categoryId]);
}
