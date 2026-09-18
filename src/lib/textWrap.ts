/**
 * Splits a product card's name into exactly two display lines, measured
 * against the card's real rendered width — see Naeems.txt "PART 1" for the
 * measurements that led to this approach. CSS-only wrapping (word-break,
 * overflow-wrap) can't express "prefer whole words, but break a word if
 * skipping it whole would waste the rest of the line" — the browser only
 * ever does one or the other, so this does it manually with canvas
 * measureText and picks the CSS can't reach.
 */

let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureContext(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    measureCtx = ctx;
  }
  return measureCtx;
}

function textWidth(text: string, font: string): number {
  const ctx = getMeasureContext();
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** Longest prefix of `word` (by character count) that renders within `maxWidth`. */
function longestFittingPrefix(word: string, maxWidth: number, font: string): number {
  let lo = 0;
  let hi = word.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(word.slice(0, mid), font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const ELLIPSIS = '…';

function truncateToWidth(text: string, maxWidthPx: number, font: string): string {
  if (textWidth(text, font) <= maxWidthPx) return text;
  const budget = Math.max(0, maxWidthPx - textWidth(ELLIPSIS, font));
  const fit = longestFittingPrefix(text, budget, font);
  return text.slice(0, fit).trimEnd() + ELLIPSIS;
}

export interface TwoLineSplit {
  line1: string;
  line2: string;
}

/** A mid-word break must leave at least this many characters on both sides.
 *  Measured live against the real catalogue at the narrow end of phone
 *  widths (~360px): a threshold of 2 let "Daily" split into "Dai" + "ly" —
 *  not a single stray letter, but still reads as a broken word for almost
 *  no gain (skipping it whole costs only ~2 characters of line-1 width). 3
 *  was the smallest threshold that stopped choosing that trade at 320–428px
 *  across the real product names that were failing. */
const MIN_FRAGMENT_CHARS = 3;

/**
 * Splits `name` into two lines that fit `maxWidthPx` at the given canvas
 * `font` string (e.g. `"700 11.5px 'Plus Jakarta Sans', sans-serif"`).
 *
 * Strategy: fill line 1 with whole words first. If everything left fits on
 * line 2 as whole words too, stop there — no name that already fits in two
 * lines is ever broken mid-word. Only when the name would otherwise be
 * truncated does it consider spilling part of the next word onto line 1,
 * and only when that doesn't strand a lone 1-character fragment on
 * either side of the break. Line 2, if still too long, is truncated with
 * an ellipsis — never a new third line, so there's nothing to strand.
 */
export function splitProductName(name: string, maxWidthPx: number, font: string): TwoLineSplit {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { line1: '', line2: '' };

  const line1Words: string[] = [];
  let idx = 0;
  while (idx < words.length) {
    const candidate = [...line1Words, words[idx]].join(' ');
    if (textWidth(candidate, font) <= maxWidthPx) {
      line1Words.push(words[idx]);
      idx++;
    } else {
      break;
    }
  }

  // The whole name fits on line 1 alone.
  if (idx === words.length) {
    return { line1: line1Words.join(' '), line2: '' };
  }

  // Not even the first word fits whole on a fresh line — break it, since
  // there is no whole-word alternative to prefer.
  if (line1Words.length === 0) {
    const fit = Math.max(longestFittingPrefix(words[0], maxWidthPx, font), 1);
    const remaining = [words[0].slice(fit), ...words.slice(1)].join(' ');
    return { line1: words[0].slice(0, fit), line2: truncateToWidth(remaining, maxWidthPx, font) };
  }

  const remainingWords = words.slice(idx);
  const remainingWhole = remainingWords.join(' ');

  // Everything left fits whole on line 2 — plain word-wrap already works,
  // so there's nothing to gain (and an orphan to risk) by breaking a word.
  if (textWidth(remainingWhole, font) <= maxWidthPx) {
    return { line1: line1Words.join(' '), line2: remainingWhole };
  }

  // Line 2 is going to be truncated regardless. See if part of the next
  // word can usefully extend line 1 without stranding a lone character.
  const usedWidth = textWidth(line1Words.join(' ') + ' ', font);
  const leftover = maxWidthPx - usedWidth;
  const nextWord = remainingWords[0];
  const fit = longestFittingPrefix(nextWord, leftover, font);
  const remainderLen = nextWord.length - fit;

  if (fit >= MIN_FRAGMENT_CHARS && remainderLen >= MIN_FRAGMENT_CHARS) {
    const line1 = line1Words.join(' ') + ' ' + nextWord.slice(0, fit);
    const rest = [nextWord.slice(fit), ...remainingWords.slice(1)].join(' ');
    return { line1, line2: truncateToWidth(rest, maxWidthPx, font) };
  }

  return { line1: line1Words.join(' '), line2: truncateToWidth(remainingWhole, maxWidthPx, font) };
}

/** Canvas `font` shorthand matching an element's computed text style. */
export function fontStringOf(el: HTMLElement): string {
  const cs = getComputedStyle(el);
  return `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
}
