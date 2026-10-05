import { useMemo, useState } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
import { groupThanas, useThanaList } from '../../lib/thanas';

interface ThanaPickerSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** The district already chosen — its thanas are listed first. */
  district: string;
  selectedThana: string;
  /** district is set when the thana was picked from another district's
   *  group (a search), null for a typed "Other" thana. */
  onPick: (thana: string, district: string | null) => void;
}

/**
 * Batch 30 Part 6: every thana Steadfast delivers to, grouped by district
 * (A–Z), searchable, with "Other — type your thana" at the end so an
 * order is never blocked by a missing name. Shared by checkout, admin New
 * order and the Edit order sheet (all through AddressFormFields).
 */
export function ThanaPickerSheet({ isOpen, onClose, district, selectedThana, onPick }: ThanaPickerSheetProps) {
  const { list } = useThanaList(isOpen);
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');

  const groups = useMemo(() => groupThanas(list, query, district || null), [list, query, district]);

  const close = () => {
    setQuery('');
    setTyping(false);
    setTyped('');
    onClose();
  };

  const pick = (thana: string, fromDistrict: string | null) => {
    onPick(thana, fromDistrict);
    close();
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={close} title="Select thana / upazila">
      <div className="picker-sheet thana-picker">
        <div className="search-bar picker-sheet__search">
          <svg className="search-bar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="search"
            className="search-bar__input"
            placeholder="Search thana or district..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Search thana"
          />
        </div>

        <div className="picker-sheet__list thana-picker__list" data-testid="thana-list">
          {groups.length === 0 && <p className="picker-sheet__empty">No thana matches “{query.trim()}”</p>}
          {groups.map((group) => (
            <section key={group.district} className="thana-picker__group" aria-label={group.district}>
              <h3 className="thana-picker__district">{group.district}</h3>
              <ul className="thana-picker__rows">
                {group.thanas.map((thana) => {
                  const selected = thana === selectedThana && group.district === district;
                  return (
                    <li key={thana}>
                      <button
                        type="button"
                        className={`picker-sheet__row${selected ? ' picker-sheet__row--selected' : ''}`}
                        aria-pressed={selected}
                        onClick={() => pick(thana, group.district === district ? null : group.district)}
                      >
                        <span className="picker-sheet__row-label">{thana}</span>
                        {selected && (
                          <svg className="picker-sheet__check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          <div className="thana-picker__other">
            {typing ? (
              // Not a <form>: this sheet sits inside the checkout / order
              // forms, and a nested form would submit the outer one too.
              <div className="thana-picker__other-form">
                <input
                  type="text"
                  className="form-input"
                  placeholder="Type your thana / area"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    if (typed.trim() !== '') pick(typed.trim(), null);
                  }}
                  aria-label="Type your thana"
                  autoFocus
                />
                <button
                  type="button"
                  className="button button--secondary button--small"
                  disabled={typed.trim() === ''}
                  onClick={() => pick(typed.trim(), null)}
                >
                  Use this
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="picker-sheet__row thana-picker__other-row"
                onClick={() => {
                  setTyping(true);
                  setTyped(query.trim());
                }}
              >
                <span className="picker-sheet__row-label">Other — type your thana</span>
                <svg className="picker-sheet__check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </BottomSheet>
  );
}
