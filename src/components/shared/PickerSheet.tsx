import { useMemo, useState } from 'react';
import { BottomSheet } from './BottomSheet';

export interface PickerOption {
  id: string;
  /** Primary label (e.g. English name). */
  label: string;
  /** Secondary label shown alongside it (e.g. Bangla name). */
  subLabel?: string;
}

interface PickerSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  options: PickerOption[];
  selectedId: string | null;
  onSelect: (option: PickerOption) => void;
  searchPlaceholder?: string;
}

/**
 * Searchable single-select list in a bottom sheet — a plain <select> with
 * 490+ entries (e.g. every Bangladeshi thana) is unusable on mobile, so this
 * is the shared picker for any long option list. Filters case-insensitively
 * across both label and subLabel, so typing either the English or Bangla
 * name finds the right row.
 */
export function PickerSheet({
  isOpen,
  onClose,
  title,
  options,
  selectedId,
  onSelect,
  searchPlaceholder = 'Search...',
}: PickerSheetProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.subLabel?.toLowerCase().includes(q)
    );
  }, [options, query]);

  const handleSelect = (option: PickerOption) => {
    onSelect(option);
    setQuery('');
    onClose();
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={title}>
      <div className="picker-sheet">
        <div className="search-bar picker-sheet__search">
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
            type="search"
            className="search-bar__input"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
          />
        </div>

        {filtered.length === 0 ? (
          <p className="picker-sheet__empty">No matches</p>
        ) : (
          <ul className="picker-sheet__list">
            {filtered.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  className={`picker-sheet__row${
                    option.id === selectedId ? ' picker-sheet__row--selected' : ''
                  }`}
                  onClick={() => handleSelect(option)}
                  aria-pressed={option.id === selectedId}
                >
                  <span className="picker-sheet__row-label">
                    {option.label}
                    {option.subLabel && (
                      <span className="picker-sheet__row-sub">{option.subLabel}</span>
                    )}
                  </span>
                  {option.id === selectedId && (
                    <svg
                      className="picker-sheet__check"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </BottomSheet>
  );
}
