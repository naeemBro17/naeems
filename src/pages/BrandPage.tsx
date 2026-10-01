import { useCallback, useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useProducts, sortFeaturedFirst } from '../contexts/ProductContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useUrlParams } from '../hooks/useUrlParams';
import { filterByCategory } from '../lib/categoryFilter';
import { brandCategories, productCountLabel } from '../lib/brands';
import { BackButton } from '../components/shared/BackButton';
import { ThemeToggle } from '../components/shared/ThemeToggle';
import { BrandBanner } from '../components/viewer/BrandBanner';
import { CategoryChips } from '../components/viewer/CategoryChips';
import { ProductGrid } from '../components/viewer/ProductGrid';
import type { Brand } from '../types';

/** App-wide og: values from index.html, restored when this page unmounts. */
const DEFAULT_OG = {
  title: "Naeem's Price Hub",
  description: 'Premium Australian skincare — check prices instantly',
  image: window.location.origin + '/og-image.png',
  url: window.location.origin + '/',
};

function setOgTag(property: string, content: string): void {
  document.querySelector(`meta[property="og:${property}"]`)?.setAttribute('content', content);
}

/**
 * /brand/<slug> (Batch 26 Part 5): banner (video, picture or gradient) with
 * the logo, the brand name and product count, chips for the categories this
 * brand has products in (kept in the URL, so Back restores them), and the
 * brand's products as the same product cards as Home — tap opens the
 * product with the same hero animation, Back returns to the same spot.
 */
export function BrandPage() {
  const { slug } = useParams<{ slug: string }>();
  const { products, categories, brands, isLoading } = useProducts();
  const brand: Brand | null = brands.find((b) => b.slug === slug) ?? null;

  const [searchParams, updateParams] = useUrlParams();
  const catSlug = searchParams.get('cat');

  const brandProducts = useMemo(
    () => (brand ? sortFeaturedFirst(products.filter((p) => p.is_active && p.brand_id === brand.id)) : []),
    [products, brand]
  );
  const chipCategories = useMemo(() => brandCategories(categories, brandProducts), [categories, brandProducts]);
  const selectedCategoryId = chipCategories.find((c) => c.slug === catSlug)?.id ?? null;
  const shown = useMemo(() => filterByCategory(brandProducts, selectedCategoryId), [brandProducts, selectedCategoryId]);

  const selectCategory = useCallback(
    (id: string | null) => {
      const next = id === null ? null : categories.find((c) => c.id === id)?.slug ?? null;
      updateParams((params) => {
        if (next === null) params.delete('cat');
        else params.set('cat', next);
      });
    },
    [categories, updateParams]
  );

  useDocumentTitle(brand ? `${brand.name} — Naeem's` : "Naeem's");

  // Link preview for a shared brand link (browsers that run the page; link
  // bots get the same from api/brand-og.ts).
  useEffect(() => {
    if (!brand) return;
    setOgTag('title', `${brand.name} — Naeem's`);
    setOgTag('description', `Shop authentic ${brand.name} at Naeem's — ${productCountLabel(brandProducts.length)}.`);
    setOgTag('image', brand.banner_image_url ?? brand.logo_url ?? DEFAULT_OG.image);
    setOgTag('url', window.location.href);
    return () => {
      setOgTag('title', DEFAULT_OG.title);
      setOgTag('description', DEFAULT_OG.description);
      setOgTag('image', DEFAULT_OG.image);
      setOgTag('url', DEFAULT_OG.url);
    };
  }, [brand, brandProducts.length]);

  const header = (
    <header className="detail-header">
      <BackButton />
      <div className="detail-header__actions">
        <ThemeToggle />
      </div>
    </header>
  );

  if (!brand) {
    return (
      <div className="viewer-shell detail-shell">
        {header}
        <main className="detail-main">
          {isLoading ? (
            <div className="brand-page__skeleton" aria-label="Loading brand">
              <span className="skeleton brand-banner brand-banner--skeleton" />
              <span className="skeleton brand-page__skeleton-name" />
            </div>
          ) : (
            <div className="empty-state" data-testid="brand-not-found">
              <p className="empty-state__message">Brand not found</p>
              <Link to="/brands" className="button button--secondary">
                See all brands
              </Link>
            </div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="viewer-shell detail-shell brand-page">
      {header}
      <BrandBanner brand={brand} />
      <main className="brand-page__main">
        <div className="brand-page__intro">
          <h1 className="brand-page__name">{brand.name}</h1>
          <p className="brand-page__count" data-testid="brand-count">
            {productCountLabel(brandProducts.length)}
          </p>
        </div>
        {chipCategories.length > 1 && (
          <div className="brand-page__chips">
            <CategoryChips categories={chipCategories} selectedId={selectedCategoryId} onSelect={selectCategory} />
          </div>
        )}
        <ProductGrid
          products={shown}
          isLoading={isLoading && brandProducts.length === 0}
          searchQuery=""
          selectedCategoryId={selectedCategoryId}
          onClearSearch={() => {}}
          activeFilterCount={0}
          onClearFilters={() => {}}
        />
      </main>
    </div>
  );
}
