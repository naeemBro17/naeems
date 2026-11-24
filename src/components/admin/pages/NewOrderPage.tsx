import { useCallback, useState } from 'react';
import { AdminFormPage } from '../AdminFormPage';
import { NewOrderForm, type NewOrderFormState } from '../NewOrderForm';
import { formatTaka } from '../../../lib/format';
import { itemsWord } from '../../../lib/newOrderLook';

const FORM_ID = 'new-order-form';

interface NewOrderPageProps {
  onBack: () => void;
  /** After saving: open the new order (its detail on the Orders list). */
  onCreated: (orderId: string) => void | Promise<void>;
}

/** Batch 32 Part 3: /admin/orders/new. Batch 63: on a computer Create order
 *  sits in the Delivery and payment card (not the top bar); on a phone the
 *  bottom bar shows "Total · N items" and the total beside it. */
export function NewOrderPage({ onBack, onCreated }: NewOrderPageProps) {
  const [state, setState] = useState<NewOrderFormState>({ canSave: false, isSaving: false, itemCount: 0, total: 0 });
  const onState = useCallback((next: NewOrderFormState) => setState(next), []);
  return (
    <AdminFormPage
      title="New order"
      backLabel="Back to orders"
      onBack={onBack}
      testId="new-order-page"
      className="nord-page"
      headerPrimary={false}
      dockLead={
        <div className="nord-dock-lead" data-testid="nord-dock-lead">
          <span>Total · {itemsWord(state.itemCount)}</span>
          <b>{formatTaka(state.total)}</b>
        </div>
      }
      primary={{ label: 'Create order', formId: FORM_ID, disabled: !state.canSave, busy: state.isSaving }}
    >
      <NewOrderForm formId={FORM_ID} onState={onState} onCreated={onCreated} />
    </AdminFormPage>
  );
}
