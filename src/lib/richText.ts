import DOMPurify from 'dompurify';

import { isRichText } from './richTextPlain';

export { isRichText, richTextToPlain } from './richTextPlain';

/**
 * Batch 36 Part 2: the formatting product descriptions may use. Colours
 * are stored by NAME (data-color / data-hl), never as hex, and each name
 * maps to a theme token in richText.css — a darker shade in light mode, a
 * brighter one in dark mode, so it is always readable.
 */
export const RT_TEXT_COLORS = ['orange', 'red', 'green', 'blue', 'purple', 'teal'] as const;
export const RT_HIGHLIGHTS = ['peach', 'yellow', 'mint'] as const;
export const RT_BOXES = ['warning', 'tip', 'benefits'] as const;

/** Fix Part 4: the one alignment value besides normal (left). */
export const RT_JUSTIFY = 'justify';

export type RtTextColor = (typeof RT_TEXT_COLORS)[number];
export type RtHighlight = (typeof RT_HIGHLIGHTS)[number];
export type RtBox = (typeof RT_BOXES)[number];

export const RT_COLOR_LABELS: Record<RtTextColor, string> = {
  orange: 'Orange',
  red: 'Red',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  teal: 'Teal',
};

export const RT_HIGHLIGHT_LABELS: Record<RtHighlight, string> = {
  peach: 'Peach',
  yellow: 'Yellow',
  mint: 'Mint',
};

export const RT_BOX_LABELS: Record<RtBox, string> = {
  warning: 'Warning box',
  tip: 'Tip box',
  benefits: 'Key benefits box',
};

// b / i are what Word and older pages use for bold / italic.
const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'h3', 'ul', 'ol', 'li', 'a', 'span', 'mark', 'div'];
const ALLOWED_ATTR = ['href', 'target', 'rel', 'data-color', 'data-hl', 'data-box', 'data-align'];

export const LINK_REL = 'noopener noreferrer nofollow';

/** Only http(s) links. */
export function safeLinkHref(href: string | null | undefined): string | null {
  const value = (href ?? '').trim();
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    // Kept exactly as typed once it is a valid http(s) address.
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

let hooked = false;

function addHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    const tag = el.tagName?.toLowerCase();
    if (!tag) return;
    if (tag === 'a') {
      const href = safeLinkHref(el.getAttribute('href'));
      if (href) {
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', LINK_REL);
      } else {
        el.removeAttribute('href');
        el.removeAttribute('target');
        el.removeAttribute('rel');
      }
    } else {
      el.removeAttribute('href');
      el.removeAttribute('target');
      el.removeAttribute('rel');
    }
    const color = el.getAttribute('data-color');
    if (color !== null && !(tag === 'span' && (RT_TEXT_COLORS as readonly string[]).includes(color))) {
      el.removeAttribute('data-color');
    }
    const hl = el.getAttribute('data-hl');
    if (hl !== null && !(tag === 'mark' && (RT_HIGHLIGHTS as readonly string[]).includes(hl))) {
      el.removeAttribute('data-hl');
    }
    // Only data-align="justify", only on a paragraph or heading.
    const align = el.getAttribute('data-align');
    if (align !== null && !((tag === 'p' || tag === 'h3') && align === RT_JUSTIFY)) {
      el.removeAttribute('data-align');
    }
    const box = el.getAttribute('data-box');
    if (box !== null && !(tag === 'div' && (RT_BOXES as readonly string[]).includes(box))) {
      el.removeAttribute('data-box');
    }
  });
}

/**
 * The allow-list: only the tags and named attributes above survive —
 * no <script>, no on* handlers, no style, no unknown tags (their text is
 * kept). Run on save AND on render.
 */
export function sanitizeRichHtml(html: string): string {
  addHooks();
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
  });
  return clean.trim();
}

/**
 * Pasting from Word / Google Docs / WhatsApp: the same allow-list, but
 * the style attribute is kept for one moment so the editor can tell real bold from
 * Google Docs' "not bold" wrapper. The editor then keeps only what it
 * knows (no colours, fonts or sizes), and the save cleans it again.
 */
export function sanitizePastedHtml(html: string): string {
  addHooks();
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: [...ALLOWED_ATTR, 'style'],
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
  });
  // Fix Part 2: each pasted line becomes its own line (paragraph).
  return splitLineBreaks(clean);
}

/** Old plain text → one paragraph per line and an empty paragraph for each
 *  blank line (used when an old value is opened in the editor, and for
 *  pasted plain text). Paragraphs have no gap between them, so it looks
 *  exactly like the old text. */
export function plainToEditorHtml(text: string): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line === '' ? '<p></p>' : `<p>${escape(line)}</p>`))
    .join('');
}

/**
 * Fix (rich-text editor) Part 2: every line break inside a paragraph
 * becomes its own paragraph, keeping the formatting around it (bold that
 * runs over a break is closed and reopened). A break that ends a paragraph
 * shows nothing on screen, so it is dropped. Used for pasted HTML and for
 * old saved text opened in the editor — the database is unchanged until
 * Naeem saves.
 */
export function splitLineBreaks(html: string): string {
  if (!/<br/i.test(html)) return html;
  const root = document.createElement('div');
  root.innerHTML = html;
  for (const p of Array.from(root.querySelectorAll('p'))) {
    const breaks = p.querySelectorAll('br');
    const finalBreak = breaks.length > 0 ? breaks[breaks.length - 1] : null;
    if (finalBreak) {
      const after = document.createRange();
      after.setStartAfter(finalBreak);
      after.setEnd(p, p.childNodes.length);
      if (after.toString() === '') finalBreak.remove();
    }
    let br = p.querySelector('br');
    while (br) {
      const before = document.createRange();
      before.setStart(p, 0);
      before.setEndBefore(br);
      const line = document.createElement('p');
      for (const attr of Array.from(p.attributes)) line.setAttribute(attr.name, attr.value);
      line.appendChild(before.extractContents());
      p.before(line);
      br.remove();
      br = p.querySelector('br');
    }
  }
  return root.innerHTML;
}

/** What the editor opens with for a saved value (old plain text or rich). */
export function toEditorHtml(value: string): string {
  return isRichText(value) ? splitLineBreaks(sanitizeRichHtml(value)) : plainToEditorHtml(value);
}

/** An editor value with no visible text ("<p></p>") counts as empty. */
export function isEmptyRichHtml(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() === '';
}

/** What is saved for a long product text: null when empty, the cleaned HTML
 *  when rich, otherwise the plain text exactly as typed (trimmed). */
export function cleanLongText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!isRichText(trimmed)) return trimmed;
  // The editor keeps an empty line after a box so typing can continue;
  // it is not saved.
  const clean = sanitizeRichHtml(trimmed).replace(/(<p>(<br>)?<\/p>)+$/, '');
  return isEmptyRichHtml(clean) ? null : clean;
}
