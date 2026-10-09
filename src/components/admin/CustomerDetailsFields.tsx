import type { ReactNode } from 'react';
import { AddressFormFields, type AddressFieldErrors } from '../checkout/AddressFormFields';
import type { DeliveryAddress } from '../../features/checkout/types';

interface CustomerDetailsFieldsProps {
  idPrefix: string;
  address: DeliveryAddress;
  errors?: AddressFieldErrors;
  onAddressChange: (patch: Partial<DeliveryAddress>) => void;
  onLocationChange?: (district: string, thana: string) => void;
  altPhone: string;
  onAltPhoneChange: (value: string) => void;
  /** Add customer only: a private note. */
  note?: string;
  onNoteChange?: (value: string) => void;
  /** Batch 36: Smart paste's thana chips, under the thana picker. */
  thanaExtra?: ReactNode;
}

const noErrors: AddressFieldErrors = {};

/**
 * Batch 32 Part 4: one customer form — name, phone, alternative phone,
 * division / district / thana picker / address (the same fields as
 * checkout), and on Add customer an optional note. Used by Admin →
 * Customers → Add customer and by New order → New customer.
 */
export function CustomerDetailsFields({
  idPrefix,
  address,
  errors = noErrors,
  onAddressChange,
  onLocationChange,
  altPhone,
  onAltPhoneChange,
  note,
  onNoteChange,
  thanaExtra,
}: CustomerDetailsFieldsProps) {
  return (
    <>
      <AddressFormFields
        form={address}
        errors={errors}
        onChange={onAddressChange}
        onLocationChange={onLocationChange}
        idPrefix={idPrefix}
        thanaExtra={thanaExtra}
      />
      <div className="form-field">
        <label className="form-label" htmlFor={`${idPrefix}-alt-phone`}>
          Alternative phone (optional)
        </label>
        <input
          id={`${idPrefix}-alt-phone`}
          type="tel"
          inputMode="tel"
          className="form-input"
          value={altPhone}
          onChange={(e) => onAltPhoneChange(e.target.value)}
          autoComplete="off"
        />
      </div>
      {onNoteChange && (
        <div className="form-field">
          <label className="form-label" htmlFor={`${idPrefix}-note`}>
            Note (optional)
          </label>
          <textarea
            id={`${idPrefix}-note`}
            className="form-input form-textarea"
            rows={3}
            value={note ?? ''}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder="Only staff can see this"
          />
        </div>
      )}
    </>
  );
}
