import { useCallback, useMemo } from 'react';
import type { Product } from '../types';
import { productHasConcern } from '../lib/concerns';
import { useUrlParams } from './useUrlParams';

export interface ProductFilterState {
  brands: string[];
  skinTypes: string[];
  /** Batch 72: concerns (?concern=, repeatable). */
  concerns: string[];
}

export const EMPTY_FILTERS: ProductFilterState = { brands: [], skinTypes: [], concerns: [] };

/** URL param names — repeated once per selected value (?brand=A&brand=B), so
 *  a brand name containing a comma can never be split apart by mistake. */
const BRAND_PARAM = 'brand';
const SKIN_PARAM = 'skin';
const CONCERN_PARAM = 'concern';

/**
 * Pure filter-application, exported so the filter sheet can preview a result
 * count against a draft (not-yet-applied) selection using the exact same
 * logic the grid uses once it's committed.
 */
export function applyProductFilters(products: Product[], filters: ProductFilterState): Product[] {
  if (filters.brands.length === 0 && filters.skinTypes.length === 0 && filters.concerns.length === 0) return products;
  return products.filter((p) => {
    if (filters.brands.length > 0 && (!p.brand || !filters.brands.includes(p.brand))) {
      return false;
    }
    if (filters.skinTypes.length > 0) {
      const types = p.skin_types ?? [];
      if (!filters.skinTypes.some((t) => types.includes(t))) return false;
    }
    if (filters.concerns.length > 0 && !filters.concerns.some((c) => productHasConcern(p.skin_conditions, c))) {
      return false;
    }
    return true;
  });
}

/**
 * Brand + Skin Type + Concern (Batch 72) filtering for the product grid — combined with AND
 * across the two facets, OR within each (e.g. Brand=CeraVe OR Avene, AND
 * SkinType=Sensitive). Applied on top of the existing category/search
 * pipeline, never inside it, so neither of those is touched.
 *
 * The applied selection lives in the URL (see hooks/useUrlParams.ts) so Back
 * from a product returns to the same filtered grid.
 */
export function useProductFilters(catalog: Product[]) {
  const [searchParams, updateParams] = useUrlParams();
  const brandKey = searchParams.getAll(BRAND_PARAM).join('\u0000');
  const skinKey = searchParams.getAll(SKIN_PARAM).join('\u0000');
  const concernKey = searchParams.getAll(CONCERN_PARAM).join('\u0000');

  // Keyed on the joined values so the object is only rebuilt when the
  // selection actually changes, not on every unrelated URL update.
  const filters = useMemo<ProductFilterState>(
    () => ({
      brands: brandKey === '' ? [] : brandKey.split('\u0000'),
      skinTypes: skinKey === '' ? [] : skinKey.split('\u0000'),
      concerns: concernKey === '' ? [] : concernKey.split('\u0000'),
    }),
    [brandKey, skinKey, concernKey]
  );

  const setFilters = useCallback(
    (next: ProductFilterState) => {
      updateParams((params) => {
        params.delete(BRAND_PARAM);
        params.delete(SKIN_PARAM);
        params.delete(CONCERN_PARAM);
        for (const brand of next.brands) params.append(BRAND_PARAM, brand);
        for (const skin of next.skinTypes) params.append(SKIN_PARAM, skin);
        for (const concern of next.concerns) params.append(CONCERN_PARAM, concern);
      });
    },
    [updateParams]
  );

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

  const activeCount = filters.brands.length + filters.skinTypes.length + filters.concerns.length;
  const clear = useCallback(() => setFilters(EMPTY_FILTERS), [setFilters]);

  return { filters, setFilters, availableBrands, apply, activeCount, clear };
}
