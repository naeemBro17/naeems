import { useRef, type KeyboardEvent, type RefObject } from 'react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  /** Lets the bottom nav's Search tab focus this input. */
  inputRef?: RefObject<HTMLInputElement>;
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** The X button. Replaces onChange('') when the owner keeps extra state. */
  onClear?: () => void;
  /** True while the autocomplete list is showing, for aria-expanded. */
  isExpanded?: boolean;
  /** Opens the Brand/Skin Type filter sheet. */
  onOpenFilters: () => void;
  /** Number of active filters, shown as a badge on the filter button. */
  activeFilterCount: number;
}

export function SearchBar({
  value,
  onChange,
  inputRef,
  onFocus,
  onBlur,
  onKeyDown,
  onClear,
  isExpanded = false,
  onOpenFilters,
  activeFilterCount,
}: SearchBarProps) {
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;

  return (
    <div className="search-row">
      {/* No autoFocus and no focus-on-mount effect — the keyboard must only
          open when the reader taps the field themselves. */}
      <div className="search-bar">
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
        <input
          ref={ref}
          type="search"
          className="search-bar__input"
          placeholder="Search products..."
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          aria-label="Search products"
          role="combobox"
          aria-expanded={isExpanded}
          aria-controls="search-suggestions"
          aria-autocomplete="list"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {value !== '' && (
          <button
            type="button"
            className="search-bar__clear"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (onClear) onClear();
              else onChange('');
              ref.current?.focus();
            }}
            aria-label="Clear search"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

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
