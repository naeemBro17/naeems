// Batch 63: small pieces of Admin → New order's new look (search results
// with photos, the item count), kept here so they can be tested on their own.

/** The circle on a customer result: the first letter of the first two words
 *  of the name; with no name, the last two digits of the phone. */
export function customerInitials(name: string, phone: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    return words
      .slice(0, 2)
      .map((w) => Array.from(w)[0] ?? '')
      .join('')
      .toUpperCase();
  }
  const digits = phone.replace(/\D/g, '');
  return digits.slice(-2);
}

export type StockTone = 'normal' | 'low' | 'out';

/** The stock line under a product result: "12 in stock", "Only 2 left"
 *  (1 to 3), "Out of stock" (0 or less), nothing when stock isn't counted. */
export function stockLine(stockQuantity: number | null): { text: string; tone: StockTone } | null {
  if (stockQuantity === null) return null;
  if (stockQuantity <= 0) return { text: 'Out of stock', tone: 'out' };
  if (stockQuantity <= 3) return { text: `Only ${stockQuantity} left`, tone: 'low' };
  return { text: `${stockQuantity} in stock`, tone: 'normal' };
}

/** "1 item" / "3 items". */
export function itemsWord(count: number): string {
  return `${count} item${count === 1 ? '' : 's'}`;
}
