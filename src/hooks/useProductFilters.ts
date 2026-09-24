import { useCallback, useMemo, useState } from 'react';
import type { Product } from '../types';

export interface ProductFilterState {
  brands: string[];
  skinTypes: string[];
}

export const EMPTY_FILTERS: ProductFilterState = { brands: [], skinTypes: [] };

/**
 * Pure filter-application, exported so the filter sheet can preview a result
 * count against a draft (not-yet-applied) selection using the exact same
 * logic the grid uses once it's committed.
 */
export function applyProductFilters(products: Product[], filters: ProductFilterState): Product[] {
  if (filters.brands.length === 0 && filters.skinTypes.length === 0) return products;
  return products.filter((p) => {
    if (filters.brands.length > 0 && (!p.brand || !filters.brands.includes(p.brand))) {
      return false;
    }
    if (filters.skinTypes.length > 0) {
      const types = p.skin_types ?? [];
      if (!filters.skinTypes.some((t) => types.includes(t))) return false;
    }
    return true;
  });
}

/**
 * Brand + Skin Type filtering for the product grid — combined with AND
 * across the two facets, OR within each (e.g. Brand=CeraVe OR Avene, AND
 * SkinType=Sensitive). Applied on top of the existing category/search
 * pipeline, never inside it, so neither of those is touched.
 */
export function useProductFilters(catalog: Product[]) {
  const [filters, setFilters] = useState<ProductFilterState>(EMPTY_FILTERS);

  /** Every brand actually present in the active catalog, alphabetised. */
  const availableBrands = useMemo(() => {
    const set = new Set<string>();
    for (const p of catalog) {
      if (p.brand && p.brand.trim() !== '') set.add(p.brand.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [catalog]);

  const apply = useCallback((products: Product[]) => applyProductFilters(products, filters), [
    filters,
  ]);

  const activeCount = filters.brands.length + filters.skinTypes.length;
  const clear = useCallback(() => setFilters(EMPTY_FILTERS), []);

  return { filters, setFilters, availableBrands, apply, activeCount, clear };
}
