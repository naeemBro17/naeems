import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { useDragReorder } from '../../hooks/useDragReorder';
import { brandPath, productCountLabel, productCountsByBrand, sortBrands } from '../../lib/brands';
import { deleteBrand, MOVE_PRODUCTS_FIRST, reorderBrands, setBrandOnHome } from '../../lib/brandAdmin';
import { timeAgo } from '../../lib/adminData';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { Modal } from '../shared/Modal';
import { BrandEditor } from './BrandEditor';
import { AdminPageHeader, AdminSearch, EmptyState, KebabMenu, SkeletonRows, type MenuItem } from './ui/AdminUi';
import { AdminIcon } from './ui/AdminIcon';
import type { Brand } from '../../types';

function DragGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="adm-icon">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

/** The logo on a small light card (the shop's light-mode look). */
export function BrandThumb({ brand }: { brand: Pick<Brand, 'name' | 'logo_url'> }) {
  return (
    <span className="adm-brand-thumb">
      {brand.logo_url ? <img src={brand.logo_url} alt="" loading="lazy" /> : <span>{brand.name.slice(0, 2).toUpperCase()}</span>}
    </span>
  );
}

/**
 * Admin → Brands (Batch 26 Part 2). Rows on a phone, a table on a computer:
 * logo, name, number of products, "Show on home" switch and ⋮ (Edit, View
 * on site, Delete). Drag the handle to reorder — that order is the Home
 * row's. Needs "Edit brands" (the Super Admin always); the database checks
 * the same on every change.
 */
export function BrandsTab() {
  const { brands, products, isLoading, refetch } = useProducts();
  const { showToast } = useToast();
  const [list, setList] = useState<Brand[]>(() => sortBrands(brands));
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Brand | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleting, setDeleting] = useState<Brand | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    setList(sortBrands(brands));
  }, [brands]);

  const counts = useMemo(() => productCountsByBrand(products), [products]);
  const term = search.trim().toLowerCase();
  const visible = term ? list.filter((b) => b.name.toLowerCase().includes(term) || b.slug.includes(term)) : list;

  const drag = useDragReorder<Brand>({
    items: list,
    mode: 'move',
    axis: 'y',
    enabled: term === '' && list.length > 1,
    longPressMs: 0,
    keyOf: (b) => b.id,
    onReorder: async (next) => {
      const previous = list;
      setList(next);
      const error = await reorderBrands(next.map((b) => b.id));
      if (error) {
        setList(previous);
        showToast(error, 'error');
        throw new Error(error);
      }
      showToast('Order saved');
      void refetch();
    },
  });

  const openEditor = (brand: Brand | null) => {
    setEditing(brand);
    setEditorOpen(true);
  };

  const toggleHome = async (brand: Brand) => {
    setBusyId(brand.id);
    setList((prev) => prev.map((b) => (b.id === brand.id ? { ...b, show_on_home: !brand.show_on_home } : b)));
    const error = await setBrandOnHome(brand.id, !brand.show_on_home);
    setBusyId(null);
    if (error) {
      setList((prev) => prev.map((b) => (b.id === brand.id ? { ...b, show_on_home: brand.show_on_home } : b)));
      showToast(error, 'error');
      return;
    }
    void refetch();
  };

  const handleDelete = async () => {
    if (!deleting) return;
    const error = await deleteBrand(deleting.id);
    setDeleting(null);
    if (error) {
      showToast(error, 'error');
      return;
    }
    showToast('Brand deleted');
    await refetch();
  };

  const rowMenu = (brand: Brand): MenuItem[] => [
    { label: 'Edit', icon: 'edit', onSelect: () => openEditor(brand) },
    { label: 'View on site', icon: 'external', onSelect: () => window.open(brandPath(brand), '_blank', 'noopener') },
    { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDeleting(brand) },
  ];

  const deletingCount = deleting ? (counts.get(deleting.id) ?? 0) : 0;

  return (
    <section aria-label="Brands" className="adm-brands">
      <AdminPageHeader
        title="Brands"
        primary={
          <button type="button" className="adm-btn adm-btn--primary" onClick={() => openEditor(null)} aria-label="Add brand">
            <AdminIcon name="plus" />
            <span className="adm-only-mobile">Add</span>
            <span className="adm-only-desktop">Add brand</span>
          </button>
        }
      />

      <div className="adm-filter-row">
        <AdminSearch value={search} onChange={setSearch} placeholder="Search brands" label="Search brands" />
      </div>
      <p className="adm-brands__hint">
        {term ? 'Clear the search to drag brands into a new order.' : 'Drag the handle to change the order. Home shows brands in this order.'}
      </p>

      {isLoading && list.length === 0 ? (
        <SkeletonRows rows={8} />
      ) : list.length === 0 ? (
        <EmptyState
          icon="brands"
          title="No brands yet"
          hint="Add a brand, or type a brand on a product."
          action={
            <button type="button" className="adm-btn adm-btn--primary" onClick={() => openEditor(null)}>
              <AdminIcon name="plus" /> Add brand
            </button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState icon="search" title="No brand matches that search" />
      ) : (
        <div className="adm-list adm-blist" role="list" aria-label="Brands">
          <div className="adm-thead" aria-hidden="true">
            <span />
            <span />
            <span>BRAND</span>
            <span>PRODUCTS</span>
            <span>LINK</span>
            <span>SHOW ON HOME</span>
            <span />
          </div>
          {visible.map((brand) => {
            const index = list.indexOf(brand);
            const count = counts.get(brand.id) ?? 0;
            const isDragged = drag.dragIndex === index;
            const style: CSSProperties = {};
            if (isDragged) style.transform = `translateY(${drag.delta.y}px)`;
            else if (term === '') {
              const shift = drag.shiftFor(index);
              if (shift !== 0) style.transform = `translateY(${shift}px)`;
            }
            return (
              <div
                key={brand.id}
                ref={term === '' ? drag.registerItem(index) : undefined}
                role="listitem"
                className={`adm-lrow adm-brow${isDragged ? ' adm-brow--dragging' : ''}`}
                style={style}
                data-testid="brand-row-admin"
                data-brand-id={brand.id}
                onClick={() => openEditor(brand)}
              >
                <span
                  ref={term === '' ? drag.registerHandle(index) : undefined}
                  className={`adm-brow__handle${term ? ' adm-brow__handle--off' : ''}`}
                  aria-label={`Drag to reorder ${brand.name}`}
                  data-testid="brand-drag-handle"
                  onClick={(e) => e.stopPropagation()}
                >
                  <DragGlyph />
                </span>
                <BrandThumb brand={brand} />
                <div className="adm-lrow__main">
                  <button
                    type="button"
                    className="adm-lrow__open"
                    onClick={(e) => {
                      e.stopPropagation();
                      openEditor(brand);
                    }}
                    aria-label={`Edit ${brand.name}`}
                  >
                    <span className="adm-lrow__name">{brand.name}</span>
                  </button>
                  <p className="adm-lrow__meta adm-mobile-meta">
                    <span data-testid="brand-product-count">{productCountLabel(count)}</span>
                    {brand.updated_by && brand.updated_by !== 'system' && (
                      <span>
                        by {brand.updated_by} · {timeAgo(brand.updated_at)}
                      </span>
                    )}
                  </p>
                  <p className="adm-lrow__sub adm-only-desktop-block">
                    {brand.updated_by && brand.updated_by !== 'system'
                      ? `updated by ${brand.updated_by} · ${timeAgo(brand.updated_at)}`
                      : `/brand/${brand.slug}`}
                  </p>
                </div>
                <span className="adm-cell">{productCountLabel(count)}</span>
                <span className="adm-cell adm-cell--muted adm-brow__link">/brand/{brand.slug}</span>
                <span className="adm-prow__live" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={brand.show_on_home}
                    aria-label={`Show ${brand.name} on home`}
                    disabled={busyId === brand.id}
                    className={`adm-switch${brand.show_on_home ? ' adm-switch--on' : ''}`}
                    onClick={() => void toggleHome(brand)}
                    data-testid="brand-home-switch"
                  >
                    <span className="adm-switch__thumb" aria-hidden="true" />
                  </button>
                </span>
                <span className="adm-prow__more" onClick={(e) => e.stopPropagation()}>
                  <KebabMenu label={`Actions for ${brand.name}`} items={rowMenu(brand)} />
                </span>
              </div>
            );
          })}
        </div>
      )}
      {visible.length > 0 && (
        <p className="adm-list-foot">
          {visible.length} of {list.length} brand{list.length === 1 ? '' : 's'} · {list.filter((b) => b.show_on_home).length} on Home
        </p>
      )}

      <Modal isOpen={editorOpen} onClose={() => setEditorOpen(false)} title={editing ? 'Edit brand' : 'Add brand'} fullScreenOnMobile>
        {editorOpen && (
          <BrandEditor
            key={editing?.id ?? 'new'}
            brand={editing}
            nextOrder={list.reduce((max, b) => Math.max(max, b.display_order), 0) + 1}
            productCount={editing ? (counts.get(editing.id) ?? 0) : 0}
            onSaved={async (saved) => {
              setEditorOpen(false);
              showToast(editing ? 'Brand saved' : `Brand "${saved.name}" added`);
              await refetch();
            }}
            onCancel={() => setEditorOpen(false)}
            onDelete={() => {
              if (editing) {
                setEditorOpen(false);
                setDeleting(editing);
              }
            }}
          />
        )}
      </Modal>

      <ConfirmDialog
        isOpen={deleting !== null}
        title={deletingCount > 0 ? "Can't delete this brand" : 'Delete brand?'}
        message={
          deleting
            ? deletingCount > 0
              ? `${deleting.name} has ${productCountLabel(deletingCount)}. ${MOVE_PRODUCTS_FIRST}`
              : `Delete "${deleting.name}"? This cannot be undone.`
            : ''
        }
        confirmLabel={deletingCount > 0 ? null : 'Delete'}
        cancelLabel={deletingCount > 0 ? 'OK' : 'Cancel'}
        danger
        onConfirm={handleDelete}
        onClose={() => setDeleting(null)}
      />
    </section>
  );
}
