import type { Review, ReviewFormData } from '../types';

/** Columns selected wherever reviews are read. */
export const REVIEW_SELECT =
  'id, name, country, country_code, star_rating, quote, photo_url, sort_order, is_approved, is_visible, submitted_by, created_at';

export const MAX_QUOTE_LENGTH = 300;

/** Blank form state for the admin "add review" form. */
export function emptyReviewForm(): ReviewFormData {
  return {
    name: '',
    country: '',
    country_code: '',
    star_rating: 5,
    quote: '',
    sort_order: '0',
    is_approved: true,
    is_visible: true,
  };
}

/** Populate the admin form from an existing row. */
export function reviewToForm(review: Review): ReviewFormData {
  return {
    name: review.name,
    country: review.country ?? '',
    country_code: review.country_code ?? '',
    star_rating: review.star_rating ?? 5,
    quote: review.quote,
    sort_order: String(review.sort_order),
    is_approved: review.is_approved,
    is_visible: review.is_visible,
  };
}

/**
 * ISO 3166-1 alpha-2 codes are two ASCII letters. Anything else would produce
 * a `fi-xx` class with no matching flag, so it's normalised away and the flag
 * is simply not rendered.
 */
export function normalizeCountryCode(raw: string): string | null {
  const code = raw.trim().toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : null;
}

/** Average star rating across reviews, or null when none carry a rating. */
export function averageRating(reviews: Review[]): number | null {
  const rated = reviews.filter((r) => r.star_rating !== null);
  if (rated.length === 0) return null;
  const total = rated.reduce((sum, r) => sum + (r.star_rating ?? 0), 0);
  return total / rated.length;
}
