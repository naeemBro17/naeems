import { useState } from 'react';
import { noteDateText, noteSeen, setNoteToCustomer } from '../../lib/orderNotes';
import { useToast } from '../../hooks/useToast';

const MAX = 500;

/**
 * Batch 65: a note Naeem sends the customer about this order. She sees it
 * in My Orders and once as a card the next time she opens the site; "Seen"
 * appears once she has. Saves with its own button (data-own-save), so the
 * page never asks "Discard changes?" because of it.
 */
export function NoteToCustomerCard({
  orderId,
  note,
  noteAt,
  seenAt,
  canEdit,
  onSaved,
}: {
  orderId: string;
  note: string | null;
  noteAt: string | null;
  seenAt: string | null;
  canEdit: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const { showToast } = useToast();
  const [editing, setEditing] = useState(note === null);
  const [text, setText] = useState(note ?? '');
  const [busy, setBusy] = useState(false);
  const seen = noteSeen(noteAt, seenAt);

  const save = async (value: string) => {
    setBusy(true);
    const { error } = await setNoteToCustomer(orderId, value);
    if (error) {
      setBusy(false);
      showToast(error, 'error');
      return;
    }
    const removed = value.trim() === '';
    // The page reads the order again first, so the card never shows an
    // empty "Sent" while the new note is on its way.
    await onSaved();
    setBusy(false);
    showToast(removed ? 'Note removed' : 'Note sent');
    setEditing(removed);
    setText(removed ? '' : value.trim());
  };

  return (
    <section className="adm-ocard adm-cnote" aria-label="Note to customer" data-testid="note-to-customer" data-own-save="">
      <h2 className="adm-ocard__title">Note to customer</h2>
      <p className="adm-cnote__hint">The customer sees this in My Orders, and once as a card when she next opens the site.</p>
      {!canEdit ? (
        <p className="adm-cnote__text">{note ?? 'No note sent.'}</p>
      ) : editing ? (
        <>
          <textarea
            id={`cnote-${orderId}`}
            className="adm-cnote__input"
            rows={4}
            maxLength={MAX}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write a note for the customer"
            aria-label="Note to customer"
          />
          <div className="adm-cnote__row">
            <span className="adm-cnote__count">
              {text.length} / {MAX}
            </span>
            <div className="adm-cnote__actions">
              {note !== null && (
                <button
                  type="button"
                  className="adm-cnote__link"
                  onClick={() => {
                    setText(note);
                    setEditing(false);
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                className="adm-btn adm-btn--primary adm-cnote__send"
                disabled={busy || text.trim() === '' || text.trim() === (note ?? '')}
                onClick={() => void save(text)}
              >
                {busy ? <span className="spinner" aria-hidden="true" /> : 'Send note'}
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="adm-cnote__sent">
          <p className="adm-cnote__text" data-testid="note-to-customer-text">
            {note}
          </p>
          <div className="adm-cnote__meta">
            <span>
              Sent {noteAt ? noteDateText(noteAt) : ''}
              {seen && (
                <b className="adm-cnote__seen" data-testid="note-to-customer-seen">
                  {' '}
                  · Seen
                </b>
              )}
            </span>
            <span className="adm-cnote__actions">
              <button type="button" className="adm-cnote__link" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button type="button" className="adm-cnote__link" disabled={busy} onClick={() => void save('')}>
                Remove
              </button>
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
