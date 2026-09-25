import { useEffect, useState, type FormEvent } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
import {
  AddressFormFields,
  validateAddress,
  type AddressFieldErrors,
} from '../checkout/AddressFormFields';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../hooks/useToast';
import type { DeliveryAddress } from '../../features/checkout/types';

interface EditDeliveryDetailsSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

function addressFromProfile(profile: {
  full_name: string | null;
  phone: string | null;
  division: string | null;
  district: string | null;
  thana: string | null;
  address_line: string | null;
}): DeliveryAddress {
  return {
    fullName: profile.full_name ?? '',
    phone: profile.phone ?? '',
    division: profile.division ?? '',
    district: profile.district ?? '',
    thana: profile.thana ?? '',
    fullAddress: profile.address_line ?? '',
  };
}

/** The account page's "Edit" action on the Delivery details card — same
 *  fields and validation as checkout's DeliveryDetailsPage (via
 *  AddressFormFields), saved straight to the customer's profile. */
export function EditDeliveryDetailsSheet({ isOpen, onClose }: EditDeliveryDetailsSheetProps) {
  const { profile, updateOwnProfile } = useAuth();
  const { showToast } = useToast();
  const [form, setForm] = useState<DeliveryAddress>(() =>
    profile ? addressFromProfile(profile) : { fullName: '', phone: '', division: '', district: '', thana: '', fullAddress: '' }
  );
  const [errors, setErrors] = useState<AddressFieldErrors>({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (isOpen && profile) {
      setForm(addressFromProfile(profile));
      setErrors({});
    }
  }, [isOpen, profile]);

  const updateField = (patch: Partial<DeliveryAddress>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const nextErrors = validateAddress(form);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setIsSaving(true);
    const { error } = await updateOwnProfile({
      full_name: form.fullName,
      phone: form.phone,
      division: form.division,
      district: form.district,
      thana: form.thana,
      address_line: form.fullAddress,
    });
    setIsSaving(false);
    if (error) {
      showToast(error, 'error');
      return;
    }
    showToast('Delivery details saved', 'success');
    onClose();
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Delivery details">
      <form onSubmit={handleSubmit} className="form" noValidate>
        <AddressFormFields
          form={form}
          errors={errors}
          onChange={updateField}
          idPrefix="account-address"
        />
        <button type="submit" className="button button--primary button--full" disabled={isSaving}>
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
        </button>
      </form>
    </BottomSheet>
  );
}
