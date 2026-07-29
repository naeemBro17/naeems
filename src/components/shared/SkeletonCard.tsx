/** Loading placeholder matching the exact product card layout. */
export function SkeletonCard() {
  return (
    <div className="skeleton-card" aria-hidden="true">
      <div className="skeleton skeleton-card__image" />
      <div className="skeleton-card__body">
        <div className="skeleton skeleton-card__badge" />
        <div className="skeleton skeleton-card__name" />
        <div className="skeleton skeleton-card__name skeleton-card__name--short" />
        <div className="skeleton skeleton-card__sku" />
        <div className="skeleton skeleton-card__price" />
        <div className="skeleton skeleton-card__stock" />
        <div className="skeleton skeleton-card__button" />
      </div>
    </div>
  );
}
