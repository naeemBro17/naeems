// Step 2 of the checkout flow. Collects delivery zone selection and
// customer address. Reads/writes via useCheckoutState. Redirects back to
// /cart if the cart is empty (nothing to deliver), and routes to
// OrderSummaryPage on a valid submit.
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { BackButton } from '../../components/shared/BackButton';
import { formatTaka } from '../../lib/format';
import { useCheckoutState } from './useCheckoutState';
import { CheckoutProgressBar } from './CheckoutProgressBar';
import { DELIVERY_ZONES, type DeliveryAddress } from './types';

type FieldErrors = Partial<Record<keyof DeliveryAddress, string>>;

export function DeliveryDetailsPage() {
  const { items, zoneId, setZoneId, address, setAddress } = useCheckoutState();
  const navigate = useNavigate();

  const [form, setForm] = useState<DeliveryAddress>(address);
  const [errors, setErrors] = useState<FieldErrors>({});

  // Keep the local draft in sync if the shared address changes elsewhere
  // (e.g. the customer went back from Order Summary to edit it).
  useEffect(() => {
    setForm(address);
  }, [address]);

  if (items.length === 0) {
    return <Navigate to="/cart" replace />;
  }

  const updateField = (patch: Partial<DeliveryAddress>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const nextErrors: FieldErrors = {};
    if (form.fullName.trim() === '') nextErrors.fullName = 'Full name is required';
    if (form.phone.trim() === '') nextErrors.phone = 'Phone number is required';
    if (form.fullAddress.trim() === '') nextErrors.fullAddress = 'Full address is required';

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setErrors({});
    setAddress(form);
    navigate('/checkout/summary');
  };

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">Delivery Details</h1>
        <div className="detail-header__actions" />
      </header>

      <CheckoutProgressBar currentStep={2} />

      <main className="detail-main">
        <div className="checkout-zone-grid">
          {DELIVERY_ZONES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`checkout-zone-card${
                zoneId === option.id ? ' checkout-zone-card--selected' : ''
              }`}
              onClick={() => setZoneId(option.id)}
              aria-pressed={zoneId === option.id}
            >
              {zoneId === option.id && (
                <span className="checkout-zone-card__check" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
              )}
              <span className="checkout-zone-card__label">{option.label}</span>
              <span className="checkout-zone-card__fee">{formatTaka(option.fee)}</span>
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="form checkout-delivery-form" noValidate>
          <div className="form-field">
            <label className="form-label" htmlFor="delivery-name">
              Full name <span className="form-required" aria-hidden="true">*</span>
            </label>
            <input
              id="delivery-name"
              type="text"
              className="form-input"
              value={form.fullName}
              onChange={(e) => updateField({ fullName: e.target.value })}
            />
            {errors.fullName && (
              <p className="form-error" role="alert">
                {errors.fullName}
              </p>
            )}
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="delivery-phone">
              Phone number <span className="form-required" aria-hidden="true">*</span>
            </label>
            <input
              id="delivery-phone"
              type="tel"
              inputMode="numeric"
              className="form-input"
              value={form.phone}
              onChange={(e) => updateField({ phone: e.target.value })}
            />
            {errors.phone && (
              <p className="form-error" role="alert">
                {errors.phone}
              </p>
            )}
          </div>

          <div className="form-row">
            <div className="form-field">
              <label className="form-label" htmlFor="delivery-district">
                District
              </label>
              <input
                id="delivery-district"
                type="text"
                className="form-input"
                value={form.district}
                onChange={(e) => updateField({ district: e.target.value })}
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="delivery-thana">
                Thana / Area
              </label>
              <input
                id="delivery-thana"
                type="text"
                className="form-input"
                value={form.thana}
                onChange={(e) => updateField({ thana: e.target.value })}
              />
            </div>
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="delivery-address">
              Full address <span className="form-required" aria-hidden="true">*</span>
            </label>
            <textarea
              id="delivery-address"
              className="form-input form-textarea"
              rows={3}
              placeholder="House, road, landmark"
              value={form.fullAddress}
              onChange={(e) => updateField({ fullAddress: e.target.value })}
            />
            {errors.fullAddress && (
              <p className="form-error" role="alert">
                {errors.fullAddress}
              </p>
            )}
          </div>

          <button type="submit" className="button button--primary checkout-delivery-form__submit">
            Save and continue
          </button>
        </form>
      </main>
    </div>
  );
}
