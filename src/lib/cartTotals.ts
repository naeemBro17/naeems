// Batch 67: small pure helpers for the Cart and Order Summary screens.

interface CountedLine {
  quantity: number;
}

interface PricedLine extends CountedLine {
  unitPrice: number;
  retail: number | null;
}

/** How many pieces are in the cart ("3 items"), not how many lines. */
export function countPieces(items: CountedLine[]): number {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

/** How much the customer saves against retail ("You save ৳750"). A line
 *  counts only when its retail price is known and above what it costs. */
export function cartYouSave(items: PricedLine[]): number {
  return items.reduce(
    (sum, item) =>
      item.retail !== null && item.retail > item.unitPrice ? sum + (item.retail - item.unitPrice) * item.quantity : sum,
    0
  );
}

/** "House 32, Road 7, Dhanmondi, Dhaka": thana / district added only when
 *  the typed address does not already say them (and a district with the
 *  same name as the thana only once). */
export function summaryAddressLine(address: { fullAddress: string; thana: string; district: string }): string {
  const parts = [address.fullAddress, address.thana, address.district].map((part) => part.trim());
  const first = parts[0].toLowerCase();
  return parts
    .filter(
      (part, index) =>
        part !== '' &&
        (index === 0 ||
          (!first.includes(part.toLowerCase()) &&
            !parts.slice(1, index).some((earlier) => earlier.toLowerCase() === part.toLowerCase())))
    )
    .join(', ');
}
