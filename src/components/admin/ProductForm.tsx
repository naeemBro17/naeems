import { useEffect, useState, type FormEvent } from 'react';
import {
  supabase,
  STORAGE_BUCKET,
  newProductImagePath,
  storagePathFromUrl,
} from '../../lib/supabase';
import { resizeImage } from '../../lib/imageResize';
import { slugify } from '../../lib/format';
import { productImages } from '../../lib/productImages';
import { useProducts, PRODUCTS_VIEW } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { Modal } from '../shared/Modal';
import { ImageUploader } from './ImageUploader';
import type { Product, ProductFormData, FormImage } from '../../types';

interface ProductFormProps {
  isOpen: boolean;
  /** null = create mode; a product = edit mode. */
  product: Product | null;
  onClose: () => void;
}

const NOTE_MAX_LENGTH = 200;
const CREATE_CATEGORY_VALUE = '__create__';

type FieldName =
  | 'sku'
  | 'name'
  | 'retail_price'
  | 'offer_price'
  | 'wholesale_price'
  | 'stock_quantity';
type FieldErrors = Partial<Record<FieldName, string>>;

function emptyForm(): ProductFormData {
  return {
    sku: '',
    name: '',
    brand: '',
    description: '',
    category_id: '',
    retail_price: '',
    offer_price: '',
    wholesale_price: '',
    stock_status: 'in_stock',
    stock_quantity: '',
    note: '',
    is_featured: false,
    is_active: true,
  };
}

let nextImageKey = 0;

function existingImages(product: Product | null): FormImage[] {
  if (!product) return [];
  return productImages(product).map((url) => ({
    id: `existing-${nextImageKey++}`,
    url,
    file: null,
  }));
}

function formFromProduct(product: Product): ProductFormData {
  return {
    sku: product.sku,
    name: product.name,
    brand: product.brand ?? '',
    description: product.description ?? '',
    category_id: product.category_id ?? '',
    retail_price: String(product.retail_price),
    offer_price: product.offer_price !== null ? String(product.offer_price) : '',
    wholesale_price:
      product.wholesale_price !== null ? String(product.wholesale_price) : '',
    stock_status: product.stock_status,
    stock_quantity:
      product.stock_quantity !== null ? String(product.stock_quantity) : '',
    note: product.note ?? '',
    is_featured: product.is_featured,
    is_active: product.is_active,
  };
}

function validate(form: ProductFormData): FieldErrors {
  const errors: FieldErrors = {};
  if (form.sku.trim() === '') {
    errors.sku = 'SKU is required';
  }
  if (form.name.trim() === '') {
    errors.name = 'Product name is required';
  }
  if (form.retail_price.trim() === '') {
    errors.retail_price = 'Retail price is required';
  } else {
    const price = Number(form.retail_price);
    if (Number.isNaN(price) || price < 0) {
      errors.retail_price = 'Enter a valid price of 0 or more';
    }
  }
  if (form.offer_price.trim() !== '') {
    const offer = Number(form.offer_price);
    const retail = Number(form.retail_price);
    if (Number.isNaN(offer) || offer < 0) {
      errors.offer_price = 'Enter a valid price of 0 or more';
    } else if (
      form.retail_price.trim() !== '' &&
      !Number.isNaN(retail) &&
      offer >= retail
    ) {
      errors.offer_price = 'Offer price must be lower than retail price';
    }
  }
  if (form.wholesale_price.trim() !== '') {
    const price = Number(form.wholesale_price);
    if (Number.isNaN(price) || price < 0) {
      errors.wholesale_price = 'Enter a valid price of 0 or more';
    }
  }
  if (form.stock_quantity.trim() !== '') {
    const qty = Number(form.stock_quantity);
    if (!Number.isInteger(qty) || qty < 0) {
      errors.stock_quantity = 'Enter a whole number of 0 or more';
    }
  }
  return errors;
}

export function ProductForm({ isOpen, product, onClose }: ProductFormProps) {
  const { categories, refetch } = useProducts();
  const { showToast } = useToast();

  const [form, setForm] = useState<ProductFormData>(emptyForm());
  const [images, setImages] = useState<FormImage[]>([]);
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [skuTakenError, setSkuTakenError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [isSavingCategory, setIsSavingCategory] = useState(false);

  // Reset everything when the form opens (create or edit).
  useEffect(() => {
    if (!isOpen) return;
    setForm(product ? formFromProduct(product) : emptyForm());
    setImages(existingImages(product));
    setTouched({});
    setSkuTakenError(null);
    setUploadError(null);
    setShowNewCategory(false);
    setNewCategoryName('');
  }, [isOpen, product]);

  const errors = validate(form);
  const hasBlockingErrors =
    Object.keys(errors).length > 0 || skuTakenError !== null;

  const setField = <K extends keyof ProductFormData>(
    field: K,
    value: ProductFormData[K]
  ) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const markTouched = (field: FieldName) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
  };

  const fieldError = (field: FieldName): string | null =>
    touched[field] && errors[field] ? errors[field] ?? null : null;

  const checkSkuUniqueness = async () => {
    markTouched('sku');
    const sku = form.sku.trim();
    setSkuTakenError(null);
    if (sku === '' || (product && sku === product.sku)) return;
    const { data, error } = await supabase
      .from(PRODUCTS_VIEW)
      .select('id')
      .eq('sku', sku)
      .limit(1);
    if (!error && data && data.length > 0 && data[0].id !== product?.id) {
      setSkuTakenError('This SKU is already in use');
    }
  };

  const handleCategoryChange = (value: string) => {
    if (value === CREATE_CATEGORY_VALUE) {
      setShowNewCategory(true);
      return;
    }
    setField('category_id', value);
  };

  const handleSaveNewCategory = async () => {
    const name = newCategoryName.trim();
    if (name === '') return;
    setIsSavingCategory(true);
    const { data, error } = await supabase
      .from('categories')
      .insert({ name, slug: slugify(name) })
      .select()
      .single();
    setIsSavingCategory(false);
    if (error || !data) {
      showToast('Could not create category — the name may already exist', 'error');
      return;
    }
    await refetch();
    setField('category_id', data.id as string);
    setShowNewCategory(false);
    setNewCategoryName('');
    showToast(`Category '${name}' created`);
  };

  /**
   * Resolve the final image_urls, in display order:
   * - pending files → resize + upload each to products/{uuid}.webp
   * - existing images removed from the form → delete their stored files
   * Storage paths are random (SKU-independent), so SKU changes need no moves.
   * Throws on upload failure; removals are best-effort.
   */
  const resolveImageUrls = async (): Promise<string[]> => {
    const keptUrls = new Set(
      images.filter((img) => img.url !== null).map((img) => img.url as string)
    );
    const removedPaths = product
      ? productImages(product)
          .filter((url) => !keptUrls.has(url))
          .map(storagePathFromUrl)
          .filter((path): path is string => path !== null)
      : [];

    const hasNewFiles = images.some((img) => img.file !== null);
    if (hasNewFiles) setIsUploadingImage(true);
    try {
      const urls: string[] = [];
      for (const image of images) {
        if (image.url !== null) {
          urls.push(image.url);
          continue;
        }
        if (!image.file) continue;
        const blob = await resizeImage(image.file);
        const path = newProductImagePath();
        const { error } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(path, blob, { contentType: 'image/webp' });
        if (error) throw error;
        const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
        urls.push(data.publicUrl);
      }

      if (removedPaths.length > 0) {
        // Best-effort: an orphaned file must not block saving the product.
        await supabase.storage
          .from(STORAGE_BUCKET)
          .remove(removedPaths)
          .catch(() => undefined);
      }

      return urls;
    } finally {
      if (hasNewFiles) setIsUploadingImage(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched({
      sku: true,
      name: true,
      retail_price: true,
      offer_price: true,
      wholesale_price: true,
      stock_quantity: true,
    });
    if (hasBlockingErrors) return;

    setIsSaving(true);
    setUploadError(null);
    const finalSku = form.sku.trim();

    let imageUrls: string[];
    try {
      imageUrls = await resolveImageUrls();
    } catch {
      setUploadError('Upload failed. Please try again.');
      setIsSaving(false);
      return;
    }

    const payload = {
      sku: finalSku,
      name: form.name.trim(),
      brand: form.brand.trim() === '' ? null : form.brand.trim(),
      description: form.description.trim() === '' ? null : form.description.trim(),
      category_id: form.category_id === '' ? null : form.category_id,
      retail_price: Number(form.retail_price),
      offer_price: form.offer_price.trim() === '' ? null : Number(form.offer_price),
      wholesale_price:
        form.wholesale_price.trim() === '' ? null : Number(form.wholesale_price),
      stock_status: form.stock_status,
      stock_quantity:
        form.stock_quantity.trim() === '' ? null : Number(form.stock_quantity),
      note: form.note.trim() === '' ? null : form.note.trim(),
      is_featured: form.is_featured,
      image_urls: imageUrls,
      image_url: imageUrls[0] ?? null,
      is_active: form.is_active,
    };

    const result = product
      ? await supabase
          .from('products')
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq('id', product.id)
      : await supabase.from('products').insert(payload);

    setIsSaving(false);
    if (result.error) {
      showToast('Could not save the product. Please try again.', 'error');
      return;
    }

    await refetch();
    showToast(product ? 'Product updated' : 'Product added');
    onClose();
  };

  const requiredEmpty =
    form.sku.trim() === '' ||
    form.name.trim() === '' ||
    form.retail_price.trim() === '';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={product ? 'Edit Product' : 'Add Product'}
      fullScreenOnMobile
    >
      <form onSubmit={handleSubmit} className="form" noValidate>
        <div className="form-field">
          <label className="form-label" htmlFor="pf-sku">
            SKU <span className="form-required" aria-hidden="true">*</span>
          </label>
          <input
            id="pf-sku"
            type="text"
            className={`form-input${fieldError('sku') || skuTakenError ? ' form-input--error' : ''}`}
            value={form.sku}
            onChange={(e) => {
              setField('sku', e.target.value);
              setSkuTakenError(null);
            }}
            onBlur={checkSkuUniqueness}
            required
            aria-required="true"
          />
          {(fieldError('sku') || skuTakenError) && (
            <p className="form-error" role="alert">
              {skuTakenError ?? fieldError('sku')}
            </p>
          )}
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="pf-name">
            Product Name <span className="form-required" aria-hidden="true">*</span>
          </label>
          <input
            id="pf-name"
            type="text"
            className={`form-input${fieldError('name') ? ' form-input--error' : ''}`}
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
            onBlur={() => markTouched('name')}
            required
            aria-required="true"
          />
          {fieldError('name') && (
            <p className="form-error" role="alert">
              {fieldError('name')}
            </p>
          )}
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="pf-brand">
            Brand
          </label>
          <input
            id="pf-brand"
            type="text"
            className="form-input"
            placeholder="e.g. CeraVe — shown above the product name"
            value={form.brand}
            onChange={(e) => setField('brand', e.target.value)}
          />
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="pf-description">
            Description
          </label>
          <textarea
            id="pf-description"
            className="form-input form-textarea"
            rows={4}
            placeholder="What makes this product worth buying — ingredients, benefits, how to use, etc."
            value={form.description}
            onChange={(e) => setField('description', e.target.value)}
          />
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="pf-category">
            Category
          </label>
          <select
            id="pf-category"
            className="form-input form-select"
            value={form.category_id}
            onChange={(e) => handleCategoryChange(e.target.value)}
          >
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value={CREATE_CATEGORY_VALUE}>+ Create new category</option>
          </select>
          {showNewCategory && (
            <div className="inline-mini-form">
              <input
                type="text"
                className="form-input"
                placeholder="New category name"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                aria-label="New category name"
              />
              <button
                type="button"
                className="button button--primary button--small"
                onClick={handleSaveNewCategory}
                disabled={isSavingCategory || newCategoryName.trim() === ''}
              >
                {isSavingCategory ? <span className="spinner" aria-hidden="true" /> : 'Save'}
              </button>
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => {
                  setShowNewCategory(false);
                  setNewCategoryName('');
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        <div className="form-row">
          <div className="form-field">
            <label className="form-label" htmlFor="pf-retail">
              Retail Price ৳ <span className="form-required" aria-hidden="true">*</span>
            </label>
            <div className="form-input-prefix-wrap">
              <span className="form-input-prefix" aria-hidden="true">৳</span>
              <input
                id="pf-retail"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                className={`form-input form-input--prefixed${fieldError('retail_price') ? ' form-input--error' : ''}`}
                value={form.retail_price}
                onChange={(e) => setField('retail_price', e.target.value)}
                onBlur={() => markTouched('retail_price')}
                required
                aria-required="true"
              />
            </div>
            {fieldError('retail_price') && (
              <p className="form-error" role="alert">
                {fieldError('retail_price')}
              </p>
            )}
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pf-wholesale">
              Wholesale Price ৳
            </label>
            <div className="form-input-prefix-wrap">
              <span className="form-input-prefix" aria-hidden="true">৳</span>
              <input
                id="pf-wholesale"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                className={`form-input form-input--prefixed${fieldError('wholesale_price') ? ' form-input--error' : ''}`}
                value={form.wholesale_price}
                onChange={(e) => setField('wholesale_price', e.target.value)}
                onBlur={() => markTouched('wholesale_price')}
              />
            </div>
            {fieldError('wholesale_price') && (
              <p className="form-error" role="alert">
                {fieldError('wholesale_price')}
              </p>
            )}
          </div>
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="pf-offer">
            Offer Price ৳ (optional)
          </label>
          <div className="form-input-prefix-wrap">
            <span className="form-input-prefix" aria-hidden="true">৳</span>
            <input
              id="pf-offer"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              className={`form-input form-input--prefixed${fieldError('offer_price') ? ' form-input--error' : ''}`}
              value={form.offer_price}
              onChange={(e) => setField('offer_price', e.target.value)}
              onBlur={() => markTouched('offer_price')}
            />
          </div>
          <p className="form-helper">
            Leave blank for no offer. Must be lower than the retail price.
          </p>
          {fieldError('offer_price') && (
            <p className="form-error" role="alert">
              {fieldError('offer_price')}
            </p>
          )}
        </div>

        <div className="form-row">
          <div className="form-field">
            <label className="form-label" htmlFor="pf-stock-status">
              Stock Status <span className="form-required" aria-hidden="true">*</span>
            </label>
            <select
              id="pf-stock-status"
              className="form-input form-select"
              value={form.stock_status}
              onChange={(e) =>
                setField('stock_status', e.target.value as ProductFormData['stock_status'])
              }
            >
              <option value="in_stock">In Stock</option>
              <option value="low_stock">Low Stock</option>
              <option value="out_of_stock">Out of Stock</option>
            </select>
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pf-quantity">
              Stock Quantity
            </label>
            <input
              id="pf-quantity"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              placeholder="e.g. 25"
              className={`form-input${fieldError('stock_quantity') ? ' form-input--error' : ''}`}
              value={form.stock_quantity}
              onChange={(e) => setField('stock_quantity', e.target.value)}
              onBlur={() => markTouched('stock_quantity')}
            />
            <p className="form-helper">Leave blank if not tracking exact quantity</p>
            {fieldError('stock_quantity') && (
              <p className="form-error" role="alert">
                {fieldError('stock_quantity')}
              </p>
            )}
          </div>
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="pf-note">
            Note
          </label>
          <textarea
            id="pf-note"
            className="form-input form-textarea"
            maxLength={NOTE_MAX_LENGTH}
            rows={3}
            value={form.note}
            onChange={(e) => setField('note', e.target.value)}
          />
          <p className="form-helper form-helper--counter">
            {form.note.length} / {NOTE_MAX_LENGTH}
          </p>
        </div>

        <div className="form-field">
          <span className="form-label">Product Images</span>
          <ImageUploader
            images={images}
            onAddFiles={(files) => {
              setUploadError(null);
              setImages((prev) => [
                ...prev,
                ...files.map((file) => ({
                  id: `new-${nextImageKey++}`,
                  url: null,
                  file,
                })),
              ]);
            }}
            onRemove={(id) => {
              setImages((prev) => prev.filter((img) => img.id !== id));
            }}
            isUploading={isUploadingImage}
            uploadError={uploadError}
          />
        </div>

        <div className="form-field form-field--toggle">
          <label className="toggle-label" htmlFor="pf-featured">
            Feature on homepage
          </label>
          <button
            id="pf-featured"
            type="button"
            role="switch"
            aria-checked={form.is_featured}
            className={`toggle${form.is_featured ? ' toggle--on' : ''}`}
            onClick={() => setField('is_featured', !form.is_featured)}
          >
            <span className="toggle__thumb" aria-hidden="true" />
          </button>
        </div>

        <div className="form-field form-field--toggle">
          <label className="toggle-label" htmlFor="pf-active">
            Active (visible to viewers)
          </label>
          <button
            id="pf-active"
            type="button"
            role="switch"
            aria-checked={form.is_active}
            className={`toggle${form.is_active ? ' toggle--on' : ''}`}
            onClick={() => setField('is_active', !form.is_active)}
          >
            <span className="toggle__thumb" aria-hidden="true" />
          </button>
        </div>

        <button
          type="submit"
          className="button button--primary button--full"
          disabled={isSaving || requiredEmpty || hasBlockingErrors}
        >
          {isSaving ? (
            <span className="spinner" aria-hidden="true" />
          ) : product ? (
            'Save Changes'
          ) : (
            'Add Product'
          )}
        </button>
      </form>
    </Modal>
  );
}
