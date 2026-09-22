import { useMemo, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { supabase } from '../../../lib/supabase';
import { useProducts } from '../../../contexts/ProductContext';
import { useToast } from '../../../hooks/useToast';
import { formatTaka } from '../../../lib/format';
import {
  distinctRegions,
  distinctSizes,
  emptyVariantForm,
  validateVariantForm,
  variantToForm,
} from '../../../lib/variants';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { AdminImagePicker } from '../AdminImagePicker';
import { GuidedField, PencilGlyph, RowIconButton, Toggle, TrashGlyph } from './SheetChrome';
import type { ProductVariant, VariantFormData } from '../../../types';

const VARIANT_NOTE_MAX_LENGTH = 200;

interface VariantEditorProps {
  productId: string;
}

const numberOrNull = (value: string): number | null =>
  value.trim() === '' ? null : Number(value);

function VariantForm({
  variantId,
  form,
  isSaving,
  knownRegions,
  knownSizes,
  onChange,
  onSubmit,
  onCancel,
}: {
  /** Stable id this variant will be saved under — a freshly generated one
   *  for a not-yet-saved row, kept for its lifetime — so its image can be
   *  uploaded to a fixed Storage path before the row itself is inserted. */
  variantId: string;
  form: VariantFormData;
  isSaving: boolean;
  /** Existing Region/Size values already used in the catalog, for the
   *  guided picker — see GuidedField. */
  knownRegions: string[];
  knownSizes: string[];
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
        <GuidedField
          id="vf-region"
          label="Region"
          required
          value={form.region}
          options={knownRegions}
          placeholder="AU"
          onChange={(region) => onChange({ region })}
        />
        <GuidedField
          id="vf-size"
          label="Size"
          required
          value={form.size}
          options={knownSizes}
          placeholder="340g"
          onChange={(size) => onChange({ size })}
        />
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

      <div className="form-field">
        <label className="form-label" htmlFor="vf-quantity">Stock Quantity</label>
        <input
          id="vf-quantity"
          type="number"
          min="0"
          step="1"
          inputMode="numeric"
          placeholder="Not tracked"
          className="form-input"
          value={form.stock_quantity}
          onChange={(e) => onChange({ stock_quantity: e.target.value })}
        />
        <p className="form-helper">
          Leave blank to use the In Stock toggle above instead of an exact count.
        </p>
      </div>

      <div className="form-field">
        <span className="form-label">Image (optional)</span>
        <AdminImagePicker
          path={`variants/${variantId}.webp`}
          value={form.image_url}
          onChange={(image_url) => onChange({ image_url })}
          shape="rect"
          label="Variant image"
          placeholderIcon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
          }
        />
        <p className="form-helper">
          With no image, this variant uses the product's own main image.
        </p>
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor="vf-note">Note (optional)</label>
        <textarea
          id="vf-note"
          className="form-input form-textarea"
          maxLength={VARIANT_NOTE_MAX_LENGTH}
          rows={2}
          placeholder="e.g. USA batch, slightly different box"
          value={form.note}
          onChange={(e) => onChange({ note: e.target.value })}
        />
        <p className="form-helper form-helper--counter">
          {form.note.length} / {VARIANT_NOTE_MAX_LENGTH}
        </p>
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
  const { products, variantsFor, allVariants, reloadVariants } = useProducts();
  const { showToast } = useToast();
  const variants = variantsFor(productId);

  const knownRegions = useMemo(() => distinctRegions(products, allVariants), [products, allVariants]);
  const knownSizes = useMemo(() => distinctSizes(products, allVariants), [products, allVariants]);

  const [form, setForm] = useState<VariantFormData | null>(null);
  /** Variant being edited, or null while adding a new one. */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Id a not-yet-saved variant will be inserted under — generated up front
   *  so its image can be uploaded to a fixed path before the row exists. */
  const [newVariantId, setNewVariantId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ProductVariant | null>(null);

  const startAdd = () => {
    setForm(emptyVariantForm());
    setEditingId(null);
    setNewVariantId(crypto.randomUUID());
  };

  const startEdit = (variant: ProductVariant) => {
    setForm(variantToForm(variant));
    setEditingId(variant.id);
  };

  const closeForm = () => {
    setForm(null);
    setEditingId(null);
    setNewVariantId(null);
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
      stock_quantity: numberOrNull(form.stock_quantity),
      image_url: form.image_url,
      note: form.note.trim() === '' ? null : form.note.trim(),
    };
    const { error } = editingId
      ? await supabase.from('product_variants').update(payload).eq('id', editingId)
      : await supabase
          .from('product_variants')
          .insert({ ...payload, id: newVariantId, sort_order: variants.length + 1 });
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
                  variantId={variant.id}
                  form={form}
                  isSaving={isSaving}
                  knownRegions={knownRegions}
                  knownSizes={knownSizes}
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

      {form !== null && editingId === null && newVariantId !== null && (
        <VariantForm
          variantId={newVariantId}
          form={form}
          isSaving={isSaving}
          knownRegions={knownRegions}
          knownSizes={knownSizes}
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
