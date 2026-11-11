/* Batch 43 Part 3: "Below cost" under an order line. The database decides
   (smart_below_cost); this only words the answer. Never blocks saving. */
import { moneyText } from '../money/format';
import type { BelowCostAnswer, BelowCostLine } from './types';

export interface BelowCostInput extends BelowCostLine {
  key: string;
}

/** The words under a line; null = nothing to show. */
export function belowCostText(answer: BelowCostAnswer | undefined, canSeeCost: boolean): string | null {
  if (!answer?.below) return null;
  if (!canSeeCost || answer.cost === null) return 'Below cost — check with Naeem';
  const loss = answer.loss !== null && answer.loss > 0 ? `, loss ${moneyText(answer.loss)}` : '';
  return `Below cost — cost ${moneyText(answer.cost)} each${loss}`;
}
