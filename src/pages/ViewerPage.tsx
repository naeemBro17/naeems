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
import { useProductFilters } from '../hooks/useProductFilters';
import { useDragReorder } from '../hooks/useDragReorder';
import { useToast } from '../hooks/useToast';
import { takeGridScroll } from '../lib/gridScroll';
import { saveSettings, serializeIdList } from '../lib/settingsLists';
import {
  DEFAULT_SECTION_ORDER,
  readOrder,
  REORDERABLE_SECTIONS,
  type HomeSectionId,
} from '../lib/layoutOrder';
import { SearchEntryBar } from '../components/viewer/SearchEntryBar';
import { FilterSheet } from '../components/viewer/FilterSheet';
import { HeroBanner } from '../components/viewer/HeroBanner';
import { BrowseCircles } from '../components/viewer/BrowseCircles';
import { BentoGrid } from '../components/viewer/BentoGrid';
import { CategoryChips } from '../components/viewer/CategoryChips';
import { ProductGrid } from '../components/viewer/ProductGrid';
import { BottomNav } from '../components/viewer/BottomNav';
import { HamburgerMenu } from '../components/viewer/HamburgerMenu';
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
  const [filterOpen, setFilterOpen] = useState(false);

  const productsRef = useRef<HTMLElement>(null);
  const chipsRowRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(52);
  // True once the in-flow chip row has scrolled up past the header — a
  // second, always-pinned copy of the chips then takes over visually (see
  // .home-chips-pinned in app.css). Plain CSS `position: sticky` on the
  // in-flow row doesn't work here: each reorderable homepage section (hero/
  // browse/bento/chips) is wrapped in its own .home-section box sized to
  // exactly that section's content, so the chip row's sticky "containing
  // block" is only ever as tall as the chip row itself — there's no room
  // for it to visibly stick before its own tiny box scrolls past too (see
  // reports/batch-17.txt Part 1 for how this was found). A fixed duplicate,
  // toggled by scroll position, sidesteps that entirely.
  const [isChipsPinned, setIsChipsPinned] = useState(false);

  // Measures the header's real height (used both for the pinned chips'
  // top offset and the scroll-target math below) and re-measures on resize.
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const setHeight = () => setHeaderHeight(header.getBoundingClientRect().height);
    setHeight();
    const observer = new ResizeObserver(setHeight);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  // A plain scroll listener rather than IntersectionObserver: simpler to
  // reason about, and the chip row's own height can change (e.g. its
  // categories load in after first paint), which would otherwise mean
  // recreating the observer's rootMargin whenever that height settles.
  // rAF-throttled so this never runs more than once per frame.
  useEffect(() => {
    let ticking = false;
    const checkPinned = () => {
      ticking = false;
      const el = chipsRowRef.current;
      if (!el) return;
      const chipsDocumentTop = el.getBoundingClientRect().top + window.scrollY;
      setIsChipsPinned(window.scrollY > chipsDocumentTop - headerHeight);
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(checkPinned);
    };
    checkPinned();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [headerHeight]);

  // Owns this page's scroll position on every fresh mount — not just the
  // "coming back from a product" case below. Without this, returning here
  // via the browser Back button from anywhere that ISN'T a product page
  // (e.g. /search — see reports/batch-18.txt Part 6) left the browser's own
  // native scroll restoration to guess a position, which then visibly
  // fought the page-slide transition and this component's full remount
  // (PageTransition keys on pathname, so navigating back here is a real
  // unmount+remount, not just a re-render) — a jump/shake as the two
  // settled into different final positions. history.scrollRestoration is
  // set to 'manual' once in main.tsx specifically so this effect is the
  // only thing deciding where a fresh mount of this page starts.
  //
  // The guard ref means this only ever runs once per actual mount — a
  // later `products` reference change (e.g. an admin's edit triggering
  // refetch()) must NOT re-trigger a scroll jump while they're already
  // browsing the page.
  const hasSetInitialScroll = useRef(false);
  useEffect(() => {
    if (hasSetInitialScroll.current) return;
    if (isLoading) return; // wait for real content, same as before
    hasSetInitialScroll.current = true;

    const savedY = takeGridScroll();
    requestAnimationFrame(() => {
      setTimeout(() => {
        window.scrollTo({ top: savedY ?? 0, behavior: 'instant' });
      }, 80);
    });
  }, [products, isLoading]);

  // Viewers only ever see active products (admin sessions fetch inactive too).
  const activeProducts = useMemo(() => products.filter((p) => p.is_active), [products]);
  // Featured-first only in the default "All" view — the first impression every
  // new visitor gets. Within a specific category, keep the existing sort.
  const orderedProducts = useMemo(
    () =>
      selectedCategoryId === null ? sortFeaturedFirst(activeProducts) : activeProducts,
    [activeProducts, selectedCategoryId]
  );
  // Brand / Skin Type filtering sits on top of the category selection —
  // free-text search now lives entirely on its own page (SearchPage), the
  // home grid only ever shows the category-filtered catalog.
  const productFilters = useProductFilters(activeProducts);
  const filteredProducts = productFilters.apply(orderedProducts);

  const scrollToProducts = useCallback(() => {
    productsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Scrolls so the chip row lands right below the header, with products
  // visible underneath — never past it, unlike the old scrollToProducts-
  // based version, which scrolled the chip row itself off-screen above the
  // header once the filtered grid was tall enough to allow the scroll to go
  // that far (see reports/batch-17.txt Part 1). Computed manually (current
  // viewport offset + current scroll - header height) rather than a plain
  // scrollIntoView, since the chip row isn't actually CSS-sticky (see the
  // isChipsPinned effect above) — scrollIntoView's block:'start' would
  // otherwise land it at y=0, under the header, not just below it.
  const scrollToChips = useCallback(() => {
    const el = chipsRowRef.current;
    if (!el) return;
    const targetY = el.getBoundingClientRect().top + window.scrollY - headerHeight;
    window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
  }, [headerHeight]);

  // The Browse circles and the chips write the same filter, so selecting in
  // either place lights up the other.
  const handleSelectCategory = useCallback(
    (id: string | null) => {
      setSelectedCategoryId(id);
      // scrollToChips measures chipsRowRef's CURRENT position — calling it
      // synchronously here measures the layout from before this filter took
      // effect (setSelectedCategoryId is async/batched), then starts a smooth
      // scroll toward that stale target just as the grid's real height (very
      // different depending on how many products the category has) lands
      // underneath it. Waiting two animation frames lets the browser finish
      // laying out and painting the filtered grid first, so the scroll
      // always measures the real, final position.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToChips();
        });
      });
    },
    [scrollToChips]
  );

  const handleRetry = async () => {
    setIsRetrying(true);
    await refetch();
    setIsRetrying(false);
  };

  const handleHomeTab = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleAccountTab = () => {
    navigate('/account');
  };

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
      <header className="app-header" ref={headerRef}>
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

      {/* Always mounted (so it can animate in/out smoothly, no snap-in),
          only actually visible once isChipsPinned — see the effect above. */}
      <div
        className={`home-chips-pinned${isChipsPinned ? ' home-chips-pinned--visible' : ''}`}
        style={{ top: headerHeight }}
        aria-hidden={!isChipsPinned}
      >
        <CategoryChips
          categories={categories}
          selectedId={selectedCategoryId}
          onSelect={handleSelectCategory}
        />
      </div>

      {isOffline && <OfflineBanner />}

      <div className="home-search">
        <SearchEntryBar
          onOpenFilters={() => setFilterOpen(true)}
          activeFilterCount={productFilters.activeCount}
        />
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
            <div className="home-chips" ref={chipsRowRef}>
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
          searchQuery=""
          selectedCategoryId={selectedCategoryId}
          onClearSearch={() => {}}
          activeFilterCount={productFilters.activeCount}
          onClearFilters={productFilters.clear}
        />
      </main>

      <BottomNav activeTab="home" onHome={handleHomeTab} onAccount={handleAccountTab} />

      <HamburgerMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />
      <FilterSheet
        isOpen={filterOpen}
        onClose={() => setFilterOpen(false)}
        filters={productFilters.filters}
        onChange={productFilters.setFilters}
        availableBrands={productFilters.availableBrands}
        baseProducts={orderedProducts}
      />

      {/* Both render nothing for anyone who isn't an approved admin. */}
      <EditModeToggle />
      <ProductEditSheet />
    </div>
  );
}
