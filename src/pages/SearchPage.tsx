// Dedicated search view — tapping the home page's search bar or the bottom
// nav's Search tab lands here instead of expanding suggestions in place over
// the home content. No hero banner, Browse circles, bento grid, or category
// chips here on purpose (see reports/batch-17.txt Part 2): this screen is
// just the input and whatever it turns up. The query AND the picked category
// live in the URL (?q=...&cat=<slug>) so Back from a product — phone or
// in-app — returns to the same results, same scroll position (restored by
// PageTransition), without re-opening the keyboard.
import { useCallback, useEffect, useRef } from 'react';
import { NavigationType, useNavigate as useRouterNavigate, useNavigationType } from 'react-router-dom';
import { useAppNavigate } from '../hooks/useAppNavigate';
import { useUrlParams } from '../hooks/useUrlParams';
import { useProducts } from '../contexts/ProductContext';
import { useSearch } from '../hooks/useSearch';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { productPath } from '../lib/slugify';
import { navigateBack } from '../lib/viewTransition';
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
  useDocumentTitle("Search — NAEEM'S");
  const navigate = useAppNavigate();
  const routerNavigate = useRouterNavigate();
  const [searchParams, updateParams] = useUrlParams();
  const navigationType = useNavigationType();
  const { products, categories, isLoading } = useProducts();

  const activeProducts = products.filter((p) => p.is_active);
  const urlQuery = searchParams.get('q') ?? '';
  // "Popular categories" below used to fill the search box with the
  // category's NAME and run it through Fuse's fuzzy text match — which only
  // ever coincidentally worked for a category whose products happen to have
  // that word in their own name/brand (e.g. "Baby"), and silently returned
  // nothing for most others. This is an exact category_id filter instead,
  // same as the home page's chips/circles, and toggles like them too. Kept
  // in the URL as the category's slug (readable, stable across renames of
  // nothing but the name) so it survives Back.
  const catSlug = searchParams.get('cat');
  const selectedCategoryId = categories.find((c) => c.slug === catSlug)?.id ?? null;
  // Autofocus only on a genuinely fresh, empty entry into search — never on
  // a Back (the page being returned to already shows what the shopper was
  // looking at), and never when there's already a query or category to show.
  // That was the "keyboard pops up and the results are gone" bug.
  const shouldAutoFocus = useRef(
    navigationType !== NavigationType.Pop && urlQuery === '' && catSlug === null
  ).current;

  const openProduct = useCallback(
    (product: Product) => {
      navigate(productPath(product));
    },
    [navigate]
  );

  // A genuine back-navigation (same helper as BackButton), not a fresh push
  // of '/' — that used to leave an extra '/' entry sitting in history for a
  // subsequent real Back to trip over (reports/fix-animation-audit.txt).
  const goBack = useCallback(() => navigateBack(routerNavigate), [routerNavigate]);

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
    updateParams((next) => {
      if (trimmed === '') next.delete('q');
      else next.set('q', trimmed);
    });
  }, [search.query, updateParams]);

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
    const slug = categories.find((c) => c.id === categoryId)?.slug ?? null;
    updateParams((next) => {
      if (slug === null || next.get('cat') === slug) next.delete('cat');
      else next.set('cat', slug);
    });
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
