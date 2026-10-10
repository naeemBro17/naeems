import { roundDiv, toScaled } from './decimal';

/**
 * Batch 38 Part 2: landed cost of a lot — the same rule as the database's
 * inventory_allocate_lot() (migration-040), so the preview shows exactly
 * what Save will store:
 *   buy price in taka = buy price × exchange rate (to 4 decimals)
 *   weight bills shared by grams       (row basis = qty × grams)
 *   other bills shared by buy value    (row basis = qty × buy price in taka;
 *                                       every price 0 → by pieces)
 *   Largest remainder in whole paisa, so the rows add up to EXACTLY the
 *   lot's totals (ties: the row higher in the list).
 *   landed cost per piece = buy price in taka + row shares ÷ qty
 */
export interface AllocItemInput {
  qty: number;
  /** Buy price per piece in the lot's currency. */
  unitPriceForeign: string | number;
  weightGrams: string | number | null;
  /** For the "Enter weight for: …" message. */
  label: string;
}

export interface AllocCostInput {
  costType: 'weight' | 'other';
  amountBdt: string | number;
}

export interface AllocRow {
  qty: number;
  /** Buy price per piece in taka, 4 decimals (scaled). */
  unitPriceBdtE4: bigint;
  /** The row's share of the weight / other bills, in paisa. */
  weightPaisa: bigint;
  otherPaisa: bigint;
  /** Per piece, in taka (for showing). */
  buyUnitBdt: number;
  weightUnitBdt: number;
  otherUnitBdt: number;
  landedUnitBdt: number;
}

export type AllocResult =
  | {
      ok: true;
      rows: AllocRow[];
      weightTotalPaisa: bigint;
      otherTotalPaisa: bigint;
      allocatedWeightPaisa: bigint;
      allocatedOtherPaisa: bigint;
      /** Sum of qty × buy price in taka, in paisa (rounded). */
      buyTotalPaisa: bigint;
    }
  | { ok: false; error: string };

/** Splits `total` paisa by the row bases, exactly (largest remainder). */
export function largestRemainder(total: bigint, bases: readonly bigint[]): bigint[] {
  const sum = bases.reduce((a, b) => a + b, 0n);
  if (sum <= 0n || total === 0n) return bases.map(() => 0n);
  const floors = bases.map((b) => (total * b) / sum);
  const rems = bases.map((b) => (total * b) % sum);
  let left = total - floors.reduce((a, b) => a + b, 0n);
  const order = bases.map((_, i) => i).sort((a, b) => (rems[b] > rems[a] ? 1 : rems[b] < rems[a] ? -1 : a - b));
  const out = [...floors];
  for (const i of order) {
    if (left <= 0n) break;
    out[i] += 1n;
    left -= 1n;
  }
  return out;
}

export function allocateLot(items: readonly AllocItemInput[], costs: readonly AllocCostInput[], exchangeRate: string | number): AllocResult {
  const rate = toScaled(exchangeRate, 6);
  if (rate === null || rate <= 0n) return { ok: false, error: 'Enter the exchange rate.' };
  let weightTotal = 0n;
  let otherTotal = 0n;
  for (const cost of costs) {
    const amount = toScaled(cost.amountBdt, 2);
    if (amount === null || amount < 0n) return { ok: false, error: 'Cost amounts must be 0 or more.' };
    if (cost.costType === 'weight') weightTotal += amount;
    else otherTotal += amount;
  }
  const parsed: { qty: bigint; priceE4: bigint; gramsE2: bigint | null; label: string }[] = [];
  for (const item of items) {
    const price = toScaled(item.unitPriceForeign, 4);
    if (!Number.isInteger(item.qty) || item.qty <= 0) return { ok: false, error: `Pieces for ${item.label} must be a whole number above 0.` };
    if (price === null || price < 0n) return { ok: false, error: `Enter the buy price for ${item.label}.` };
    const grams = item.weightGrams === null || item.weightGrams === '' ? null : toScaled(item.weightGrams, 2);
    if (grams !== null && grams <= 0n) return { ok: false, error: `Weight for ${item.label} must be above 0.` };
    parsed.push({ qty: BigInt(item.qty), priceE4: roundDiv(price * rate, 1_000_000n), gramsE2: grams, label: item.label });
  }
  if (weightTotal > 0n) {
    const missing = parsed.filter((p) => p.gramsE2 === null).map((p) => p.label);
    if (missing.length > 0) return { ok: false, error: `Enter weight for: ${missing.join(', ')}` };
  }
  const weightBases = parsed.map((p) => (weightTotal > 0n ? p.qty * (p.gramsE2 ?? 0n) : 0n));
  const valueBases = parsed.map((p) => p.qty * p.priceE4);
  const valueSum = valueBases.reduce((a, b) => a + b, 0n);
  const otherBases = valueSum > 0n ? valueBases : parsed.map((p) => p.qty);
  const weightShares = largestRemainder(weightTotal, weightBases);
  const otherShares = largestRemainder(otherTotal, otherBases);

  const rows: AllocRow[] = parsed.map((p, i) => {
    const qty = Number(p.qty);
    const buyUnitBdt = Number(p.priceE4) / 10000;
    const weightUnitBdt = Number(weightShares[i]) / qty / 100;
    const otherUnitBdt = Number(otherShares[i]) / qty / 100;
    return {
      qty,
      unitPriceBdtE4: p.priceE4,
      weightPaisa: weightShares[i],
      otherPaisa: otherShares[i],
      buyUnitBdt,
      weightUnitBdt,
      otherUnitBdt,
      landedUnitBdt: buyUnitBdt + weightUnitBdt + otherUnitBdt,
    };
  });
  return {
    ok: true,
    rows,
    weightTotalPaisa: weightTotal,
    otherTotalPaisa: otherTotal,
    allocatedWeightPaisa: weightShares.reduce((a, b) => a + b, 0n),
    allocatedOtherPaisa: otherShares.reduce((a, b) => a + b, 0n),
    buyTotalPaisa: roundDiv(valueSum, 100n),
  };
}
