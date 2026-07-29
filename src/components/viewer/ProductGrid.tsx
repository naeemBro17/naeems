import { useMemo } from 'react';
import type { Product, Category } from '../../types';
import { ProductCard } from './ProductCard';
import { SkeletonCard } from '../shared/SkeletonCard';

interface ProductGridProps {
  products: Product[];
  categories: Category[];
  isLoading: boolean;
  searchQuery: string;
  selectedCategoryId: string | null;
  onClearSearch: () => void;
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
  categories,
  isLoading,
  searchQuery,
  selectedCategoryId,
  onClearSearch,
}: ProductGridProps) {
  // Category id → index in the sorted category list, for deterministic badge colors.
  const categoryIndexById = useMemo(() => {
    const map = new Map<string, number>();
    categories.forEach((c, i) => map.set(c.id, i));
    return map;
  }, [categories]);

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
      {products.map((product) => (
        <ProductCard
          key={product.id}
          product={product}
          categoryIndex={
            product.category_id !== null
              ? categoryIndexById.get(product.category_id) ?? 0
              : 0
          }
        />
      ))}
    </div>
  );
}
