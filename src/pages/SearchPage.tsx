// Dedicated search view — tapping the home page's search bar or the bottom
// nav's Search tab lands here instead of expanding suggestions in place over
// the home content. No hero banner, Browse circles, bento grid, or category
// chips here on purpose (see reports/batch-17.txt Part 2): this screen is
// just the input and whatever it turns up. The query lives in the URL
// (?q=...) so Back from a product returns to the same results, same scroll
// position, without re-opening the keyboard.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAppNavigate as useNavigate } from '../hooks/useAppNavigate';
import { useProducts } from '../contexts/ProductContext';
import { useSearch } from '../hooks/useSearch';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { rememberSearchScroll, takeSearchScroll } from '../lib/searchScroll';
import { productPath } from '../lib/slugify';
import { SearchBar } from '../components/viewer/SearchBar';
import { SearchSuggestions } from '../components/viewer/SearchSuggestions';
import { ProductGrid } from '../components/viewer/ProductGrid';
import type { Product } from '../types';

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

export function SearchPage() {
  useDocumentTitle("Search — Naeem's");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { products, categories, isLoading } = useProducts();

  const activeProducts = products.filter((p) => p.is_active);
  const urlQuery = searchParams.get('q') ?? '';
  // "Popular categories" below used to fill the search box with the
  // category's NAME and run it through Fuse's fuzzy text match — which only
  // ever coincidentally worked for a category whose products happen to have
  // that word in their own name/brand (e.g. "Baby"), and silently returned
  // nothing for most others. This is an exact category_id filter instead,
  // same as the home page's chips/circles, and toggles like them too.
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  // Autofocus only on a genuinely fresh, empty entry into search — never
  // when Back-navigation restores an existing query, which is exactly the
  // "keyboard pops up unexpectedly" bug this page is built to avoid.
  const shouldAutoFocus = useRef(urlQuery === '').current;

  const openProduct = useCallback(
    (product: Product) => {
      rememberSearchScroll();
      navigate(productPath(product));
    },
    [navigate]
  );

  // Pops real history when there is any (same rule as BackButton) so this
  // is a genuine back-navigation (POP), not a fresh push — pushing '/' here
  // used to make PageTransition play the forward slide-in on what the user
  // saw as going back (see reports/fix-animation-audit.txt Part 2), and left
  // an extra '/' entry sitting in history for a subsequent real Back to trip
  // over.
  const goBack = useCallback(() => {
    if (window.history.length > 2) {
      navigate(-1);
    } else {
      navigate('/');
    }
  }, [navigate]);

  const search = useSearch({
    products: activeProducts,
    defaultOrdered: activeProducts,
    categoryId: selectedCategoryId,
    onSelectSuggestion: openProduct,
    initialQuery: urlQuery,
  });

  // Query -> URL, one-directional and replacing (not pushing) so typing
  // doesn't spam browser history — only entering/leaving a product page
  // creates a real history entry to come back from.
  useEffect(() => {
    const trimmed = search.query.trim();
    const next = new URLSearchParams(searchParams);
    if (trimmed === '') next.delete('q');
    else next.set('q', trimmed);
    setSearchParams(next, { replace: true });
    // Only ever reacts to the query changing — including searchParams would
    // re-run this on every URL change this effect itself causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.query]);

  // Restore scroll position when returning from a product, once there's
  // something to scroll into.
  useEffect(() => {
    if (isLoading) return;
    const savedY = takeSearchScroll();
    if (savedY === null) return;
    requestAnimationFrame(() => {
      setTimeout(() => {
        window.scrollTo({ top: savedY, behavior: 'instant' });
      }, 80);
    });
  }, [isLoading]);

  const trimmed = search.query.trim();
  // Below Fuse's 2-character minimum, `search.results` falls back to the
  // FULL unfiltered catalog (matches the home grid's old "too short to
  // search yet, just show everything" behaviour) — right for a page with a
  // normal listing below the search bar, wrong here, where there's no other
  // content to fall back to. So the results grid only appears once there's
  // enough to actually search on; a 1-character query still sees the
  // recent/quick-picks view rather than the whole catalog.
  const hasTextQuery = trimmed.length >= 2;
  // A category pick shows its results the same way a text search does, even
  // with no text typed — useSearch already restricts `results` to this
  // category (see its own categoryId filter), this just decides when the
  // grid (rather than the recent/quick-picks view) is on screen.
  const isSearching = hasTextQuery || selectedCategoryId !== null;
  const resultCount = search.results.length;

  // Tapping the already-selected category again clears it (same toggle
  // behaviour as the home page's chips/circles), returning to quick-picks.
  const handlePickCategory = (categoryId: string) => {
    setSelectedCategoryId((current) => (current === categoryId ? null : categoryId));
  };

  return (
    <div className="viewer-shell search-page">
      <div className="search-page__bar-wrap">
        <SearchBar
          value={search.query}
          onChange={search.setQuery}
          onFocus={search.onFocus}
          onBlur={search.onBlur}
          onKeyDown={search.onKeyDown}
          onClear={search.clear}
          isExpanded={search.isDropdownOpen}
          onBack={goBack}
          autoFocus={shouldAutoFocus}
        />
        <SearchSuggestions search={search} />
      </div>

      <main className="search-page__main">
        {!hasTextQuery && (
          <>
            {selectedCategoryId === null && search.recent.length > 0 && (
              <section className="search-recent search-recent--page" aria-label="Recent searches">
                <div className="search-recent__page-head">
                  <h2 className="search-recent__label">Recent</h2>
                  <button type="button" className="search-recent__clear" onClick={search.clearRecent}>
                    Clear all
                  </button>
                </div>
                <ul className="search-recent__list">
                  {search.recent.map((term) => (
                    <li key={term} className="search-recent__row">
                      <button
                        type="button"
                        className="search-recent__term"
                        onClick={() => search.applyTerm(term)}
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
              </section>
            )}

            {categories.length > 0 && (
              <section className="search-quickpicks" aria-label="Popular categories">
                <h2 className="search-recent__label">Popular categories</h2>
                <div className="search-quickpicks__row" role="tablist">
                  {categories.slice(0, 8).map((category) => {
                    const isSelected = selectedCategoryId === category.id;
                    return (
                      <button
                        key={category.id}
                        type="button"
                        role="tab"
                        aria-selected={isSelected}
                        className={`chip${isSelected ? ' chip--active' : ''}`}
                        onClick={() => handlePickCategory(category.id)}
                      >
                        {category.name}
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}

        {isSearching && (
          <>
            {!isLoading && (
              <p className="search-page__count">
                {resultCount} {resultCount === 1 ? 'product' : 'products'} found
              </p>
            )}
            <ProductGrid
              products={search.results}
              isLoading={isLoading}
              searchQuery={search.query}
              selectedCategoryId={selectedCategoryId}
              onClearSearch={search.clear}
              activeFilterCount={0}
              onClearFilters={() => {}}
            />
          </>
        )}
      </main>
    </div>
  );
}
