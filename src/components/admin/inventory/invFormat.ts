import { takaExact } from '../../../lib/payouts';
import type { LotSourceType, MovementType } from '../../../lib/inventory/types';

/** Batch 38: small wording helpers shared by the Inventory screens. */

export function sourceLabel(source: LotSourceType | 'import' | 'wholesale' | null): string {
  switch (source) {
    case 'import':
      return 'Import';
    case 'wholesale':
      return 'Wholesale';
    case 'local':
      return 'Local';
    default:
      return 'Mixed';
  }
}

export function movementLabel(type: MovementType): string {
  const labels: Record<MovementType, string> = {
    opening: 'Opening stock',
    purchase: 'Bought (lot)',
    sale: 'Sold',
    cancel: 'Order cancelled',
    return: 'Returned',
    adjustment: 'Adjustment',
  };
  return labels[type];
}

/** "8 Oct 2026" from "2026-10-08". */
export function formatLotDate(date: string | null): string {
  if (!date) return '—';
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}

/** Taka with paisa from a taka amount (per-piece costs). */
export function taka2(amount: number): string {
  return takaExact(Math.round(amount * 100));
}
