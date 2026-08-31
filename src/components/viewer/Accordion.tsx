import { useId, useState, type ReactNode } from 'react';

interface AccordionItemProps {
  title: string;
  /** Open on first render — used for the first item on the detail page. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * One collapsible row. The body animates via max-height rather than being
 * unmounted, so opening and closing both transition instead of snapping.
 * `display: none` would kill that transition, so the collapsed state uses
 * `visibility: hidden` instead — which still takes the content out of the tab
 * order and the accessibility tree.
 */
export function AccordionItem({ title, defaultOpen = false, children }: AccordionItemProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const bodyId = useId();
  const headerId = useId();

  return (
    <div className={`accordion__item${isOpen ? ' accordion__item--open' : ''}`}>
      <button
        type="button"
        id={headerId}
        className="accordion__header"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-controls={bodyId}
      >
        <span className="accordion__title">{title}</span>
        <svg
          className="accordion__chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <div
        id={bodyId}
        role="region"
        aria-labelledby={headerId}
        className="accordion__body"
      >
        <div className="accordion__content">{children}</div>
      </div>
    </div>
  );
}

/** Wrapper that groups accordion items and draws the dividers between them. */
export function Accordion({ children }: { children: ReactNode }) {
  return <div className="accordion">{children}</div>;
}
