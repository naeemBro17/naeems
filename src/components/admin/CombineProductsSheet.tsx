import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useProducts, PRODUCT_SELECT, PRODUCTS_VIEW } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { formatTaka } from '../../lib/format';
import { coverImage, productImages } from '../../lib/productImages';
import { isOutOfStock } from '../../lib/stockStatus';
import { nextSku } from '../../lib/sku';
import { uniqueProductSlug } from '../../lib/slugify';
import { Modal } from '../shared/Modal';
import type { Product } from '../../types';

interface CombineProductsSheetProps {
  isOpen: boolean;
  /** The products selected in the list, in the order they were picked. */
  products: Product[];
  onClose: () => void;
  /** Fired once the combined product exists, with the fresh row from
   *  the refetched catalog — the caller opens its editor with it. */
  onCombined: (newProduct: Product) => void;
}

interface LabelDraft {
  region: string;
  size: string;
}

function emptyLabel(product: Product): LabelDraft {
  return { region: product.region ?? '', size: product.size ?? '' };
}

/**
 * Confirmation screen for turning 2+ existing, independently-created products
 * into one product with variants — for catalogue entries that predate the
 * variant system and are really just size/region versions of each other.
 *
 * Nothing is ever deleted here: a brand-new product row is created as the
 * container, and every originally-selected product (including the one whose
 * content/price becomes the container's own base) is only switched to
 * Active = OFF. See Naeems.txt "PART 7" for the full reasoning, including why
 * the content-source product's own data becomes the container's base fields
 * directly rather than a separate variant row (it avoids an extra option
 * nobody selected).
 */
export function CombineProductsSheet({
  isOpen,
  products,
  onClose,
  onCombined,
}: CombineProductsSheetProps) {
  const { refetch } = useProducts();
  const { showToast } = useToast();

  const [contentSourceId, setContentSourceId] = useState<string>('');
  const [combinedName, setCombinedName] = useState('');
  const [labels, setLabels] = useState<Record<string, LabelDraft>>({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen || products.length === 0) return;
    const first = products[0];
    setContentSourceId(first.id);
    setCombinedName(first.name);
    setLabels(Object.fromEntries(products.map((p) => [p.id, emptyLabel(p)])));
  }, [isOpen, products]);

  const patchLabel = (productId: string, patch: Partial<LabelDraft>) =>
    setLabels((current) => ({ ...current, [productId]: { ...current[productId], ...patch } }));

  const contentSource = products.find((p) => p.id === contentSourceId) ?? products[0] ?? null;
  const others = products.filter((p) => p.id !== contentSourceId);

  // Every product that will become a REAL variant row needs both halves of
  // the label — product_variants.region/size are NOT NULL in the database.
  // The content-source product's own label is optional (Part 5's state 2/3
  // rule already handles a blank one gracefully).
  const missingLabel = others.some((p) => {
    const l = labels[p.id];
    return !l || l.region.trim() === '' || l.size.trim() === '';
  });
  const canSubmit = combinedName.trim() !== '' && contentSource !== null && !missingLabel;

  const handleConfirm = async () => {
    if (!contentSource || !canSubmit) return;
    setIsSaving(true);

    const name = combinedName.trim();
    const sourceLabel = labels[contentSource.id] ?? emptyLabel(contentSource);
    const slug = await uniqueProductSlug(supabase, name);
    const categoryName = contentSource.category?.name ?? null;
    const sku = await nextSku(supabase, categoryName);

    const { data: inserted, error: insertError } = await supabase
      .from('products')
      .insert({
        sku,
        name,
        slug,
        brand: contentSource.brand,
        description: contentSource.description,
        how_to_use: contentSource.how_to_use,
        key_ingredients: contentSource.key_ingredients,
        youtube_url: contentSource.youtube_url,
        category_id: contentSource.category_id,
        skin_types: contentSource.skin_types ?? [],
        skin_conditions: contentSource.skin_conditions ?? [],
        retail_price: contentSource.retail_price,
        offer_price: contentSource.offer_price,
        wholesale_price: contentSource.wholesale_price,
        stock_status: contentSource.stock_status,
        stock_quantity: contentSource.stock_quantity,
        note: contentSource.note,
        // Uppercased so the base option's Region can never mismatch a
        // variant row's case-normalized one — see Naeems.txt "duplicate
        // variant display" fix.
        region: sourceLabel.region.trim() === '' ? null : sourceLabel.region.trim().toUpperCase(),
        size: sourceLabel.size.trim() === '' ? null : sourceLabel.size.trim(),
        image_urls: productImages(contentSource),
        image_url: coverImage(contentSource),
        // Lets deleting this combined product later know to reactivate the
        // content-source original too — see Naeems.txt "PART 2" (batch 5).
        combined_from_product_id: contentSource.id,
        is_featured: false,
        is_active: true,
      })
      .select('id')
      .single();

    if (insertError || !inserted) {
      console.error('Combine: creating the combined product failed:', insertError);
      setIsSaving(false);
      showToast('Could not create the combined product', 'error');
      return;
    }

    const newProductId = inserted.id as string;

    const variantRows = others.map((p, index) => {
      const label = labels[p.id] ?? emptyLabel(p);
      return {
        product_id: newProductId,
        region: label.region.trim().toUpperCase(),
        size: label.size.trim(),
        retail_price: p.retail_price,
        offer_price: p.offer_price,
        wholesale_price: p.wholesale_price,
        in_stock: !isOutOfStock(p),
        stock_quantity: p.stock_quantity,
        image_url: coverImage(p),
        note: p.note,
        // See combined_from_product_id above — the same reactivate-on-delete
        // mechanism, for a variant row instead of the container itself.
        source_product_id: p.id,
        sort_order: index,
      };
    });

    if (variantRows.length > 0) {
      const { error: variantError } = await supabase.from('product_variants').insert(variantRows);
      if (variantError) {
        console.error('Combine: creating variant rows failed:', variantError);
        setIsSaving(false);
        showToast(
          'Combined product was created, but adding its variants failed — check it in the product list',
          'error'
        );
        await refetch();
        return;
      }
    }

    // Nothing is ever deleted — every originally-selected product (including
    // the content source) just stops being shown to customers.
    const { error: deactivateError } = await supabase
      .from('products')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .in(
        'id',
        products.map((p) => p.id)
      );
    if (deactivateError) {
      console.error('Combine: deactivating the source products failed:', deactivateError);
      showToast(
        'Combined product was created, but the original products could not be hidden — deactivate them by hand',
        'error'
      );
    }

    await refetch();
    setIsSaving(false);
    showToast('Products combined');

    // Reads go through products_view, never the base table directly — the
    // base table's wholesale_price column has no SELECT grant at all, so a
    // plain '*' against it 42501s (silently, from here, since it's the same
    // shape of error Supabase returns for "no such row").
    const { data: freshProduct, error: freshError } = await supabase
      .from(PRODUCTS_VIEW)
      .select(PRODUCT_SELECT)
      .eq('id', newProductId)
      .single();
    if (freshError || !freshProduct) {
      console.error('Combine: re-fetching the combined product failed:', freshError);
      onClose();
      return;
    }
    onCombined(freshProduct as Product);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Combine into Variants" fullScreenOnMobile>
      <div className="form">
        <p className="form-helper">
          Turns the selected products into variants of one combined product.
          Nothing is deleted — the originals are switched to Active = OFF and
          stay in the product list.
        </p>

        <div className="form-field">
          <label className="form-label" htmlFor="cp-name">
            Combined Product Name <span className="form-required" aria-hidden="true">*</span>
          </label>
          <input
            id="cp-name"
            type="text"
            className="form-input"
            value={combinedName}
            onChange={(e) => setCombinedName(e.target.value)}
          />
        </div>

        <div className="form-field">
          <span className="form-label">Shared content comes from</span>
          <p className="form-helper">
            Description, How to Use, Key Ingredients, Video, Category, Skin
            Type and Skin Condition are copied from whichever product you
            pick here. The others become selectable variants under it.
          </p>
        </div>

        <ul className="combine-product-list">
          {products.map((product) => {
            const isSource = product.id === contentSourceId;
            const label = labels[product.id] ?? emptyLabel(product);
            return (
              <li key={product.id} className="combine-product-row">
                <label className="combine-product-row__pick">
                  <input
                    type="radio"
                    name="cp-content-source"
                    checked={isSource}
                    onChange={() => setContentSourceId(product.id)}
                  />
                </label>

                <div className="combine-product-row__thumb-wrap">
                  {coverImage(product) ? (
                    <img
                      src={coverImage(product) ?? ''}
                      alt={product.name}
                      className="combine-product-row__thumb"
                    />
                  ) : (
                    <div className="combine-product-row__thumb-placeholder" aria-hidden="true" />
                  )}
                </div>

                <div className="combine-product-row__info">
                  <p className="combine-product-row__name">{product.name}</p>
                  <p className="combine-product-row__price">{formatTaka(product.retail_price)}</p>
                  {isSource && <p className="combine-product-row__source-note">Shared content source</p>}
                </div>

                <div className="combine-product-row__labels">
                  <input
                    type="text"
                    className="form-input combine-product-row__label-input"
                    placeholder="Region"
                    value={label.region}
                    onChange={(e) => patchLabel(product.id, { region: e.target.value })}
                    aria-label={`Region for ${product.name}`}
                  />
                  <input
                    type="text"
                    className="form-input combine-product-row__label-input"
                    placeholder="Size"
                    value={label.size}
                    onChange={(e) => patchLabel(product.id, { size: e.target.value })}
                    aria-label={`Size for ${product.name}`}
                  />
                </div>
                {!isSource && (label.region.trim() === '' || label.size.trim() === '') && (
                  <p className="form-error combine-product-row__error">
                    Region and Size are both required for a variant.
                  </p>
                )}
              </li>
            );
          })}
        </ul>

        <div className="edit-sheet__footer">
          <button type="button" className="edit-sheet__cancel" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={handleConfirm}
            disabled={isSaving || !canSubmit}
          >
            {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Combine into Variants'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
