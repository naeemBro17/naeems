import { useEffect, useMemo, useState } from 'react';
import { SKIN_TYPES } from '../../lib/skinFields';
import { BottomSheet } from '../shared/BottomSheet';
import { ChipGroup } from '../admin/edit-sheets/SheetChrome';
import { applyProductFilters, type ProductFilterState } from '../../hooks/useProductFilters';
import type { Product } from '../../types';

interface FilterSheetProps {
  isOpen: boolean;
  onClose: () => void;
  filters: ProductFilterState;
  onChange: (next: ProductFilterState) => void;
  availableBrands: string[];
  /** The category/search-filtered list the count preview is drawn from —
   *  same base the grid itself filters from, so the number the sheet shows
   *  matches what actually appears once applied. */
  baseProducts: Product[];
}

/**
 * Brand + Skin Type filters for the product grid, opened from the search
 * row's filter button. Edits are drafted locally and only committed to the
 * real grid on "Show results" — cancelling (backdrop tap, Escape, back)
 * leaves the grid exactly as it was.
 */
export function FilterSheet({
  isOpen,
  onClose,
  filters,
  onChange,
  availableBrands,
  baseProducts,
}: FilterSheetProps) {
  const [draft, setDraft] = useState(filters);

  // Start every open from whatever is actually applied right now.
  useEffect(() => {
    if (isOpen) setDraft(filters);
  }, [isOpen, filters]);

  const draftCount = draft.brands.length + draft.skinTypes.length;
  const resultCount = useMemo(
    () => applyProductFilters(baseProducts, draft).length,
    [baseProducts, draft]
  );

  const handleApply = () => {
    onChange(draft);
    onClose();
  };

  const handleClear = () => setDraft({ brands: [], skinTypes: [] });

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Filters">
      <div className="filter-sheet">
        {availableBrands.length > 0 && (
          <ChipGroup
            label="Brand"
            options={availableBrands}
            selected={draft.brands}
            onChange={(brands) => setDraft((d) => ({ ...d, brands }))}
          />
        )}

        <ChipGroup
          label="Skin Type"
          options={SKIN_TYPES}
          selected={draft.skinTypes}
          onChange={(skinTypes) => setDraft((d) => ({ ...d, skinTypes }))}
        />

        <div className="filter-sheet__footer">
          <button
            type="button"
            className="filter-sheet__clear"
            onClick={handleClear}
            disabled={draftCount === 0}
          >
            Clear all
          </button>
          <button type="button" className="filter-sheet__apply" onClick={handleApply}>
            Show {resultCount} {resultCount === 1 ? 'result' : 'results'}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
