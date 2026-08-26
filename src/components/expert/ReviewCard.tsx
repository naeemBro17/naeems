import type { Review } from '../../types';
import { normalizeCountryCode } from '../../lib/reviews';
import { StarRating } from './StarRating';

/** One client review: avatar, name, flagged location, stars and the quote. */
export function ReviewCard({ review }: { review: Review }) {
  const initial = review.name.trim().charAt(0).toUpperCase() || '?';
  const countryCode = normalizeCountryCode(review.country_code ?? '');

  return (
    <article className="exp-review">
      <div className="exp-review__top">
        <span className="exp-review__avatar" aria-hidden="true">
          {review.photo_url ? <img src={review.photo_url} alt="" /> : initial}
        </span>

        <div className="exp-review__who">
          <span className="exp-review__name">{review.name}</span>
          {review.country && (
            <span className="exp-review__location">
              {countryCode && (
                <span className={`fi fi-${countryCode} exp-review__flag`} aria-hidden="true" />
              )}
              {review.country}
            </span>
          )}
        </div>

        {review.star_rating !== null && <StarRating rating={review.star_rating} />}
      </div>

      <p className="exp-review__quote">{review.quote}</p>
    </article>
  );
}
