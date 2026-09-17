import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { PROMO_CODE_ADMIN_SELECT, emptyPromoCodeForm, promoCodeToForm } from '../../lib/promoCodes';
import { useToast } from '../../hooks/useToast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { PromoCodeForm } from './PromoCodeForm';
import type { PromoCode, PromoCodeFormData } from '../../types';

function formatExpiry(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  return new Date(expiresAt).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function PromoCodesTab() {
  const { showToast } = useToast();

  const [codes, setCodes] = useState<PromoCode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState<PromoCodeFormData | null>(null);
  /** Row being edited, or null when the form is creating a new code. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PromoCode | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from('promo_codes')
      .select(PROMO_CODE_ADMIN_SELECT)
      .order('created_at', { ascending: false });
    setIsLoading(false);
    if (error) {
      console.error('Promo code load failed:', error);
      showToast('Could not load promo codes', 'error');
      return;
    }
    setCodes((data ?? []) as PromoCode[]);
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggleActive = async (code: PromoCode) => {
    const { error } = await supabase
      .from('promo_codes')
      .update({ active: !code.active })
      .eq('id', code.id);
    if (error) {
      console.error('Promo code update failed:', error);
      showToast('Could not update the code', 'error');
      return;
    }
    await load();
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    const { error } = await supabase.from('promo_codes').delete().eq('id', pendingDelete.id);
    setPendingDelete(null);
    if (error) {
      console.error('Promo code delete failed:', error);
      showToast('Could not delete the code', 'error');
      return;
    }
    showToast('Promo code deleted');
    await load();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setIsSaving(true);

    const maxUses = form.max_uses.trim() === '' ? null : Number.parseInt(form.max_uses, 10);
    const payload = {
      code: form.code.trim().toUpperCase(),
      discount_amount: Number.parseFloat(form.discount_amount) || 0,
      discount_type: form.discount_type,
      max_uses: maxUses !== null && Number.isFinite(maxUses) ? maxUses : null,
      expires_at: form.expires_at.trim() === '' ? null : new Date(form.expires_at).toISOString(),
      active: form.active,
    };

    const { error } = editingId
      ? await supabase.from('promo_codes').update(payload).eq('id', editingId)
      : await supabase.from('promo_codes').insert(payload);
    setIsSaving(false);

    if (error) {
      console.error('Promo code save failed:', error);
      showToast(
        error.code === '23505' ? 'That code already exists' : 'Could not save the code',
        'error'
      );
      return;
    }
    showToast(editingId ? 'Promo code updated' : 'Promo code added');
    setForm(null);
    setEditingId(null);
    await load();
  };

  const startCreate = () => {
    setForm(emptyPromoCodeForm());
    setEditingId(null);
  };

  return (
    <section aria-label="Promo codes">
      <header className="admin-section-header">
        <h2 className="admin-section-title">Promo Codes</h2>
        {form === null && (
          <button type="button" className="button button--primary" onClick={startCreate}>
            Add code
          </button>
        )}
      </header>

      {form !== null && (
        <div className="admin-panel">
          <PromoCodeForm
            form={form}
            title={editingId ? 'Edit Code' : 'New Code'}
            isSaving={isSaving}
            onChange={(patch) =>
              setForm((current) => (current ? { ...current, ...patch } : current))
            }
            onSubmit={handleSubmit}
            onCancel={() => {
              setForm(null);
              setEditingId(null);
            }}
          />
        </div>
      )}

      <div className="admin-panel">
        <h3 className="admin-panel__title">Codes</h3>
        <p className="admin-panel__description">
          Customers redeem these on the Order Summary screen. Usage only counts once an order is
          actually placed, not when the code is typed in.
        </p>

        {isLoading ? (
          <div className="full-screen-center">
            <span className="spinner spinner--large" aria-hidden="true" />
          </div>
        ) : codes.length === 0 ? (
          <p className="review-admin__empty">No promo codes yet.</p>
        ) : (
          <ul className="review-admin__list">
            {codes.map((code) => {
              const expiry = formatExpiry(code.expires_at);
              const isExpired = code.expires_at !== null && new Date(code.expires_at) <= new Date();
              return (
                <li key={code.id} className="review-admin__row">
                  <div className="review-admin__info">
                    <span className="review-admin__name">
                      {code.code}
                      {!code.active && (
                        <span className="status-badge status-badge--inactive">Inactive</span>
                      )}
                      {isExpired && (
                        <span className="status-badge status-badge--inactive">Expired</span>
                      )}
                    </span>
                    <span className="review-admin__quote">
                      {code.discount_type === 'percent'
                        ? `${code.discount_amount}% off`
                        : `৳${code.discount_amount} off`}
                      {' — '}
                      {code.times_used} / {code.max_uses ?? '∞'} used
                    </span>
                    {expiry && <span className="review-admin__country">Expires {expiry}</span>}
                  </div>

                  <div className="review-admin__actions">
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() => void handleToggleActive(code)}
                    >
                      {code.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() => {
                        setForm(promoCodeToForm(code));
                        setEditingId(code.id);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="button button--danger-outline button--small"
                      onClick={() => setPendingDelete(code)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title="Delete promo code?"
        message={pendingDelete ? `"${pendingDelete.code}" will be permanently removed.` : ''}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onClose={() => setPendingDelete(null)}
      />
    </section>
  );
}
