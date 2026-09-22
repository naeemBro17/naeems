import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useProducts, sortFeaturedFirst } from '../contexts/ProductContext';
import { useTheme } from '../contexts/ThemeContext';
import { useAuth } from '../contexts/AuthContext';
import { useAdminEdit } from '../contexts/AdminEditContext';
import { useNavigate } from 'react-router-dom';
import { useSearch } from '../hooks/useSearch';
import { useDragReorder } from '../hooks/useDragReorder';
import { useToast } from '../hooks/useToast';
import { rememberGridScroll, takeGridScroll } from '../lib/gridScroll';
import { productPath } from '../lib/slugify';
import { saveSettings, serializeIdList } from '../lib/settingsLists';
import {
  DEFAULT_SECTION_ORDER,
  readOrder,
  REORDERABLE_SECTIONS,
  type HomeSectionId,
} from '../lib/layoutOrder';
import type { Product } from '../types';
import { SearchBar } from '../components/viewer/SearchBar';
import { SearchPanels } from '../components/viewer/SearchPanels';
import { HeroBanner } from '../components/viewer/HeroBanner';
import { BrowseCircles } from '../components/viewer/BrowseCircles';
import { BentoGrid } from '../components/viewer/BentoGrid';
import { CategoryChips } from '../components/viewer/CategoryChips';
import { ProductGrid } from '../components/viewer/ProductGrid';
import { BottomNav, type NavTab } from '../components/viewer/BottomNav';
import { HamburgerMenu } from '../components/viewer/HamburgerMenu';
import { AccountSheet } from '../components/viewer/AccountSheet';
import { ThemeIcon } from '../components/shared/ThemeToggle';
import { EditModeToggle } from '../components/admin/EditModeToggle';
import { ProductEditSheet } from '../components/admin/edit-sheets/ProductEditSheet';

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

type ReorderableSection = (typeof REORDERABLE_SECTIONS)[number];

function DragHandleGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.7" />
      <circle cx="15" cy="6" r="1.7" />
      <circle cx="9" cy="12" r="1.7" />
      <circle cx="15" cy="12" r="1.7" />
      <circle cx="9" cy="18" r="1.7" />
      <circle cx="15" cy="18" r="1.7" />
    </svg>
  );
}

export function ViewerPage() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { isAdmin } = useAuth();
  const { isEditMode } = useAdminEdit();
  const { showToast } = useToast();
  const { products, categories, settings, isLoading, isOffline, loadFailed, refetch } =
    useProducts();

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
    const savedY = takeGridScroll();
    if (savedY === null) return;
    requestAnimationFrame(() => {
      setTimeout(() => {
        window.scrollTo({ top: savedY, behavior: 'instant' });
      }, 80);
    });
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
  // Choosing a suggestion opens that product, like tapping its card.
  const openSuggestedProduct = useCallback(
    (product: Product) => {
      rememberGridScroll();
      navigate(productPath(product));
    },
    [navigate]
  );

  const search = useSearch({
    products: activeProducts,
    defaultOrdered: orderedProducts,
    categoryId: selectedCategoryId,
    onSelectSuggestion: openSuggestedProduct,
  });
  const filteredProducts = search.results;

  const handleRecent = useCallback(
    (term: string) => {
      search.applyTerm(term);
      searchInputRef.current?.blur();
    },
    [search]
  );

  const scrollToProducts = useCallback(() => {
    productsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // The Browse circles and the chips write the same filter, so selecting in
  // either place lights up the other.
  const handleSelectCategory = useCallback(
    (id: string | null) => {
      setSelectedCategoryId(id);
      // scrollToProducts measures productsRef's CURRENT position — calling it
      // synchronously here measures the layout from before this filter took
      // effect (setSelectedCategoryId is async/batched), then starts a smooth
      // scroll toward that stale target just as the grid's real height (very
      // different depending on how many products the category has) lands
      // underneath it. A category with a very different row count from
      // whatever was showing before is exactly when the scroll and the
      // reflow could visibly fight each other — the chip row and grid
      // frame looking cut off / covered while that settled. Waiting two
      // animation frames lets the browser finish laying out and painting
      // the filtered grid first, so the scroll always measures the real,
      // final position.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToProducts();
        });
      });
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

  // Homepage section order. 'products' is pinned last and never dragged, so
  // only the four movable sections take part in the drag.
  const sectionOrder = useMemo(
    () => readOrder<HomeSectionId>(settings.homepage_section_order, DEFAULT_SECTION_ORDER, 'products'),
    [settings.homepage_section_order]
  );
  const movableSections = useMemo(
    () => sectionOrder.filter((id): id is ReorderableSection => id !== 'products'),
    [sectionOrder]
  );

  const handleSectionReorder = useCallback(
    async (next: ReorderableSection[]) => {
      const error = await saveSettings({
        homepage_section_order: serializeIdList([...next, 'products']),
      });
      if (error) {
        console.error('Section order save failed:', error);
        showToast('Could not save the section order', 'error');
        throw error;
      }
      await refetch();
      showToast('Saved');
    },
    [refetch, showToast]
  );

  const sectionDrag = useDragReorder<ReorderableSection>({
    items: movableSections,
    onReorder: handleSectionReorder,
    mode: 'move',
    enabled: isEditMode,
  });

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
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
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
          value={search.query}
          onChange={search.setQuery}
          inputRef={searchInputRef}
          onFocus={search.onFocus}
          onBlur={search.onBlur}
          onKeyDown={search.onKeyDown}
          onClear={search.clear}
          isExpanded={search.isDropdownOpen}
        />
        <SearchPanels search={search} onRecent={handleRecent} />
      </div>

      {movableSections.map((id, index) => {
        const content: Record<ReorderableSection, ReactNode> = {
          hero: (
            <HeroBanner
              slides={settings.banner_slides}
              onScrollToProducts={scrollToProducts}
            />
          ),
          browse: (
            <BrowseCircles
              categories={categories}
              products={activeProducts}
              selectedId={selectedCategoryId}
              onSelect={handleSelectCategory}
            />
          ),
          bento: <BentoGrid products={activeProducts} settings={settings} />,
          chips: (
            <div className="home-chips">
              <CategoryChips
                categories={categories}
                selectedId={selectedCategoryId}
                onSelect={handleSelectCategory}
              />
            </div>
          ),
        };
        const isDragged = sectionDrag.dragIndex === index;
        const style: CSSProperties = {};
        if (isDragged) {
          style.transform = `translateY(${sectionDrag.delta.y}px) scale(1.02)`;
        } else {
          const shift = sectionDrag.shiftFor(index);
          if (shift !== 0) style.transform = `translateY(${shift}px)`;
        }
        return (
          <div
            key={id}
            data-section={id}
            ref={sectionDrag.registerItem(index)}
            className={`home-section${isEditMode ? ' home-section--editing' : ''}${
              isDragged ? ' home-section--dragging' : ''
            }${
              isDragged && sectionDrag.isDragging ? ' home-section--live' : ''
            }`}
            style={style}
          >
            {/* Admin-only handle; faded and inert while Edit Mode is off. */}
            {isAdmin && (
              <button
                type="button"
                ref={sectionDrag.registerHandle(index)}
                className={`section-handle${isEditMode ? '' : ' section-handle--off'}`}
                aria-label={`Drag to reorder the ${id} section`}
                aria-hidden={!isEditMode}
                tabIndex={-1}
              >
                <DragHandleGlyph />
              </button>
            )}
            {content[id]}
          </div>
        );
      })}

      <main className="viewer-main" ref={productsRef}>
        <h2 className="home-section-title">All Products</h2>
        <ProductGrid
          products={filteredProducts}
          isLoading={isLoading}
          searchQuery={search.query}
          selectedCategoryId={selectedCategoryId}
          onClearSearch={search.clear}
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

      {/* Both render nothing for anyone who isn't an approved admin. */}
      <EditModeToggle />
      <ProductEditSheet />
    </div>
  );
}
