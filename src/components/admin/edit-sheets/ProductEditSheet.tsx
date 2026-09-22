import { useAdminEdit } from '../../../contexts/AdminEditContext';
import { BottomSheet } from '../../shared/BottomSheet';
import { ProductEditorForm } from '../ProductEditorForm';

/**
 * Full product editor opened from a card's "..." menu while Edit Mode is on.
 * Mounted once (in ViewerPage) and driven by AdminEditContext, so 100+ cards
 * don't each carry a form. Only the surrounding sheet chrome lives here —
 * the fields, validation and save all live in the shared ProductEditorForm,
 * the same component the /admin Products tab uses (see ProductForm.tsx).
 */
export function ProductEditSheet() {
  const { editingProduct, closeProductEdit } = useAdminEdit();
  const isOpen = editingProduct !== null;

  return (
    <BottomSheet isOpen={isOpen} onClose={closeProductEdit} title="Edit Product">
      {editingProduct && (
        <ProductEditorForm
          product={editingProduct}
          onSaved={closeProductEdit}
          onCancel={closeProductEdit}
          footerVariant="sheet"
        />
      )}
    </BottomSheet>
  );
}
