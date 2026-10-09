// Batch 37: Code 128 barcode for the consignment ID on the parcel label.
// Steadfast IDs are digits, so code set C (two digits per symbol) keeps the
// barcode short and easy to scan; anything else uses code set B.

/** Bar/space widths for symbol values 0–105 (each adds up to 11 modules). */
export const CODE128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232',
];
export const CODE128_STOP = '2331112';

const START_B = 104;
const START_C = 105;
const CODE_B = 100;

/** The symbol values (start, data, checksum) for the text. Throws on a
 *  character Code 128 B cannot hold. */
export function code128Values(text: string): number[] {
  const values: number[] = [];
  const digitsOnly = /^\d+$/.test(text) && text.length >= 2;
  if (digitsOnly) {
    values.push(START_C);
    const pairs = text.length - (text.length % 2);
    for (let i = 0; i < pairs; i += 2) values.push(Number(text.slice(i, i + 2)));
    if (pairs < text.length) {
      values.push(CODE_B);
      values.push(text.charCodeAt(text.length - 1) - 32);
    }
  } else {
    values.push(START_B);
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code < 32 || code > 126) throw new Error(`Code 128 cannot hold "${ch}"`);
      values.push(code - 32);
    }
  }
  let sum = values[0];
  for (let i = 1; i < values.length; i += 1) sum += values[i] * i;
  values.push(sum % 103);
  return values;
}

/** Alternating bar/space widths in modules, starting with a bar. */
export function code128Widths(text: string): number[] {
  const pattern = code128Values(text).map((v) => CODE128_PATTERNS[v]).join('') + CODE128_STOP;
  return pattern.split('').map(Number);
}
