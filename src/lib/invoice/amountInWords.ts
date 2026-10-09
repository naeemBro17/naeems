// Batch 37: "Four thousand seventy-nine taka only" for the invoice — the
// Bangladeshi way of grouping (crore, lakh, thousand, hundred), so
// 1,20,450 reads "One lakh twenty thousand four hundred fifty".

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  return n % 10 === 0 ? tens : `${tens}-${ONES[n % 10]}`;
}

/** Words for a whole number 1 or more (no "zero", no currency). */
function wholeWords(n: number): string {
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  let rest = n % 10_000_000;
  if (crore > 0) parts.push(`${wholeWords(crore)} crore`);
  const lakh = Math.floor(rest / 100_000);
  rest %= 100_000;
  if (lakh > 0) parts.push(`${belowHundred(lakh)} lakh`);
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  if (thousand > 0) parts.push(`${belowHundred(thousand)} thousand`);
  const hundred = Math.floor(rest / 100);
  rest %= 100;
  if (hundred > 0) parts.push(`${ONES[hundred]} hundred`);
  if (rest > 0) parts.push(belowHundred(rest));
  return parts.join(' ');
}

/** "Four thousand seventy-nine taka only"; paisa when there are any:
 *  "Ten taka and fifty paisa only". Negative amounts read as their size. */
export function amountInWords(amount: number): string {
  const paisaTotal = Math.round(Math.abs(amount) * 100);
  const taka = Math.floor(paisaTotal / 100);
  const paisa = paisaTotal % 100;
  const takaText = taka === 0 ? 'zero' : wholeWords(taka);
  const text = paisa > 0 ? `${takaText} taka and ${belowHundred(paisa)} paisa only` : `${takaText} taka only`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
