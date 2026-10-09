/**
 * Batch 36 Part 2: rich product text, the parts that need no browser — is
 * a stored value rich (HTML from the editor) or old plain text, and its
 * plain-text version for the meta description and link previews.
 */

/** Rich values are what the editor saves: they start with a block tag.
 *  Everything else is old plain text and renders exactly as before. */
export function isRichText(value: string | null | undefined): boolean {
  return /^\s*<(p|h3|ul|ol|div)[\s>]/i.test(value ?? '');
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** One line of plain text: tags removed, blocks separated by a space. */
export function richTextToPlain(value: string | null | undefined): string {
  const raw = value ?? '';
  if (!isRichText(raw)) return raw.replace(/\s+/g, ' ').trim();
  return raw
    .replace(/<(br|\/p|\/h3|\/li|\/div)\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}
