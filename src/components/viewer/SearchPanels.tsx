import type { Product } from '../../types';
import type { SearchState } from '../../hooks/useSearch';
import { coverImage } from '../../lib/productImages';

interface SearchPanelsProps {
  search: SearchState;
  /** A recent term was tapped — the page fills the bar and blurs the input. */
  onRecent: (term: string) => void;
}

function ClockIcon() {
  return (
    <svg
      className="search-recent__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function SuggestionRow({
  product,
  highlighted,
  onSelect,
}: {
  product: Product;
  highlighted: boolean;
  onSelect: () => void;
}) {
  const image = coverImage(product);
  return (
    <li role="option" aria-selected={highlighted}>
      <button
        type="button"
        className={`search-suggestion${highlighted ? ' search-suggestion--active' : ''}`}
        onClick={onSelect}
      >
        {image ? (
          <img className="search-suggestion__thumb" src={image} alt="" loading="lazy" />
        ) : (
          <span className="search-suggestion__thumb search-suggestion__thumb--empty" aria-hidden="true" />
        )}
        <span className="search-suggestion__name">{product.name}</span>
      </button>
    </li>
  );
}

/**
 * The two overlays under the search bar: autocomplete while typing, recent
 * searches while focused and empty. Both float over the page (no layout
 * shift). mousedown is cancelled inside so tapping a row doesn't blur the
 * input before the click lands.
 */
export function SearchPanels({ search, onRecent }: SearchPanelsProps) {
  if (!search.isDropdownOpen && !search.isRecentOpen) return null;

  return (
    <div className="search-panel" onMouseDown={(e) => e.preventDefault()}>
      {search.isDropdownOpen && (
        <ul id="search-suggestions" className="search-suggestions" role="listbox">
          {search.suggestions.map((product, index) => (
            <SuggestionRow
              key={product.id}
              product={product}
              highlighted={index === search.highlightIndex}
              onSelect={() => search.selectSuggestion(product)}
            />
          ))}
        </ul>
      )}

      {search.isRecentOpen && (
        <section className="search-recent" aria-label="Recent searches">
          <h3 className="search-recent__label">Recent</h3>
          <ul className="search-recent__list">
            {search.recent.map((term) => (
              <li key={term} className="search-recent__row">
                <button
                  type="button"
                  className="search-recent__term"
                  onClick={() => onRecent(term)}
                >
                  <ClockIcon />
                  <span className="search-recent__text">{term}</span>
                </button>
                <button
                  type="button"
                  className="search-recent__remove"
                  onClick={() => search.removeRecent(term)}
                  aria-label={`Remove ${term} from recent searches`}
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
              </li>
            ))}
          </ul>
          <div className="search-recent__footer">
            <button type="button" className="search-recent__clear" onClick={search.clearRecent}>
              Clear all
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
