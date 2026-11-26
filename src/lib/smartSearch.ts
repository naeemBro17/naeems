import Fuse from 'fuse.js';
import { normalizeText } from './format';

// Batch 70: search like Kaarbar. The query is split into words; a product
// matches when EVERY word is found in its text, as the start of a word
// ("aus" finds "AUSTRALIA", "236" finds "236ml", "f" finds "Foaming"), in
// any order. Words that start the product name rank first. When nothing
// matches word by word (a typo like "cerve"), Fuse finds close spellings.
function words(text: string): string[] {
  return normalizeText(text)
    .replace(/[^a-z0-9ঀ-৿]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

export function matchesAllWords(haystack: string, query: string): boolean {
  const hay = words(haystack);
  const needles = words(query);
  if (needles.length === 0) return true;
  return needles.every((n) => hay.some((h) => h.startsWith(n)));
}

function score(haystack: string, query: string): number {
  const hay = words(haystack);
  const needles = words(query);
  let s = 0;
  needles.forEach((n, i) => {
    const at = hay.findIndex((h) => h.startsWith(n));
    if (at === i) s += 3;
    if (hay[at] === n) s += 2;
    s += Math.max(0, 5 - at) * 0.2;
  });
  return s;
}

export function smartSearch<T>(items: readonly T[], query: string, textOf: (item: T) => string): T[] {
  const q = query.trim();
  if (q === '') return [...items];
  const exact = items
    .map((item) => ({ item, text: textOf(item) }))
    .filter((row) => matchesAllWords(row.text, q))
    .sort((a, b) => score(b.text, q) - score(a.text, q))
    .map((row) => row.item);
  if (exact.length > 0) return exact;
  if (q.length < 3) return [];
  const fuse = new Fuse(
    items.map((item) => ({ item, text: normalizeText(textOf(item)) })),
    { keys: ['text'], threshold: 0.4, ignoreLocation: true, minMatchCharLength: 2 }
  );
  return fuse.search(normalizeText(q)).map((hit) => hit.item.item);
}
