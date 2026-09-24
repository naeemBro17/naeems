import { useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { distinctRegions, distinctSizes } from '../../lib/variants';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import type { Product, ProductVariant } from '../../types';

type Field = 'region' | 'size';

interface UsageCount {
  products: number;
  variants: number;
}

/** How many products' own label, and how many variant rows, currently carry
 *  this exact value — the same count either blocks Delete or tells the admin
 *  what a Rename will touch. */
function usageCounts(
  field: Field,
  values: string[],
  products: Product[],
  variants: ProductVariant[]
): Map<string, UsageCount> {
  const counts = new Map<string, UsageCount>(values.map((v) => [v, { products: 0, variants: 0 }]));
  for (const p of products) {
    const value = p[field];
    if (value !== null && counts.has(value)) counts.get(value)!.products += 1;
  }
  for (const v of variants) {
    const value = v[field];
    if (counts.has(value)) counts.get(value)!.variants += 1;
  }
  return counts;
}

/**
 * One Region or Size management list: every distinct value currently in use
 * anywhere in the catalog (a product's own label plus every variant row —
 * same source as the GuidedField picker, see lib/variants.ts), with Rename
 * (propagates to every product and variant row carrying that exact value in
 * one operation) and Delete (blocked, with a usage count, whenever anything
 * still uses it — since a Region/Size isn't its own database row, it can
 * only ever "exist" here because something references it; Delete is a
 * safety guard against orphaning data, not a normal path to clearing one
 * out). Adding a brand new value isn't done here — GuidedField's own
 * "+ Add new…" already covers that from both the product and variant forms.
 */
function AttributeSection({ field, label }: { field: Field; label: string }) {
  const { products, allVariants, refetch, reloadVariants } = useProducts();
  const { showToast } = useToast();

  const [editingValue, setEditingValue] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [deletingValue, setDeletingValue] = useState<string | null>(null);

  const values = useMemo(
    () => (field === 'region' ? distinctRegions(products, allVariants) : distinctSizes(products, allVariants)),
    [field, products, allVariants]
  );
  const counts = useMemo(
    () => usageCounts(field, values, products, allVariants),
    [field, values, products, allVariants]
  );

  const startEdit = (value: string) => {
    setEditingValue(value);
    setEditingName(value);
  };

  const handleSaveEdit = async (oldValue: string) => {
    const newValue = editingName.trim();
    if (newValue === '' || newValue === oldValue) {
      setEditingValue(null);
      return;
    }
    setIsSaving(true);
    const [{ error: productsError }, { error: variantsError }] = await Promise.all([
      supabase.from('products').update({ [field]: newValue }).eq(field, oldValue),
      supabase.from('product_variants').update({ [field]: newValue }).eq(field, oldValue),
    ]);
    setIsSaving(false);
    if (productsError || variantsError) {
      showToast(`Could not rename '${oldValue}' — please try again`, 'error');
      return;
    }
    setEditingValue(null);
    await Promise.all([refetch(), reloadVariants()]);
    showToast(`Renamed '${oldValue}' to '${newValue}' everywhere it's used`);
  };

  // A Region/Size isn't a row of its own — it only appears in `values` at
  // all because something currently references it, so this list can never
  // contain a zero-usage entry. ConfirmDialog already hides the Delete
  // button whenever usage is > 0 (see confirmLabel below), so this only
  // ever runs in the (structurally unreachable) 0-usage case — there is
  // no separate row to delete, just the dialog to close.
  const handleDelete = async () => {
    setDeletingValue(null);
  };

  const deletingCount = deletingValue !== null ? counts.get(deletingValue) ?? { products: 0, variants: 0 } : null;

  return (
    <section aria-label={label}>
      <header className="admin-section-header">
        <h3 className="admin-section-title">{label}</h3>
      </header>

      {values.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state__message">No {label.toLowerCase()} in use yet</p>
        </div>
      ) : (
        <ul className="admin-category-list">
          {values.map((value) => {
            const count = counts.get(value) ?? { products: 0, variants: 0 };
            const isEditing = editingValue === value;
            return (
              <li key={value} className="admin-category-row">
                {isEditing ? (
                  <div className="admin-category-row__edit-fields">
                    <input
                      type="text"
                      className="form-input"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      aria-label={`Rename ${label.slice(0, -1)} ${value}`}
                    />
                    <button
                      type="button"
                      className="button button--primary button--small"
                      onClick={() => handleSaveEdit(value)}
                      disabled={isSaving || editingName.trim() === ''}
                    >
                      {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
                    </button>
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() => setEditingValue(null)}
                      disabled={isSaving}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="admin-category-row__info">
                      <p className="admin-category-row__name">{value}</p>
                    </div>
                    <span className="count-badge">
                      {count.products + count.variants}{' '}
                      {count.products + count.variants === 1 ? 'use' : 'uses'}
                    </span>
                    <div className="admin-category-row__actions">
                      <button
                        type="button"
                        className="button button--secondary button--small"
                        onClick={() => startEdit(value)}
                        aria-label={`Edit ${value}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="button button--danger-outline button--small"
                        onClick={() => setDeletingValue(value)}
                        aria-label={`Delete ${value}`}
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        isOpen={deletingValue !== null}
        title={`Delete ${label.slice(0, -1)}`}
        message={
          deletingValue !== null && deletingCount
            ? deletingCount.products + deletingCount.variants > 0
              ? `'${deletingValue}' is used by ${deletingCount.products} product(s) and ${deletingCount.variants} variant(s). Change those first.`
              : `Delete '${deletingValue}'? This cannot be undone.`
            : ''
        }
        confirmLabel={deletingCount && deletingCount.products + deletingCount.variants > 0 ? null : 'Delete'}
        cancelLabel={deletingCount && deletingCount.products + deletingCount.variants > 0 ? 'Close' : 'Cancel'}
        onConfirm={handleDelete}
        onClose={() => setDeletingValue(null)}
      />
    </section>
  );
}

/** Region and Size management, added to the admin Categories tab (they're
 *  the same kind of catalog-wide grouping label as a Category — see
 *  Naeems.txt "PART 5" for why this exists: the product's own Region/Size
 *  and a variant row's Region/Size used to be free text typed independently,
 *  which let a casing/spacing slip silently split one real-world Region into
 *  two selectable options on the detail page). */
export function RegionSizeManager() {
  return (
    <div className="region-size-manager">
      <AttributeSection field="region" label="Regions" />
      <AttributeSection field="size" label="Sizes" />
    </div>
  );
}
