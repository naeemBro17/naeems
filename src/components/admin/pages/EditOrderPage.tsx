import { useCallback, useEffect, useState } from 'react';
import { AdminFormPage } from '../AdminFormPage';
import { EditOrderForm } from '../EditOrderForm';
import { useAuth } from '../../../contexts/AuthContext';
import { fetchAdminOrderDetail, fetchOrderIdByNumber } from '../../../lib/adminData';
import { fetchOrderPayments, type OrderPayment } from '../../../lib/payments';
import type { OrderWithDetails } from '../../../types';

const FORM_ID = 'edit-order-form';

interface EditOrderPageProps {
  orderNumber: string;
  onBack: () => void;
  /** After saving (or when nothing changed): back to the order. */
  onDone: (orderId: string) => void;
}

/** Batch 32 Part 3: /admin/orders/:orderNumber/edit. */
export function EditOrderPage({ orderNumber, onBack, onDone }: EditOrderPageProps) {
  const { isAdmin, can } = useAuth();
  const [order, setOrder] = useState<OrderWithDetails | null>(null);
  const [payments, setPayments] = useState<OrderPayment[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [state, setState] = useState({ canSave: false, isSaving: false });
  const onState = useCallback((next: { canSave: boolean; isSaving: boolean }) => setState(next), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const id = await fetchOrderIdByNumber(orderNumber);
      const [detail, pays] = id ? await Promise.all([fetchAdminOrderDetail(id), fetchOrderPayments(id)]) : [null, null];
      if (!alive) return;
      setOrder(detail);
      setPayments(pays);
      setStatus(detail ? 'ready' : 'missing');
    })();
    return () => {
      alive = false;
    };
  }, [orderNumber]);

  return (
    <AdminFormPage
      title={`Edit ${orderNumber}`}
      backLabel="Back to the order"
      onBack={onBack}
      testId="edit-order-page"
      primary={
        order ? { label: 'Save changes', formId: FORM_ID, disabled: !state.canSave, busy: state.isSaving } : undefined
      }
    >
      {status === 'loading' && (
        <div className="adm-fpage__notice" role="status" aria-label="Loading">
          <span className="spinner spinner--large" aria-hidden="true" />
        </div>
      )}
      {status === 'missing' && <p className="adm-fpage__notice">Order {orderNumber} was not found.</p>}
      {order && (
        <EditOrderForm
          order={order}
          isAdmin={isAdmin === true}
          formId={FORM_ID}
          onState={onState}
          payments={payments}
          canAddPayment={can('change_order_status')}
          onUnchanged={() => onDone(order.id)}
          onSaved={() => onDone(order.id)}
        />
      )}
    </AdminFormPage>
  );
}
