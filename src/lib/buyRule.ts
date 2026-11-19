/**
 * Batch 52.1: THE rule for "can this be bought?" — the product card, the
 * product page, the combo page, the wishlist, the cart's + button and the
 * cart's "just sold out" re-check all ask this one file, so they can never
 * disagree again. The database follows the same rule in place_order().
 *
 *   Keep selling ON  → any number, up to the order limit for customers.
 *   Keep selling OFF → only what is in stock (and the limit for customers).
 *
 * An option (variant) always follows its product's "Keep selling".
 *
 * Batch 52.1 root cause: the cart's re-check read only the stock number.
 * Customers never saw that number for keep-selling products (the database
 * hides it), but staff do — so for the admin the cart removed every
 * keep-selling item at stock 0 as "just sold out".
 */

/** What the shop knows about one product option's stock. `stock` is null
 *  when the number is not shown (a keep-selling product, for a customer)
 *  or not counted. */
export interface StockFacts {
  keepSelling: boolean;
  stock: number | null;
}

/** Who is buying: customers have the order limit; wholesalers and the
 *  admin (the database's is_wholesaler_or_admin()) have none. */
export type Buyer = 'customer' | 'wholesaler' | 'admin';

/**
 * The most units of one cart line stock allows (Batch 27): the tracked
 * stock count when the product (or option) tracks one, otherwise no limit.
 * A blank count means "not tracking exact quantity", never zero.
 */
export function stockLimit(stockQuantity: number | null | undefined): number {
  if (stockQuantity === null || stockQuantity === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(stockQuantity));
}

interface ProductStockRow {
  keep_selling?: boolean;
  stock_quantity: number | null | undefined;
  stock_status: string | null;
}

interface OptionStockRow {
  keep_selling?: boolean;
  stock_quantity: number | null | undefined;
  in_stock: boolean;
}

/** A product's own stock facts. Not counted + marked out of stock = 0. */
export function productStockFacts(product: ProductStockRow): StockFacts {
  const counted = product.stock_quantity !== null && product.stock_quantity !== undefined;
  return {
    keepSelling: product.keep_selling === true,
    stock: counted ? (product.stock_quantity as number) : product.stock_status === 'out_of_stock' ? 0 : null,
  };
}

/** An option's stock facts. "Keep selling" is its product's: the option's
 *  own copy (the shop views send it) or, failing that, the product's. */
export function optionStockFacts(option: OptionStockRow, productKeepSelling?: boolean): StockFacts {
  const counted = option.stock_quantity !== null && option.stock_quantity !== undefined;
  return {
    keepSelling: (option.keep_selling ?? productKeepSelling) === true,
    stock: counted ? (option.stock_quantity as number) : option.in_stock ? null : 0,
  };
}

/** Units stock lets the shop sell right now (no order limit). Infinity =
 *  no stock cap (keep selling, or not counted and in stock). */
export function unitsSellable(facts: StockFacts): number {
  return facts.keepSelling ? Number.POSITIVE_INFINITY : stockLimit(facts.stock);
}

/** The most of one product option that may be in one order. */
export function maxQuantity(facts: StockFacts, limit: number, buyer: Buyer): number {
  const cap = unitsSellable(facts);
  return buyer === 'customer' ? Math.min(cap, limit) : cap;
}

/** "Can this buyer have n units of it in one order?" */
export function canBuy(facts: StockFacts, quantity: number, limit: number, buyer: Buyer): boolean {
  return quantity >= 1 && quantity <= maxQuantity(facts, limit, buyer);
}

/** Whether the shop shows it as buyable at all (at least one unit). */
export function isBuyable(facts: StockFacts): boolean {
  return unitsSellable(facts) >= 1;
}
