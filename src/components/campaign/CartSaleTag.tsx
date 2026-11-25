import { shortLeft, useCountdown } from './useCountdown';
import type { CartLineSale } from '../../features/checkout/types';

/** Batch 66: "Summer Fest · ends in 2d 04:05:09" under a sale line. At
 *  zero the campaign store re-prices the cart (CampaignProvider). */
export function CartSaleTag({ sale }: { sale: CartLineSale }) {
  const left = useCountdown(sale.endsAt);
  if (left.done) return null;
  return (
    <span className={`cmp-linetag${sale.style === 'glitter' ? ' cmp-linetag--glitter' : ''}`} data-testid="cart-sale-tag">
      {sale.campaignName} · ends in {shortLeft(left)}
    </span>
  );
}
