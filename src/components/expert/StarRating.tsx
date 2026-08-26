interface StarRatingProps {
  /** Number of filled stars, 1-5. */
  rating: number;
  /** Rendered size in pixels. */
  size?: number;
}

const MAX_STARS = 5;

const STAR_PATH =
  'M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.31l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94L12 2.5z';

/** Filled stars up to `rating`, dimmed outlines for the remainder. */
export function StarRating({ rating, size = 11 }: StarRatingProps) {
  const filled = Math.max(0, Math.min(MAX_STARS, Math.round(rating)));

  return (
    <span
      className="exp-stars"
      role="img"
      aria-label={`${filled} out of ${MAX_STARS} stars`}
    >
      {Array.from({ length: MAX_STARS }, (_, i) => (
        <svg
          key={i}
          className={`exp-stars__star${i < filled ? ' exp-stars__star--on' : ''}`}
          style={{ width: size, height: size }}
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d={STAR_PATH} />
        </svg>
      ))}
    </span>
  );
}
