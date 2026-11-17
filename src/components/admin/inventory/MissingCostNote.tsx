import { Link } from 'react-router-dom';

/**
 * Batch 45 Part 7: under a profit figure — sold items with no buying price
 * have no cost yet, so the profit would look too high without this note.
 * Links to Inventory → Set buying prices.
 */
export function MissingCostNote({ count }: { count: number | undefined }) {
  if (!count || count <= 0) return null;
  return (
    <p className="inv-muted" data-testid="missing-cost-note">
      {count} item{count === 1 ? ' has' : 's have'} no buying price yet, so {count === 1 ? 'its order is' : 'their orders are'} left out of this profit.{' '}
      <Link to="/admin?tab=inventory&inv=prices">Set buying prices</Link>
    </p>
  );
}
