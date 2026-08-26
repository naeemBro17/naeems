import { useRef, type RefObject } from 'react';
import { useToast } from '../../hooks/useToast';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  /** Lets the bottom nav's Search tab focus this input. */
  inputRef?: RefObject<HTMLInputElement>;
}

export function SearchBar({ value, onChange, inputRef }: SearchBarProps) {
  const { showToast } = useToast();
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
          aria-label="Search products"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {value !== '' && (
          <button
            type="button"
            className="search-bar__clear"
            onClick={() => {
              onChange('');
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
        onClick={() => showToast('Filters coming soon')}
        aria-label="Filter products"
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
      </button>
    </div>
  );
}
