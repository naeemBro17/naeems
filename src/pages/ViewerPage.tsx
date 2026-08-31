import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProducts, sortFeaturedFirst } from '../contexts/ProductContext';
import { useTheme } from '../contexts/ThemeContext';
import { useSearch } from '../hooks/useSearch';
import { SearchBar } from '../components/viewer/SearchBar';
import { HeroBanner } from '../components/viewer/HeroBanner';
import { BrowseCircles } from '../components/viewer/BrowseCircles';
import { BentoGrid } from '../components/viewer/BentoGrid';
import { CategoryChips } from '../components/viewer/CategoryChips';
import { ProductGrid } from '../components/viewer/ProductGrid';
import { BottomNav, type NavTab } from '../components/viewer/BottomNav';
import { HamburgerMenu } from '../components/viewer/HamburgerMenu';
import { AccountSheet } from '../components/viewer/AccountSheet';
import { ThemeIcon } from '../components/shared/ThemeToggle';

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
      You're offline — showing saved data
    </div>
  );
}

export function ViewerPage() {
  const { theme, toggleTheme } = useTheme();
  const { products, categories, settings, isLoading, isOffline, loadFailed, refetch } =
    useProducts();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<NavTab>('home');

  const searchInputRef = useRef<HTMLInputElement>(null);
  const productsRef = useRef<HTMLElement>(null);

  // Coming back from a product detail page: put the grid back where it was.
  // Runs after products land so the list is tall enough to scroll into.
  useEffect(() => {
    const fromProduct = sessionStorage.getItem('grid_nav_from_product');
    const savedY = sessionStorage.getItem('grid_scroll_y');
    if (fromProduct === 'true' && savedY) {
      sessionStorage.removeItem('grid_nav_from_product');
      sessionStorage.removeItem('grid_scroll_y');
      requestAnimationFrame(() => {
        setTimeout(() => {
          window.scrollTo({ top: parseInt(savedY, 10), behavior: 'instant' });
        }, 80);
      });
    }
  }, [products]);

  // Viewers only ever see active products (admin sessions fetch inactive too).
  const activeProducts = useMemo(() => products.filter((p) => p.is_active), [products]);
  // Featured-first only in the default "All" view — the first impression every
  // new visitor gets. Within a specific category, keep the existing sort.
  const orderedProducts = useMemo(
    () =>
      selectedCategoryId === null ? sortFeaturedFirst(activeProducts) : activeProducts,
    [activeProducts, selectedCategoryId]
  );
  const filteredProducts = useSearch(orderedProducts, searchQuery, selectedCategoryId);

  const scrollToProducts = useCallback(() => {
    productsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // The Browse circles and the chips write the same filter, so selecting in
  // either place lights up the other.
  const handleSelectCategory = useCallback(
    (id: string | null) => {
      setSelectedCategoryId(id);
      scrollToProducts();
    },
    [scrollToProducts]
  );

  const handleRetry = async () => {
    setIsRetrying(true);
    await refetch();
    setIsRetrying(false);
  };

  const handleHomeTab = () => {
    setActiveTab('home');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSearchTab = () => {
    setActiveTab('search');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    searchInputRef.current?.focus();
  };

  const handleAccountTab = () => {
    setActiveTab('account');
    setAccountOpen(true);
  };

  const closeAccount = useCallback(() => {
    setAccountOpen(false);
    setActiveTab('home');
  }, []);

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

  return (
    <div className="viewer-shell">
      <header className="app-header">
        <button
          type="button"
          className="app-header__hamburger"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          aria-expanded={menuOpen}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>

        <h1 className="app-header__wordmark">Naeem&apos;s</h1>

        <button
          type="button"
          className="app-header__theme"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <ThemeIcon theme={theme} />
        </button>
      </header>

      {isOffline && <OfflineBanner />}

      <div className="home-search">
        <SearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          inputRef={searchInputRef}
        />
      </div>

      <HeroBanner
        slides={settings.banner_slides}
        onScrollToProducts={scrollToProducts}
      />

      <BrowseCircles
        categories={categories}
        products={activeProducts}
        selectedId={selectedCategoryId}
        onSelect={handleSelectCategory}
      />

      <BentoGrid products={activeProducts} settings={settings} />

      <div className="home-chips">
        <CategoryChips
          categories={categories}
          selectedId={selectedCategoryId}
          onSelect={handleSelectCategory}
        />
      </div>

      <main className="viewer-main" ref={productsRef}>
        <h2 className="home-section-title">All Products</h2>
        <ProductGrid
          products={filteredProducts}
          isLoading={isLoading}
          searchQuery={searchQuery}
          selectedCategoryId={selectedCategoryId}
          onClearSearch={() => setSearchQuery('')}
        />
      </main>

      <BottomNav
        activeTab={activeTab}
        onHome={handleHomeTab}
        onSearch={handleSearchTab}
        onAccount={handleAccountTab}
      />

      <HamburgerMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />
      <AccountSheet isOpen={accountOpen} onClose={closeAccount} />
    </div>
  );
}
