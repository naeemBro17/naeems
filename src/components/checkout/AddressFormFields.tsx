import { useMemo, useState } from 'react';
import { BD_DIVISIONS, BD_DISTRICTS, BD_THANAS } from '../../data/bangladeshGeo';
import { PickerSheet, type PickerOption } from '../shared/PickerSheet';
import type { DeliveryAddress } from '../../features/checkout/types';

export type AddressFieldErrors = Partial<Record<keyof DeliveryAddress, string>>;
type OpenPicker = 'division' | 'district' | 'thana' | null;

function toOptions(rows: { id: string; name: string; bnName: string }[]): PickerOption[] {
  return rows.map((r) => ({ id: r.id, label: r.name, subLabel: r.bnName }));
}

/** Bangladeshi mobile numbers: 01[3-9]XXXXXXXX (11 digits), optionally with
 *  a +880/880 country code prefix. Spaces/hyphens are stripped before testing
 *  so "017 1234 5678" and "01712345678" both pass. */
export function isValidBangladeshiPhone(raw: string): boolean {
  const digitsOnly = raw.replace(/[\s-]/g, '');
  return /^(\+?880|0)1[3-9]\d{8}$/.test(digitsOnly);
}

/** Validates a delivery address, returning the error map DeliveryAddress
 *  form fields expect. Shared so the checkout step and the account page's
 *  edit sheet agree on exactly the same rules. */
export function validateAddress(form: DeliveryAddress): AddressFieldErrors {
  const errors: AddressFieldErrors = {};
  if (form.fullName.trim() === '') errors.fullName = 'Full name is required';
  if (form.phone.trim() === '') {
    errors.phone = 'Phone number is required';
  } else if (!isValidBangladeshiPhone(form.phone)) {
    errors.phone = 'Enter a valid Bangladeshi phone number (e.g. 01XXXXXXXXX)';
  }
  if (form.division.trim() === '') errors.division = 'Select a division';
  if (form.district.trim() === '') errors.district = 'Select a district';
  if (form.thana.trim() === '') errors.thana = 'Select a thana/upazila';
  if (form.fullAddress.trim() === '') errors.fullAddress = 'Full address is required';
  return errors;
}

interface AddressFormFieldsProps {
  form: DeliveryAddress;
  errors: AddressFieldErrors;
  onChange: (patch: Partial<DeliveryAddress>) => void;
  /** Called whenever district or thana changes, so the caller can
   *  auto-select the matching delivery zone (see lib/deliveryZones.ts).
   *  Optional — the account page's edit sheet has no zone to update. */
  onLocationChange?: (district: string, thana: string) => void;
  idPrefix: string;
}

/** The Full name / Phone / Division / District / Thana / Address fields,
 *  shared by DeliveryDetailsPage (checkout step 2) and the account page's
 *  "Edit delivery details" sheet — one form, one set of validation rules,
 *  one Bangladesh geo picker, used in both places. */
export function AddressFormFields({
  form,
  errors,
  onChange,
  onLocationChange,
  idPrefix,
}: AddressFormFieldsProps) {
  const [openPicker, setOpenPicker] = useState<OpenPicker>(null);

  const divisionOptions = useMemo(() => toOptions(BD_DIVISIONS), []);
  const selectedDivision = BD_DIVISIONS.find((d) => d.name === form.division) ?? null;

  const districtOptions = useMemo(() => {
    if (!selectedDivision) return [];
    return toOptions(BD_DISTRICTS.filter((d) => d.divisionId === selectedDivision.id));
  }, [selectedDivision]);
  const selectedDistrict = BD_DISTRICTS.find((d) => d.name === form.district) ?? null;

  const thanaOptions = useMemo(() => {
    if (!selectedDistrict) return [];
    return toOptions(BD_THANAS.filter((t) => t.districtId === selectedDistrict.id));
  }, [selectedDistrict]);

  const handlePickDivision = (option: PickerOption) => {
    onChange({ division: option.label, district: '', thana: '' });
    onLocationChange?.('', '');
  };

  const handlePickDistrict = (option: PickerOption) => {
    onChange({ district: option.label, thana: '' });
    onLocationChange?.(option.label, '');
  };

  const handlePickThana = (option: PickerOption) => {
    onChange({ thana: option.label });
    onLocationChange?.(form.district, option.label);
  };

  return (
    <>
      <div className="form-field">
        <label className="form-label" htmlFor={`${idPrefix}-name`}>
          Full name <span className="form-required" aria-hidden="true">*</span>
        </label>
        <input
          id={`${idPrefix}-name`}
          type="text"
          className="form-input"
          value={form.fullName}
          onChange={(e) => onChange({ fullName: e.target.value })}
        />
        {errors.fullName && (
          <p className="form-error" role="alert">
            {errors.fullName}
          </p>
        )}
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor={`${idPrefix}-phone`}>
          Phone number <span className="form-required" aria-hidden="true">*</span>
        </label>
        <input
          id={`${idPrefix}-phone`}
          type="tel"
          inputMode="tel"
          className="form-input"
          value={form.phone}
          onChange={(e) => onChange({ phone: e.target.value })}
        />
        {errors.phone && (
          <p className="form-error" role="alert">
            {errors.phone}
          </p>
        )}
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor={`${idPrefix}-division`}>
          Division <span className="form-required" aria-hidden="true">*</span>
        </label>
        <button
          type="button"
          id={`${idPrefix}-division`}
          className={`form-picker-button${form.division === '' ? ' form-picker-button--placeholder' : ''}`}
          onClick={() => setOpenPicker('division')}
        >
          {form.division || 'Select division'}
        </button>
        {errors.division && (
          <p className="form-error" role="alert">
            {errors.division}
          </p>
        )}
      </div>

      <div className="form-row">
        <div className="form-field">
          <label className="form-label" htmlFor={`${idPrefix}-district`}>
            District <span className="form-required" aria-hidden="true">*</span>
          </label>
          <button
            type="button"
            id={`${idPrefix}-district`}
            className={`form-picker-button${form.district === '' ? ' form-picker-button--placeholder' : ''}`}
            onClick={() => selectedDivision && setOpenPicker('district')}
            disabled={!selectedDivision}
          >
            {form.district || 'Select district'}
          </button>
          {errors.district && (
            <p className="form-error" role="alert">
              {errors.district}
            </p>
          )}
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor={`${idPrefix}-thana`}>
            Thana / Upazila <span className="form-required" aria-hidden="true">*</span>
          </label>
          <button
            type="button"
            id={`${idPrefix}-thana`}
            className={`form-picker-button${form.thana === '' ? ' form-picker-button--placeholder' : ''}`}
            onClick={() => selectedDistrict && setOpenPicker('thana')}
            disabled={!selectedDistrict}
          >
            {form.thana || 'Select thana'}
          </button>
          {errors.thana && (
            <p className="form-error" role="alert">
              {errors.thana}
            </p>
          )}
        </div>
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor={`${idPrefix}-address`}>
          House / road / landmark <span className="form-required" aria-hidden="true">*</span>
        </label>
        <textarea
          id={`${idPrefix}-address`}
          className="form-input form-textarea"
          rows={3}
          placeholder="House, road, landmark"
          value={form.fullAddress}
          onChange={(e) => onChange({ fullAddress: e.target.value })}
        />
        {errors.fullAddress && (
          <p className="form-error" role="alert">
            {errors.fullAddress}
          </p>
        )}
      </div>

      <PickerSheet
        isOpen={openPicker === 'division'}
        onClose={() => setOpenPicker(null)}
        title="Select division"
        options={divisionOptions}
        selectedId={selectedDivision?.id ?? null}
        onSelect={handlePickDivision}
        searchPlaceholder="Search division..."
      />
      <PickerSheet
        isOpen={openPicker === 'district'}
        onClose={() => setOpenPicker(null)}
        title="Select district"
        options={districtOptions}
        selectedId={selectedDistrict?.id ?? null}
        onSelect={handlePickDistrict}
        searchPlaceholder="Search district..."
      />
      <PickerSheet
        isOpen={openPicker === 'thana'}
        onClose={() => setOpenPicker(null)}
        title="Select thana / upazila"
        options={thanaOptions}
        selectedId={BD_THANAS.find((t) => t.name === form.thana)?.id ?? null}
        onSelect={handlePickThana}
        searchPlaceholder="Search thana..."
      />
    </>
  );
}
