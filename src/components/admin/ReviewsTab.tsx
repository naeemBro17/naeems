import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import {
  emptyReviewForm,
  MAX_QUOTE_LENGTH,
  normalizeCountryCode,
  REVIEW_SELECT,
  reviewToForm,
} from '../../lib/reviews';
import { useToast } from '../../hooks/useToast';
import { StarRating } from '../expert/StarRating';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import type { Review, ReviewFormData } from '../../types';

const STAR_VALUES = [1, 2, 3, 4, 5];

interface ReviewFormProps {
  form: ReviewFormData;
  title: string;
  isSaving: boolean;
  onChange: (patch: Partial<ReviewFormData>) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
}

function ReviewForm({
  form,
  title,
  isSaving,
  onChange,
  onSubmit,
  onCancel,
}: ReviewFormProps) {
  return (
    <form onSubmit={onSubmit} className="form review-admin__form" noValidate>
      <h4 className="review-admin__form-title">{title}</h4>

      <div className="form-field">
        <label className="form-label" htmlFor="review-admin-name">
          Name <span className="form-required" aria-hidden="true">*</span>
        </label>
        <input
          id="review-admin-name"
          type="text"
          className="form-input"
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value })}
          required
        />
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor="review-admin-country">
          Country
        </label>
        <input
          id="review-admin-country"
          type="text"
          className="form-input"
          placeholder="Dhaka, Bangladesh"
          value={form.country}
          onChange={(e) => onChange({ country: e.target.value })}
        />
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor="review-admin-code">
          Country Code (e.g. bd, au, gb)
        </label>
        <input
          id="review-admin-code"
          type="text"
          className="form-input"
          placeholder="bd"
          maxLength={2}
          value={form.country_code}
          onChange={(e) => onChange({ country_code: e.target.value })}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>

      <div className="form-field">
        <span className="form-label">Rating</span>
        <div className="review-stars-input" role="radiogroup" aria-label="Rating">
          {STAR_VALUES.map((value) => (
            <button
              key={value}
              type="button"
              className={`review-stars-input__star${
                value <= form.star_rating ? ' review-stars-input__star--on' : ''
              }`}
              onClick={() => onChange({ star_rating: value })}
              role="radio"
              aria-checked={value === form.star_rating}
              aria-label={`${value} star${value === 1 ? '' : 's'}`}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.31l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94L12 2.5z" />
              </svg>
            </button>
          ))}
        </div>
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor="review-admin-quote">
          Quote <span className="form-required" aria-hidden="true">*</span>
        </label>
        <textarea
          id="review-admin-quote"
          className="form-input form-textarea"
          rows={4}
          maxLength={MAX_QUOTE_LENGTH}
          value={form.quote}
          onChange={(e) => onChange({ quote: e.target.value })}
          required
        />
        <span className="form-hint">
          {form.quote.length} / {MAX_QUOTE_LENGTH}
        </span>
      </div>

      <div className="form-field form-field--toggle">
        <span className="toggle-label">Approved (visible on the page)</span>
        <button
          type="button"
          className={`toggle${form.is_approved ? ' toggle--on' : ''}`}
          onClick={() => onChange({ is_approved: !form.is_approved })}
          role="switch"
          aria-checked={form.is_approved}
          aria-label="Approved"
        >
          <span className="toggle__thumb" />
        </button>
      </div>

      <div className="form-field form-field--toggle">
        <span className="toggle-label">Visible</span>
        <button
          type="button"
          className={`toggle${form.is_visible ? ' toggle--on' : ''}`}
          onClick={() => onChange({ is_visible: !form.is_visible })}
          role="switch"
          aria-checked={form.is_visible}
          aria-label="Visible"
        >
          <span className="toggle__thumb" />
        </button>
      </div>

      <div className="review-admin__form-actions">
        <button
          type="submit"
          className="button button--primary"
          disabled={isSaving || form.name.trim() === '' || form.quote.trim() === ''}
        >
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save Review'}
        </button>
        <button type="button" className="button button--secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ReviewsTab() {
  const { showToast } = useToast();

  const [reviews, setReviews] = useState<Review[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState<ReviewFormData | null>(null);
  /** Row being edited, or null when the form is creating a new review. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Review | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from('reviews')
      .select(REVIEW_SELECT)
      .order('sort_order', { ascending: true });
    setIsLoading(false);
    if (error) {
      console.error('Review load failed:', error);
      showToast('Could not load reviews', 'error');
      return;
    }
    setReviews((data ?? []) as Review[]);
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const approved = reviews.filter((r) => r.is_approved);
  const pending = reviews.filter((r) => !r.is_approved);

  const patchRow = async (id: string, patch: Partial<Review>) => {
    const { error } = await supabase.from('reviews').update(patch).eq('id', id);
    if (error) {
      console.error('Review update failed:', error);
      showToast('Could not update the review', 'error');
      return;
    }
    await load();
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    const { error } = await supabase.from('reviews').delete().eq('id', pendingDelete.id);
    setPendingDelete(null);
    if (error) {
      console.error('Review delete failed:', error);
      showToast('Could not delete the review', 'error');
      return;
    }
    showToast('Review deleted');
    await load();
  };

  /** Reorder within the approved list and write every new sort_order. */
  const handleDrop = async (targetId: string) => {
    if (dragId === null || dragId === targetId) {
      setDragId(null);
      return;
    }
    const from = approved.findIndex((r) => r.id === dragId);
    const to = approved.findIndex((r) => r.id === targetId);
    setDragId(null);
    if (from === -1 || to === -1) return;

    const next = [...approved];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);

    setReviews([...next, ...pending]);
    const updates = next.map((review, index) =>
      supabase.from('reviews').update({ sort_order: index + 1 }).eq('id', review.id)
    );
    const results = await Promise.all(updates);
    if (results.some((r) => r.error)) {
      showToast('Could not save the new order', 'error');
    }
    await load();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setIsSaving(true);
    const payload = {
      name: form.name.trim(),
      country: form.country.trim(),
      country_code: normalizeCountryCode(form.country_code),
      star_rating: form.star_rating,
      quote: form.quote.trim(),
      sort_order: Number.parseInt(form.sort_order, 10) || 0,
      is_approved: form.is_approved,
      is_visible: form.is_visible,
    };

    const { error } = editingId
      ? await supabase.from('reviews').update(payload).eq('id', editingId)
      : await supabase
          .from('reviews')
          .insert({ ...payload, submitted_by: 'admin' });
    setIsSaving(false);

    if (error) {
      console.error('Review save failed:', error);
      showToast('Could not save the review', 'error');
      return;
    }
    showToast(editingId ? 'Review updated' : 'Review added');
    setForm(null);
    setEditingId(null);
    await load();
  };

  const startEdit = (review: Review) => {
    setForm(reviewToForm(review));
    setEditingId(review.id);
  };

  const startCreate = () => {
    const nextOrder = approved.length + 1;
    setForm({ ...emptyReviewForm(), sort_order: String(nextOrder) });
    setEditingId(null);
  };

  const renderRow = (review: Review, draggable: boolean) => (
    <li
      key={review.id}
      className={`review-admin__row${
        dragId === review.id ? ' review-admin__row--dragging' : ''
      }`}
      onDragOver={draggable ? (e) => e.preventDefault() : undefined}
      onDrop={draggable ? () => void handleDrop(review.id) : undefined}
    >
      {draggable && (
        <span
          className="review-admin__handle"
          draggable
          onDragStart={() => setDragId(review.id)}
          onDragEnd={() => setDragId(null)}
          aria-label={`Reorder review by ${review.name}`}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
          </svg>
        </span>
      )}

      <div className="review-admin__info">
        <span className="review-admin__name">
          {review.name}
          {review.country && (
            <span className="review-admin__country">{review.country}</span>
          )}
        </span>
        {review.star_rating !== null && <StarRating rating={review.star_rating} />}
        <span className="review-admin__quote">{review.quote}</span>
      </div>

      <div className="review-admin__actions">
        {!review.is_approved && (
          <button
            type="button"
            className="button button--primary button--small"
            onClick={() => void patchRow(review.id, { is_approved: true })}
          >
            Approve
          </button>
        )}
        {review.is_approved && (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => void patchRow(review.id, { is_visible: !review.is_visible })}
          >
            {review.is_visible ? 'Hide' : 'Show'}
          </button>
        )}
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={() => startEdit(review)}
        >
          Edit
        </button>
        <button
          type="button"
          className="button button--danger-outline button--small"
          onClick={() => setPendingDelete(review)}
        >
          Delete
        </button>
      </div>
    </li>
  );

  return (
    <section aria-label="Reviews">
      <header className="admin-section-header">
        <h2 className="admin-section-title">Reviews</h2>
        {form === null && (
          <button type="button" className="button button--primary" onClick={startCreate}>
            Add Review
          </button>
        )}
      </header>

      {form !== null && (
        <div className="admin-panel">
          <ReviewForm
            form={form}
            title={editingId ? 'Edit Review' : 'New Review'}
            isSaving={isSaving}
            onChange={(patch) =>
              setForm((current) => (current ? { ...current, ...patch } : current))
            }
            onSubmit={handleSubmit}
            onCancel={() => {
              setForm(null);
              setEditingId(null);
            }}
          />
        </div>
      )}

      {isLoading ? (
        <div className="full-screen-center">
          <span className="spinner spinner--large" aria-hidden="true" />
        </div>
      ) : (
        <>
          {pending.length > 0 && (
            <div className="admin-panel">
              <h3 className="admin-panel__title">
                Pending Approval
                <span className="admin-nav__badge">{pending.length}</span>
              </h3>
              <p className="admin-panel__description">
                Submitted from the expert profile page. Nothing here is visible to
                visitors until approved.
              </p>
              <ul className="review-admin__list">
                {pending.map((review) => renderRow(review, false))}
              </ul>
            </div>
          )}

          <div className="admin-panel">
            <h3 className="admin-panel__title">Published</h3>
            <p className="admin-panel__description">
              Drag the handle to reorder — reviews appear in this order on the expert
              profile page.
            </p>
            {approved.length === 0 ? (
              <p className="review-admin__empty">No published reviews yet.</p>
            ) : (
              <ul className="review-admin__list">
                {approved.map((review) => renderRow(review, true))}
              </ul>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title="Delete review?"
        message={
          pendingDelete
            ? `The review by ${pendingDelete.name} will be permanently removed.`
            : ''
        }
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onClose={() => setPendingDelete(null)}
      />
    </section>
  );
}
