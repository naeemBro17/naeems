import { useEffect, useRef, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { getDisplayPrice } from '../../lib/pricing';
import { cardImage } from '../../lib/productImages';
import { productPath } from '../../lib/slugify';
import { formatTaka } from '../../lib/format';
import type { Product } from '../../types';

/** px per millisecond the row drifts left. */
export const DRIFT_PX_PER_MS = 0.025;
/** After a touch, a wheel or focus leaving, the drift waits this long. */
export const DRIFT_RESUME_MS = 4000;
/** A press that moves more than this (px) is a drag, not a tap. */
const TAP_SLOP_PX = 6;

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function Card({ product, hidden, onOpen }: { product: Product; hidden: boolean; onOpen: (e: MouseEvent<HTMLAnchorElement>, p: Product) => void }) {
  const price = getDisplayPrice(product);
  const image = cardImage(product);
  return (
    <a
      href={productPath(product)}
      className="b71-pc"
      onClick={(e) => onOpen(e, product)}
      tabIndex={hidden ? -1 : undefined}
      data-testid={hidden ? undefined : 'best-seller-card'}
    >
      <div className="b71-pc__img">{image && <img src={image} alt="" loading="lazy" decoding="async" />}</div>
      <div className="b71-pc__b">
        <div className="b71-pc__n">{product.name}</div>
        <div className="b71-pc__p">
          <b>{formatTaka(price.mainPrice)}</b>
          {price.strikePrice !== null && <s>{formatTaka(price.strikePrice)}</s>}
        </div>
      </div>
    </a>
  );
}

/**
 * Batch 71 Part 3b: the Best sellers row. The cards are drawn twice (the
 * second copy hidden from screen readers and the keyboard) and one
 * requestAnimationFrame loop moves the row's scrollLeft slowly left,
 * wrapping by half the track. It stops while the row is off screen or the
 * tab is hidden, pauses on a touch, a wheel or keyboard focus, and starts
 * again 4 s later. No drift at all with reduced motion. Native scrolling
 * only (touch-action pan-x pan-y), so a finger on the row still scrolls
 * the page up and down.
 */
export function BestSellers({ products }: { products: Product[] }) {
  const navigate = useAppNavigate();
  const rowRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const dragRef = useRef(false);
  const controlRef = useRef<{ pause: () => void; resumeLater: () => void } | null>(null);

  useEffect(() => {
    const row = rowRef.current;
    const track = trackRef.current;
    if (!row || !track || products.length === 0 || reducedMotion()) return undefined;
    let frame = 0;
    let last = 0;
    let pos = row.scrollLeft;
    let onScreen = false;
    let paused = false;
    let resumeTimer = 0;

    const tick = (now: number) => {
      frame = 0;
      const dt = last === 0 ? 0 : Math.min(now - last, 64);
      last = now;
      // Half the track: from the first card to the first card of the copy.
      const first = track.firstElementChild as HTMLElement | null;
      const copy = track.querySelector<HTMLElement>('.b71-marq__copy > a');
      const half = first && copy ? copy.offsetLeft - first.offsetLeft : track.scrollWidth / 2;
      if (half > 0 && track.scrollWidth > row.clientWidth) {
        pos += dt * DRIFT_PX_PER_MS;
        if (pos >= half) pos -= half;
        row.scrollLeft = pos;
      }
      schedule();
    };
    const running = () => onScreen && !paused && document.visibilityState === 'visible';
    function schedule() {
      if (frame === 0 && running()) frame = window.requestAnimationFrame(tick);
    }
    const stop = () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
    };
    const start = () => {
      // Pick up wherever a finger left it.
      pos = row.scrollLeft;
      schedule();
    };
    const pause = () => {
      paused = true;
      window.clearTimeout(resumeTimer);
      stop();
    };
    const resumeLater = () => {
      window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        paused = false;
        start();
      }, DRIFT_RESUME_MS);
    };
    controlRef.current = { pause, resumeLater };

    const observer = new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      if (onScreen) start();
      else stop();
    });
    observer.observe(row);
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    const onWheel = () => {
      pause();
      resumeLater();
    };
    const onFocusIn = () => pause();
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget instanceof Node && row.contains(e.relatedTarget)) return;
      resumeLater();
    };
    document.addEventListener('visibilitychange', onVisibility);
    row.addEventListener('wheel', onWheel, { passive: true });
    row.addEventListener('focusin', onFocusIn);
    row.addEventListener('focusout', onFocusOut);
    return () => {
      stop();
      window.clearTimeout(resumeTimer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      row.removeEventListener('wheel', onWheel);
      row.removeEventListener('focusin', onFocusIn);
      row.removeEventListener('focusout', onFocusOut);
      controlRef.current = null;
    };
  }, [products.length]);

  if (products.length === 0) return null;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    pressRef.current = { x: e.clientX, y: e.clientY, moved: false };
    dragRef.current = false;
    controlRef.current?.pause();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!press || press.moved) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP_PX) press.moved = true;
  };
  const onPointerEnd = () => {
    dragRef.current = pressRef.current?.moved ?? false;
    pressRef.current = null;
    controlRef.current?.resumeLater();
  };
  const open = (e: MouseEvent<HTMLAnchorElement>, product: Product) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (dragRef.current) {
      dragRef.current = false;
      return;
    }
    navigate(productPath(product));
  };

  return (
    <div
      ref={rowRef}
      className="b71-marq"
      data-testid="best-sellers"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div ref={trackRef} className="b71-marq__track">
        {products.map((p) => (
          <Card key={p.id} product={p} hidden={false} onOpen={open} />
        ))}
        <div className="b71-marq__copy" aria-hidden="true">
          {products.map((p) => (
            <Card key={`copy-${p.id}`} product={p} hidden onOpen={open} />
          ))}
        </div>
      </div>
    </div>
  );
}
