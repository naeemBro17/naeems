// Batch 43 Part 3: asks smart_below_cost for the order lines (kept apart
// from belowCost.ts so the words can be tested without a database).
import { useEffect, useMemo, useState } from 'react';
import { checkBelowCost } from './api';
import type { BelowCostInput } from './belowCost';
import type { BelowCostAnswer } from './types';

/** Asks the database again (after a short pause) whenever a line changes. */
export function useBelowCost(lines: readonly BelowCostInput[], enabled: boolean): Map<string, BelowCostAnswer> {
  const [answers, setAnswers] = useState<Map<string, BelowCostAnswer>>(new Map());
  const signature = useMemo(
    () => JSON.stringify(lines.map((l) => [l.key, l.product_id, l.variant_id, l.sold_unit, l.price, l.quantity])),
    [lines]
  );
  useEffect(() => {
    if (!enabled || lines.length === 0) {
      setAnswers(new Map());
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      const ask = lines.map(({ key: _key, ...line }) => line);
      void checkBelowCost(ask).then((result) => {
        if (!alive || !result) return;
        const map = new Map<string, BelowCostAnswer>();
        lines.forEach((l, i) => {
          if (result[i]) map.set(l.key, result[i]);
        });
        setAnswers(map);
      });
    }, 350);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // The signature covers every field that changes the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, enabled]);
  return answers;
}
