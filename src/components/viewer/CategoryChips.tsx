import type { Category } from '../../types';

interface CategoryChipsProps {
  categories: Category[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function CategoryChips({ categories, selectedId, onSelect }: CategoryChipsProps) {
  return (
    <div className="category-chips" role="tablist" aria-label="Filter by category">
      <button
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
