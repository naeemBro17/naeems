import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { CartIcon } from './CartButton';
import { CartCountBadge, useCartBump } from './CartBadgeButton';
import { useBuyBarState, type BuyBarState } from '../../lib/buyBarState';
import { openSideCart } from '../../lib/sideCart';

/** The product page — where the floating cart is a little smaller. */
function isProductPage(pathname: string): boolean {
  return pathname.startsWith('/product/');
}

/** The shop pages that show the floating cart (Batch 27 Part 2; the product
 *  page joined in Batch 28, where it is the only cart button). Never the
 *  cart, checkout, account, orders or admin. */
export function showsGlassCart(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/search' ||
    pathname === '/brands' ||
    pathname.startsWith('/brand/') ||
    isProductPage(pathname)
  );
}

/** Batch 70: where the shopper put the bubble (null = never moved). */
export interface BubblePlace {
  side: 'left' | 'right';
  /** The bubble's top, as a fraction of the screen height. */
  y: number;
}

export const BUBBLE_KEY = 'naeems.cartBubble';
/** A press that moves this far (px) is a drag, not a tap. */
const DRAG_START_PX = 6;
/** Gap to the screen edge after the snap. */
const EDGE_PX = 12;
/** The product page's top bar. */
const HEADER_PX = 56;
/** The widest the shop column gets (wider screens centre it). */
const COLUMN_PX = 480;

export function readBubblePlace(): BubblePlace | null {
  try {
    const raw = window.localStorage.getItem(BUBBLE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { side, y } = parsed as { side?: unknown; y?: unknown };
    if ((side !== 'left' && side !== 'right') || typeof y !== 'number' || !Number.isFinite(y)) return null;
    return { side, y: Math.min(1, Math.max(0, y)) };
  } catch {
    return null;
  }
}

function saveBubblePlace(place: BubblePlace): void {
  try {
    window.localStorage.setItem(BUBBLE_KEY, JSON.stringify(place));
  } catch {
    // Storage blocked: the bubble stays put for this page only.
  }
}

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
  bottomNav: number;
}

let probe: HTMLDivElement | null = null;

/** The safe-area insets and the bottom nav's height, in px. */
function readInsets(): Insets {
  if (!probe) {
    probe = document.createElement('div');
    probe.className = 'b70-probe';
    probe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(probe);
  }
  const s = window.getComputedStyle(probe);
  return {
    top: parseFloat(s.paddingTop) || 0,
    right: parseFloat(s.paddingRight) || 0,
    bottom: parseFloat(s.paddingBottom) || 0,
    left: parseFloat(s.paddingLeft) || 0,
    bottomNav: parseFloat(s.height) || 0,
  };
}

/** The top-left corner (px) for a side and a wanted top, kept clear of the
 *  top bar and of what sits at the bottom (the tab bar on Home, the buy bar
 *  on the product page while it shows). */
function placeToPoint(place: BubblePlace, size: number, pathname: string, bar: BuyBarState): { x: number; y: number } {
  const insets = readInsets();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const colLeft = Math.max(0, (vw - COLUMN_PX) / 2);
  const colRight = colLeft + Math.min(vw, COLUMN_PX);
  const x = place.side === 'left' ? colLeft + EDGE_PX + insets.left : colRight - EDGE_PX - size - insets.right;
  const bottomReserve =
    pathname === '/'
      ? insets.bottomNav + EDGE_PX
      : isProductPage(pathname) && bar === 'shown'
        ? 14 + 66 + 11 + insets.bottom
        : EDGE_PX + insets.bottom;
  const minY = HEADER_PX + 8 + insets.top;
  const maxY = Math.max(minY, vh - bottomReserve - size);
  return { x, y: Math.min(maxY, Math.max(minY, place.y * vh)) };
}

interface Press {
  pointerId: number;
  startX: number;
  startY: number;
  /** The bubble's top-left at the press. */
  originX: number;
  originY: number;
  dragging: boolean;
  x: number;
  y: number;
}

/**
 * Round crystal-glass cart button at the middle of the right edge (on the
 * product page: bottom-right, just above the glass buy bar, sliding down and
 * back up together with it — Batch 29 Part 3) — the one
 * cart entry point on the shop pages (Batch 28 Part 5). Shown while the cart
 * has something in it: it jumps in the first time an item is added, gives a
 * small pulse on every later add (on the product page also on every remove).
 *
 * Batch 70: a tap opens the side cart. A drag moves it (it follows the
 * finger, transform only) and on release it snaps to the nearest side; the
 * side and height are remembered for the next page and visit. Once moved,
 * the product page's "ride above the buy bar" rule no longer applies; it
 * only keeps clear of the bar. Its badge pops when a flying product lands.
 *
 * Rendered next to the bottom nav, outside the page's animated subtree, so
 * its fixed position is never thrown off by a transform (see App.tsx). It
 * sits above the page but below the bottom nav, sheets and dialogs.
 */
export function GlassCartButton() {
  const location = useLocation();
  const onThisPage = showsGlassCart(location.pathname);
  const onProductPage = isProductPage(location.pathname);
  const { itemCount, bump, key } = useCartBump(onThisPage, onProductPage);
  const buyBar = useBuyBarState();
  const [place, setPlace] = useState<BubblePlace | null>(readBubblePlace);
  const [dragging, setDragging] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pressRef = useRef<Press | null>(null);
  const frameRef = useRef(0);
  const suppressClickRef = useRef(false);
  const shown = itemCount > 0 && onThisPage;

  const applyPlace = useCallback(() => {
    const el = buttonRef.current;
    if (!el || !place || pressRef.current?.dragging) return;
    const { x, y } = placeToPoint(place, el.offsetWidth, location.pathname, buyBar);
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }, [place, location.pathname, buyBar]);

  // A moved bubble: its spot, kept clear of the bars, also after a resize.
  useLayoutEffect(() => {
    const el = buttonRef.current;
    if (!el || pressRef.current?.dragging) return undefined;
    if (!place) {
      el.style.transform = '';
      return undefined;
    }
    applyPlace();
    window.addEventListener('resize', applyPlace);
    return () => window.removeEventListener('resize', applyPlace);
  }, [place, applyPlace, shown]);

  // The badge pops when a flying product lands (lib/flyToCart.ts).
  useEffect(() => {
    const onBump = () => {
      const badge = buttonRef.current?.querySelector<HTMLElement>('.cart-count-badge');
      if (!badge) return;
      badge.classList.remove('b70-badge-pop');
      // Restarts the animation when two land close together.
      void badge.offsetWidth;
      badge.classList.add('b70-badge-pop');
    };
    window.addEventListener('naeems:cart-bump', onBump);
    return () => window.removeEventListener('naeems:cart-bump', onBump);
  }, []);

  useEffect(() => () => window.cancelAnimationFrame(frameRef.current), []);

  if (!shown) return null;

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    pressRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: rect.left,
      originY: rect.top,
      dragging: false,
      x: rect.left,
      y: rect.top,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== e.pointerId) return;
    const dx = e.clientX - press.startX;
    const dy = e.clientY - press.startY;
    if (!press.dragging) {
      if (Math.hypot(dx, dy) < DRAG_START_PX) return;
      press.dragging = true;
      // Same spot, now in drag coordinates, before the class change lands.
      e.currentTarget.style.transform = `translate3d(${press.originX}px, ${press.originY}px, 0)`;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // The pointer is already gone; the release below still ends the drag.
      }
      setDragging(true);
    }
    press.x = press.originX + dx;
    press.y = press.originY + dy;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = window.requestAnimationFrame(() => {
      const el = buttonRef.current;
      if (el) el.style.transform = `translate3d(${press.x}px, ${press.y}px, 0)`;
    });
  };

  const finish = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== e.pointerId) return;
    pressRef.current = null;
    if (!press.dragging) return;
    suppressClickRef.current = true;
    window.cancelAnimationFrame(frameRef.current);
    const size = e.currentTarget.offsetWidth;
    const vw = document.documentElement.clientWidth;
    const next: BubblePlace = {
      side: press.x + size / 2 < vw / 2 ? 'left' : 'right',
      y: Math.min(1, Math.max(0, press.y / window.innerHeight)),
    };
    const el = buttonRef.current;
    // The snap: transition on again, then the new spot (one style change).
    setDragging(false);
    if (el) {
      el.classList.remove('glass-cart--drag');
      const { x, y } = placeToPoint(next, size, location.pathname, buyBar);
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
    saveBubblePlace(next);
    setPlace(next);
  };

  const onClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    openSideCart();
  };

  const placed = place !== null || dragging;
  const className = [
    'glass-cart',
    onProductPage ? 'glass-cart--pdp' : '',
    onProductPage && !placed && buyBar !== 'shown' ? 'glass-cart--bar-away' : '',
    placed ? 'glass-cart--placed' : '',
    dragging ? 'glass-cart--drag' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={buttonRef}
      type="button"
      className={className}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      aria-label={`Open cart, ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`}
      aria-haspopup="dialog"
      data-testid="glass-cart"
      data-side={place?.side ?? 'right'}
    >
      <span key={key} className={`glass-cart__inner${bump === 'none' ? '' : ` cart-bump--${bump}`}`}>
        <CartIcon className="glass-cart__icon" />
        <CartCountBadge count={itemCount} testId="glass-cart-badge" />
      </span>
    </button>
  );
}
