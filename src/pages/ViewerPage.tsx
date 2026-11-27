import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useProducts, sortFeaturedFirst } from '../contexts/ProductContext';
import { useProductFilters } from '../hooks/useProductFilters';
import { filterByCategory } from '../lib/categoryFilter';
import { useUrlParams } from '../hooks/useUrlParams';
import { useAppNavigate } from '../hooks/useAppNavigate';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { searchTextOf } from '../hooks/useSearch';
import { smartSearch } from '../lib/smartSearch';
import { getDisplayPrice } from '../lib/pricing';
import { FilterSheet } from '../components/viewer/FilterSheet';
import { CategoryChips } from '../components/viewer/CategoryChips';
import { ProductGrid } from '../components/viewer/ProductGrid';
import { SiteFooter } from '../components/shared/SiteFooter';
import { HomeWalletOpenNote } from '../components/account/WalletOpenNote';
import { HomeCampaigns } from '../components/campaign/HomeCampaigns';
import { EditModeToggle } from '../components/admin/EditModeToggle';
import { ProductEditSheet } from '../components/admin/edit-sheets/deferred';
import type { Product } from '../types';

function OfflineBanner() {
  return (
    <div className="offline-banner" role="status">
      <svg
        className="offline-banner__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M1 1l22 22" />
        <path d="M16.72 11.06A10.94 10.94 0 0119 12.55" />
        <path d="M5 12.55a10.94 10.94 0 015.17-2.39" />
        <path d="M10.71 5.05A16 16 0 0122.58 9" />
        <path d="M1.42 9a15.91 15.91 0 014.7-2.88" />
        <path d="M8.53 16.11a6 6 0 016.95 0" />
        <path d="M12 20h.01" />
      </svg>
      You're offline. Showing saved data
    </div>
  );
}

/** Batch 71: the grid's order (?sort=), "featured" when missing. */
export type ShopSort = 'featured' | 'price-low' | 'price-high' | 'newest';

const SORT_LABELS: Record<ShopSort, string> = {
  featured: 'Featured',
  'price-low': 'Price: low to high',
  'price-high': 'Price: high to low',
  newest: 'Newest',
};

export function readSort(raw: string | null): ShopSort {
  return raw === 'price-low' || raw === 'price-high' || raw === 'newest' ? raw : 'featured';
}

export function sortProducts(products: Product[], sort: ShopSort): Product[] {
  if (sort === 'featured') return products;
  const price = (p: Product) => getDisplayPrice(p).mainPrice;
  const copy = [...products];
  if (sort === 'price-low') return copy.sort((a, b) => price(a) - price(b));
  if (sort === 'price-high') return copy.sort((a, b) => price(b) - price(a));
  return copy.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function FilterIcon() {
  return (
    <svg className="filter-button__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M7 12h10" />
      <path d="M10 17h4" />
    </svg>
  );
}

/**
 * The Shop tab (/shop, Batch 71). Today's product grid moved here from
 * Home: the search pill, the filter sheet, the category chips (with their
 * pinned copy), the grid, admin Edit Mode, campaigns and the wallet note.
 * The banner, Browse circles and brand row moved to the new Home.
 */
export function ViewerPage() {
  useDocumentTitle("Shop | NAEEM'S");
  const navigate = useAppNavigate();
  const { products, categories, isLoading, isOffline, loadFailed, refetch } = useProducts();

  // The selected category lives in the URL (?cat=<slug>) so Back from a
  // product returns to the same filtered grid — component state would be
  // thrown away the moment this page unmounts. Same for ?q= (a Home skin
  // type / concern tile) and ?sort=.
  const [searchParams, updateParams] = useUrlParams();
  const catSlug = searchParams.get('cat');
  const query = (searchParams.get('q') ?? '').trim();
  const sort = readSort(searchParams.get('sort'));
  const selectedCategoryId = categories.find((c) => c.slug === catSlug)?.id ?? null;
  const [isRetrying, setIsRetrying] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);

  const chipsRowRef = useRef<HTMLDivElement>(null);
  // True once the in-flow chip row has scrolled up off the top — a second,
  // always-pinned copy of the chips then takes over visually (see
  // .home-chips-pinned in app.css).
  const [isChipsPinned, setIsChipsPinned] = useState(false);
  // True only for the first frame(s) after this page mounts: the pinned bar
  // then takes its correct initial state with no fade/slide (a Back that
  // lands deep in the grid must show the bar already there).
  const [pinnedInstant, setPinnedInstant] = useState(true);
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setPinnedInstant(false));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);

  // useLayoutEffect: on a fresh mount that's already scrolled deep (Back
  // from a product, restored by PageTransition's ScrollRestorer), the
  // pinned bar's first state must land before the browser paints.
  useLayoutEffect(() => {
    let ticking = false;
    const checkPinned = () => {
      ticking = false;
      const el = chipsRowRef.current;
      if (!el) return;
      const chipsDocumentTop = el.getBoundingClientRect().top + window.scrollY;
      setIsChipsPinned(window.scrollY > chipsDocumentTop);
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(checkPinned);
    };
    checkPinned();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Viewers only ever see active products (admin sessions fetch inactive too).
  const activeProducts = useMemo(() => products.filter((p) => p.is_active), [products]);
  // Featured-first only in the default "All" view; within a category, keep
  // the existing sort.
  const orderedProducts = useMemo(
    () => (selectedCategoryId === null ? sortFeaturedFirst(activeProducts) : activeProducts),
    [activeProducts, selectedCategoryId]
  );
  const searchedProducts = useMemo(
    () => (query === '' ? orderedProducts : smartSearch(orderedProducts, query, (p) => searchTextOf(p))),
    [orderedProducts, query]
  );
  const categoryFilteredProducts = useMemo(
    () => filterByCategory(searchedProducts, selectedCategoryId),
    [searchedProducts, selectedCategoryId]
  );
  const productFilters = useProductFilters(activeProducts);
  const filteredProducts = sortProducts(productFilters.apply(categoryFilteredProducts), sort);

  // Scrolls so the chip row lands at the top, with products visible under it.
  const scrollToChips = useCallback(() => {
    const el = chipsRowRef.current;
    if (!el) return;
    const targetY = el.getBoundingClientRect().top + window.scrollY;
    if (window.scrollY <= targetY) return;
    window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
  }, []);

  const handleSelectCategory = useCallback(
    (id: string | null) => {
      const slug = id === null ? null : categories.find((c) => c.id === id)?.slug ?? null;
      updateParams((next) => {
        if (slug === null) next.delete('cat');
        else next.set('cat', slug);
      });
      // Two frames: the filtered grid's real height lands first.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToChips();
        });
      });
    },
    [scrollToChips, categories, updateParams]
  );

  const handleSort = (e: ChangeEvent<HTMLSelectElement>) => {
    const value = readSort(e.target.value);
    updateParams((next) => {
      if (value === 'featured') next.delete('sort');
      else next.set('sort', value);
    });
  };

  const clearQuery = () =>
    updateParams((next) => {
      next.delete('q');
    });

  const handleRetry = async () => {
    setIsRetrying(true);
    await refetch();
    setIsRetrying(false);
  };

  if (loadFailed) {
    return (
      <div className="viewer-shell">
        <div className="full-screen-center">
          <div className="empty-state">
            <div className="empty-state__icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4m0 4h.01" />
              </svg>
            </div>
            <p className="empty-state__message">
              {navigator.onLine
                ? "Couldn't load products"
                : "You're offline and no saved data is available"}
            </p>
            <button
              type="button"
              className="button button--primary"
              onClick={handleRetry}
              disabled={isRetrying}
            >
              {isRetrying ? <span className="spinner" aria-hidden="true" /> : 'Retry'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const count = filteredProducts.length;

  return (
    <div className="viewer-shell b71-shop" data-testid="shop-page">
      <header className="b71-shop__head">
        <h1 className="b71-shop__title">Shop</h1>
        <button
          type="button"
          className="filter-button"
          onClick={() => setFilterOpen(true)}
          aria-label={
            productFilters.activeCount > 0
              ? `Filter products, ${productFilters.activeCount} active`
              : 'Filter products'
          }
        >
          <FilterIcon />
          {productFilters.activeCount > 0 && (
            <span className="filter-button__badge" aria-hidden="true">
              {productFilters.activeCount}
            </span>
          )}
        </button>
      </header>

      {/* Always mounted (so it can animate in/out smoothly), only visible
          once isChipsPinned. */}
      <div
        className={`home-chips-pinned${isChipsPinned ? ' home-chips-pinned--visible' : ''}${
          pinnedInstant ? ' home-chips-pinned--instant' : ''
        }`}
        style={{ top: 0 }}
        aria-hidden={!isChipsPinned}
      >
        <CategoryChips categories={categories} selectedId={selectedCategoryId} onSelect={handleSelectCategory} />
      </div>

      {isOffline && <OfflineBanner />}

      <div className="b71-shop__search">
        <button
          type="button"
          className="b71-search"
          onClick={() => navigate('/search')}
          aria-label="Search products"
          data-testid="shop-search-pill"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4.35-4.35" />
          </svg>
          Search products, brands, concerns
        </button>
      </div>

      {/* Batch 66: live campaigns (at most 2), above the grid as before. */}
      <HomeCampaigns />

      <div className="home-chips b71-shop__chips" ref={chipsRowRef}>
        <CategoryChips categories={categories} selectedId={selectedCategoryId} onSelect={handleSelectCategory} />
      </div>

      {query !== '' && (
        <div className="b71-shop__query" data-testid="shop-query">
          <span>
            Results for <b>{query}</b>
          </span>
          <button type="button" onClick={clearQuery}>
            Clear
          </button>
        </div>
      )}

      <div className="b71-shop__bar">
        <span data-testid="shop-count">
          {isLoading ? ' ' : `${count} ${count === 1 ? 'product' : 'products'}`}
        </span>
        <label className="b71-sort">
          <span className="visually-hidden">Sort products</span>
          <select value={sort} onChange={handleSort} data-testid="shop-sort">
            {(Object.keys(SORT_LABELS) as ShopSort[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </label>
      </div>

      <main className="viewer-main">
        <ProductGrid
          products={filteredProducts}
          isLoading={isLoading}
          searchQuery={query}
          selectedCategoryId={selectedCategoryId}
          onClearSearch={clearQuery}
          activeFilterCount={productFilters.activeCount}
          onClearFilters={productFilters.clear}
        />
      </main>

      <SiteFooter />

      <HomeWalletOpenNote />

      <FilterSheet
        isOpen={filterOpen}
        onClose={() => setFilterOpen(false)}
        filters={productFilters.filters}
        onChange={productFilters.setFilters}
        availableBrands={productFilters.availableBrands}
        baseProducts={categoryFilteredProducts}
      />

      {/* Both render nothing for anyone who isn't an approved admin. */}
      <EditModeToggle />
      <ProductEditSheet />
    </div>
  );
}
