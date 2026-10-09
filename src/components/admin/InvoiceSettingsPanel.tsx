import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { INVOICE_DEFAULTS, formatInvoicePhone } from '../../lib/invoice/invoiceShop';
import type { AppSettings } from '../../types';

type InvoiceKey =
  | 'invoice_shop_phone'
  | 'invoice_shop_city'
  | 'invoice_community_link'
  | 'invoice_community_title'
  | 'invoice_community_line1'
  | 'invoice_community_line2';

const FIELDS: { key: InvoiceKey; label: string; placeholder: (shopNumber: string) => string; hint?: string }[] = [
  {
    key: 'invoice_shop_phone',
    label: 'Shop phone / WhatsApp',
    placeholder: (shop) => formatInvoicePhone(shop) || '01XXX-XXXXXX',
    hint: 'Blank uses the Checkout WhatsApp number.',
  },
  { key: 'invoice_shop_city', label: 'Shop city', placeholder: () => INVOICE_DEFAULTS.city },
  { key: 'invoice_community_link', label: 'Community QR link', placeholder: () => INVOICE_DEFAULTS.communityLink },
  { key: 'invoice_community_title', label: 'Community title', placeholder: () => INVOICE_DEFAULTS.communityTitle },
  { key: 'invoice_community_line1', label: 'Community line 1', placeholder: () => INVOICE_DEFAULTS.communityLine1 },
  { key: 'invoice_community_line2', label: 'Community line 2', placeholder: () => INVOICE_DEFAULTS.communityLine2 },
];

function valuesFrom(settings: AppSettings): Record<InvoiceKey, string> {
  return Object.fromEntries(FIELDS.map((f) => [f.key, settings[f.key] ?? ''])) as Record<InvoiceKey, string>;
}

/**
 * Batch 37: Admin → Settings → Invoice. Blank fields use the default shown
 * in grey. Saved to app_settings, which only the Super Admin can change
 * (checked in the database); every change is in the Activity Log.
 */
export function InvoiceSettingsPanel() {
  const { settings, refetch } = useProducts();
  const { showToast } = useToast();
  const [values, setValues] = useState<Record<InvoiceKey, string>>(() => valuesFrom(settings));
  const [showCommunity, setShowCommunity] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setValues(valuesFrom(settings));
    setShowCommunity((settings.invoice_show_community ?? 'true').trim() !== 'false');
  }, [settings]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    const link = values.invoice_community_link.trim();
    if (link !== '' && !/^https?:\/\/\S+$/i.test(link)) {
      showToast('The QR link must start with https://', 'error');
      return;
    }
    setIsSaving(true);
    const rows = [
      ...FIELDS.map((f) => ({ key: f.key, value: values[f.key].trim() })),
      { key: 'invoice_show_community', value: showCommunity ? 'true' : 'false' },
    ];
    const { error } = await supabase.from('app_settings').upsert(rows, { onConflict: 'key' });
    setIsSaving(false);
    if (error) {
      console.error('Invoice settings save failed:', error);
      showToast('Could not save. Please try again.', 'error');
      return;
    }
    await refetch();
    showToast('Invoice settings saved');
  };

  return (
    <div className="admin-panel">
      <h3 className="admin-panel__title">Invoice</h3>
      <p className="admin-panel__description">What the printed invoice shows. Leave a field blank to use the default.</p>
      <form onSubmit={handleSave} className="form" noValidate>
        {FIELDS.map((f) => (
          <div className="form-field" key={f.key}>
            <label className="form-label" htmlFor={`settings-${f.key}`}>
              {f.label}
            </label>
            <input
              id={`settings-${f.key}`}
              type={f.key === 'invoice_community_link' ? 'url' : 'text'}
              className="form-input"
              placeholder={f.placeholder(settings.shop_whatsapp_number)}
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
            {f.hint && <span className="admin-panel__description">{f.hint}</span>}
          </div>
        ))}
        <div className="form-field form-field--toggle settings-switch-row">
          <span className="settings-switch-row__text">
            <span className="toggle-label" id="settings-invoice-community-label">
              Show community box
            </span>
            <span className="admin-panel__description settings-switch-row__hint">The QR code panel near the bottom of the invoice.</span>
          </span>
          <button
            type="button"
            className={`toggle${showCommunity ? ' toggle--on' : ''}`}
            onClick={() => setShowCommunity((on) => !on)}
            role="switch"
            aria-checked={showCommunity}
            aria-labelledby="settings-invoice-community-label"
            data-testid="invoice-community-switch"
          >
            <span className="toggle__thumb" />
          </button>
        </div>
        <button type="submit" className="button button--primary" disabled={isSaving}>
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
        </button>
      </form>
    </div>
  );
}
