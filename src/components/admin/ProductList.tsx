import { useEffect, useMemo, useState } from 'react';
import { useUrlParam } from '../../hooks/useUrlParams';
import { supabase, STORAGE_BUCKET, storagePathFromUrl } from '../../lib/supabase';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { normalizeText } from '../../lib/format';
import { productImages, coverImage, generateCardThumb } from '../../lib/productImages';
import { ProductForm } from './ProductForm';
import { CombineProductsSheet } from './CombineProductsSheet';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { BottomSheet } from '../shared/BottomSheet';
import { isOutOfStock } from '../../lib/stockStatus';
import { VARIANTS_VIEW } from '../../lib/variants';
import { useAuth } from '../../contexts/AuthContext';
import { fetchProductEditInfo, type ProductEditInfo } from '../../lib/staff';
import { isLowStockCount, isLowStockProduct, parseLowStockThreshold, timeAgo } from '../../lib/adminData';
import { formatTakaBd } from '../../lib/adminNav';
import {
  AdminPageHeader,
  AdminSearch,
  BulkBar,
  ChipRow,
  EmptyState,
  KebabMenu,
  SkeletonRows,
  StockDot,
  type MenuItem,
} from './ui/AdminUi';
import { AdminIcon } from './ui/AdminIcon';
import type { Product } from '../../types';

type StatusFilter = 'all' | 'active' | 'inactive';
const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'active', 'inactive'];
type StockFilter = 'all' | 'in' | 'low' | 'out';
const STOCK_FILTERS: readonly StockFilter[] = ['all', 'in', 'low', 'out'];

/** Stock line: "45 pcs" / "In stock" (green), "2 left" / "Out of stock"
 *  (red) — red at or below the low-stock threshold. Availability comes from
 *  isOutOfStock(), so a product with 0 pieces can never read "In stock". */
function stockLabel(product: Product, threshold: number): { tone: 'ok' | 'low'; text: string } {
  if (isOutOfStock(product)) return { tone: 'low', text: 'Out of stock' };
  if (product.stock_quantity === null || product.stock_quantity === undefined) return { tone: 'ok', text: 'In stock' };
  if (isLowStockCount(product, threshold)) return { tone: 'low', text: `${product.stock_quantity} left` };
  return { tone: 'ok', text: `${product.stock_quantity} pcs` };
}

/**
 * Admin → Products (Batch 25 Part 3, mockup screens 1 and 4). Phone: rows
 * with photo, full name, price, stock, Live switch and ⋮. Computer: the same
 * rows as a table. Tapping a row opens the product editor; Edit, Feature on
 * home, View on site and Delete live in the ⋮ menu.
 */
export function ProductList() {
  const { products, categories, settings, isLoading, refetch, patchProductLocal, variantsFor } = useProducts();
  const { showToast } = useToast();
  // Batch 24: deleting a product stays with the Super Admin; moderators
  // with "Edit products and stock" can add and edit only.
  const { isAdmin } = useAuth();
  const [editInfo, setEditInfo] = useState<Map<string, ProductEditInfo>>(() => new Map());
  const threshold = parseLowStockThreshold(settings.low_stock_threshold);

  // "updated by <username> · <time>" — re-read whenever the product list
  // reloads (after any save).
  useEffect(() => {
    let active = true;
    void fetchProductEditInfo().then((info) => {
      if (active) setEditInfo(info);
    });
    return () => {
      active = false;
    };
  }, [products]);

  // Filters live in the URL so they survive leaving the admin panel and
  // coming Back (hooks/useUrlParams.ts).
  const [search, setSearch] = useUrlParam<string>('pq', '');
  const [categoryFilter, setCategoryFilter] = useUrlParam<string>('pcat', '');
  const [brandFilter, setBrandFilter] = useUrlParam<string>('pbrand', '');
  const [statusFilter, setStatusFilter] = useUrlParam<StatusFilter>('pstatus', 'all', STATUS_FILTERS);
  const [stockFilter, setStockFilter] = useUrlParam<StockFilter>('pstock', 'all', STOCK_FILTERS);
  const [formOpen, setFormOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [deletingProduct, setDeletingProduct] = useState<Product | null>(null);
  /** Phone: checkboxes appear only after "Select products". On a computer
   *  the checkbox column is always there. */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [combineOpen, setCombineOpen] = useState(false);
  const [isBulkSaving, setIsBulkSaving] = useState(false);
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

  const brands = useMemo(
    () =>
      Array.from(new Set(products.map((p) => (p.brand ?? '').trim()).filter((b) => b !== ''))).sort((a, b) =>
        a.localeCompare(b)
      ),
    [products]
  );

  const filtered = useMemo(() => {
    let result = products;
    if (categoryFilter !== '') {
      result = result.filter((p) => p.category_id === categoryFilter);
    }
    if (brandFilter !== '') {
      result = result.filter((p) => (p.brand ?? '').trim() === brandFilter);
    }
    if (statusFilter !== 'all') {
      result = result.filter((p) => p.is_active === (statusFilter === 'active'));
    }
    if (stockFilter === 'low') result = result.filter((p) => isLowStockProduct(p, threshold));
    if (stockFilter === 'out') result = result.filter((p) => isOutOfStock(p));
    if (stockFilter === 'in') result = result.filter((p) => !isOutOfStock(p));
    const q = normalizeText(search.trim());
    if (q !== '') {
      result = result.filter((p) => normalizeText(p.name).includes(q) || normalizeText(p.sku).includes(q));
    }
    return result;
  }, [products, search, categoryFilter, brandFilter, statusFilter, stockFilter, threshold]);

  const lowCount = useMemo(() => products.filter((p) => isLowStockProduct(p, threshold)).length, [products, threshold]);
  const hiddenCount = useMemo(() => products.filter((p) => !p.is_active).length, [products]);

  // The phone's quick chips are shortcuts onto the same URL filters.
  const activeChip =
    stockFilter === 'low'
      ? 'low'
      : statusFilter === 'inactive'
        ? 'hidden'
        : categoryFilter !== ''
          ? `cat:${categoryFilter}`
          : 'all';
  const chips = [
    { id: 'all', label: 'All', count: products.length },
    { id: 'low', label: 'Low stock', count: lowCount },
    { id: 'hidden', label: 'Hidden', count: hiddenCount },
    ...categories.map((c) => ({ id: `cat:${c.id}`, label: c.name })),
  ];
  const selectChip = (id: string) => {
    setStockFilter(id === 'low' ? 'low' : 'all');
    setStatusFilter(id === 'hidden' ? 'inactive' : 'all');
    setCategoryFilter(id.startsWith('cat:') ? id.slice(4) : '');
  };

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
        const { error } = await supabase.from('products').update({ image_urls_thumb: thumbs }).eq('id', product.id);
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
        ? `Done: generated small images for ${done} product${done === 1 ? '' : 's'}`
        : `Done: ${done} succeeded, ${failed} failed (run it again to retry those)`,
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
      return;
    }
    showToast(nextValue ? `${product.name} is featured on home` : `${product.name} removed from home`);
  };

  /** Bulk Live on/off for the selected products. */
  const handleBulkLive = async (isActive: boolean) => {
    const ids = [...selectedIds];
    setIsBulkSaving(true);
    const { error } = await supabase
      .from('products')
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .in('id', ids);
    setIsBulkSaving(false);
    if (error) {
      showToast('Could not update the products. Please try again.', 'error');
      return;
    }
    for (const id of ids) patchProductLocal(id, { is_active: isActive });
    showToast(`${ids.length} product${ids.length === 1 ? '' : 's'} ${isActive ? 'now live' : 'hidden'}`);
    exitSelectMode();
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

    const { error } = await supabase.from('products').delete().eq('id', deletingProduct.id);
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
        showToast('Product deleted, but its original products could not be reactivated. Turn them on by hand.', 'error');
        setDeletingProduct(null);
        await refetch();
        return;
      }
    }

    setDeletingProduct(null);
    await refetch();
    showToast(
      toReactivate.size > 0
        ? `Product deleted. ${toReactivate.size} original product${toReactivate.size === 1 ? '' : 's'} reactivated`
        : 'Product deleted'
    );
  };

  const openEditor = (product: Product | null) => {
    setEditingProduct(product);
    setFormOpen(true);
  };

  const rowMenu = (product: Product): MenuItem[] => {
    const items: MenuItem[] = [
      { label: 'Edit', icon: 'edit', onSelect: () => openEditor(product) },
      {
        label: product.is_featured ? 'Remove from home' : 'Feature on home',
        icon: 'star',
        onSelect: () => void handleToggleFeatured(product),
      },
    ];
    if (product.slug) {
      items.push({
        label: 'View on site',
        icon: 'external',
        onSelect: () => window.open(`/product/${product.slug}`, '_blank', 'noopener'),
      });
    }
    if (isAdmin) {
      items.push({ label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDeletingProduct(product) });
    }
    return items;
  };

  const subLine = (product: Product): string => {
    const parts = [product.sku];
    const variantCount = variantsFor(product.id).length;
    if (variantCount > 0) parts.push(`${variantCount} variant${variantCount === 1 ? '' : 's'}`);
    const info = editInfo.get(product.id);
    if (info) parts.push(`updated by ${info.lastEditedBy} · ${timeAgo(info.lastEditedAt)}`);
    return parts.filter(Boolean).join(' · ');
  };

  const addButton = (
    <button type="button" className="adm-btn adm-btn--primary" onClick={() => openEditor(null)} aria-label="Add product">
      <AdminIcon name="plus" />
      <span className="adm-only-mobile">Add</span>
      <span className="adm-only-desktop">Add product</span>
    </button>
  );

  const filterSelects = (
    <>
      <select
        className="adm-select"
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
      <select className="adm-select" value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)} aria-label="Filter by brand">
        <option value="">All brands</option>
        {brands.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
      <select
        className="adm-select"
        value={stockFilter}
        onChange={(e) => setStockFilter(e.target.value as StockFilter)}
        aria-label="Filter by stock"
      >
        <option value="all">Stock: All</option>
        <option value="in">In stock</option>
        <option value="low">Low stock</option>
        <option value="out">Out of stock</option>
      </select>
      <select
        className="adm-select"
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
        aria-label="Filter by status"
      >
        <option value="all">Live: All</option>
        <option value="active">Live</option>
        <option value="inactive">Hidden</option>
      </select>
    </>
  );

  const showChecks = selectMode;
  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => selectedIds.includes(p.id));

  return (
    <section aria-label="Products" className="adm-products">
      <AdminPageHeader title="Products" primary={addButton} />

      <div className="adm-filter-row">
        <AdminSearch
          value={search}
          onChange={setSearch}
          placeholder="Search name or SKU"
          label="Search products by name or SKU"
          trailing={
            <button
              type="button"
              className="adm-icon-btn adm-icon-btn--plain adm-only-mobile-flex"
              onClick={() => setFiltersOpen(true)}
              aria-label="Filters and select"
            >
              <AdminIcon name="sliders" />
            </button>
          }
        />
        <span className="adm-only-desktop adm-filter-row__selects">{filterSelects}</span>
      </div>

      <div className="adm-only-mobile">
        <ChipRow chips={chips} active={activeChip} onSelect={selectChip} label="Quick filters" />
      </div>

      {(productsNeedingThumb.length > 0 || isBackfillingThumbs) && (
        <div className="admin-panel adm-notice">
          <h3 className="admin-panel__title">Speed up product photos</h3>
          <p className="admin-panel__description">
            {isBackfillingThumbs
              ? `Generating small card images: ${thumbBackfillProgress?.done ?? 0} of ${
                  thumbBackfillProgress?.total ?? 0
                } done. Keep this tab open.`
              : `${productsNeedingThumb.length} product${
                  productsNeedingThumb.length === 1 ? '' : 's'
                } still send${
                  productsNeedingThumb.length === 1 ? 's' : ''
                } the full-size photo to the grid/search/cart instead of a small one. One-time fix, safe to run: it only adds a small extra copy of each photo, nothing is deleted.`}
          </p>
          {!isBackfillingThumbs && (
            <button type="button" className="button button--secondary button--small" onClick={handleGenerateThumbnails}>
              Generate small images
            </button>
          )}
        </div>
      )}

      {isLoading && products.length === 0 ? (
        <SkeletonRows rows={8} />
      ) : products.length === 0 ? (
        <EmptyState
          icon="products"
          title="No products yet"
          hint="Add your first product to start selling."
          action={
            <button type="button" className="adm-btn adm-btn--primary" onClick={() => openEditor(null)}>
              <AdminIcon name="plus" /> Add your first product
            </button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon="search" title="No products match your filters" hint="Try another search or tap All." />
      ) : (
        <div className={`adm-list adm-plist${showChecks ? ' adm-plist--selecting' : ''}`} role="list" aria-label="Products">
          <div className="adm-thead" aria-hidden="true">
            <span>
              <input
                type="checkbox"
                className="adm-check"
                tabIndex={-1}
                checked={allFilteredSelected}
                onChange={() =>
                  setSelectedIds(allFilteredSelected ? [] : filtered.map((p) => p.id))
                }
              />
            </span>
            <span />
            <span>PRODUCT</span>
            <span>CATEGORY</span>
            <span>PRICE</span>
            <span>STOCK</span>
            <span>LIVE</span>
            <span />
          </div>
          {filtered.map((product) => {
            const stock = stockLabel(product, threshold);
            const cover = coverImage(product);
            const isSelected = selectedIds.includes(product.id);
            return (
              <div
                key={product.id}
                role="listitem"
                className={`adm-lrow adm-prow${isSelected ? ' adm-lrow--selected' : ''}`}
                data-testid="product-row"
                onClick={() => (selectMode ? toggleSelected(product.id) : openEditor(product))}
              >
                <span className="adm-prow__check" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="adm-check"
                    checked={isSelected}
                    onChange={() => toggleSelected(product.id)}
                    aria-label={`Select ${product.name}`}
                  />
                </span>
                <span className="adm-lrow__thumb">
                  {cover ? (
                    <img src={cover} alt="" loading="lazy" />
                  ) : (
                    <AdminIcon name="products" />
                  )}
                </span>
                <div className="adm-lrow__main">
                  <button
                    type="button"
                    className="adm-lrow__open"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (selectMode) toggleSelected(product.id);
                      else openEditor(product);
                    }}
                    aria-label={`Edit ${product.name}`}
                  >
                    <span className="adm-lrow__name">{product.name}</span>
                  </button>
                  <p className="adm-lrow__sub adm-only-desktop-block">{subLine(product)}</p>
                  <p className="adm-lrow__meta adm-mobile-meta">
                    <span className="adm-price">{formatTakaBd(product.retail_price)}</span>
                    <StockDot tone={stock.tone}>{stock.text}</StockDot>
                  </p>
                </div>
                <span className="adm-cell">
                  {product.category && <span className="adm-tag">{product.category.name}</span>}
                </span>
                <span className="adm-cell adm-price">{formatTakaBd(product.retail_price)}</span>
                <span className="adm-cell">
                  <StockDot tone={stock.tone}>{stock.text}</StockDot>
                </span>
                <span className="adm-prow__live" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={product.is_active}
                    aria-label={`${product.name} is ${product.is_active ? 'live' : 'hidden'}`}
                    className={`adm-switch${product.is_active ? ' adm-switch--on' : ''}`}
                    onClick={() => void handleToggleActive(product)}
                  >
                    <span className="adm-switch__thumb" aria-hidden="true" />
                  </button>
                </span>
                <span className="adm-prow__more" onClick={(e) => e.stopPropagation()}>
                  <KebabMenu label={`Actions for ${product.name}`} items={rowMenu(product)} />
                </span>
              </div>
            );
          })}
        </div>
      )}
      {filtered.length > 0 && (
        <p className="adm-list-foot">
          {filtered.length} of {products.length} product{products.length === 1 ? '' : 's'}
        </p>
      )}

      {selectedIds.length > 0 && (
        <BulkBar count={selectedIds.length} onClear={exitSelectMode}>
          <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" disabled={isBulkSaving} onClick={() => void handleBulkLive(true)}>
            Show
          </button>
          <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" disabled={isBulkSaving} onClick={() => void handleBulkLive(false)}>
            Hide
          </button>
          {selectedIds.length >= 2 && (
            <button type="button" className="adm-btn adm-btn--primary adm-btn--sm" onClick={() => setCombineOpen(true)}>
              Combine into variants
            </button>
          )}
        </BulkBar>
      )}

      <BottomSheet isOpen={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters">
        <div className="adm-filter-sheet">{filterSelects}</div>
        <button
          type="button"
          className="button button--secondary button--full adm-filter-sheet__select"
          onClick={() => {
            setFiltersOpen(false);
            if (selectMode) exitSelectMode();
            else setSelectMode(true);
          }}
        >
          {selectMode ? 'Stop selecting' : 'Select products'}
        </button>
      </BottomSheet>

      <ProductForm
        isOpen={formOpen}
        product={editingProduct}
        editInfo={editingProduct ? (editInfo.get(editingProduct.id) ?? null) : null}
        onClose={() => setFormOpen(false)}
      />

      <ConfirmDialog
        isOpen={deletingProduct !== null}
        title="Delete product?"
        message={deletingProduct ? `Delete '${deletingProduct.name}'? This cannot be undone.` : ''}
        confirmLabel="Delete"
        danger
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
