import { useCallback, useEffect, useState } from 'react';
import { AdminFormPage } from '../AdminFormPage';
import { LOADING_TEXT_LABEL, ProductEditorForm, type ProductFormState } from '../ProductEditorForm';
import { useProducts } from '../../../contexts/ProductContext';
import { fetchProductEditInfo, formatDhakaTime, type ProductEditInfo } from '../../../lib/staff';
import type { Product } from '../../../types';

const FORM_ID = 'product-form';

interface ProductEditPageProps {
  /** null = Add product. */
  productId: string | null;
  onBack: () => void;
  /** After saving: back to the products list. */
  onDone: () => void;
}

/** Batch 32 Part 3: /admin/products/new and /admin/products/:id/edit — the
 *  same product editor the Products tab always used, as a page. */
export function ProductEditPage({ productId, onBack, onDone }: ProductEditPageProps) {
  const { products, isLoading } = useProducts();
  // The product as it was when the page opened. The editor starts a fresh
  // form whenever its product changes, so a later refresh of the product
  // list must never swap it under the person typing.
  const [product, setProduct] = useState<Product | null>(null);
  const [editInfo, setEditInfo] = useState<ProductEditInfo | null>(null);
  const [state, setState] = useState<ProductFormState>({ canSave: false, isSaving: false, loadingText: true });
  const onState = useCallback((next: ProductFormState) => setState(next), []);

  useEffect(() => {
    if (productId === null || product !== null) return;
    const found = products.find((p) => p.id === productId);
    if (found) setProduct(found);
  }, [productId, product, products]);

  useEffect(() => {
    if (productId === null) return;
    let alive = true;
    void fetchProductEditInfo().then((map) => {
      if (alive) setEditInfo(map.get(productId) ?? null);
    });
    return () => {
      alive = false;
    };
  }, [productId]);

  const isNew = productId === null;
  const missing = !isNew && product === null && !isLoading;
  const ready = isNew || product !== null;

  return (
    <AdminFormPage
      title={isNew ? 'Add product' : 'Edit product'}
      subtitle={
        product && editInfo ? `Last updated by ${editInfo.lastEditedBy} · ${formatDhakaTime(editInfo.lastEditedAt)}` : undefined
      }
      backLabel="Back to products"
      onBack={onBack}
      testId="product-page"
      primary={
        ready
          ? { label: state.loadingText ? LOADING_TEXT_LABEL : isNew ? 'Add product' : 'Save changes', formId: FORM_ID, disabled: !state.canSave, busy: state.isSaving }
          : undefined
      }
    >
      {!ready && !missing && (
        <div className="adm-fpage__notice" role="status" aria-label="Loading">
          <span className="spinner spinner--large" aria-hidden="true" />
        </div>
      )}
      {missing && <p className="adm-fpage__notice">This product was not found. It may have been deleted.</p>}
      {ready && (
        <ProductEditorForm
          product={product}
          onSaved={onDone}
          onCancel={onBack}
          footerVariant="page"
          formId={FORM_ID}
          onState={onState}
        />
      )}
    </AdminFormPage>
  );
}
