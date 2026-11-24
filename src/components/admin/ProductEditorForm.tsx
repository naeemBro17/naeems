import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { MoneyInput } from '../shared/MoneyInput';
import { supabase, STORAGE_BUCKET, storagePathFromUrl, productCardPath, smallCopyPath } from '../../lib/supabase';
import { slugify } from '../../lib/format';
import { uniqueProductSlug } from '../../lib/slugify';
import { nextSku } from '../../lib/sku';
import { statusFromQuantity } from '../../lib/stockStatus';
import { productImages, generateCardThumb, isSmallCopy, uploadProductPhoto } from '../../lib/productImages';
import { sanitizeSkinValues, SKIN_CONDITIONS, SKIN_TYPES } from '../../lib/skinFields';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { distinctRegions } from '../../lib/variants';
import { ImageUploader } from './ImageUploader';
import { RichTextField } from './RichTextField';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { LONG_TEXTS, cleanLongText, emptiedLongTexts } from '../../lib/richText';
import { ChipGroup, GuidedField, SheetFooter, Toggle } from './edit-sheets/SheetChrome';
import { VariantEditor } from './edit-sheets/VariantEditor';
import { RemoveStockPanel } from './money/RemoveStockPanel';
import { PackSizePanel } from './inventory/PackSizePanel';
import { PickerSheet } from '../shared/PickerSheet';
import { RichTextView } from '../shared/RichTextView';
import { useStockUnitsMap } from './PackStockLine';
import { useLeaveGuard } from './LeaveGuard';
import { packKey } from '../../lib/inventory/api';
import { lotsStockText, packWord } from '../../lib/inventory/unitText';
import { useNavigate } from 'react-router-dom';
import type { Product, ProductFormData, FormImage } from '../../types';

interface ProductEditorFormProps {
  /** null = create mode; a product = edit mode. */
  product: Product | null;
  /** Called after a successful save, with the product's id. */
  onSaved: (productId: string) => void;
  onCancel: () => void;
  /**
   * 'sheet' renders the Cancel/Save footer used by every other bottom
   * sheet in the app (card "..." → Edit Product). 'modal' renders the
   * single full-width button the /admin Products tab has always used —
   * its Modal already has its own close (X) button, so a second Cancel
   * control would be redundant there.
   */
  footerVariant: 'sheet' | 'modal' | 'page';
  /** 'page' (Batch 32): the page's own Save button submits this form by id. */
  formId?: string;
  /** 'page': tells the page whether its Save button can be pressed. */
  onState?: (state: ProductFormState) => void;
}

export interface ProductFormState {
  canSave: boolean;
  isSaving: boolean;
  /** The long texts' editors are still opening — Save waits for them. */
  loadingText: boolean;
}

export const LOADING_TEXT_LABEL = 'Loading text…';

const NOTE_MAX_LENGTH = 200;
const CREATE_CATEGORY_VALUE = '__create__';
/** Retries when a concurrent insert claims the generated SKU first. */
const SKU_ATTEMPTS = 5;
/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

type FieldName =
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
    how_to_use: '',
    key_ingredients: '',
    youtube_url: '',
    category_id: '',
    retail_price: '',
    offer_price: '',
    wholesale_price: '',
    stock_status: 'in_stock',
    stock_quantity: '',
    note: '',
    region: '',
    size: '',
    is_featured: false,
    is_active: true,
    skin_types: [],
    skin_conditions: [],
    keep_selling: true,
  };
}

let nextImageKey = 0;

function existingImages(product: Product | null): FormImage[] {
  if (!product) return [];
  const thumbs = product.image_urls_thumb ?? [];
  return productImages(product).map((url, i) => ({
    id: `existing-${nextImageKey++}`,
    url,
    file: null,
    thumbUrl: isSmallCopy(url, thumbs[i]) ? thumbs[i] : null,
  }));
}

function formFromProduct(product: Product): ProductFormData {
  return {
    sku: product.sku,
    name: product.name,
    brand: product.brand ?? '',
    description: product.description ?? '',
    how_to_use: product.how_to_use ?? '',
    key_ingredients: product.key_ingredients ?? '',
    youtube_url: product.youtube_url ?? '',
    category_id: product.category_id ?? '',
    retail_price: String(product.retail_price),
    offer_price: product.offer_price !== null ? String(product.offer_price) : '',
    wholesale_price:
      product.wholesale_price !== null ? String(product.wholesale_price) : '',
    stock_status: product.stock_status,
    stock_quantity:
      product.stock_quantity !== null ? String(product.stock_quantity) : '',
    note: product.note ?? '',
    region: product.region ?? '',
    size: product.size ?? '',
    is_featured: product.is_featured,
    is_active: product.is_active,
    skin_types: sanitizeSkinValues(product.skin_types, SKIN_TYPES),
    skin_conditions: sanitizeSkinValues(product.skin_conditions, SKIN_CONDITIONS),
    keep_selling: product.keep_selling !== false,
  };
}

function validate(form: ProductFormData): FieldErrors {
  const errors: FieldErrors = {};
  if (form.name.trim() === '') {
    errors.name = 'Product name is required';
  }
  if (form.retail_price.trim() === '') {
    errors.retail_price = 'Retail price is required';
  } else {
    const price = Number(form.retail_price);
    if (Number.isNaN(price) || price < 0) {
      errors.retail_price = 'Enter a valid price of 0 or more';
    } else if (price === 0 && form.is_active) {
      // Batch 50: the database refuses this too (products_no_free_show).
      errors.retail_price = 'Set a price before showing this product.';
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

/**
 * The one product editor, shared by the /admin Products tab and the home
 * grid card's "..." → Edit Product sheet. Owns every field, image upload,
 * validation and the save itself, so a field added here reaches both entry
 * points automatically instead of needing to be copied by hand.
 */
export function ProductEditorForm({ product, onSaved, onCancel, footerVariant, formId, onState }: ProductEditorFormProps) {
  const { categories, products, allVariants, brands, refetch, settings } = useProducts();
  // Batch 39: while Inventory mode is On the stock number comes from lots.
  const stockFromLots = settings.inventory_mode === 'true';
  const brandNames = useMemo(() => brands.map((b) => b.name).sort((a, b) => a.localeCompare(b)), [brands]);
  const { showToast } = useToast();
  const knownRegions = useMemo(() => distinctRegions(products, allVariants), [products, allVariants]);

  const [form, setForm] = useState<ProductFormData>(emptyForm());
  const [images, setImages] = useState<FormImage[]>([]);
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [isSavingCategory, setIsSavingCategory] = useState(false);
  // Fix (rich-text editor) Part 1: Save waits until every long-text editor
  // shows the product's text, and asks before wiping one.
  const [readyTexts, setReadyTexts] = useState<ReadonlySet<string>>(() => new Set());
  const markTextReady = useCallback(
    (id: string) => setReadyTexts((prev) => (prev.has(id) ? prev : new Set(prev).add(id))),
    []
  );
  const loadingText = readyTexts.size < LONG_TEXTS.length;
  const [emptiedConfirm, setEmptiedConfirm] = useState<string[] | null>(null);
  // The long texts as last saved — the page stays open after Save (Fix
  // Part 3), so the "delete this text?" check compares with these.
  // Batch 62: which long text's tab is open, the Brand picker (phones) and
  // whether this is a touch screen (the brand list there is a picker sheet).
  const [activeText, setActiveText] = useState<(typeof LONG_TEXTS)[number]['key']>('description');
  const [brandPickerOpen, setBrandPickerOpen] = useState(false);
  const coarsePointer = useCoarsePointer();
  const navigate = useNavigate();
  const { requestLeave } = useLeaveGuard();
  const [savedTexts, setSavedTexts] = useState<Pick<Product, 'description' | 'how_to_use' | 'key_ingredients'> | null>(product);

  // A fresh form for whichever product this instance was mounted to edit
  // (or a blank one in create mode).
  useEffect(() => {
    setForm(product ? formFromProduct(product) : emptyForm());
    setImages(existingImages(product));
    setSavedTexts(product);
    setTouched({});
    setUploadError(null);
    setShowNewCategory(false);
    setNewCategoryName('');
  }, [product]);

  // Batch 51: the switch shows (and is saved) once migration-052 has
  // added products.keep_selling — products_view then returns it.
  const keepSellingReady = products.some((p) => p.keep_selling !== undefined);

  const errors = validate(form);
  const hasBlockingErrors = Object.keys(errors).length > 0;

  // Availability follows the quantity whenever one is entered; the manual
  // select only applies to products whose exact count isn't tracked.
  const derivedStatus = statusFromQuantity(form.stock_quantity, form.stock_status);
  const quantityDrivesStatus = form.stock_quantity.trim() !== '';

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
   * Resolve the final image_urls (and their small "card" counterparts, see
   * Batch 19), in display order:
   * - pending files → resize + upload each to products/{uuid}.webp (large,
   *   1400 px), plus a small card version at products/card/{uuid}.webp
   *   (480 px) — Batch 40: new names, kept by phones for a year
   * - kept existing images → reuse their existing thumb if this product
   *   already had one at the same URL, otherwise backfill one now (a
   *   pre-Batch-19 image being kept for the first time since)
   * - existing images removed from the form → delete their stored files
   *   (full + its small copies)
   * Storage paths are random (SKU-independent), so SKU changes need no moves.
   * Throws on upload failure; removals are best-effort.
   */
  const resolveImageUrls = async (): Promise<{ urls: string[]; thumbUrls: string[] }> => {
    const keptUrls = new Set(
      images.filter((img) => img.url !== null).map((img) => img.url as string)
    );
    const removedFullPaths = product
      ? productImages(product)
          .filter((url) => !keptUrls.has(url))
          .map(storagePathFromUrl)
          .filter((path): path is string => path !== null)
      : [];
    const removedPaths = removedFullPaths.flatMap((path) => [path, smallCopyPath(path, 'thumb'), productCardPath(path)]);

    // Existing product's own full URL -> thumb URL, so a kept image (order
    // may have changed) still finds its own thumb by URL, not by index.
    const existingThumbByUrl = new Map<string, string>();
    if (product) {
      const fullList = productImages(product);
      const thumbList = product.image_urls_thumb ?? [];
      fullList.forEach((url, i) => {
        // Batch 31 Part 8: only a real small copy is reused; the full photo
        // saved in the small slot (older failed copies) is made again.
        if (isSmallCopy(url, thumbList[i])) existingThumbByUrl.set(url, thumbList[i]);
      });
    }

    // Also true when a kept image still needs its thumb backfilled — that
    // does real network work (fetch + resize + upload) even though no new
    // file was chosen, and the admin should see the same spinner for it.
    const hasNewFiles = images.some(
      (img) => img.file !== null || (img.url !== null && !existingThumbByUrl.has(img.url))
    );
    if (hasNewFiles) setIsUploadingImage(true);
    try {
      const urls: string[] = [];
      const thumbUrls: string[] = [];
      for (const image of images) {
        if (image.url !== null) {
          urls.push(image.url);
          thumbUrls.push(
            existingThumbByUrl.get(image.url) ?? (await generateCardThumb(image.url))
          );
          continue;
        }
        if (!image.file) continue;
        const uploaded = await uploadProductPhoto(image.file);
        urls.push(uploaded.url);
        thumbUrls.push(uploaded.cardUrl);
      }

      if (removedPaths.length > 0) {
        // Best-effort: an orphaned file must not block saving the product.
        await supabase.storage
          .from(STORAGE_BUCKET)
          .remove(removedPaths)
          .catch(() => undefined);
      }

      return { urls, thumbUrls };
    } finally {
      if (hasNewFiles) setIsUploadingImage(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (loadingText) return;
    setTouched({
      name: true,
      retail_price: true,
      offer_price: true,
      wholesale_price: true,
      stock_quantity: true,
    });
    if (hasBlockingErrors) return;
    const emptied = emptiedLongTexts(savedTexts, form);
    if (emptied.length > 0) {
      setEmptiedConfirm(emptied);
      return;
    }
    void save();
  };

  const save = async () => {
    setIsSaving(true);
    setUploadError(null);

    let imageUrls: string[];
    let imageThumbUrls: string[];
    try {
      ({ urls: imageUrls, thumbUrls: imageThumbUrls } = await resolveImageUrls());
    } catch {
      setUploadError('Upload failed. Please try again.');
      setIsSaving(false);
      return;
    }

    const name = form.name.trim();
    // Slug follows the name, so renaming a product updates its URL. Skipped
    // when the name hasn't changed to avoid an unnecessary uniqueness query.
    const slug =
      product && name === product.name && product.slug
        ? product.slug
        : await uniqueProductSlug(supabase, name, product?.id);

    const payload = {
      name,
      slug,
      brand: form.brand.trim() === '' ? null : form.brand.trim(),
      // Batch 36 Part 2: rich text is cleaned (allow-list) again on save.
      description: cleanLongText(form.description),
      how_to_use: cleanLongText(form.how_to_use),
      key_ingredients: cleanLongText(form.key_ingredients),
      youtube_url: form.youtube_url.trim() === '' ? null : form.youtube_url.trim(),
      category_id: form.category_id === '' ? null : form.category_id,
      retail_price: Number(form.retail_price),
      offer_price: form.offer_price.trim() === '' ? null : Number(form.offer_price),
      wholesale_price:
        form.wholesale_price.trim() === '' ? null : Number(form.wholesale_price),
      // Derived, never set independently — a quantity of 0 forces out_of_stock.
      stock_status: derivedStatus,
      stock_quantity:
        form.stock_quantity.trim() === '' ? null : Number(form.stock_quantity),
      note: form.note.trim() === '' ? null : form.note.trim(),
      // Uppercased so it can never mismatch a real variant row's own Region
      // (VariantEditor uppercases the same way) — a case difference between
      // this product's own base option and one of its variants is exactly
      // what made the two look like duplicate options. See Naeems.txt.
      region: form.region.trim() === '' ? null : form.region.trim().toUpperCase(),
      size: form.size.trim() === '' ? null : form.size.trim(),
      is_featured: form.is_featured,
      skin_types: form.skin_types,
      skin_conditions: form.skin_conditions,
      image_urls: imageUrls,
      image_urls_thumb: imageThumbUrls,
      image_url: imageUrls[0] ?? null,
      is_active: form.is_active,
      // Batch 51: only once migration-052 has added the column.
      ...(keepSellingReady ? { keep_selling: form.keep_selling } : {}),
    };

    let result: { error: { code?: string } | null };
    let savedId: string | null = product?.id ?? null;
    if (product) {
      result = await supabase
        .from('products')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', product.id);
    } else {
      // SKU is generated here, never typed. A concurrent insert can claim the
      // same number, so a unique-violation is retried with a fresh one.
      const categoryName =
        categories.find((c) => c.id === form.category_id)?.name ?? null;
      result = { error: null } as { error: { code?: string } | null };
      for (let attempt = 0; attempt < SKU_ATTEMPTS; attempt += 1) {
        const sku = await nextSku(supabase, categoryName);
        const inserted = await supabase.from('products').insert({ ...payload, sku }).select('id').single();
        result = inserted;
        savedId = inserted.data?.id ?? null;
        if (!result.error || result.error.code !== UNIQUE_VIOLATION) break;
      }
    }

    setIsSaving(false);
    if (result.error) {
      showToast('Could not save the product. Please try again.', 'error');
      return;
    }

    // The photos are now saved addresses: a second Save must not upload
    // the same files again.
    setImages(
      imageUrls.map((url, i) => ({
        id: `existing-${nextImageKey++}`,
        url,
        file: null,
        thumbUrl: isSmallCopy(url, imageThumbUrls[i]) ? imageThumbUrls[i] : null,
      }))
    );
    setSavedTexts({ description: payload.description, how_to_use: payload.how_to_use, key_ingredients: payload.key_ingredients });

    await refetch();
    showToast(footerVariant === 'page' ? 'Saved ✓' : product ? 'Product updated' : 'Product added');
    if (savedId) onSaved(savedId);
  };

  const requiredEmpty =
    form.name.trim() === '' || form.retail_price.trim() === '';

  const canSave = !isSaving && !requiredEmpty && !hasBlockingErrors && !loadingText;
  useEffect(() => {
    onState?.({ canSave, isSaving, loadingText });
  }, [canSave, isSaving, loadingText, onState]);
  const saveLabel = loadingText ? LOADING_TEXT_LABEL : product ? 'Save Changes' : 'Add Product';

  // Batch 62: Edit product reorganised (approved mockup). One column on a
  // phone in the order Product, Photos, Price, Shop, Variants, Stock,
  // Product page text, More details. On the Edit product page at 1024 px
  // and wider: two columns, most-used on top (admin.css). No field was
  // removed and saving is unchanged.
  const textTab = LONG_TEXTS.find((t) => t.key === activeText) ?? LONG_TEXTS[0];
  const previewTitle = activeText === 'description' ? 'About this product' : activeText === 'how_to_use' ? 'How to use' : 'Key ingredients';
  const previewValue = form[activeText];

  return (
    <form id={formId} onSubmit={handleSubmit} className="form pform pform-grid" noValidate>
      <FormSection id="basics" title="Product">
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

        <div className="form-row pform__row pform__row--wide">
          <div className="form-field">
            <label className="form-label" htmlFor="pf-brand">
              Brand
            </label>
            <div className={coarsePointer ? 'pform-brand pform-brand--pick' : 'pform-brand'}>
              <input
                id="pf-brand"
                type="text"
                className="form-input"
                placeholder="e.g. CeraVe — shown above the product name"
                value={form.brand}
                onChange={(e) => setField('brand', e.target.value)}
                list={coarsePointer ? undefined : 'pf-brand-options'}
                autoComplete="off"
              />
              {coarsePointer && brandNames.length > 0 && (
                <button
                  type="button"
                  className="button button--secondary pform-brand__pick"
                  onClick={() => setBrandPickerOpen(true)}
                  data-testid="pf-brand-pick"
                >
                  Choose
                </button>
              )}
            </div>
            {!coarsePointer && (
              <datalist id="pf-brand-options">
                {brandNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            )}
            <p className="form-helper">
              Pick a brand from the list. A new name makes a new brand (set its logo in Brands).
            </p>
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
        </div>

        {product && (
          <div className="form-field">
            <div className="form-row pform__row">
              <GuidedField
                id="pf-region"
                label="Region"
                value={form.region}
                options={knownRegions}
                placeholder="e.g. AU"
                onChange={(region) => setField('region', region)}
              />
              <div className="form-field">
                <label className="form-label" htmlFor="pf-size">Size</label>
                <input
                  id="pf-size"
                  type="text"
                  className="form-input"
                  placeholder="e.g. 50 ml"
                  value={form.size}
                  onChange={(e) => setField('size', e.target.value)}
                />
              </div>
            </div>
            <p className="form-helper">
              Optional label for this product itself. With no variants added
              below, it just shows as text on the detail page (no selector).
              Once you add a real variant, this product's own price/stock
              becomes the first selectable option under this label.
            </p>
          </div>
        )}
      </FormSection>

      <FormSection id="photos" title="Photos" className="pform-full">
        <div className="form-field">
          <span className="form-label visually-hidden">Product Images</span>
          <ImageUploader
            layout="tiles"
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
            onReorder={setImages}
            isUploading={isUploadingImage}
            uploadError={uploadError}
          />
        </div>
      </FormSection>

      <FormSection id="price" title="Price">
        <div className="pform__row pform__row--3 pform-price">
          <div className="form-field">
            <label className="form-label" htmlFor="pf-retail">
              Retail ৳ <span className="form-required" aria-hidden="true">*</span>
            </label>
            <MoneyInput
              id="pf-retail"
              min="0"
              step="0.01"
              className={fieldError('retail_price') ? 'form-input--error' : undefined}
              value={form.retail_price}
              onChange={(e) => setField('retail_price', e.target.value)}
              onBlur={() => markTouched('retail_price')}
              required
              aria-required="true"
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pf-offer">
              Offer ৳
            </label>
            <MoneyInput
              id="pf-offer"
              min="0"
              step="0.01"
              className={fieldError('offer_price') ? 'form-input--error' : undefined}
              value={form.offer_price}
              onChange={(e) => setField('offer_price', e.target.value)}
              onBlur={() => markTouched('offer_price')}
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="pf-wholesale">
              Wholesale ৳
            </label>
            <MoneyInput
              id="pf-wholesale"
              min="0"
              step="0.01"
              className={fieldError('wholesale_price') ? 'form-input--error' : undefined}
              value={form.wholesale_price}
              onChange={(e) => setField('wholesale_price', e.target.value)}
              onBlur={() => markTouched('wholesale_price')}
            />
          </div>
        </div>
        <p className="form-helper pform-price__help">Leave offer blank for no offer.</p>
        {(['retail_price', 'offer_price', 'wholesale_price'] as const).map((field) =>
          fieldError(field) ? (
            <p key={field} className="form-error" role="alert">
              {fieldError(field)}
            </p>
          ) : null
        )}
      </FormSection>

      <FormSection id="shop" title="Shop">
        <div className="pform-switch">
          <span className="pform-switch__text">
            <span className="toggle-label">Active</span>
            <span className="form-helper">Visible in the shop</span>
          </span>
          <Toggle checked={form.is_active} onChange={(is_active) => setField('is_active', is_active)} label="Active" />
        </div>
        {form.is_active && form.retail_price.trim() !== '' && Number(form.retail_price) === 0 && (
          <p className="form-error" role="alert" data-testid="product-no-price">
            Set a price before showing this product.
          </p>
        )}
        {keepSellingReady && (
          <div className="pform-switch">
            <span className="pform-switch__text">
              <span className="toggle-label">Keep selling when out of stock</span>
              <span className="form-helper" data-testid="keep-selling-hint">
                Customers can order at stock 0. You buy it after the order.
              </span>
            </span>
            <Toggle
              checked={form.keep_selling}
              onChange={(keep_selling) => setField('keep_selling', keep_selling)}
              label="Keep selling when out of stock"
            />
          </div>
        )}
        <div className="pform-switch">
          <span className="pform-switch__text">
            <span className="toggle-label">Featured</span>
            <span className="form-helper">Shown in the bento grid on Home</span>
          </span>
          <Toggle checked={form.is_featured} onChange={(is_featured) => setField('is_featured', is_featured)} label="Featured" />
        </div>
      </FormSection>

      {/* Variants only make sense for a product that already exists —
          a newly-created one has no id to attach them to yet. */}
      {product && (
        <FormSection id="variants" title="Variants">
          <VariantEditor productId={product.id} showLabel={false} />
        </FormSection>
      )}

      <FormSection id="stock" title="Stock">
        {stockFromLots && product ? (
          <LotsStock product={product} />
        ) : (
          <div className="form-row pform__row">
            <div className="form-field">
              <label className="form-label" htmlFor="pf-stock-status">
                Stock Status <span className="form-required" aria-hidden="true">*</span>
              </label>
              <select
                id="pf-stock-status"
                className="form-input form-select"
                value={derivedStatus}
                disabled={quantityDrivesStatus || stockFromLots}
                onChange={(e) =>
                  setField('stock_status', e.target.value as ProductFormData['stock_status'])
                }
              >
                <option value="in_stock">In Stock</option>
                <option value="low_stock">Low Stock</option>
                <option value="out_of_stock">Out of Stock</option>
              </select>
              <p className="form-helper">
                {quantityDrivesStatus
                  ? 'Set automatically from the stock quantity.'
                  : 'Used only while no exact quantity is tracked.'}
              </p>
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
                disabled={stockFromLots}
                onChange={(e) => setField('stock_quantity', e.target.value)}
                onBlur={() => markTouched('stock_quantity')}
              />
              <p className="form-helper">
                {stockFromLots
                  ? 'Inventory mode is On: the stock number comes from lots (whole packs). Add a lot to change it.'
                  : 'Leave blank if not tracking exact quantity'}
              </p>
              {fieldError('stock_quantity') && (
                <p className="form-error" role="alert">
                  {fieldError('stock_quantity')}
                </p>
              )}
            </div>
          </div>
        )}

        {product && <PackSizePanel productId={product.id} />}
        {product && stockFromLots && (
          <div className="inv-actions pform-stock__actions">
            <button type="button" className="adm-btn" onClick={() => requestLeave(() => navigate(addLotPath(product.id)))} data-testid="pf-add-lot">
              + Add a lot
            </button>
          </div>
        )}
        {/* Batch 41 Part 5. */}
        {product && <RemoveStockPanel productId={product.id} />}
      </FormSection>

      {/* Batch 36 Part 2: the three long texts use the Word-like editor.
          Batch 62: tabs above one editor; all three stay mounted (hidden),
          so each is ready and all three still save. */}
      <FormSection id="details" title="Product page text" className="pform-full">
        <div className="pform-text">
          <div className="pform-text__edit">
            <div className="pform-tabs" role="tablist" aria-label="Product page text">
              {LONG_TEXTS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  id={`${t.id}-tab`}
                  aria-selected={activeText === t.key}
                  aria-controls={`${t.id}-panel`}
                  className={`pform-tab${activeText === t.key ? ' pform-tab--on' : ''}`}
                  onClick={() => setActiveText(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {LONG_TEXTS.map((t) => (
              <div
                key={t.key}
                role="tabpanel"
                id={`${t.id}-panel`}
                aria-labelledby={`${t.id}-tab`}
                hidden={activeText !== t.key}
                className="pform-text__panel"
              >
                <RichTextField
                  id={t.id}
                  resetKey={product?.id ?? 'new'}
                  onReady={markTextReady}
                  label={t.label}
                  value={form[t.key]}
                  onChange={(html) => setField(t.key, html)}
                  placeholder={TEXT_PLACEHOLDERS[t.key]}
                  helper={
                    t.key === 'description'
                      ? 'Shown on the detail page under "About this product".'
                      : 'Detail-page accordion. Leave blank to hide the section.'
                  }
                />
              </div>
            ))}

            <div className="form-field">
              <label className="form-label" htmlFor="pf-youtube">
                Video review (YouTube link)
              </label>
              <input
                id="pf-youtube"
                type="url"
                className="form-input"
                placeholder="https://youtube.com/watch?v=…"
                value={form.youtube_url}
                onChange={(e) => setField('youtube_url', e.target.value)}
              />
              <p className="form-helper">
                Detail-page accordion. Leave blank to hide the section.
              </p>
            </div>
          </div>

          <aside className="pform-preview" aria-label={`Phone preview: ${textTab.label}`} data-testid="pf-preview">
            <div className="pform-preview__screen">
              <div className="accordion">
                <div className="accordion__item accordion__item--open">
                  <div className="accordion__header pform-preview__header">
                    <span className="accordion__title">{previewTitle}</span>
                  </div>
                  <div className="accordion__body">
                    <div className="accordion__content">
                      {previewValue.trim() === '' ? (
                        <p className="accordion__text pform-preview__empty">Nothing written yet.</p>
                      ) : (
                        <RichTextView value={previewValue} testId="pf-preview-text" />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </FormSection>

      <div className="pform-more" role="separator" aria-label="More details">
        MORE DETAILS
      </div>

      <FormSection id="search" title="For search and filters">
        <ChipGroup
          label="Skin Type (optional)"
          options={SKIN_TYPES}
          selected={form.skin_types}
          onChange={(skin_types) => setField('skin_types', skin_types)}
        />

        <ChipGroup
          label="Skin Condition (optional)"
          options={SKIN_CONDITIONS}
          selected={form.skin_conditions}
          onChange={(skin_conditions) => setField('skin_conditions', skin_conditions)}
        />
      </FormSection>

      <FormSection id="reference" title="Note and reference">
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
        {product && (
          <div className="form-field">
            <span className="form-label">SKU</span>
            <p className="form-readonly">{product.sku}</p>
            <p className="form-helper">
              Generated automatically and kept for reference. Not shown to viewers.
            </p>
          </div>
        )}
      </FormSection>

      {footerVariant === 'sheet' ? (
        <div className="pform__footer pform-full">
          <SheetFooter
            onCancel={onCancel}
            isSaving={isSaving}
            disabled={requiredEmpty || hasBlockingErrors || loadingText}
            saveLabel={saveLabel}
          />
        </div>
      ) : footerVariant === 'page' ? null : (
        <button
          type="submit"
          className="button button--primary button--full pform__footer pform-full"
          disabled={isSaving || requiredEmpty || hasBlockingErrors || loadingText}
        >
          {isSaving ? <span className="spinner" aria-hidden="true" /> : saveLabel}
        </button>
      )}

      <PickerSheet
        isOpen={brandPickerOpen}
        onClose={() => setBrandPickerOpen(false)}
        title="Brand"
        options={brandNames.map((name) => ({ id: name, label: name }))}
        selectedId={brandNames.includes(form.brand.trim()) ? form.brand.trim() : null}
        onSelect={(option) => setField('brand', option.label)}
        searchPlaceholder="Search brands"
      />

      <ConfirmDialog
        isOpen={emptiedConfirm !== null}
        title="Delete this text?"
        message={`This will delete the ${(emptiedConfirm ?? []).join(' and ')} text. Save anyway?`}
        confirmLabel="Save"
        cancelLabel="Keep text"
        onClose={() => setEmptiedConfirm(null)}
        onConfirm={() => {
          setEmptiedConfirm(null);
          void save();
        }}
      />
    </form>
  );
}

const TEXT_PLACEHOLDERS: Record<(typeof LONG_TEXTS)[number]['key'], string> = {
  description: 'What makes this product worth buying — ingredients, benefits, how to use, etc.',
  how_to_use: 'Apply morning and night to clean, dry skin…',
  key_ingredients: 'Niacinamide 5%, Hyaluronic Acid, Ceramides…',
};

/** Batch 62: New lot with this product already added. */
function addLotPath(productId: string): string {
  return `/admin?tab=inventory&inv=new&add=${encodeURIComponent(productId)}`;
}

/** Batch 62: the Stock card while Inventory mode is On — whole packs in
 *  lots, and every unit for a pack of more than one ("2 bottles in lots
 *  (946 ml)"). Read from the lots ("View profit & costs"); without that
 *  permission the shop's own number (also whole packs in lots). */
function LotsStock({ product }: { product: Product }) {
  const { adminVariantsFor } = useProducts();
  const units = useStockUnitsMap();
  const options = adminVariantsFor(product.id);
  const rows = [
    { key: packKey(product.id, null), label: options.length > 0 ? [product.region, product.size].filter(Boolean).join(' · ') || 'This product' : null, stock: product.stock_quantity },
    ...options.map((v) => ({ key: packKey(product.id, v.id), label: [v.region, v.size].filter(Boolean).join(' · ') || 'Option', stock: v.stock_quantity })),
  ];
  const lines = rows.map((row) => {
    const unit = units.get(row.key);
    const shown = unit
      ? lotsStockText(unit.lot_pieces_left, unit.pack_size, unit.stock_unit)
      : { packs: Math.max(0, row.stock ?? 0), text: packWord(Math.max(0, row.stock ?? 0)) + ' in lots' };
    return { ...row, ...shown };
  });
  const total = lines.reduce((sum, l) => sum + l.packs, 0);
  return (
    <div className="pform-lots" data-testid="pf-lots-stock">
      {lines.length === 1 ? (
        <p className="pform-lots__big">
          <b>{lines[0].packs.toLocaleString('en-US')}</b> <span>{lines[0].text}</span>
        </p>
      ) : (
        <>
          <p className="pform-lots__big">
            <b>{total.toLocaleString('en-US')}</b> <span>{packWord(total)} in lots</span>
          </p>
          <ul className="pform-lots__list">
            {lines.map((l) => (
              <li key={l.key}>
                <span>{l.label}</span>
                <span>
                  {l.packs.toLocaleString('en-US')} {l.text}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="form-helper">Inventory mode is On: stock comes from lots. Add a lot to change it.</p>
    </div>
  );
}

/** Batch 62: a touch screen (no mouse): the datalist dropdown does not work
 *  there, so Brand opens the site's PickerSheet instead. */
function useCoarsePointer(): boolean {
  const query = '(pointer: coarse)';
  const [coarse, setCoarse] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const onChange = () => setCoarse(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return coarse;
}

/** Batch 52.1 Part 2: one titled group of fields. */
function FormSection({ id, title, className, children }: { id: string; title: string; className?: string; children: ReactNode }) {
  return (
    <section
      className={`pform__section pform__section--${id}${className ? ` ${className}` : ''}`}
      aria-labelledby={`pf-section-${id}`}
      data-testid={`pf-section-${id}`}
    >
      <h2 className="pform__heading" id={`pf-section-${id}`}>
        {title}
      </h2>
      <div className="pform__fields">{children}</div>
    </section>
  );
}
