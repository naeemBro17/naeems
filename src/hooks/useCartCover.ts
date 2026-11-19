import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { lineKey, optionVariantId } from '../lib/cartStock';

export interface CoverLine {
  productId: string;
  variantId: string | null;
  quantity: number;
  /** Only "Keep selling when out of stock" lines are asked about. */
  keepSelling: boolean;
}

/**
 * Batch 51: which cart lines stock does not fully cover (the cart's "Get it
 * in 3–5 days" note). The database answers yes / no per line (cart_cover),
 * never a stock number. Before migration-052 (or offline) nothing is
 * marked. Returns the line keys (lineKey) that are NOT covered.
 */
export function useCartCover(lines: CoverLine[]): Set<string> {
  const asked = useMemo(() => lines.filter((l) => l.keepSelling), [lines]);
  const signature = asked.map((l) => `${lineKey(l.productId, l.variantId)}x${l.quantity}`).join('|');
  const [notCovered, setNotCovered] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (asked.length === 0) {
      setNotCovered(new Set());
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      void supabase
        .rpc('cart_cover', {
          p_lines: asked.map((l) => ({
            product_id: l.productId,
            variant_id: optionVariantId(l.productId, l.variantId),
            quantity: l.quantity,
          })),
        })
        .then(({ data, error }) => {
          if (!alive) return;
          if (error || !Array.isArray(data)) {
            setNotCovered(new Set());
            return;
          }
          const rows = data as { product_id: string; variant_id: string | null; covered: boolean }[];
          const next = new Set<string>();
          for (const row of rows) {
            if (row.covered) continue;
            // The answer carries the id the cart sent (the product's own size
            // is sent as no option, so match both ways).
            for (const l of asked) {
              if (l.productId === row.product_id && optionVariantId(l.productId, l.variantId) === (row.variant_id ?? null)) {
                next.add(lineKey(l.productId, l.variantId));
              }
            }
          }
          setNotCovered(next);
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // The signature holds every asked line and quantity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return notCovered;
}
