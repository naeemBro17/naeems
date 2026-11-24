import type { ReactNode } from 'react';
import { AddressFormFields, type AddressFieldErrors, type AddressPart } from '../checkout/AddressFormFields';
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
  /** Batch 63: 'all' (default) is the whole form as today; New order shows
   *  'contact' (name, phone, alternative phone) and 'address' on two cards. */
  part?: AddressPart;
  /** Batch 63, 'contact' only: shown between the phone and the alternative
   *  phone (New order's fraud check and "Account found"). */
  afterPhone?: ReactNode;
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
  part = 'all',
  afterPhone,
}: CustomerDetailsFieldsProps) {
  if (part === 'address') {
    return (
      <AddressFormFields
        form={address}
        errors={errors}
        onChange={onAddressChange}
        onLocationChange={onLocationChange}
        idPrefix={idPrefix}
        thanaExtra={thanaExtra}
        part="address"
      />
    );
  }

  if (part === 'contact') {
    return (
      <>
        <AddressFormFields form={address} errors={errors} onChange={onAddressChange} idPrefix={idPrefix} part="contact" />
        {afterPhone}
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
            placeholder="Another number to call"
            autoComplete="off"
          />
        </div>
      </>
    );
  }

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
