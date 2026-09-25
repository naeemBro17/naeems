import { useMemo, useState } from 'react';
import { supabase, STORAGE_BUCKET, storagePathFromUrl } from '../../lib/supabase';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { formatTaka, normalizeText } from '../../lib/format';
import { productImages, coverImage, generateCardThumb } from '../../lib/productImages';
import { ProductForm } from './ProductForm';
import { CombineProductsSheet } from './CombineProductsSheet';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { isOutOfStock } from '../../lib/stockStatus';
import { VARIANTS_VIEW } from '../../lib/variants';
import type { Product } from '../../types';

type StatusFilter = 'all' | 'active' | 'inactive';

/**
 * Availability comes from isOutOfStock(), which derives it from
 * stock_quantity — so a row with 0 in stock can never read "In Stock" here
 * either. The exact count stays visible: this is the admin's own inventory view.
 */
function stockText(product: Product): string {
  const label = isOutOfStock(product) ? 'Out of Stock' : 'In Stock';
  if (product.stock_quantity === null || product.stock_quantity === undefined) {
    return label;
  }
  return `${label} · ${product.stock_quantity} pcs`;
}

export function ProductList() {
  const { products, categories, refetch, patchProductLocal } = useProducts();
  const { showToast } = useToast();

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [deletingProduct, setDeletingProduct] = useState<Product | null>(null);
  /** Bulk multi-select for "Combine into variants" — off by default so the
   *  list behaves exactly as before unless the admin opts in. */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [combineOpen, setCombineOpen] = useState(false);
  // One-time (self-healing) backfill for products saved before Batch 19's
  // small "card" image column existed — see generateCardThumb.
  const [isBackfillingThumbs, setIsBackfillingThumbs] = useState(false);
  const [thumbBackfillProgress, setThumbBackfillProgress] = useState<{ done: number; total: number } | null>(
    null
  );

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds([]);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // Selected products, kept in the order they were picked — the first one is
  // the combine sheet's default "shared content" source.
  const selectedProducts = selectedIds
    .map((id) => products.find((p) => p.id === id))
    .filter((p): p is Product => p !== undefined);

  const filtered = useMemo(() => {
    let result = products;
    if (categoryFilter !== '') {
      result = result.filter((p) => p.category_id === categoryFilter);
    }
    if (statusFilter !== 'all') {
      result = result.filter((p) => p.is_active === (statusFilter === 'active'));
    }
    const q = normalizeText(search.trim());
    if (q !== '') {
      result = result.filter(
        (p) => normalizeText(p.name).includes(q) || normalizeText(p.sku).includes(q)
      );
    }
    return result;
  }, [products, search, categoryFilter, statusFilter]);

  // Batch 19: products saved before the small "card" image column existed
  // (or with a photo added/kept since then that never got backfilled).
  const productsNeedingThumb = useMemo(
    () =>
      products.filter((p) => {
        const full = productImages(p);
        return full.length > 0 && (p.image_urls_thumb ?? []).length < full.length;
      }),
    [products]
  );

  const handleGenerateThumbnails = async () => {
    setIsBackfillingThumbs(true);
    const total = productsNeedingThumb.length;
    let done = 0;
    let failed = 0;
    setThumbBackfillProgress({ done: 0, total });

    for (const product of productsNeedingThumb) {
      try {
        const full = productImages(product);
        const existing = product.image_urls_thumb ?? [];
        const thumbs: string[] = [];
        for (let i = 0; i < full.length; i += 1) {
          thumbs.push(existing[i] ?? (await generateCardThumb(full[i])));
        }
        const { error } = await supabase
          .from('products')
          .update({ image_urls_thumb: thumbs })
          .eq('id', product.id);
        if (error) throw error;
        patchProductLocal(product.id, { image_urls_thumb: thumbs });
        done += 1;
      } catch {
        failed += 1;
      }
      setThumbBackfillProgress({ done: done + failed, total });
    }

    setIsBackfillingThumbs(false);
    setThumbBackfillProgress(null);
    showToast(
      failed === 0
        ? `Done — generated small images for ${done} product${done === 1 ? '' : 's'}`
        : `Done — ${done} succeeded, ${failed} failed (run it again to retry those)`,
      failed === 0 ? 'success' : 'error'
    );
  };

  const handleToggleActive = async (product: Product) => {
    const nextValue = !product.is_active;
    // Optimistic UI: flip immediately, revert if the update fails.
    patchProductLocal(product.id, { is_active: nextValue });
    const { error } = await supabase
      .from('products')
      .update({ is_active: nextValue, updated_at: new Date().toISOString() })
      .eq('id', product.id);
    if (error) {
      patchProductLocal(product.id, { is_active: product.is_active });
      showToast('Could not update the product. Please try again.', 'error');
    }
  };

  const handleToggleFeatured = async (product: Product) => {
    const nextValue = !product.is_featured;
    // Optimistic UI: flip immediately, revert if the update fails.
    patchProductLocal(product.id, { is_featured: nextValue });
    const { error } = await supabase
      .from('products')
      .update({ is_featured: nextValue, updated_at: new Date().toISOString() })
      .eq('id', product.id);
    if (error) {
      patchProductLocal(product.id, { is_featured: product.is_featured });
      showToast('Could not update the product. Please try again.', 'error');
    }
  };

  const handleDelete = async () => {
    if (!deletingProduct) return;

    // If this product was created by "Combine into Variants", every
    // original it was built from needs to come back Active once it's gone
    // — the container itself for whichever product supplied its shared
    // content (combined_from_product_id), and each of its variant rows for
    // the rest (source_product_id). Both are null for an ordinary product,
    // so this is a no-op for the everyday delete path. Read before
    // deleting: the variant rows (and with them their source_product_id)
    // are cascade-deleted the instant the product row goes.
    const { data: variantRows } = await supabase
      .from(VARIANTS_VIEW)
      .select('source_product_id')
      .eq('product_id', deletingProduct.id);

    const toReactivate = new Set<string>();
    if (deletingProduct.combined_from_product_id) {
      toReactivate.add(deletingProduct.combined_from_product_id);
    }
    for (const row of (variantRows ?? []) as { source_product_id: string | null }[]) {
      if (row.source_product_id) toReactivate.add(row.source_product_id);
    }

    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', deletingProduct.id);
    if (error) {
      showToast('Could not delete the product. Please try again.', 'error');
      return;
    }
    const imagePaths = productImages(deletingProduct)
      .map(storagePathFromUrl)
      .filter((path): path is string => path !== null);
    if (imagePaths.length > 0) {
      await supabase.storage.from(STORAGE_BUCKET).remove(imagePaths);
    }

    if (toReactivate.size > 0) {
      const { error: reactivateError } = await supabase
        .from('products')
        .update({ is_active: true, updated_at: new Date().toISOString() })
        .in('id', Array.from(toReactivate));
      if (reactivateError) {
        console.error('Reactivating combined-from products failed:', reactivateError);
        showToast(
          'Product deleted, but its original products could not be reactivated — turn them on by hand',
          'error'
        );
        setDeletingProduct(null);
        await refetch();
        return;
      }
    }

    setDeletingProduct(null);
    await refetch();
    showToast(
      toReactivate.size > 0
        ? `Product deleted — ${toReactivate.size} original product${toReactivate.size === 1 ? '' : 's'} reactivated`
        : 'Product deleted'
    );
  };

  return (
    <section aria-label="Products">
      <header className="admin-section-header">
        <h2 className="admin-section-title">Products</h2>
        <div className="admin-section-header__actions">
          {selectMode ? (
            <button type="button" className="button button--secondary button--small" onClick={exitSelectMode}>
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => setSelectMode(true)}
            >
              Select
            </button>
          )}
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              setEditingProduct(null);
              setFormOpen(true);
            }}
          >
            + Add Product
          </button>
        </div>
      </header>

      <div className="admin-filter-bar">
        <input
          type="search"
          className="form-input admin-filter-bar__search"
          placeholder="Search name or SKU..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search products by name or SKU"
        />
        <select
          className="form-input form-select"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          className="form-input form-select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          aria-label="Filter by status"
        >
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {(productsNeedingThumb.length > 0 || isBackfillingThumbs) && (
        <div className="admin-panel" style={{ marginBottom: 16 }}>
          <h3 className="admin-panel__title">Speed up product photos</h3>
          <p className="admin-panel__description">
            {isBackfillingThumbs
              ? `Generating small card images — ${thumbBackfillProgress?.done ?? 0} of ${
                  thumbBackfillProgress?.total ?? 0
                } done. Keep this tab open.`
              : `${productsNeedingThumb.length} product${
                  productsNeedingThumb.length === 1 ? '' : 's'
                } still send${
                  productsNeedingThumb.length === 1 ? 's' : ''
                } the full-size photo to the grid/search/cart instead of a small one. One-time fix, safe to run — it only adds a small extra copy of each photo, nothing is deleted.`}
          </p>
          {!isBackfillingThumbs && (
            <button type="button" className="button button--primary button--small" onClick={handleGenerateThumbnails}>
              Generate small images
            </button>
          )}
        </div>
      )}

      {products.length === 0 ? (
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
              <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
              <path d="M3 8l9 5 9-5" />
              <path d="M12 13v8" />
            </svg>
          </div>
          <p className="empty-state__message">No products yet</p>
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              setEditingProduct(null);
              setFormOpen(true);
            }}
          >
            + Add your first product
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state__message">No products match your filters</p>
        </div>
      ) : (
        <ul className="admin-product-list">
          {filtered.map((product) => (
            <li key={product.id} className="admin-product-row">
              {selectMode && (
                <input
                  type="checkbox"
                  className="admin-product-row__checkbox"
                  checked={selectedIds.includes(product.id)}
                  onChange={() => toggleSelected(product.id)}
                  aria-label={`Select ${product.name}`}
                />
              )}
              <div className="admin-product-row__thumb-wrap">
                {coverImage(product) ? (
                  <img
                    src={coverImage(product) ?? ''}
                    alt={product.name}
                    className="admin-product-row__thumb"
                    loading="lazy"
                  />
                ) : (
                  <div className="admin-product-row__thumb-placeholder" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
                      <path d="M3 8l9 5 9-5" />
                    </svg>
                  </div>
                )}
              </div>

              <div className="admin-product-row__info">
                <p className="admin-product-row__name">{product.name}</p>
                <p className="admin-product-row__sku">{product.sku}</p>
                <div className="admin-product-row__meta">
                  {product.category && (
                    <span className="category-badge category-badge--neutral">
                      {product.category.name}
                    </span>
                  )}
                  <span
                    className={`status-badge ${product.is_active ? 'status-badge--active' : 'status-badge--inactive'}`}
                  >
                    {product.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <p className="admin-product-row__price">
                  {formatTaka(product.retail_price)}
                </p>
                <p className="stock-row">
                  <span
                    className={`stock-dot ${
                      isOutOfStock(product) ? 'stock-dot--red' : 'stock-dot--green'
                    }`}
                    aria-hidden="true"
                  />
                  <span className="stock-row__text">{stockText(product)}</span>
                </p>
              </div>

              <div className="admin-product-row__actions">
                <button
                  type="button"
                  aria-pressed={product.is_featured}
                  className={`star-toggle${product.is_featured ? ' star-toggle--on' : ''}`}
                  onClick={() => handleToggleFeatured(product)}
                  aria-label={
                    product.is_featured
                      ? `Unfeature ${product.name} from the homepage`
                      : `Feature ${product.name} on the homepage`
                  }
                  title={product.is_featured ? 'Featured on homepage' : 'Feature on homepage'}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill={product.is_featured ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={product.is_active}
                  aria-label={`${product.name} is ${product.is_active ? 'active' : 'inactive'}`}
                  className={`toggle${product.is_active ? ' toggle--on' : ''}`}
                  onClick={() => handleToggleActive(product)}
                >
                  <span className="toggle__thumb" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => {
                    setEditingProduct(product);
                    setFormOpen(true);
                  }}
                  aria-label={`Edit ${product.name}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="button button--danger-outline button--small"
                  onClick={() => setDeletingProduct(product)}
                  aria-label={`Delete ${product.name}`}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {selectMode && selectedIds.length >= 2 && (
        <div className="admin-combine-bar">
          <span className="admin-combine-bar__count">{selectedIds.length} selected</span>
          <button
            type="button"
            className="button button--primary button--small"
            onClick={() => setCombineOpen(true)}
          >
            Combine into variants
          </button>
        </div>
      )}

      <ProductForm
        isOpen={formOpen}
        product={editingProduct}
        onClose={() => setFormOpen(false)}
      />

      <ConfirmDialog
        isOpen={deletingProduct !== null}
        title="Delete Product"
        message={
          deletingProduct
            ? `Delete '${deletingProduct.name}'? This cannot be undone.`
            : ''
        }
        onConfirm={handleDelete}
        onClose={() => setDeletingProduct(null)}
      />

      <CombineProductsSheet
        isOpen={combineOpen}
        products={selectedProducts}
        onClose={() => setCombineOpen(false)}
        onCombined={(newProduct) => {
          setCombineOpen(false);
          exitSelectMode();
          setEditingProduct(newProduct);
          setFormOpen(true);
        }}
      />
    </section>
  );
}
