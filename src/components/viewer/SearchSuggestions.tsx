import type { Product } from '../../types';
import type { SearchState } from '../../hooks/useSearch';
import { coverImage } from '../../lib/productImages';

interface SearchSuggestionsProps {
  search: SearchState;
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
 * Live autocomplete while typing on SearchPage — floats over whatever's
 * below (the results grid, or the recent-searches view) so it never shifts
 * layout, and disappears the instant the dropdown closes (blur, Escape, a
 * pick). Recent searches themselves are NOT here — on SearchPage they're
 * persistent page content, not a focus-gated overlay, see SearchPage.tsx.
 */
export function SearchSuggestions({ search }: SearchSuggestionsProps) {
  if (!search.isDropdownOpen) return null;

  return (
    <div className="search-panel" onMouseDown={(e) => e.preventDefault()}>
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
    </div>
  );
}
