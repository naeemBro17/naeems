/**
 * Exact decimal maths for the Inventory screens (Batch 38). A value is held
 * as a whole number (BigInt) at a fixed number of decimals — 1234.5 at 2
 * decimals is 123450n — so the preview works out exactly what the
 * database's numeric type stores, with no floating-point drift.
 */

/** Rounds n ÷ d to a whole number, halves away from zero (like Postgres round()). */
export function roundDiv(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('Division by zero');
  const negative = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (2n * an + ad) / (2n * ad);
  return negative ? -q : q;
}

export function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

/**
 * Reads "1,234.567", " 12 ", 12.5 … at a fixed number of decimals (extra
 * decimals rounded half away from zero). Commas and spaces are thousands
 * separators. null for blank or not a number.
 */
export function toScaled(value: string | number | null | undefined, decimals: number): bigint | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = /e/i.test(String(value)) ? value.toFixed(Math.min(20, decimals + 8)) : String(value);
  } else {
    text = value.replace(/[,\s]/g, '');
  }
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) return null;
  const [, sign, whole, fraction = ''] = match;
  const digits = BigInt((whole === '' ? '0' : whole) + fraction);
  const scaled = roundDiv(digits * pow10(decimals), pow10(fraction.length));
  return sign ? -scaled : scaled;
}

/** A scaled value back to a JS number (for showing only). */
export function fromScaled(value: bigint, decimals: number): number {
  return Number(value) / Number(pow10(decimals));
}

/** A scaled value as plain text with exactly `decimals` digits ("12.3400"). */
export function scaledText(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = pow10(decimals);
  const whole = abs / unit;
  const fraction = decimals > 0 ? `.${String(abs % unit).padStart(decimals, '0')}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}
