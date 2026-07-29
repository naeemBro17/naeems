import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useProducts, sortFeaturedFirst } from '../contexts/ProductContext';
import { useAuthModal } from '../contexts/AuthModalContext';
import { useSearch } from '../hooks/useSearch';
import { SearchBar } from '../components/viewer/SearchBar';
import { CategoryChips } from '../components/viewer/CategoryChips';
import { ProductGrid } from '../components/viewer/ProductGrid';
import { ContactButton } from '../components/viewer/ContactButton';
import { ThemeToggle } from '../components/shared/ThemeToggle';

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
  const { session, isAdmin } = useAuth();
  const navigate = useNavigate();
  const { openAuth } = useAuthModal();
  const { products, categories, isLoading, isOffline, loadFailed, refetch } =
    useProducts();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  // Viewers only ever see active products (admin sessions fetch inactive too).
  const activeProducts = products.filter((p) => p.is_active);
  // Featured-first only in the default "All" view — the first impression every
  // new visitor gets. Within a specific category, keep the existing sort.
  const orderedProducts = useMemo(
    () =>
      selectedCategoryId === null ? sortFeaturedFirst(activeProducts) : activeProducts,
    [activeProducts, selectedCategoryId]
  );
  const filteredProducts = useSearch(orderedProducts, searchQuery, selectedCategoryId);

  const handleLockTap = () => {
    if (isAdmin) {
      navigate('/admin');
    } else if (session) {
      // Logged in but not an admin (a wholesaler) — show account status/sign-out.
      openAuth('status');
    } else {
      openAuth('choice');
    }
  };

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

  return (
    <div className="viewer-shell">
      <header className="viewer-header">
        <h1 className="viewer-header__title">Naeem's</h1>
        <div className="viewer-header__actions">
          <ThemeToggle />
          <button
            type="button"
            className="icon-button icon-button--circle"
            onClick={handleLockTap}
            aria-label={isAdmin ? 'Open admin panel' : 'Sign in'}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
          </button>
        </div>
      </header>

      {isOffline && <OfflineBanner />}

      <div className="viewer-controls">
        <SearchBar value={searchQuery} onChange={setSearchQuery} />
        <CategoryChips
          categories={categories}
          selectedId={selectedCategoryId}
          onSelect={setSelectedCategoryId}
        />
      </div>

      <main className="viewer-main">
        <ProductGrid
          products={filteredProducts}
          categories={categories}
          isLoading={isLoading}
          searchQuery={searchQuery}
          selectedCategoryId={selectedCategoryId}
          onClearSearch={() => setSearchQuery('')}
        />
      </main>

      <ContactButton />
    </div>
  );
}
