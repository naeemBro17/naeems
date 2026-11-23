import { Link } from 'react-router-dom';

/**
 * Batch 45 Part 7: under a profit figure — sold items with no buying price
 * have no cost yet, so the profit would look too high without this note.
 * Links to Inventory → Set buying prices. Batch 58: their orders are
 * counted (the missing cost as ৳0), so the note says so.
 */
export function MissingCostNote({ count }: { count: number | undefined }) {
  if (!count || count <= 0) return null;
  return (
    <p className="inv-muted" data-testid="missing-cost-note">
      {count} delivered item{count === 1 ? ' has' : 's have'} no cost (counted as ৳0).{' '}
      <Link to="/admin?tab=inventory&inv=prices">Set buying prices</Link>
    </p>
  );
}
