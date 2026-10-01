import { useMemo } from 'react';
import { useProducts } from '../contexts/ProductContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { brandsWithProducts, productCountLabel, productCountsByBrand } from '../lib/brands';
import { BackButton } from '../components/shared/BackButton';
import { BrandCard } from '../components/viewer/BrandCard';

/**
 * /brands (Batch 26 Part 4): every brand with at least one live product, in
 * the admin's order — the same cards as Home's row, two per line, with the
 * name and product count under each. Back returns to the exact spot on Home
 * (PageTransition's scroll memory, like every page).
 */
export function BrandsPage() {
  useDocumentTitle("Brands — Naeem's");
  const { products, brands, isLoading } = useProducts();
  const activeProducts = useMemo(() => products.filter((p) => p.is_active), [products]);
  const list = useMemo(() => brandsWithProducts(brands, activeProducts), [brands, activeProducts]);
  const counts = useMemo(() => productCountsByBrand(activeProducts), [activeProducts]);

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">Brands</h1>
        <div className="detail-header__actions" />
      </header>

      <main className="detail-main brands-page">
        {isLoading && list.length === 0 ? (
          <div className="brands-grid" aria-label="Loading brands">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="brands-grid__item" aria-hidden="true">
                <span className="brand-card brand-card--skeleton skeleton" />
                <span className="skeleton brands-grid__skeleton-name" />
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="empty-state">
            <p className="empty-state__message">No brands yet</p>
          </div>
        ) : (
          <ul className="brands-grid" aria-label="All brands">
            {list.map((brand) => (
              <li key={brand.id} className="brands-grid__item">
                <BrandCard brand={brand} />
                <span className="brands-grid__name">{brand.name}</span>
                <span className="brands-grid__count">{productCountLabel(counts.get(brand.id) ?? 0)}</span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
