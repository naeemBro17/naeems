import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../../lib/supabase';
import { useProducts } from '../../../contexts/ProductContext';
import { useToast } from '../../../hooks/useToast';
import { dhakaToday } from '../../../lib/inventory/api';
import { DEFAULT_REMINDER_TEMPLATE, reminderMessage } from '../../../lib/money/format';

/**
 * Batch 41 Part 4.2: Settings → Due reminder message. The text WhatsApp
 * opens with on "Send due reminder". {name} {due} {date} {link}; the line
 * with {link} is left out when the customer owes only a previous balance.
 */
export function DueReminderPanel() {
  const { settings, refetch } = useProducts();
  const { showToast } = useToast();
  const [text, setText] = useState(settings.due_reminder_template || DEFAULT_REMINDER_TEMPLATE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setText(settings.due_reminder_template || DEFAULT_REMINDER_TEMPLATE);
  }, [settings.due_reminder_template]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.includes('{due}')) {
      showToast('Keep {due} in the message (the amount).', 'error');
      return;
    }
    setSaving(true);
    const { error } = await supabase.from('app_settings').upsert({ key: 'due_reminder_template', value: text.trim() }, { onConflict: 'key' });
    setSaving(false);
    if (error) {
      showToast('Could not save. Please try again.', 'error');
      return;
    }
    await refetch();
    showToast('Due reminder message saved');
  };

  const sample = reminderMessage(text, { name: 'Rahima', due: 3070, date: dhakaToday(), link: `${window.location.origin}/orders/…` });

  return (
    <div className="admin-panel">
      <h3 className="admin-panel__title">Due reminder message</h3>
      <p className="admin-panel__description">
        What WhatsApp opens with when you tap "Send due reminder" on a customer. Use {'{name}'}, {'{due}'}, {'{date}'} and {'{link}'} (their own order
        page on this site). The line with {'{link}'} is left out when they owe only a previous balance.
      </p>
      <form onSubmit={save} className="form" noValidate>
        <label className="form-field">
          <span className="form-label">Message</span>
          <textarea className="form-input" rows={7} value={text} onChange={(e) => setText(e.target.value)} aria-label="Due reminder message" data-testid="due-reminder-template" />
        </label>
        <p className="form-label">Example</p>
        <pre className="money-message">{sample}</pre>
        <div className="inv-actions">
          <button type="button" className="adm-btn" onClick={() => setText(DEFAULT_REMINDER_TEMPLATE)}>
            Use the default text
          </button>
          <button type="submit" className="adm-btn adm-btn--primary" disabled={saving}>
            {saving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
