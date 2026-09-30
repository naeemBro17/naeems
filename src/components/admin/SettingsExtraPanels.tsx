import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import { Modal } from '../shared/Modal';
import { PasswordField } from './PasswordField';
import {
  fetchOrderNumberFormat,
  previewOrderNumber,
  saveOrderNumberFormat,
  type OrderNumberFormat,
} from '../../lib/orders';
import { EDITABLE_TEXT_GROUPS, siteText, type EditableTextKey } from '../../lib/editableTexts';
import { formatCountdown, SAFETY_LOCK_MINUTES, useSafetyLock } from '../../contexts/SafetyLockContext';

/**
 * Admin → Settings → Orders (Batch 24 Part 3): order number prefix, next
 * number and suffix. The number itself is made in the database
 * (next_order_number()), so two orders at the same moment can never get
 * the same one, and the next number can only go up.
 */
export function OrderNumberPanel() {
  const { showToast } = useToast();
  const [saved, setSaved] = useState<OrderNumberFormat | null>(null);
  const [prefix, setPrefix] = useState('');
  const [nextNumber, setNextNumber] = useState('');
  const [suffix, setSuffix] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const load = async () => {
    const format = await fetchOrderNumberFormat();
    setSaved(format);
    if (format) {
      setPrefix(format.prefix);
      setNextNumber(String(format.nextNumber));
      setSuffix(format.suffix);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const parsedNext = Number.parseInt(nextNumber, 10);
  const preview = previewOrderNumber({
    prefix,
    nextNumber: Number.isFinite(parsedNext) ? parsedNext : (saved?.nextNumber ?? 0),
    suffix,
  });

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!saved) return;
    if (!Number.isFinite(parsedNext) || parsedNext < saved.nextNumber) {
      setError(`The next number can only go up. It is now ${saved.nextNumber}.`);
      return;
    }
    setIsSaving(true);
    const result = await saveOrderNumberFormat({ prefix: prefix.trim(), nextNumber: parsedNext, suffix: suffix.trim() });
    setIsSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    showToast('Order number format saved');
    await load();
  };

  return (
    <div className="admin-panel">
      <h3 className="admin-panel__title">Orders: order number</h3>
      <p className="admin-panel__description">
        How new order numbers look. Existing orders keep their numbers. The next number can only go up, so a
        number is never used twice.
      </p>
      {!saved ? (
        <p className="admin-panel__description">Loading…</p>
      ) : (
        <form onSubmit={handleSave} className="form" noValidate>
          <div className="form-row order-number-form">
            <div className="form-field">
              <label className="form-label" htmlFor="settings-order-prefix">
                Prefix
              </label>
              <input
                id="settings-order-prefix"
                className="form-input"
                value={prefix}
                maxLength={12}
                onChange={(e) => setPrefix(e.target.value.replace(/\s/g, ''))}
              />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="settings-order-next">
                Next number
              </label>
              <input
                id="settings-order-next"
                className="form-input"
                type="number"
                inputMode="numeric"
                min={saved.nextNumber}
                value={nextNumber}
                onChange={(e) => setNextNumber(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="settings-order-suffix">
                Suffix
              </label>
              <input
                id="settings-order-suffix"
                className="form-input"
                value={suffix}
                maxLength={12}
                onChange={(e) => setSuffix(e.target.value.replace(/\s/g, ''))}
              />
            </div>
          </div>
          <p className="order-number-preview" data-testid="order-number-preview">
            Next order will be: <strong>{preview}</strong>
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button button--primary" disabled={isSaving}>
            {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * Admin → Settings → Safety Locks (Batch 24 Part 4). One switch: "Allow
 * deleting orders at any stage". Off by default; turning it on needs the
 * password again, and it switches itself back off after 15 minutes and on
 * logout. The database checks it on every delete.
 */
export function SafetyLocksPanel() {
  const { openUntil, secondsLeft, open, close } = useSafetyLock();
  const [isAsking, setIsAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const isOn = openUntil !== null;

  const handleToggle = async () => {
    if (isOn) {
      setIsWorking(true);
      await close();
      setIsWorking(false);
      return;
    }
    setPassword('');
    setError(null);
    setIsAsking(true);
  };

  const handleConfirm = async (e: FormEvent) => {
    e.preventDefault();
    setIsWorking(true);
    const result = await open(password);
    setIsWorking(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setIsAsking(false);
    setPassword('');
  };

  return (
    <div className="admin-panel">
      <h3 className="admin-panel__title">Safety Locks</h3>
      <p className="admin-panel__description">
        Normally an order can only be deleted while it is Pending, or Cancelled and never sent to Steadfast.
        This switch lets you delete an order at any stage, for {SAFETY_LOCK_MINUTES} minutes.
      </p>
      <div className="form-field form-field--toggle safety-lock-row">
        <span className="toggle-label">
          Allow deleting orders at any stage
          {isOn && <span className="safety-lock-row__timer"> (turns back off in {formatCountdown(secondsLeft)})</span>}
        </span>
        <button
          type="button"
          className={`toggle${isOn ? ' toggle--danger' : ''}`}
          role="switch"
          aria-checked={isOn}
          aria-label="Allow deleting orders at any stage"
          onClick={handleToggle}
          disabled={isWorking}
        >
          <span className="toggle__thumb" />
        </button>
      </div>

      <Modal isOpen={isAsking} onClose={() => setIsAsking(false)} title="Confirm it's you">
        <form onSubmit={handleConfirm} className="form" noValidate>
          <p className="delete-orders__warning" role="alert">
            Warning: while this is on, ANY order can be deleted, including confirmed, shipped and delivered
            ones. Deleting cannot be undone. It switches itself back off after {SAFETY_LOCK_MINUTES} minutes.
          </p>
          <PasswordField
            id="safety-lock-password"
            label="Your password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="confirm-actions">
            <button type="button" className="button button--secondary" onClick={() => setIsAsking(false)}>
              Cancel
            </button>
            <button type="submit" className="button button--danger" disabled={isWorking || password === ''}>
              {isWorking ? <span className="spinner" aria-hidden="true" /> : 'Turn off the lock'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/**
 * Admin → Settings → Texts (Batch 24 Part 7). Site texts Naeem can change
 * without a deploy. An empty field means "use the default", so the site
 * never shows a blank text.
 */
export function TextsPanel() {
  const { settings, refetch } = useProducts();
  const { showToast } = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [savingGroup, setSavingGroup] = useState<string | null>(null);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const group of EDITABLE_TEXT_GROUPS) {
      for (const field of group.fields) next[field.key] = settings[field.key] ?? '';
    }
    setValues(next);
  }, [settings]);

  const save = async (groupId: string, keys: EditableTextKey[], blank: boolean) => {
    setSavingGroup(groupId);
    const { error } = await supabase.from('app_settings').upsert(
      keys.map((key) => ({ key, value: blank ? '' : (values[key] ?? '').trim() })),
      { onConflict: 'key' }
    );
    setSavingGroup(null);
    if (error) {
      showToast('Could not save. Please try again.', 'error');
      return;
    }
    await refetch();
    showToast(blank ? 'Back to the default text' : 'Text saved');
  };

  return (
    <div className="admin-panel">
      <h3 className="admin-panel__title">Texts</h3>
      <p className="admin-panel__description">
        Change wording on the site. Leave a field empty to use the default. Changes show on the site straight
        away.
      </p>
      {EDITABLE_TEXT_GROUPS.map((group) => {
        const keys = group.fields.map((f) => f.key);
        return (
          <form
            key={group.id}
            className="form texts-group"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save(group.id, keys, false);
            }}
          >
            <h4 className="texts-group__title">{group.title}</h4>
            <p className="form-hint">{group.description}</p>
            {group.fields.map((field) => (
              <div className="form-field" key={field.key}>
                <label className="form-label" htmlFor={`text-${field.key}`}>
                  {field.label}
                </label>
                {field.multiline ? (
                  <textarea
                    id={`text-${field.key}`}
                    className="form-input form-textarea"
                    rows={3}
                    placeholder={field.defaultText}
                    value={values[field.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  />
                ) : (
                  <input
                    id={`text-${field.key}`}
                    className="form-input"
                    placeholder={field.defaultText}
                    value={values[field.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  />
                )}
                <p className="form-hint">Shown now: “{siteText(settings, field.key)}”</p>
              </div>
            ))}
            <div className="texts-group__actions">
              <button type="submit" className="button button--primary" disabled={savingGroup === group.id}>
                {savingGroup === group.id ? <span className="spinner" aria-hidden="true" /> : 'Save'}
              </button>
              <button
                type="button"
                className="button button--secondary"
                disabled={savingGroup === group.id}
                onClick={() => void save(group.id, keys, true)}
              >
                Reset to default
              </button>
            </div>
          </form>
        );
      })}
    </div>
  );
}
