import { useState, type KeyboardEvent } from 'react';
import { saveCustomerNote, type CustomerNote } from '../../lib/brandAdmin';
import { formatDhakaTime } from '../../lib/staff';
import { useToast } from '../../hooks/useToast';
import { AdminIcon } from './ui/AdminIcon';

const MAX_TAG_LENGTH = 30;

/** Small tag chips on a Customers row. */
export function CustomerTagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="adm-ctags" data-testid="customer-tags">
      {tags.map((t) => (
        <span key={t} className="adm-ctag">
          {t}
        </span>
      ))}
    </span>
  );
}

/**
 * A customer's private note and tags (Batch 26 Part 7) — on the customer's
 * sheet in Customers. Staff only: a customer can never read them (the
 * database only lets staff with "View customers" read the table). Saving
 * needs "Edit customer notes"; without it they are shown read-only.
 */
export function CustomerNotesEditor({
  customerId,
  note,
  knownTags,
  canEdit,
  onSaved,
}: {
  customerId: string;
  note: CustomerNote | null;
  knownTags: string[];
  canEdit: boolean;
  onSaved: (note: CustomerNote) => void;
}) {
  const { showToast } = useToast();
  const [text, setText] = useState(note?.note ?? '');
  const [tags, setTags] = useState<string[]>(note?.tags ?? []);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = text.trim() !== (note?.note ?? '') || tags.join('\u0000') !== (note?.tags ?? []).join('\u0000');

  const addTag = (raw: string) => {
    const tag = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
    if (tag === '') return;
    const known = knownTags.find((t) => t.toLowerCase() === tag.toLowerCase());
    const value = known ?? tag;
    setTags((prev) => (prev.some((t) => t.toLowerCase() === value.toLowerCase()) ? prev : [...prev, value]));
    setDraft('');
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(draft);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const pending = draft.trim() !== '' ? [...tags, draft.trim()] : tags;
    const result = await saveCustomerNote(customerId, text, pending);
    setSaving(false);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setTags(result.tags);
    setText(result.note);
    setDraft('');
    onSaved({ note: result.note, tags: result.tags, updatedBy: null, updatedAt: new Date().toISOString() });
    showToast('Saved');
  };

  const suggestions = knownTags.filter((t) => !tags.some((x) => x.toLowerCase() === t.toLowerCase()));

  if (!canEdit) {
    if (!note || (note.note === '' && note.tags.length === 0)) return null;
    return (
      <div className="adm-cnote" data-testid="customer-note">
        <h3 className="adm-group__title adm-customer__heading">PRIVATE NOTE</h3>
        <CustomerTagChips tags={note.tags} />
        {note.note && <p className="adm-cnote__text">{note.note}</p>}
      </div>
    );
  }

  return (
    <div className="adm-cnote" data-testid="customer-note">
      <h3 className="adm-group__title adm-customer__heading">PRIVATE NOTE AND TAGS</h3>
      <p className="adm-cnote__hint">
        <AdminIcon name="lock" className="adm-icon--sm" /> Only staff can see this. The customer never does.
      </p>
      <label className="form-label" htmlFor={`cn-${customerId}`}>
        Note
      </label>
      <textarea
        id={`cn-${customerId}`}
        className="form-input form-textarea"
        rows={3}
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Prefers evening delivery. Pays by bKash."
        data-testid="customer-note-text"
      />

      <span className="form-label adm-cnote__tags-label">Tags</span>
      <div className="adm-cnote__tags">
        {tags.map((t) => (
          <span key={t} className="adm-ctag adm-ctag--edit">
            {t}
            <button type="button" onClick={() => setTags((prev) => prev.filter((x) => x !== t))} aria-label={`Remove tag ${t}`}>
              <AdminIcon name="close" />
            </button>
          </span>
        ))}
      </div>
      <div className="adm-cnote__add">
        <input
          className="form-input"
          value={draft}
          maxLength={MAX_TAG_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder="Type a tag, e.g. VIP"
          aria-label="New tag"
          list={`cn-tags-${customerId}`}
          data-testid="customer-tag-input"
        />
        <datalist id={`cn-tags-${customerId}`}>
          {suggestions.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" onClick={() => addTag(draft)} disabled={draft.trim() === ''}>
          <AdminIcon name="plus" /> Add
        </button>
      </div>
      {suggestions.length > 0 && (
        <div className="adm-cnote__suggest" aria-label="Tags already used">
          {suggestions.slice(0, 8).map((t) => (
            <button key={t} type="button" className="adm-chip" onClick={() => addTag(t)}>
              {t}
            </button>
          ))}
        </div>
      )}

      {note?.updatedAt && note.updatedBy && (
        <p className="adm-cnote__hint">
          Last changed by {note.updatedBy} · {formatDhakaTime(note.updatedAt)}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="adm-btn adm-btn--primary adm-cnote__save"
        disabled={saving || (!dirty && draft.trim() === '')}
        onClick={() => void save()}
        data-testid="customer-note-save"
      >
        {saving ? <span className="spinner" aria-hidden="true" /> : 'Save note and tags'}
      </button>
    </div>
  );
}
