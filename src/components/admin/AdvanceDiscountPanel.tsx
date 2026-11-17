import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { advancePreview, type AdvanceDiscountType } from '../../lib/advanceDiscount';

/** Checks the typed value; null = fine. Percent 0–100 (0.5 is fine), a
 *  fixed amount whole taka. 0 is allowed: the offer then disappears. */
export function advanceValueError(type: AdvanceDiscountType, raw: string): string | null {
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return 'Enter a number (0 or more).';
  const value = Number(text);
  if (type === 'percent' && value > 100) return 'A percent can be at most 100.';
  if (type === 'fixed' && !Number.isInteger(value)) return 'Enter whole taka.';
  return null;
}

/**
 * Batch 48: Settings -> "Advance payment discount". Customers who pay in
 * advance with bKash or Nagad get this off their products (never off
 * delivery). Saved in app_settings, which only the Super Admin can write
 * (is_admin() in the database); place_order() reads the same rows, so the
 * customer is never charged by what the browser says.
 */
export function AdvanceDiscountPanel() {
  const { settings, refetch } = useProducts();
  const { isAdmin } = useAuth();
  const { showToast } = useToast();
  const ready = settings.advance_discount_type.trim() !== '';

  const [enabled, setEnabled] = useState(false);
  const [type, setType] = useState<AdvanceDiscountType>('percent');
  const [value, setValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setEnabled(settings.advance_discount_enabled === 'true');
    setType(settings.advance_discount_type === 'fixed' ? 'fixed' : 'percent');
    setValue(settings.advance_discount_value);
  }, [settings.advance_discount_enabled, settings.advance_discount_type, settings.advance_discount_value]);

  const error = advanceValueError(type, value);
  const canEdit = isAdmin && ready;

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!canEdit || error) return;
    setIsSaving(true);
    const { error: saveError } = await supabase.from('app_settings').upsert(
      [
        { key: 'advance_discount_enabled', value: enabled ? 'true' : 'false' },
        { key: 'advance_discount_type', value: type },
        { key: 'advance_discount_value', value: String(Number(value.trim())) },
      ],
      { onConflict: 'key' }
    );
    setIsSaving(false);
    if (saveError) {
      console.error('Advance discount save failed:', saveError);
      showToast('Could not save. Please try again.', 'error');
      return;
    }
    await refetch();
    showToast('Saved');
  };

  return (
    <div className="admin-panel" data-testid="advance-discount-card">
      <h3 className="admin-panel__title">Advance payment discount</h3>
      <p className="admin-panel__description">
        Customers who pay in advance (bKash or Nagad) get this off their products. Delivery is not discounted.
      </p>
      {!ready && (
        <p className="admin-panel__description" role="status">
          This needs the Batch 48 database update (migration-049) first.
        </p>
      )}
      {ready && !isAdmin && (
        <p className="admin-panel__description" role="status">
          Only the Super Admin can change this.
        </p>
      )}
      <form onSubmit={handleSave} className="form" noValidate>
        <div className="form-field form-field--toggle settings-switch-row">
          <span className="settings-switch-row__text">
            <span className="toggle-label" id="settings-advance-on-label">
              {enabled ? 'On' : 'Off'}
            </span>
          </span>
          <button
            type="button"
            className={`toggle${enabled ? ' toggle--on' : ''}`}
            onClick={() => setEnabled((on) => !on)}
            role="switch"
            aria-checked={enabled}
            aria-labelledby="settings-advance-on-label"
            disabled={!canEdit || isSaving}
            data-testid="advance-discount-switch"
          >
            <span className="toggle__thumb" />
          </button>
        </div>

        <div className="form-field">
          <span className="form-label" id="settings-advance-type-label">
            Type
          </span>
          <div className="chip-group" role="group" aria-labelledby="settings-advance-type-label">
            <button
              type="button"
              className={`chip-select${type === 'percent' ? ' chip-select--on' : ''}`}
              aria-pressed={type === 'percent'}
              onClick={() => setType('percent')}
              disabled={!canEdit || isSaving}
            >
              Percent (%)
            </button>
            <button
              type="button"
              className={`chip-select${type === 'fixed' ? ' chip-select--on' : ''}`}
              aria-pressed={type === 'fixed'}
              onClick={() => setType('fixed')}
              disabled={!canEdit || isSaving}
            >
              Fixed amount (৳)
            </button>
          </div>
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="settings-advance-value">
            Value {type === 'percent' ? '(%)' : '(৳)'}
          </label>
          <input
            id="settings-advance-value"
            type="text"
            inputMode="decimal"
            className="form-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={!canEdit || isSaving}
            aria-invalid={error !== null}
          />
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="admin-panel__description" data-testid="advance-discount-preview">
              {advancePreview({ type, value: Number(value.trim()) })}
            </p>
          )}
        </div>

        <button type="submit" className="button button--secondary" disabled={!canEdit || isSaving || error !== null}>
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
        </button>
      </form>
    </div>
  );
}
