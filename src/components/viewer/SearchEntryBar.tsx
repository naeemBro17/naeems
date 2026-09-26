import { useAppNavigate as useNavigate } from '../../hooks/useAppNavigate';

interface SearchEntryBarProps {
  /** Opens the Brand/Skin Type filter sheet — still lives on the home grid. */
  onOpenFilters: () => void;
  activeFilterCount: number;
}

/**
 * What sits at the top of the home page: looks exactly like the real search
 * bar, but is a button, not an input — tapping it (like Daraz/Shopee/Amazon)
 * goes straight to the dedicated /search view rather than typing in place.
 * Keeps the filter button, which still filters the home grid.
 */
export function SearchEntryBar({ onOpenFilters, activeFilterCount }: SearchEntryBarProps) {
  const navigate = useNavigate();

  return (
    <div className="search-row">
      <button
        type="button"
        className="search-bar search-bar--entry"
        onClick={() => navigate('/search')}
        aria-label="Search products"
      >
        <svg
          className="search-bar__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <span className="search-bar__placeholder">Search products...</span>
      </button>

      <button
        type="button"
        className="filter-button"
        onClick={onOpenFilters}
        aria-label={
          activeFilterCount > 0
            ? `Filter products, ${activeFilterCount} active`
            : 'Filter products'
        }
      >
        <svg
          className="filter-button__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 7h16" />
          <path d="M7 12h10" />
          <path d="M10 17h4" />
        </svg>
        {activeFilterCount > 0 && (
          <span className="filter-button__badge" aria-hidden="true">
            {activeFilterCount}
          </span>
        )}
      </button>
    </div>
  );
}
