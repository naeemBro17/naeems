import { shortLeft, useCountdown } from './useCountdown';
import type { CartLineSale } from '../../features/checkout/types';
import { SparkIcon } from '../checkout/b67Icons';

/** Batch 66: "Summer Fest · ends in 2d 04:05:09" under a sale line. At
 *  zero the campaign store re-prices the cart (CampaignProvider).
 *  Batch 67: star for the glitter style, the time in bold. */
export function CartSaleTag({ sale }: { sale: CartLineSale }) {
  const left = useCountdown(sale.endsAt);
  if (left.done) return null;
  const glitter = sale.style === 'glitter';
  return (
    <span className={`cmp-linetag${glitter ? ' cmp-linetag--glitter' : ''}`} data-testid="cart-sale-tag">
      {glitter && <SparkIcon />}
      {sale.campaignName} · ends in <b>{shortLeft(left)}</b>
    </span>
  );
}
