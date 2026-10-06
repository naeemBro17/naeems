import { useCallback, useState } from 'react';
import { AdminFormPage } from '../AdminFormPage';
import { NewOrderForm } from '../NewOrderForm';

const FORM_ID = 'new-order-form';

interface NewOrderPageProps {
  onBack: () => void;
  /** After saving: open the new order (its detail on the Orders list). */
  onCreated: (orderId: string) => void | Promise<void>;
}

/** Batch 32 Part 3: /admin/orders/new. */
export function NewOrderPage({ onBack, onCreated }: NewOrderPageProps) {
  const [state, setState] = useState({ canSave: false, isSaving: false });
  const onState = useCallback((next: { canSave: boolean; isSaving: boolean }) => setState(next), []);
  return (
    <AdminFormPage
      title="New order"
      backLabel="Back to orders"
      onBack={onBack}
      testId="new-order-page"
      primary={{ label: 'Create order', formId: FORM_ID, disabled: !state.canSave, busy: state.isSaving }}
    >
      <NewOrderForm formId={FORM_ID} onState={onState} onCreated={onCreated} />
    </AdminFormPage>
  );
}
