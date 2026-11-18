import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useProducts } from '../../contexts/ProductContext';
import { limitTitle, moreThanLimitMessage, type LimitReason } from '../../lib/sellRules';
import { openExternal, shopWhatsAppMessageUrl } from '../../lib/expertLinks';

interface LimitPopupProps {
  reason: LimitReason;
  productName: string;
  optionLabel: string | null;
  onClose: () => void;
}

/** Gap between the card's pointer and the stepper. */
const GAP = 10;
/** Kept this far from the screen's edges. */
const EDGE = 8;
/** Room the page's own top bar takes: with less above the stepper, the
 *  card opens below it instead. */
const TOP_BAR = 72;

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

interface Place {
  left: number;
  top: number;
  arrow: number;
  below: boolean;
}

/**
 * Batch 51: the small card just above a quantity stepper when + is tapped
 * at the most allowed — "Limit 4 per order" with a WhatsApp link, or
 * "You've got the last 2!". Rendered where it is used (inside the stepper)
 * but floats in its own layer above the stepper, so a narrow product card
 * never cuts it off and the page never moves. Closes on ✕, on a tap
 * anywhere else, and on Escape.
 */
export function LimitPopup({ reason, productName, optionLabel, onClose }: LimitPopupProps) {
  const { settings } = useProducts();
  const markerRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [place, setPlace] = useState<Place | null>(null);

  const measure = useCallback(() => {
    const anchor = markerRef.current?.parentElement;
    const card = cardRef.current;
    if (!anchor || !card) return;
    const a = anchor.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const viewport = document.documentElement.clientWidth;
    const centre = a.left + a.width / 2;
    const left = Math.min(Math.max(a.right - width, EDGE), Math.max(viewport - width - EDGE, EDGE));
    const below = a.top - height - GAP < TOP_BAR;
    setPlace({
      left,
      top: below ? a.bottom + GAP : a.top - height - GAP,
      arrow: Math.min(Math.max(centre - left, 18), width - 18),
      below,
    });
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, reason]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (cardRef.current && e.target instanceof Node && cardRef.current.contains(e.target)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    // Next tick: the tap that opened it must not close it.
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointer, true);
      document.addEventListener('keydown', onKey);
    }, 0);
    window.addEventListener('scroll', follow, { passive: true, capture: true });
    window.addEventListener('resize', follow);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', follow, { capture: true });
      window.removeEventListener('resize', follow);
    };
  }, [measure]);

  const waHref =
    reason.kind === 'limit'
      ? shopWhatsAppMessageUrl(settings, moreThanLimitMessage(reason.limit, productName, optionLabel))
      : null;

  const style: CSSProperties = place
    ? ({ left: `${place.left}px`, top: `${place.top}px`, '--arrow-x': `${place.arrow}px` } as CSSProperties)
    : { left: 0, top: 0, visibility: 'hidden' };

  return (
    <span ref={markerRef} className="limit-pop-anchor" aria-hidden="false">
      {createPortal(
        <div
          ref={cardRef}
          className={`limit-pop${place ? ' limit-pop--shown' : ''}${place?.below ? ' limit-pop--below' : ''}`}
          style={style}
          role="dialog"
          aria-live="polite"
          aria-label={limitTitle(reason)}
          data-testid="limit-popup"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="limit-pop__body">
            <p className="limit-pop__title" data-testid="limit-popup-title">
              {limitTitle(reason)}
            </p>
            {waHref && (
              <button
                type="button"
                className="limit-pop__link"
                onClick={() => openExternal(waHref)}
                data-testid="limit-popup-whatsapp"
              >
                Need more? Chat with us on WhatsApp
              </button>
            )}
          </div>
          <button type="button" className="limit-pop__close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
          <span className="limit-pop__arrow" aria-hidden="true" />
        </div>,
        document.body
      )}
    </span>
  );
}
