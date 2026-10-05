import { useEffect, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { recallScroll } from '../../lib/scrollMemory';
import type { Product } from '../../types';
import { ProductCard } from './ProductCard';
import { SkeletonCard } from '../shared/SkeletonCard';

interface ProductGridProps {
  products: Product[];
  isLoading: boolean;
  searchQuery: string;
  selectedCategoryId: string | null;
  onClearSearch: () => void;
  /** Active Brand/Skin Type filter count, and how to clear them. */
  activeFilterCount: number;
  onClearFilters: () => void;
}

/** Cards drawn straight away — about two screens on a phone. */
const FIRST_CARDS = 8;
/** Cards added per idle moment after that — few enough that each step
 *  stays well under the 50 ms a phone can spend without a tap feeling stuck. */
const CARDS_PER_STEP = 4;

/**
 * How many cards to draw (Batch 29 Part 7). Drawing all ~150 at once kept a
 * phone busy for over a second before anything could be tapped, so a fresh
 * visit draws the first few and adds the rest in small steps whenever the
 * phone is idle (each step short enough never to freeze a tap). Coming Back
 * to a page that remembers a scroll spot draws everything at once, exactly
 * as before — the spot and the card the morph returns to must be there on
 * the very first frame.
 */
function useCardsToDraw(total: number): number {
  const navigationType = useNavigationType();
  const location = useLocation();
  const [count, setCount] = useState(() => {
    const returning = navigationType === 'POP' && (recallScroll(location.key) ?? 0) > 0;
    return returning ? Number.POSITIVE_INFINITY : FIRST_CARDS;
  });

  useEffect(() => {
    if (count >= total) return;
    const step = () => setCount((c) => c + CARDS_PER_STEP);
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(step, { timeout: 300 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = window.setTimeout(step, 16);
    return () => window.clearTimeout(timer);
  }, [count, total]);

  return count;
}

function EmptyState({
  message,
  action,
}: {
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
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
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
          <path d="M8 11h6" />
        </svg>
      </div>
      <p className="empty-state__message">{message}</p>
      {action && (
        <button type="button" className="button button--secondary" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

export function ProductGrid({
  products,
  isLoading,
  searchQuery,
  selectedCategoryId,
  onClearSearch,
  activeFilterCount,
  onClearFilters,
}: ProductGridProps) {
  const cardsToDraw = useCardsToDraw(products.length);

  if (isLoading) {
    return (
      <div className="product-grid" aria-label="Loading products">
        {Array.from({ length: 6 }, (_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (products.length === 0) {
    if (activeFilterCount > 0) {
      return (
        <EmptyState
          message="No products match these filters"
          action={{ label: 'Clear filters', onClick: onClearFilters }}
        />
      );
    }
    if (searchQuery.trim() !== '') {
      return (
        <EmptyState
          message={`No results for '${searchQuery.trim()}'`}
          action={{ label: 'Clear search', onClick: onClearSearch }}
        />
      );
    }
    if (selectedCategoryId !== null) {
      return <EmptyState message="Nothing in this category" />;
    }
    return <EmptyState message="No products yet" />;
  }

  return (
    <div className="product-grid">
      {(cardsToDraw >= products.length ? products : products.slice(0, cardsToDraw)).map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}
