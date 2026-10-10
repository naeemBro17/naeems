import type { OrderItem } from '../types';

/**
 * Batch 39: an order line can be sold in loose units ("150 pcs" of a 400
 * pcs bottle, admin only). Its quantity is then the number of units and
 * its price is per unit. To the customer (invoice, order pages) such a
 * line reads as one item: "Fish Oil 1000mg — 150 pcs", 1 × the line total.
 * Lines sold in whole packs (every order so far) read exactly as before.
 */
type Line = Pick<OrderItem, 'quantity'> & { sold_unit?: OrderItem['sold_unit'] };

export function soldInUnits(item: Line): boolean {
  return Boolean(item.sold_unit);
}

/** "150 pcs" for a loose-unit line, else the quantity ("2"). */
export function lineQuantityText(item: Line): string {
  return item.sold_unit ? `${item.quantity} ${item.sold_unit}` : String(item.quantity);
}

/** Items in an order, counting a loose-unit line as one item. */
export function orderItemCount(items: readonly Line[]): number {
  return items.reduce((n, item) => n + (item.sold_unit ? 1 : item.quantity), 0);
}

/** "Fish Oil 1000mg — 150 pcs" (or the name unchanged for a pack line). */
export function lineNameWithUnits(name: string, item: Line): string {
  return item.sold_unit ? `${name} — ${item.quantity} ${item.sold_unit}` : name;
}
