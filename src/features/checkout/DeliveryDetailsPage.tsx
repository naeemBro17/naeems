// Step 2 of the checkout flow. Collects delivery zone selection and
// customer address. Reads/writes via useCheckoutState. Redirects back to
// /cart if the cart is empty (nothing to deliver), and routes to
// OrderSummaryPage on a valid submit.
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { BackButton } from '../../components/shared/BackButton';
import { formatTaka } from '../../lib/format';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useAuth } from '../../contexts/AuthContext';
import { zoneForAddress } from '../../lib/deliveryZones';
import {
  AddressFormFields,
  validateAddress,
  type AddressFieldErrors,
} from '../../components/checkout/AddressFormFields';
import { useCheckoutState } from './useCheckoutState';
import { CheckoutProgressBar } from './CheckoutProgressBar';
import { DELIVERY_ZONES, type DeliveryAddress } from './types';

export function DeliveryDetailsPage() {
  useDocumentTitle("Delivery Details — Naeem's");
  const { items, isCatalogLoading, zoneId, setZoneId, address, setAddress } = useCheckoutState();
  const { profile, isCustomer, updateOwnProfile } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState<DeliveryAddress>(address);
  const [errors, setErrors] = useState<AddressFieldErrors>({});

  // Keep the local draft in sync if the shared address changes elsewhere
  // (e.g. the customer went back from Order Summary to edit it).
  useEffect(() => {
    setForm(address);
  }, [address]);

  // A returning, logged-in customer's saved delivery details prefill the
  // form the first time it's empty — first-time customers just see it blank.
  // Never overwrites something the customer already typed this session.
  useEffect(() => {
    if (!profile) return;
    const hasSavedAddress = profile.district || profile.thana || profile.address_line;
    if (!hasSavedAddress) return;
    setForm((current) => {
      if (current.fullName || current.phone || current.district || current.fullAddress) {
        return current;
      }
      const next = {
        fullName: current.fullName || profile.full_name || '',
        phone: current.phone || profile.phone || '',
        division: profile.division ?? '',
        district: profile.district ?? '',
        thana: profile.thana ?? '',
        fullAddress: profile.address_line ?? '',
      };
      setZoneId(zoneForAddress(next.district || null, next.thana || null));
      return next;
    });
    // Only meant to run once, right when the profile first becomes
    // available — not every time the profile object identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  // Cart items resolve against the product catalog, which is still empty on
  // a cold load straight onto this route (e.g. returning from the Google
  // OAuth redirect) — wait for it rather than bouncing a customer whose
  // cart is actually fine back to an apparently-empty cart page.
  if (isCatalogLoading) {
    return (
      <div className="full-screen-center" aria-label="Loading your cart">
        <span className="spinner spinner--large" aria-hidden="true" />
      </div>
    );
  }

  if (items.length === 0) {
    return <Navigate to="/cart" replace />;
  }

  const updateField = (patch: Partial<DeliveryAddress>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const handleLocationChange = (district: string, thana: string) => {
    setZoneId(zoneForAddress(district || null, thana || null));
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const nextErrors = validateAddress(form);

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setErrors({});
    setAddress(form);
    // Remember these details on the customer's profile for next visit — not
    // blocking navigation on it, and never for admin/wholesaler sessions
    // (they aren't customer profiles and shouldn't gain address fields).
    if (isCustomer) {
      void updateOwnProfile({
        full_name: form.fullName,
        phone: form.phone,
        division: form.division,
        district: form.district,
        thana: form.thana,
        address_line: form.fullAddress,
      });
    }
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
          <AddressFormFields
            form={form}
            errors={errors}
            onChange={updateField}
            onLocationChange={handleLocationChange}
            idPrefix="delivery"
          />

          <button type="submit" className="button button--primary checkout-delivery-form__submit">
            Save and continue
          </button>
        </form>
      </main>
    </div>
  );
}
