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

  // Whichever chip is active scrolls into view within the row — e.g.
  // selecting "Hair Care" from the Browse circles while the chip row itself
  // is scrolled to the far left would otherwise leave the active chip
  // off-screen. 'nearest' on both axes so this never also nudges the page.
  useEffect(() => {
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
