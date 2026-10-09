import { lazy, Suspense } from 'react';
import '../../styles/richText.css';

// The editor (Tiptap) is only downloaded when a product form opens — the
// shop never loads it.
const RichTextEditor = lazy(() => import('./RichTextEditor'));

interface RichTextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  helper?: string;
  /** The record the text belongs to (product id) — see RichTextEditor. */
  resetKey?: string;
  /** Called with the field's id once its editor shows the text. */
  onReady?: (id: string) => void;
}

/** Batch 36 Part 2: a long product text field with the Word-like editor. */
export function RichTextField({ id, label, value, onChange, placeholder, helper, resetKey, onReady }: RichTextFieldProps) {
  const labelId = `${id}-label`;
  return (
    <div className="form-field">
      <span className="form-label" id={labelId}>
        {label}
      </span>
      <Suspense fallback={<div className="rich-text-loading" aria-hidden="true" />}>
        <RichTextEditor
          id={id}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          labelledBy={labelId}
          resetKey={resetKey}
          onReady={onReady ? () => onReady(id) : undefined}
        />
      </Suspense>
      {helper && <p className="form-helper">{helper}</p>}
    </div>
  );
}
