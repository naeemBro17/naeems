import { useEffect, useRef } from 'react';
import type { Category } from '../../types';

interface CategoryChipsProps {
  categories: Category[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

/** 'all' stands in for the null category id as a map key. */
const ALL_KEY = 'all';

export function CategoryChips({ categories, selectedId, onSelect }: CategoryChipsProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const isFirstRender = useRef(true);

  // Whichever chip is active scrolls into view within the row — e.g.
  // selecting "Hair Care" from the Browse circles while the chip row itself
  // is scrolled to the far left would otherwise leave the active chip
  // off-screen. 'nearest' on both axes so this never also nudges the page —
  // except that guard only holds for a chip that's ALREADY off-screen for a
  // reason unrelated to page scroll (the row's own horizontal scroll); the
  // very first render of a fresh mount is exactly that case, since the chip
  // row typically isn't near the top of a restored deep scroll position at
  // all — 'nearest' block-axis then means "scroll the page", fighting
  // ViewerPage's own scroll restoration on the way back from a product
  // (reports/batch-21.txt Part 1, caught by the e2e suite in Part 3). Only
  // a real, later category change (not the mount itself) should move
  // anything.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const key = selectedId ?? ALL_KEY;
    chipRefs.current.get(key)?.scrollIntoView({
      behavior: 'smooth',
      inline: 'nearest',
      block: 'nearest',
    });
  }, [selectedId]);

  const registerChip = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) chipRefs.current.set(key, el);
    else chipRefs.current.delete(key);
  };

  return (
    <div
      ref={rowRef}
      className="category-chips"
      role="tablist"
      aria-label="Filter by category"
    >
      <button
        ref={registerChip(ALL_KEY)}
        type="button"
        role="tab"
        aria-selected={selectedId === null}
        className={`chip${selectedId === null ? ' chip--active' : ''}`}
        onClick={() => onSelect(null)}
      >
        All
      </button>
      {categories.map((category) => (
        <button
          key={category.id}
          ref={registerChip(category.id)}
          type="button"
          role="tab"
          aria-selected={selectedId === category.id}
          className={`chip${selectedId === category.id ? ' chip--active' : ''}`}
          onClick={() => onSelect(category.id)}
        >
          {category.name}
        </button>
      ))}
    </div>
  );
}
