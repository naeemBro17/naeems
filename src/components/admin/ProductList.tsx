import { useMemo, useState } from 'react';
import { supabase, STORAGE_BUCKET, storagePathFromUrl } from '../../lib/supabase';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { formatTaka, normalizeText } from '../../lib/format';
import { productImages, coverImage } from '../../lib/productImages';
import { ProductForm } from './ProductForm';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { isOutOfStock } from '../../lib/stockStatus';
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
    setDeletingProduct(null);
    await refetch();
    showToast('Product deleted');
  };

  return (
    <section aria-label="Products">
      <header className="admin-section-header">
        <h2 className="admin-section-title">Products</h2>
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
    </section>
  );
}
