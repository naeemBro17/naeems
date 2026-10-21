import { useEffect, useMemo, type MouseEvent } from 'react';
import { useProducts } from '../../contexts/ProductContext';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { homeBrands } from '../../lib/brands';
import { BrandCard } from './BrandCard';
import type { Product } from '../../types';

/** How many brands the row had last time — lets a fresh load reserve the
 *  row's height before the catalogue arrives (no pop-in, no shift). */
const LAST_COUNT_KEY = 'nph_home_brand_count';

function readLastCount(): number | null {
  try {
    const raw = localStorage.getItem(LAST_COUNT_KEY);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

function writeLastCount(count: number): void {
  try {
    localStorage.setItem(LAST_COUNT_KEY, String(count));
  } catch {
    // Private mode: the row just isn't reserved on the next fresh load.
  }
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

/**
 * Home: "Shop by Brand" (Batch 26 Part 3). One swipeable row of wide logo
 * cards (about 2.5 on a phone, so there's clearly more), brands with "Show
 * on home" on and at least one live product, in the admin's order. Native
 * sideways scrolling only — no touch handlers, so vertical page scrolling
 * with a finger on the row is the browser's own.
 */
export function BrandRow({ activeProducts }: { activeProducts: Product[] }) {
  const { brands, isLoading } = useProducts();
  const navigate = useAppNavigate();
  const list = useMemo(() => homeBrands(brands, activeProducts), [brands, activeProducts]);
  const settled = !isLoading;

  useEffect(() => {
    if (settled) writeLastCount(list.length);
  }, [settled, list.length]);

  // While the catalogue loads: hold the row's place (skeleton cards) unless
  // the last visit had no row at all.
  const reserve = !settled && list.length === 0 && readLastCount() !== 0;
  if (list.length === 0 && !reserve) return null;

  const seeAll = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate('/brands');
  };

  return (
    <section className="brand-row" aria-label="Shop by Brand" data-testid="brand-row">
      <div className="brand-row__head">
        <h2 className="home-section-title brand-row__title">Shop by Brand</h2>
        <a href="/brands" className="brand-row__all" onClick={seeAll}>
          See all
          <ArrowIcon />
        </a>
      </div>
      <div className="brand-row__scroller">
        {reserve
          ? [0, 1, 2].map((i) => <span key={i} className="brand-card brand-card--skeleton skeleton" aria-hidden="true" />)
          : list.map((brand) => <BrandCard key={brand.id} brand={brand} />)}
      </div>
    </section>
  );
}
