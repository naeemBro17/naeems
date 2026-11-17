import { roundDiv, toScaled } from './decimal';

/**
 * Landed cost of a lot — the same rule as the database's
 * inventory_allocate_lot() (Batch 45, migration-046), so the preview shows
 * exactly what Save will store:
 *   entered          = packs or loose units, as typed (entryUnit)
 *   units            = packs × pack size, or the loose units
 *   buy price (৳)    = price × exchange rate, per pack / unit (4 decimals)
 *   buy value        = entered × buy price (exact)
 *   other bills, shared by buy value (every value 0 → by units)
 *   Largest remainder in whole paisa, so the rows add up to EXACTLY the
 *   lot's total (ties: the row higher in the list).
 *   landed cost per unit = (buy value + the row's share) ÷ units
 * Batch 45: weight is not part of product cost. A weight bill (an old
 * one, kept as history) is ignored here, as in the database.
 */
export type EntryUnit = 'pack' | 'unit';

export interface AllocItemInput {
  /** Packs (entryUnit 'pack', the default) or loose units, as typed. */
  qty: number;
  entryUnit?: EntryUnit;
  /** Units in one pack (default 1). */
  packSize?: number;
  /** Buy price per pack / per unit (as entered) in the lot's currency. */
  unitPriceForeign: string | number;
  /** For messages. */
  label: string;
}

export interface AllocCostInput {
  costType: 'weight' | 'other';
  amountBdt: string | number;
}

export interface AllocRow {
  /** Units this row adds to stock. */
  qty: number;
  /** Buy price per entered pack / unit in taka, 4 decimals (scaled). */
  unitPriceBdtE4: bigint;
  /** Buy value of the row in taka, 4 decimals (scaled). */
  buyValueE4: bigint;
  /** The row's share of the other bills, in paisa. */
  otherPaisa: bigint;
  /** Per unit, in taka (for showing). */
  buyUnitBdt: number;
  otherUnitBdt: number;
  landedUnitBdt: number;
}

export type AllocResult =
  | {
      ok: true;
      rows: AllocRow[];
      otherTotalPaisa: bigint;
      allocatedOtherPaisa: bigint;
      /** Sum of the rows' buy values, in paisa (rounded). */
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

/** Units a row adds: packs × pack size, or the loose units typed. */
export function rowUnits(qty: number, entryUnit: EntryUnit = 'pack', packSize = 1): number {
  return entryUnit === 'unit' ? qty : qty * packSize;
}

export function allocateLot(items: readonly AllocItemInput[], costs: readonly AllocCostInput[], exchangeRate: string | number): AllocResult {
  const rate = toScaled(exchangeRate, 6);
  if (rate === null || rate <= 0n) return { ok: false, error: 'Enter the exchange rate.' };
  let otherTotal = 0n;
  for (const cost of costs) {
    const amount = toScaled(cost.amountBdt, 2);
    if (amount === null || amount < 0n) return { ok: false, error: 'Cost amounts must be 0 or more.' };
    if (cost.costType === 'other') otherTotal += amount;
  }

  const parsed: { units: bigint; priceE4: bigint; valueE4: bigint }[] = [];
  for (const item of items) {
    const pack = item.packSize && item.packSize > 1 ? item.packSize : 1;
    const entry: EntryUnit = pack > 1 && item.entryUnit === 'unit' ? 'unit' : 'pack';
    const price = toScaled(item.unitPriceForeign, 4);
    const what = entry === 'unit' ? 'Units' : pack > 1 ? 'Packs' : 'Pieces';
    if (!Number.isInteger(item.qty) || item.qty <= 0) return { ok: false, error: `${what} for ${item.label} must be a whole number above 0.` };
    if (price === null || price < 0n) return { ok: false, error: `Enter the buy price for ${item.label}.` };
    const priceE4 = roundDiv(price * rate, 1_000_000n);
    parsed.push({
      units: BigInt(rowUnits(item.qty, entry, pack)),
      priceE4,
      valueE4: BigInt(item.qty) * priceE4,
    });
  }

  const valueBases = parsed.map((p) => p.valueE4);
  const valueSum = valueBases.reduce((a, b) => a + b, 0n);
  const byValue = valueSum > 0n ? valueBases : parsed.map((p) => p.units);
  const otherShares = largestRemainder(otherTotal, byValue);

  const rows: AllocRow[] = parsed.map((p, i) => {
    const units = Number(p.units);
    const buyUnitBdt = Number(p.valueE4) / 10000 / units;
    const otherUnitBdt = Number(otherShares[i]) / units / 100;
    return {
      qty: units,
      unitPriceBdtE4: p.priceE4,
      buyValueE4: p.valueE4,
      otherPaisa: otherShares[i],
      buyUnitBdt,
      otherUnitBdt,
      landedUnitBdt: buyUnitBdt + otherUnitBdt,
    };
  });
  return {
    ok: true,
    rows,
    otherTotalPaisa: otherTotal,
    allocatedOtherPaisa: otherShares.reduce((a, b) => a + b, 0n),
    buyTotalPaisa: roundDiv(valueSum, 100n),
  };
}
