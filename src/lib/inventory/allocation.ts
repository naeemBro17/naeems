import { roundDiv, toScaled } from './decimal';

/**
 * Landed cost of a lot — the same rule as the database's
 * inventory_allocate_lot() (migration-042), so the preview shows exactly
 * what Save will store. Batch 38, extended in Batch 39 with units and
 * guessed weights:
 *   entered          = packs or loose units, as typed (entryUnit)
 *   units            = packs × pack size, or the loose units
 *   buy price (৳)    = price × exchange rate, per pack / unit (4 decimals)
 *   buy value        = entered × buy price (exact)
 *   weight bills, shared by grams: grams of a row = units × (weight per
 *     pack ÷ pack size). A row with no weight gets one guessed from its
 *     buy value, at the lot's own grams per taka of the rows that have a
 *     weight. No row with a weight → shared by buy value.
 *   other bills, shared by buy value (every value 0 → by units)
 *   Largest remainder in whole paisa, so the rows add up to EXACTLY the
 *   lot's totals (ties: the row higher in the list).
 *   landed cost per unit = (buy value + row shares) ÷ units
 * With pack size 1 and every weight filled in this is exactly Batch 38.
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
  /** Weight of one pack in grams; empty = guessed from price. */
  weightGrams: string | number | null;
  /** For messages. */
  label: string;
}

export interface AllocCostInput {
  costType: 'weight' | 'other';
  amountBdt: string | number;
}

export type WeightRule = 'none' | 'grams' | 'guess' | 'value';

export interface AllocRow {
  /** Units this row adds to stock. */
  qty: number;
  /** Buy price per entered pack / unit in taka, 4 decimals (scaled). */
  unitPriceBdtE4: bigint;
  /** Buy value of the row in taka, 4 decimals (scaled). */
  buyValueE4: bigint;
  /** The row's share of the weight / other bills, in paisa. */
  weightPaisa: bigint;
  otherPaisa: bigint;
  /** The row had no weight; its weight was guessed from its price. */
  weightGuessed: boolean;
  /** Per unit, in taka (for showing). */
  buyUnitBdt: number;
  weightUnitBdt: number;
  otherUnitBdt: number;
  landedUnitBdt: number;
}

export type AllocResult =
  | {
      ok: true;
      rows: AllocRow[];
      weightRule: WeightRule;
      weightTotalPaisa: bigint;
      otherTotalPaisa: bigint;
      allocatedWeightPaisa: bigint;
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

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** Units a row adds: packs × pack size, or the loose units typed. */
export function rowUnits(qty: number, entryUnit: EntryUnit = 'pack', packSize = 1): number {
  return entryUnit === 'unit' ? qty : qty * packSize;
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

  const parsed: { units: bigint; pack: bigint; priceE4: bigint; valueE4: bigint; gramsE2: bigint | null }[] = [];
  for (const item of items) {
    const pack = item.packSize && item.packSize > 1 ? item.packSize : 1;
    const entry: EntryUnit = pack > 1 && item.entryUnit === 'unit' ? 'unit' : 'pack';
    const price = toScaled(item.unitPriceForeign, 4);
    const what = entry === 'unit' ? 'Units' : pack > 1 ? 'Packs' : 'Pieces';
    if (!Number.isInteger(item.qty) || item.qty <= 0) return { ok: false, error: `${what} for ${item.label} must be a whole number above 0.` };
    if (price === null || price < 0n) return { ok: false, error: `Enter the buy price for ${item.label}.` };
    const grams = item.weightGrams === null || item.weightGrams === '' ? null : toScaled(item.weightGrams, 2);
    if (grams !== null && grams <= 0n) return { ok: false, error: `Weight for ${item.label} must be above 0.` };
    const priceE4 = roundDiv(price * rate, 1_000_000n);
    parsed.push({
      units: BigInt(rowUnits(item.qty, entry, pack)),
      pack: BigInt(pack),
      priceE4,
      valueE4: BigInt(item.qty) * priceE4,
      gramsE2: grams,
    });
  }

  // A common multiple of the pack sizes keeps every row's grams whole.
  let lcm = 1n;
  for (const p of parsed) if (p.gramsE2 !== null) lcm = (lcm * p.pack) / gcd(lcm, p.pack);
  const grams = parsed.map((p) => (p.gramsE2 === null ? 0n : p.units * p.gramsE2 * (lcm / p.pack)));
  const weighted = parsed.map((p) => p.gramsE2 !== null);
  const g = grams.reduce((a, b) => a + b, 0n);
  const v = parsed.reduce((a, p, i) => (weighted[i] ? a + p.valueE4 : a), 0n);
  const hasWeighted = weighted.some(Boolean);
  const hasUnweighted = weighted.some((w) => !w);
  const rule: WeightRule =
    weightTotal === 0n ? 'none' : !hasUnweighted ? 'grams' : hasWeighted && v > 0n && g > 0n ? 'guess' : 'value';

  const valueBases = parsed.map((p) => p.valueE4);
  const valueSum = valueBases.reduce((a, b) => a + b, 0n);
  const byValue = valueSum > 0n ? valueBases : parsed.map((p) => p.units);
  const weightBases = parsed.map((p, i) => {
    switch (rule) {
      case 'none':
        return 0n;
      case 'grams':
        return grams[i];
      case 'guess':
        // guessed grams = value × (G ÷ V); everything × V stays whole
        return weighted[i] ? grams[i] * v : p.valueE4 * g;
      default:
        return byValue[i];
    }
  });
  const weightShares = largestRemainder(weightTotal, weightBases);
  const otherShares = largestRemainder(otherTotal, byValue);

  const rows: AllocRow[] = parsed.map((p, i) => {
    const units = Number(p.units);
    const buyUnitBdt = Number(p.valueE4) / 10000 / units;
    const weightUnitBdt = Number(weightShares[i]) / units / 100;
    const otherUnitBdt = Number(otherShares[i]) / units / 100;
    return {
      qty: units,
      unitPriceBdtE4: p.priceE4,
      buyValueE4: p.valueE4,
      weightPaisa: weightShares[i],
      otherPaisa: otherShares[i],
      weightGuessed: (rule === 'guess' || rule === 'value') && !weighted[i],
      buyUnitBdt,
      weightUnitBdt,
      otherUnitBdt,
      landedUnitBdt: buyUnitBdt + weightUnitBdt + otherUnitBdt,
    };
  });
  return {
    ok: true,
    rows,
    weightRule: rule,
    weightTotalPaisa: weightTotal,
    otherTotalPaisa: otherTotal,
    allocatedWeightPaisa: weightShares.reduce((a, b) => a + b, 0n),
    allocatedOtherPaisa: otherShares.reduce((a, b) => a + b, 0n),
    buyTotalPaisa: roundDiv(valueSum, 100n),
  };
}
