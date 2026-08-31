import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { MAX_QUOTE_LENGTH, normalizeCountryCode } from '../../lib/reviews';
import { useToast } from '../../hooks/useToast';
import { BottomSheet } from '../shared/BottomSheet';

interface ReviewSubmitSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

const STAR_VALUES = [1, 2, 3, 4, 5];

const STAR_PATH =
  'M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.31l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94L12 2.5z';

/**
 * Public review submission. Rows are inserted unapproved — the RLS insert
 * policy only accepts is_approved = false — so nothing reaches the page until
 * an admin approves it in the Reviews tab.
 */
export function ReviewSubmitSheet({ isOpen, onClose }: ReviewSubmitSheetProps) {
  const { showToast } = useToast();

  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [rating, setRating] = useState(5);
  const [quote, setQuote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Start from a clean form every time the sheet opens.
  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setCountry('');
    setCountryCode('');
    setRating(5);
    setQuote('');
    setError(null);
    setIsSubmitting(false);
  }, [isOpen]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const code = normalizeCountryCode(countryCode);
    if (code === null) {
      setError('Country code must be two letters, e.g. bd or au.');
      return;
    }

    setIsSubmitting(true);
    const { error: insertError } = await supabase.from('reviews').insert({
      name: name.trim(),
      country: country.trim(),
      country_code: code,
      star_rating: rating,
      quote: quote.trim(),
      sort_order: 0,
      is_approved: false,
      is_visible: true,
      submitted_by: 'public',
    });
    setIsSubmitting(false);

    if (insertError) {
      console.error('Review submission failed:', insertError);
      setError('Could not send your review. Please try again.');
      return;
    }

    showToast('Thank you! Your review is pending approval.');
    onClose();
  };

  const canSubmit =
    name.trim() !== '' &&
    country.trim() !== '' &&
    countryCode.trim() !== '' &&
    quote.trim() !== '';

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Share your experience">
      <form onSubmit={handleSubmit} className="form" noValidate>
        <div className="form-field">
          <label className="form-label" htmlFor="review-name">
            Your Name <span className="form-required" aria-hidden="true">*</span>
          </label>
          <input
            id="review-name"
            type="text"
            className="form-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            required
          />
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="review-country">
            Your Country <span className="form-required" aria-hidden="true">*</span>
          </label>
          <input
            id="review-country"
            type="text"
            className="form-input"
            placeholder="Dhaka, Bangladesh"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            required
          />
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="review-country-code">
            Country Code (e.g. bd, au, gb){' '}
            <span className="form-required" aria-hidden="true">*</span>
          </label>
          <input
            id="review-country-code"
            type="text"
            className="form-input"
            placeholder="bd"
            maxLength={2}
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            required
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
                  value <= rating ? ' review-stars-input__star--on' : ''
                }`}
                onClick={() => setRating(value)}
                role="radio"
                aria-checked={value === rating}
                aria-label={`${value} star${value === 1 ? '' : 's'}`}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d={STAR_PATH} />
                </svg>
              </button>
            ))}
          </div>
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="review-quote">
            Your Experience <span className="form-required" aria-hidden="true">*</span>
          </label>
          <textarea
            id="review-quote"
            className="form-input form-textarea"
            rows={4}
            maxLength={MAX_QUOTE_LENGTH}
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
            required
          />
          <span className="form-hint">
            {quote.length} / {MAX_QUOTE_LENGTH}
          </span>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="exp-submit-button"
          disabled={isSubmitting || !canSubmit}
        >
          {isSubmitting ? <span className="spinner" aria-hidden="true" /> : 'Submit Review'}
        </button>
      </form>
    </BottomSheet>
  );
}
