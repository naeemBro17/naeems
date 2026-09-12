import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../../lib/supabase';
import { useProducts } from '../../../contexts/ProductContext';
import { useAdminEdit } from '../../../contexts/AdminEditContext';
import { useToast } from '../../../hooks/useToast';
import { useReorder } from '../../../hooks/useReorder';
import { productImages } from '../../../lib/productImages';
import { statusFromQuantity } from '../../../lib/stockStatus';
import { uniqueProductSlug } from '../../../lib/slugify';
import { BottomSheet } from '../../shared/BottomSheet';
import {
  CloseGlyph,
  ReorderRow,
  RowIconButton,
  SheetFooter,
  Toggle,
} from './SheetChrome';
import type { Product } from '../../../types';

interface ProductDraft {
  name: string;
  brand: string;
  category_id: string;
  retail_price: string;
  offer_price: string;
  wholesale_price: string;
  stock_quantity: string;
  note: string;
  description: string;
  how_to_use: string;
  key_ingredients: string;
  youtube_url: string;
  is_featured: boolean;
  images: string[];
}

function draftFrom(product: Product): ProductDraft {
  return {
    name: product.name,
    brand: product.brand ?? '',
    category_id: product.category_id ?? '',
    retail_price: String(product.retail_price),
    offer_price: product.offer_price !== null ? String(product.offer_price) : '',
    wholesale_price:
      product.wholesale_price !== null && product.wholesale_price !== undefined
        ? String(product.wholesale_price)
        : '',
    stock_quantity: product.stock_quantity !== null ? String(product.stock_quantity) : '',
    note: product.note ?? '',
    description: product.description ?? '',
    how_to_use: product.how_to_use ?? '',
    key_ingredients: product.key_ingredients ?? '',
    youtube_url: product.youtube_url ?? '',
    is_featured: product.is_featured,
    images: productImages(product),
  };
}

const nullable = (value: string): string | null => (value.trim() === '' ? null : value.trim());
const numberOrNull = (value: string): number | null =>
  value.trim() === '' ? null : Number(value);

function validate(draft: ProductDraft): string | null {
  if (draft.name.trim() === '') return 'Product name is required';
  const retail = Number(draft.retail_price);
  if (draft.retail_price.trim() === '' || Number.isNaN(retail) || retail < 0) {
    return 'Enter a retail price of 0 or more';
  }
  if (draft.offer_price.trim() !== '') {
    const offer = Number(draft.offer_price);
    if (Number.isNaN(offer) || offer < 0) return 'Enter a valid offer price';
    if (offer >= retail) return 'Offer price must be lower than the retail price';
  }
  if (draft.wholesale_price.trim() !== '') {
    const wholesale = Number(draft.wholesale_price);
    if (Number.isNaN(wholesale) || wholesale < 0) return 'Enter a valid wholesale price';
  }
  if (draft.stock_quantity.trim() !== '') {
    const qty = Number(draft.stock_quantity);
    if (!Number.isInteger(qty) || qty < 0) return 'Stock count must be a whole number';
  }
  return null;
}

/**
 * Full product editor opened from a card's "..." menu while Edit Mode is on.
 * Mounted once (in ViewerPage) and driven by AdminEditContext, so 100+ cards
 * don't each carry a form. Saves pessimistically: the grid only changes after
 * Supabase confirms the update and the product list has been refetched.
 */
export function ProductEditSheet() {
  const { editingProduct, closeProductEdit } = useAdminEdit();
  const { categories, refetch } = useProducts();
  const { showToast } = useToast();

  const [draft, setDraft] = useState<ProductDraft | null>(null);
  const [newImageUrl, setNewImageUrl] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // A fresh draft for each product the sheet opens on.
  useEffect(() => {
    setDraft(editingProduct ? draftFrom(editingProduct) : null);
    setNewImageUrl('');
  }, [editingProduct]);

  const setImages = (images: string[]) =>
    setDraft((current) => (current ? { ...current, images } : current));
  const reorder = useReorder(draft?.images ?? [], setImages);

  const patch = (changes: Partial<ProductDraft>) =>
    setDraft((current) => (current ? { ...current, ...changes } : current));

  const isOpen = editingProduct !== null;

  const handleAddImage = () => {
    const url = newImageUrl.trim();
    if (url === '' || !draft) return;
    if (draft.images.includes(url)) {
      setNewImageUrl('');
      return;
    }
    setImages([...draft.images, url]);
    setNewImageUrl('');
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingProduct || !draft) return;
    const problem = validate(draft);
    if (problem) {
      showToast(problem, 'error');
      return;
    }

    setIsSaving(true);
    const name = draft.name.trim();
    const slug =
      name === editingProduct.name && editingProduct.slug
        ? editingProduct.slug
        : await uniqueProductSlug(supabase, name, editingProduct.id);

    const payload = {
      name,
      slug,
      brand: nullable(draft.brand),
      category_id: draft.category_id === '' ? null : draft.category_id,
      retail_price: Number(draft.retail_price),
      offer_price: numberOrNull(draft.offer_price),
      wholesale_price: numberOrNull(draft.wholesale_price),
      stock_quantity: numberOrNull(draft.stock_quantity),
      stock_status: statusFromQuantity(draft.stock_quantity, editingProduct.stock_status),
      note: nullable(draft.note),
      description: nullable(draft.description),
      how_to_use: nullable(draft.how_to_use),
      key_ingredients: nullable(draft.key_ingredients),
      youtube_url: nullable(draft.youtube_url),
      is_featured: draft.is_featured,
      image_urls: draft.images,
      image_url: draft.images[0] ?? null,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from('products').update(payload).eq('id', editingProduct.id);
    if (error) {
      console.error('Inline product save failed:', error);
      setIsSaving(false);
      showToast('Could not save the product', 'error');
      return;
    }
    await refetch();
    setIsSaving(false);
    showToast('Saved');
    closeProductEdit();
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={closeProductEdit} title="Edit Product">
      {draft && (
        <form className="form edit-sheet" onSubmit={handleSubmit} noValidate>
          <div className="form-field">
            <label className="form-label" htmlFor="pe-name">
              Product Name <span className="form-required" aria-hidden="true">*</span>
            </label>
            <input
              id="pe-name"
              type="text"
              className="form-input"
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              required
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pe-brand">Brand</label>
            <input
              id="pe-brand"
              type="text"
              className="form-input"
              value={draft.brand}
              onChange={(e) => patch({ brand: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pe-category">Category</label>
            <select
              id="pe-category"
              className="form-input form-select"
              value={draft.category_id}
              onChange={(e) => patch({ category_id: e.target.value })}
            >
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <div className="form-field">
              <label className="form-label" htmlFor="pe-retail">
                Retail ৳ <span className="form-required" aria-hidden="true">*</span>
              </label>
              <input
                id="pe-retail"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                className="form-input"
                value={draft.retail_price}
                onChange={(e) => patch({ retail_price: e.target.value })}
                required
              />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="pe-offer">Offer ৳</label>
              <input
                id="pe-offer"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                className="form-input"
                placeholder="None"
                value={draft.offer_price}
                onChange={(e) => patch({ offer_price: e.target.value })}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-field">
              <label className="form-label" htmlFor="pe-wholesale">Wholesale ৳</label>
              <input
                id="pe-wholesale"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                className="form-input"
                value={draft.wholesale_price}
                onChange={(e) => patch({ wholesale_price: e.target.value })}
              />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="pe-stock">Stock Count</label>
              <input
                id="pe-stock"
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                className="form-input"
                placeholder="Not tracked"
                value={draft.stock_quantity}
                onChange={(e) => patch({ stock_quantity: e.target.value })}
              />
            </div>
          </div>
          <p className="form-helper">
            A stock count of 0 marks the product Out of Stock everywhere.
          </p>

          <div className="form-field">
            <label className="form-label" htmlFor="pe-note">Note</label>
            <textarea
              id="pe-note"
              className="form-input form-textarea"
              rows={2}
              maxLength={200}
              value={draft.note}
              onChange={(e) => patch({ note: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pe-description">Description</label>
            <textarea
              id="pe-description"
              className="form-input form-textarea"
              rows={4}
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pe-how">How to Use</label>
            <textarea
              id="pe-how"
              className="form-input form-textarea"
              rows={3}
              value={draft.how_to_use}
              onChange={(e) => patch({ how_to_use: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pe-ingredients">Key Ingredients</label>
            <textarea
              id="pe-ingredients"
              className="form-input form-textarea"
              rows={3}
              value={draft.key_ingredients}
              onChange={(e) => patch({ key_ingredients: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pe-youtube">YouTube URL</label>
            <input
              id="pe-youtube"
              type="url"
              className="form-input"
              placeholder="https://youtube.com/watch?v=…"
              value={draft.youtube_url}
              onChange={(e) => patch({ youtube_url: e.target.value })}
            />
          </div>

          <div className="form-field form-field--toggle">
            <span className="toggle-label">Featured (shown in the bento grid)</span>
            <Toggle
              checked={draft.is_featured}
              onChange={(is_featured) => patch({ is_featured })}
              label="Featured"
            />
          </div>

          <div className="form-field">
            <span className="form-label">Images</span>
            {draft.images.length === 0 ? (
              <p className="edit-sheet__empty">No images yet.</p>
            ) : (
              <ul className="edit-list">
                {draft.images.map((url, index) => (
                  <ReorderRow
                    key={url}
                    index={index}
                    count={draft.images.length}
                    dragIndex={reorder.dragIndex}
                    onDragStart={reorder.setDragIndex}
                    onDragEnd={() => reorder.setDragIndex(null)}
                    onDrop={reorder.dropOn}
                    onMove={reorder.move}
                    label={`image ${index + 1}`}
                  >
                    <img className="edit-row__thumb" src={url} alt="" />
                    <span className="edit-row__text">
                      {index === 0 ? 'Cover image' : `Image ${index + 1}`}
                    </span>
                    <RowIconButton
                      label={`Remove image ${index + 1}`}
                      variant="danger"
                      onClick={() => setImages(draft.images.filter((u) => u !== url))}
                    >
                      <CloseGlyph />
                    </RowIconButton>
                  </ReorderRow>
                ))}
              </ul>
            )}
            <div className="inline-mini-form">
              <input
                type="url"
                className="form-input"
                placeholder="https://… image URL"
                value={newImageUrl}
                onChange={(e) => setNewImageUrl(e.target.value)}
                aria-label="New image URL"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddImage();
                  }
                }}
              />
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={handleAddImage}
                disabled={newImageUrl.trim() === ''}
              >
                + Add
              </button>
            </div>
          </div>

          <SheetFooter onCancel={closeProductEdit} isSaving={isSaving} />
        </form>
      )}
    </BottomSheet>
  );
}
