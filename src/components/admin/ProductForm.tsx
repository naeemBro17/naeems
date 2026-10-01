import { Modal } from '../shared/Modal';
import { ProductEditorForm } from './ProductEditorForm';
import { formatDhakaTime, type ProductEditInfo } from '../../lib/staff';
import type { Product } from '../../types';

interface ProductFormProps {
  isOpen: boolean;
  /** null = create mode; a product = edit mode. */
  product: Product | null;
  /** "Last updated by <username> · <time>" (Batch 24), shown at the top. */
  editInfo?: ProductEditInfo | null;
  onClose: () => void;
}

/**
 * /admin Products tab's editor — a Modal shell around the shared
 * ProductEditorForm (also used by the home grid card's Edit Product sheet;
 * see ProductEditSheet.tsx). Only the surrounding modal chrome lives here.
 */
export function ProductForm({ isOpen, product, editInfo, onClose }: ProductFormProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={product ? 'Edit Product' : 'Add Product'}
      fullScreenOnMobile
    >
      {product && editInfo && (
        <p className="admin-product-row__edited adm-editor-edited">
          Last updated by {editInfo.lastEditedBy} · {formatDhakaTime(editInfo.lastEditedAt)}
        </p>
      )}
      <ProductEditorForm
        product={product}
        onSaved={onClose}
        onCancel={onClose}
        footerVariant="modal"
      />
    </Modal>
  );
}
