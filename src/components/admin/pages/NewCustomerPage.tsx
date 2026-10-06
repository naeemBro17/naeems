import { useState, type FormEvent } from 'react';
import { AdminFormPage } from '../AdminFormPage';
import { CustomerDetailsFields } from '../CustomerDetailsFields';
import { useToast } from '../../../hooks/useToast';
import { addCustomer } from '../../../lib/customers';
import { bdPhoneKey } from '../../../lib/phone';
import type { DeliveryAddress } from '../../../features/checkout/types';

const FORM_ID = 'new-customer-form';

interface NewCustomerPageProps {
  onBack: () => void;
  /** After saving, or when the phone already belongs to a customer: open them. */
  onOpenCustomer: (key: string) => void;
}

/** Batch 32 Part 4: /admin/customers/new. */
export function NewCustomerPage({ onBack, onOpenCustomer }: NewCustomerPageProps) {
  const { showToast } = useToast();
  const [address, setAddress] = useState<DeliveryAddress>({
    fullName: '',
    phone: '',
    division: '',
    district: '',
    thana: '',
    fullAddress: '',
  });
  const [altPhone, setAltPhone] = useState('');
  const [note, setNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phoneOk = /^01[3-9]\d{8}$/.test(bdPhoneKey(address.phone) ?? '');
  const canSave = !isSaving && address.fullName.trim() !== '' && phoneOk;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setIsSaving(true);
    setError(null);
    const result = await addCustomer({
      fullName: address.fullName,
      phone: address.phone,
      altPhone,
      division: address.division,
      district: address.district,
      thana: address.thana,
      addressLine: address.fullAddress,
      note,
    });
    setIsSaving(false);
    if (result.error || !result.key) {
      setError(result.error ?? 'Could not add this customer.');
      return;
    }
    showToast(result.existed ? 'This phone number already belongs to a customer — opened them' : 'Customer added');
    onOpenCustomer(result.key);
  };

  return (
    <AdminFormPage
      title="Add customer"
      backLabel="Back to customers"
      onBack={onBack}
      testId="new-customer-page"
      primary={{ label: 'Save customer', formId: FORM_ID, disabled: !canSave, busy: isSaving }}
    >
      <form id={FORM_ID} className="form" onSubmit={(e) => void save(e)} noValidate>
        <CustomerDetailsFields
          idPrefix="new-customer"
          address={address}
          errors={address.phone.trim() !== '' && !phoneOk ? { phone: 'Enter a mobile number like 01712345678.' } : undefined}
          onAddressChange={(patch) => setAddress((c) => ({ ...c, ...patch }))}
          altPhone={altPhone}
          onAltPhoneChange={setAltPhone}
          note={note}
          onNoteChange={setNote}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </AdminFormPage>
  );
}
