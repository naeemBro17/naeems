import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { prefersReducedMotion } from '../../lib/viewTransition';

/** Must match .accordion__content's transition in app.css. */
const SECTION_FADE_MS = 280;

type Phase = 'closed' | 'opening' | 'open' | 'closing';

/**
 * Keeps `el` at exactly the same place on screen for `ms` while the content
 * below it changes height (Batch 27): the browser's own scroll anchoring is
 * switched off meanwhile (it "helpfully" scrolled to keep something further
 * down in view, which threw the tapped row up or down), and any drift is
 * scrolled back every frame.
 */
function pinOnScreen(el: HTMLElement, ms: number): () => void {
  const top = el.getBoundingClientRect().top;
  const root = document.documentElement;
  const previousAnchor = root.style.overflowAnchor;
  root.style.overflowAnchor = 'none';
  const until = performance.now() + ms;
  let frame = 0;
  const hold = () => {
    const drift = el.getBoundingClientRect().top - top;
    if (Math.abs(drift) >= 0.5) window.scrollBy({ top: drift, behavior: 'instant' });
    if (performance.now() < until) {
      frame = requestAnimationFrame(hold);
    } else {
      root.style.overflowAnchor = previousAnchor;
    }
  };
  frame = requestAnimationFrame(hold);
  return () => {
    cancelAnimationFrame(frame);
    root.style.overflowAnchor = previousAnchor;
  };
}

function PlusMinusIcon() {
  return (
    <svg
      className="accordion__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 12h12" />
      <path className="accordion__icon-bar" d="M12 6v12" />
    </svg>
  );
}

interface AccordionItemProps {
  title: string;
  /** Open on first render. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * One section row of the product page (Batch 27): title on the left, + / −
 * on the right, a thin divider between rows; any number can be open.
 *
 * Opening never moves the row that was tapped — its header stays exactly
 * where it is on screen and the content appears below it (a short fade and
 * slide: only opacity and transform animate). Closing is the same in
 * reverse: the content fades out, then the space closes up under the
 * header. A closed section's content is not rendered at all, so a playing
 * review video stops when its section is closed.
 */
export function AccordionItem({ title, defaultOpen = false, children }: AccordionItemProps) {
  const [phase, setPhase] = useState<Phase>(defaultOpen ? 'open' : 'closed');
  const headerRef = useRef<HTMLButtonElement>(null);
  const releaseRef = useRef<() => void>();
  const timerRef = useRef<number>();
  const bodyId = useId();
  const headerId = useId();
  const isOpen = phase === 'opening' || phase === 'open';

  useEffect(
    () => () => {
      releaseRef.current?.();
      window.clearTimeout(timerRef.current);
    },
    []
  );

  // 'opening' renders the content invisible for one frame, then 'open'
  // fades it in — so the transition has a starting point to run from.
  useLayoutEffect(() => {
    if (phase !== 'opening') return undefined;
    const frame = requestAnimationFrame(() => setPhase('open'));
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  const toggle = () => {
    const header = headerRef.current;
    const instant = prefersReducedMotion();
    releaseRef.current?.();
    window.clearTimeout(timerRef.current);
    if (header) releaseRef.current = pinOnScreen(header, SECTION_FADE_MS + 120);

    if (isOpen) {
      if (instant) {
        setPhase('closed');
        return;
      }
      setPhase('closing');
      timerRef.current = window.setTimeout(() => setPhase('closed'), SECTION_FADE_MS);
    } else {
      setPhase(instant ? 'open' : 'opening');
    }
  };

  return (
    <div className={`accordion__item accordion__item--${phase}`}>
      <button
        ref={headerRef}
        type="button"
        id={headerId}
        className="accordion__header"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-controls={bodyId}
      >
        <span className="accordion__title">{title}</span>
        <PlusMinusIcon />
      </button>

      <div id={bodyId} role="region" aria-labelledby={headerId} className="accordion__body" hidden={phase === 'closed'}>
        {phase !== 'closed' && <div className="accordion__content">{children}</div>}
      </div>
    </div>
  );
}

/** Wrapper that groups accordion items and draws the dividers between them. */
export function Accordion({ children }: { children: ReactNode }) {
  return <div className="accordion">{children}</div>;
}
