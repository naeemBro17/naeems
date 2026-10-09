import { useMemo } from 'react';
import { isRichText, sanitizeRichHtml } from '../../lib/richText';
import '../../styles/richText.css';

/**
 * Batch 36 Part 2: long product text on the product page. Old plain text
 * renders exactly as before (line breaks kept); text saved by the editor
 * is cleaned again (allow-list) and shown with its formatting.
 */
export function RichTextView({ value, testId }: { value: string; testId?: string }) {
  const rich = isRichText(value);
  const html = useMemo(() => (rich ? sanitizeRichHtml(value) : ''), [rich, value]);
  if (!rich) {
    return (
      <p className="accordion__text" data-testid={testId}>
        {value}
      </p>
    );
  }
  return <div className="rich-text accordion__rich" data-testid={testId} dangerouslySetInnerHTML={{ __html: html }} />;
}
