import { Modal } from '../shared/Modal';
import { ProductEditorForm } from './ProductEditorForm';
import type { Product } from '../../types';

interface ProductFormProps {
  isOpen: boolean;
  /** null = create mode; a product = edit mode. */
  product: Product | null;
  onClose: () => void;
}

/**
 * /admin Products tab's editor — a Modal shell around the shared
 * ProductEditorForm (also used by the home grid card's Edit Product sheet;
 * see ProductEditSheet.tsx). Only the surrounding modal chrome lives here.
 */
export function ProductForm({ isOpen, product, onClose }: ProductFormProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={product ? 'Edit Product' : 'Add Product'}
      fullScreenOnMobile
    >
      <ProductEditorForm
        product={product}
        onSaved={onClose}
        onCancel={onClose}
        footerVariant="modal"
      />
    </Modal>
  );
}
