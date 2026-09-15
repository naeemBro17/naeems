import { useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { supabase } from '../../../lib/supabase';
import { useProducts } from '../../../contexts/ProductContext';
import { useToast } from '../../../hooks/useToast';
import { formatTaka } from '../../../lib/format';
import {
  emptyVariantForm,
  validateVariantForm,
  variantToForm,
} from '../../../lib/variants';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { PencilGlyph, RowIconButton, Toggle, TrashGlyph } from './SheetChrome';
import type { ProductVariant, VariantFormData } from '../../../types';

interface VariantEditorProps {
  productId: string;
}

const numberOrNull = (value: string): number | null =>
  value.trim() === '' ? null : Number(value);

function VariantForm({
  form,
  isSaving,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: VariantFormData;
  isSaving: boolean;
  onChange: (patch: Partial<VariantFormData>) => void;
  onSubmit: (e: SyntheticEvent) => void;
  onCancel: () => void;
}) {
  // Not a <form>: this sits inside the product sheet's own form, and nested
  // forms are invalid HTML. Enter in any field saves the variant, not the
  // product.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      e.stopPropagation();
      onSubmit(e);
    }
  };

  return (
    <div className="variant-form" onKeyDown={handleKeyDown}>
      <div className="form-row">
        <div className="form-field">
          <label className="form-label" htmlFor="vf-region">
            Region <span className="form-required" aria-hidden="true">*</span>
          </label>
          <input
            id="vf-region"
            type="text"
            className="form-input"
            placeholder="AU"
            value={form.region}
            onChange={(e) => onChange({ region: e.target.value })}
            autoCapitalize="characters"
          />
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor="vf-size">
            Size <span className="form-required" aria-hidden="true">*</span>
          </label>
          <input
            id="vf-size"
            type="text"
            className="form-input"
            placeholder="340g"
            value={form.size}
            onChange={(e) => onChange({ size: e.target.value })}
          />
        </div>
      </div>

      <div className="form-row">
        <div className="form-field">
          <label className="form-label" htmlFor="vf-retail">
            Retail ৳ <span className="form-required" aria-hidden="true">*</span>
          </label>
          <input
            id="vf-retail"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            className="form-input"
            value={form.retail_price}
            onChange={(e) => onChange({ retail_price: e.target.value })}
          />
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor="vf-offer">Offer ৳</label>
          <input
            id="vf-offer"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            className="form-input"
            placeholder="None"
            value={form.offer_price}
            onChange={(e) => onChange({ offer_price: e.target.value })}
          />
        </div>
      </div>

      <div className="form-row">
        <div className="form-field">
          <label className="form-label" htmlFor="vf-wholesale">Wholesale ৳</label>
          <input
            id="vf-wholesale"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            className="form-input"
            value={form.wholesale_price}
            onChange={(e) => onChange({ wholesale_price: e.target.value })}
          />
        </div>
        <div className="form-field form-field--toggle variant-form__stock">
          <span className="toggle-label">In Stock</span>
          <Toggle
            checked={form.in_stock}
            onChange={(in_stock) => onChange({ in_stock })}
            label="In stock"
          />
        </div>
      </div>

      <div className="variant-form__actions">
        <button type="button" className="edit-sheet__cancel" onClick={onCancel} disabled={isSaving}>
          Cancel
        </button>
        <button
          type="button"
          className="button button--primary button--small"
          onClick={onSubmit}
          disabled={isSaving}
        >
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save Variant'}
        </button>
      </div>
    </div>
  );
}

/**
 * Region → Size variants of one product, edited inside the product sheet.
 * Each variant saves on its own, immediately, and the shared variant list is
 * reloaded so the grid's "from" price and the detail page follow.
 */
export function VariantEditor({ productId }: VariantEditorProps) {
  const { variantsFor, reloadVariants } = useProducts();
  const { showToast } = useToast();
  const variants = variantsFor(productId);

  const [form, setForm] = useState<VariantFormData | null>(null);
  /** Variant being edited, or null while adding a new one. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ProductVariant | null>(null);

  const startAdd = () => {
    setForm(emptyVariantForm());
    setEditingId(null);
  };

  const startEdit = (variant: ProductVariant) => {
    setForm(variantToForm(variant));
    setEditingId(variant.id);
  };

  const closeForm = () => {
    setForm(null);
    setEditingId(null);
  };

  const handleSubmit = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (!form) return;
    const problem = validateVariantForm(form);
    if (problem) {
      showToast(problem, 'error');
      return;
    }
    setIsSaving(true);
    const payload = {
      product_id: productId,
      region: form.region.trim().toUpperCase(),
      size: form.size.trim(),
      retail_price: Number(form.retail_price),
      offer_price: numberOrNull(form.offer_price),
      wholesale_price: numberOrNull(form.wholesale_price),
      in_stock: form.in_stock,
    };
    const { error } = editingId
      ? await supabase.from('product_variants').update(payload).eq('id', editingId)
      : await supabase
          .from('product_variants')
          .insert({ ...payload, sort_order: variants.length + 1 });
    if (error) {
      console.error('Variant save failed:', error);
      setIsSaving(false);
      showToast('Could not save the variant', 'error');
      return;
    }
    await reloadVariants();
    setIsSaving(false);
    showToast('Variant saved');
    closeForm();
  };

  const handleToggleStock = async (variant: ProductVariant) => {
    const { error } = await supabase
      .from('product_variants')
      .update({ in_stock: !variant.in_stock })
      .eq('id', variant.id);
    if (error) {
      console.error('Variant stock update failed:', error);
      showToast('Could not update the variant', 'error');
      return;
    }
    await reloadVariants();
    showToast('Variant saved');
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    const { error } = await supabase.from('product_variants').delete().eq('id', target.id);
    if (error) {
      console.error('Variant delete failed:', error);
      showToast('Could not delete the variant', 'error');
      return;
    }
    if (editingId === target.id) closeForm();
    await reloadVariants();
    showToast('Variant deleted');
  };

  return (
    <div className="form-field variant-editor">
      <span className="form-label">Variants</span>

      {variants.length === 0 ? (
        <p className="edit-sheet__empty">
          No variants added. This product shows as a single item.
        </p>
      ) : (
        <ul className="variant-list">
          {variants.map((variant) => (
            <li key={variant.id} className="variant-list__item">
              <div className={`variant-list__row${variant.in_stock ? '' : ' variant-list__row--out'}`}>
                <span className="variant-list__region">{variant.region}</span>
                <span className="variant-list__size">{variant.size}</span>
                <span className="variant-list__price">{formatTaka(variant.retail_price)}</span>
                <Toggle
                  small
                  checked={variant.in_stock}
                  onChange={() => void handleToggleStock(variant)}
                  label={`${variant.region} ${variant.size} in stock`}
                />
                <RowIconButton
                  label={`Edit ${variant.region} ${variant.size}`}
                  onClick={() => (editingId === variant.id ? closeForm() : startEdit(variant))}
                >
                  <PencilGlyph />
                </RowIconButton>
                <RowIconButton
                  label={`Delete ${variant.region} ${variant.size}`}
                  variant="danger"
                  onClick={() => setPendingDelete(variant)}
                >
                  <TrashGlyph />
                </RowIconButton>
              </div>
              {form !== null && editingId === variant.id && (
                <VariantForm
                  form={form}
                  isSaving={isSaving}
                  onChange={(patch) =>
                    setForm((current) => (current ? { ...current, ...patch } : current))
                  }
                  onSubmit={handleSubmit}
                  onCancel={closeForm}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {form !== null && editingId === null && (
        <VariantForm
          form={form}
          isSaving={isSaving}
          onChange={(patch) =>
            setForm((current) => (current ? { ...current, ...patch } : current))
          }
          onSubmit={handleSubmit}
          onCancel={closeForm}
        />
      )}

      {!(form !== null && editingId === null) && (
        <button
          type="button"
          className="button button--secondary button--full"
          onClick={startAdd}
        >
          + Add Variant
        </button>
      )}

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title="Delete this variant?"
        message={
          pendingDelete
            ? `${pendingDelete.region} · ${pendingDelete.size} will be removed permanently.`
            : ''
        }
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}
