import type { FormEvent } from 'react';
import type { PromoCodeFormData, PromoDiscountType } from '../../types';

interface PromoCodeFormProps {
  form: PromoCodeFormData;
  title: string;
  isSaving: boolean;
  onChange: (patch: Partial<PromoCodeFormData>) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
}

export function PromoCodeForm({
  form,
  title,
  isSaving,
  onChange,
  onSubmit,
  onCancel,
}: PromoCodeFormProps) {
  const discountAmount = Number.parseFloat(form.discount_amount);
  const isValid =
    form.code.trim() !== '' &&
    Number.isFinite(discountAmount) &&
    discountAmount > 0 &&
    (form.discount_type !== 'percent' || discountAmount <= 100);

  return (
    <form onSubmit={onSubmit} className="form review-admin__form" noValidate>
      <h4 className="review-admin__form-title">{title}</h4>

      <div className="form-field">
        <label className="form-label" htmlFor="promo-code">
          Code <span className="form-required" aria-hidden="true">*</span>
        </label>
        <input
          id="promo-code"
          type="text"
          className="form-input"
          placeholder="WELCOME10"
          value={form.code}
          onChange={(e) => onChange({ code: e.target.value.toUpperCase() })}
          required
        />
      </div>

      <div className="form-row">
        <div className="form-field">
          <label className="form-label" htmlFor="promo-discount-amount">
            Discount amount <span className="form-required" aria-hidden="true">*</span>
          </label>
          <input
            id="promo-discount-amount"
            type="number"
            min="0"
            step="0.01"
            className="form-input"
            placeholder="100"
            value={form.discount_amount}
            onChange={(e) => onChange({ discount_amount: e.target.value })}
            required
          />
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="promo-discount-type">
            Discount type
          </label>
          <select
            id="promo-discount-type"
            className="form-input"
            value={form.discount_type}
            onChange={(e) => onChange({ discount_type: e.target.value as PromoDiscountType })}
          >
            <option value="fixed">Fixed amount (৳ off)</option>
            <option value="percent">Percentage (% off)</option>
          </select>
        </div>
      </div>

      <div className="form-row">
        <div className="form-field">
          <label className="form-label" htmlFor="promo-max-uses">
            Max uses
          </label>
          <input
            id="promo-max-uses"
            type="number"
            min="1"
            step="1"
            className="form-input"
            placeholder="50"
            value={form.max_uses}
            onChange={(e) => onChange({ max_uses: e.target.value })}
          />
          <p className="form-helper">Blank = unlimited uses.</p>
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="promo-expires">
            Expires at
          </label>
          <input
            id="promo-expires"
            type="datetime-local"
            className="form-input"
            value={form.expires_at}
            onChange={(e) => onChange({ expires_at: e.target.value })}
          />
          <p className="form-helper">Blank = never expires.</p>
        </div>
      </div>

      <div className="form-field form-field--toggle">
        <span className="toggle-label">Active</span>
        <button
          type="button"
          className={`toggle${form.active ? ' toggle--on' : ''}`}
          onClick={() => onChange({ active: !form.active })}
          role="switch"
          aria-checked={form.active}
          aria-label="Active"
        >
          <span className="toggle__thumb" />
        </button>
      </div>

      <div className="review-admin__form-actions">
        <button type="submit" className="button button--primary" disabled={isSaving || !isValid}>
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save Code'}
        </button>
        <button type="button" className="button button--secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
