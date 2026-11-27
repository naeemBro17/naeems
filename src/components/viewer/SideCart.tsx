import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { ActionLink } from '../shared/ActionLink';
import { LimitPopup } from './LimitPopup';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { useCartLineLimits } from '../../hooks/useCartLineLimits';
import { useCartStockCheck } from '../../hooks/useCartStockCheck';
import { useCheckoutState } from '../../features/checkout/useCheckoutState';
import { useCartCheckout } from '../../features/checkout/useCartCheckout';
import { cardImage } from '../../lib/productImages';
import { formatTaka } from '../../lib/format';
import { countPieces } from '../../lib/cartTotals';
import { closeSideCart, lineKey, useSideCart } from '../../lib/sideCart';
import { SideCartRoutine, countCartOpen } from './SideCartRoutine';
import type { LimitReason } from '../../lib/sellRules';
import type { CartItem } from '../../features/checkout/types';

/** Pages that never show the side cart: the cart and checkout themselves,
 *  the customer's account pages and the admin. */
export function showsSideCart(pathname: string): boolean {
  return !(
    pathname === '/cart' ||
    pathname.startsWith('/checkout') ||
    pathname === '/account' ||
    pathname.startsWith('/orders') ||
    pathname === '/wallet' ||
    pathname === '/my-skin' ||
    pathname.startsWith('/admin') ||
    pathname === '/wholesaler-access'
  );
}

/** A sideways move this far (px) closes the panel on release... */
const SWIPE_CLOSE_PX = 80;
/** ...or a flick at least this fast (px per ms). */
const SWIPE_CLOSE_SPEED = 0.5;
/** How long to wait for a closing sheet's own Back before adding ours. */
const HISTORY_SETTLE_MS = 400;

function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function ShopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 8h14l-1.2 11.2a2 2 0 01-2 1.8H8.2a2 2 0 01-2-1.8L5 8z" />
      <path d="M9 10V6.5a3 3 0 016 0V10" />
    </svg>
  );
}

function PlaceholderIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
      <path d="M3 8l9 5 9-5" />
      <path d="M12 13v8" />
    </svg>
  );
}

/** Re-reads the live stock once each time the panel opens (Batch 33, the
 *  same check the cart page runs when it opens). */
function StockCheckOnOpen() {
  useCartStockCheck();
  return null;
}

interface Drag {
  pointerId: number;
  x: number;
  y: number;
  /** The gesture is a sideways swipe (decided once it moves 10 px). */
  captured: boolean;
  dx: number;
  lastX: number;
  lastT: number;
  speed: number;
}

/**
 * Batch 70: the side cart. Slides in from the right the first time a visit
 * adds something ("Added to cart", the new line highlighted at the top) and
 * whenever the floating cart bubble is tapped ("Your cart"). The lines,
 * prices, limits and total are the cart page's own (useCheckoutState,
 * useCartLineLimits), and Checkout runs the cart page's own Checkout
 * (useCartCheckout).
 *
 * Closes on Keep shopping, the close button, a tap on the dim page, Escape,
 * the phone's Back, a sideways swipe to the right and any page change.
 * Transform and opacity only; the finger-follow writes the transform
 * straight to the element in requestAnimationFrame (no re-render per move).
 */
export function SideCart() {
  const location = useLocation();
  if (!showsSideCart(location.pathname)) return null;
  return <SideCartPanel pathname={location.pathname} />;
}

function SideCartPanel({ pathname }: { pathname: string }) {
  const { open, mode, highlightKey, nudge } = useSideCart();
  const { items, subtotal, updateQuantity, removeItem } = useCheckoutState();
  const { limitOf, reasonOf } = useCartLineLimits();
  const { checkout, loginSheet } = useCartCheckout();
  const navigate = useAppNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const frameRef = useRef(0);
  const openerRef = useRef<HTMLElement | null>(null);
  const [nudging, setNudging] = useState(false);
  const [popup, setPopup] = useState<{ key: string; reason: LimitReason } | null>(null);
  // Called once our own Back entry is gone (closing with a button), e.g. to
  // open the sign-in sheet without the two history steps crossing.
  const afterCloseRef = useRef<(() => void) | null>(null);

  const count = countPieces(items);
  // Batch 72: this browser's side-cart opens (the question shows on every
  // 4th). Counted before the first paint of an open; 0 while closed.
  const [openCount, setOpenCount] = useState(0);
  useLayoutEffect(() => {
    setOpenCount(open ? countCartOpen() : 0);
  }, [open]);

  // Any page change closes it.
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    closeSideCart();
  }, [pathname]);
  // Leaving the pages that show it (the cart, checkout...) closes it too.
  useEffect(() => () => closeSideCart(), []);

  // The first-add nudge, once per opening by an add.
  useEffect(() => {
    if (open && mode === 'added' && nudge > 0) setNudging(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudge]);
  useEffect(() => {
    if (!open) {
      setNudging(false);
      setPopup(null);
    }
  }, [open]);

  // Hidden panel: out of the tab order and away from screen readers.
  useLayoutEffect(() => {
    if (rootRef.current) rootRef.current.inert = !open;
  }, [open]);

  // Focus in on open, back to what opened it on close; Escape closes; the
  // page behind does not scroll (no layout shift where a scrollbar shows).
  useEffect(() => {
    if (!open) return undefined;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    const body = document.body;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    const before = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
    body.style.overflow = 'hidden';
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    body.classList.add('b70-open');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSideCart();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      body.style.overflow = before.overflow;
      body.style.paddingRight = before.paddingRight;
      body.classList.remove('b70-open');
      const opener = openerRef.current;
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  // The phone's Back closes the panel (one same-page history entry, like
  // every sheet: hooks/useModalBackClose). Opened straight after a sheet
  // closed (the option picker's Add), that sheet's own Back is still on its
  // way, so ours is added once it has landed.
  useEffect(() => {
    if (!open) return undefined;
    const id = Math.random().toString(36).slice(2);
    let pushed = false;
    let waiting = false;
    const push = () => {
      waiting = false;
      window.history.pushState({ modalOpen: true, sideCartId: id }, '');
      pushed = true;
    };
    const onPop = () => {
      if (waiting) {
        window.clearTimeout(timer);
        push();
        return;
      }
      if (!pushed) return;
      pushed = false;
      closeSideCart();
    };
    window.addEventListener('popstate', onPop);
    let timer = 0;
    if ((window.history.state as { modalOpen?: boolean } | null)?.modalOpen) {
      waiting = true;
      timer = window.setTimeout(push, HISTORY_SETTLE_MS);
    } else {
      push();
    }
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('popstate', onPop);
      const after = afterCloseRef.current;
      afterCloseRef.current = null;
      const ours = pushed && (window.history.state as { sideCartId?: string } | null)?.sideCartId === id;
      if (!ours) {
        after?.();
        return;
      }
      if (after) {
        window.addEventListener('popstate', () => window.setTimeout(after, 0), { once: true });
      }
      window.history.back();
    };
  }, [open]);

  // Lines: in 'added' mode the line just added comes first.
  const lines =
    mode === 'added' && highlightKey !== null
      ? [
          ...items.filter((item) => lineKey(item.product.id, item.variantId) === highlightKey),
          ...items.filter((item) => lineKey(item.product.id, item.variantId) !== highlightKey),
        ]
      : items;

  const increase = (item: CartItem) => {
    const key = lineKey(item.product.id, item.variantId);
    if (item.quantity >= limitOf(item)) {
      setPopup({ key, reason: reasonOf(item) });
      return;
    }
    updateQuantity(item.product.id, item.quantity + 1, item.variantId);
  };

  const decrease = (item: CartItem) => {
    setPopup(null);
    updateQuantity(item.product.id, item.quantity - 1, item.variantId);
  };

  const onCheckout = () => {
    checkout((openSignIn) => {
      afterCloseRef.current = openSignIn;
      closeSideCart();
    });
  };

  /* ---------- swipe to close (sideways only, never a vertical scroll) ---------- */

  const setPanelX = (x: number | null) => {
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (panel) panel.style.transform = x === null ? '' : `translate3d(${x}px, 0, 0)`;
    });
  };

  const endDrag = (close: boolean) => {
    const panel = panelRef.current;
    dragRef.current = null;
    window.cancelAnimationFrame(frameRef.current);
    if (!panel) return;
    // One style change: the transition comes back on and the panel goes from
    // where the finger left it to closed, or springs back.
    panel.classList.remove('b70-panel--drag');
    panel.style.transform = '';
    if (close) closeSideCart();
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!open || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const target = e.target as Element;
    // Batch 72: the routine row scrolls sideways by itself, never a swipe.
    if (target.closest('button, a, .b70-mini, .b72-rcards')) return;
    dragRef.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      captured: false,
      dx: 0,
      lastX: e.clientX,
      lastT: e.timeStamp,
      speed: 0,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.captured) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
        drag.captured = true;
        setNudging(false);
        panelRef.current?.classList.add('b70-panel--drag');
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // The pointer is already gone; the release below still ends the drag.
        }
      } else if (Math.abs(dy) > 10) {
        // A vertical move: the list scrolls; this is never a swipe.
        dragRef.current = null;
        return;
      } else {
        return;
      }
    }
    const dt = e.timeStamp - drag.lastT;
    if (dt > 0) drag.speed = (e.clientX - drag.lastX) / dt;
    drag.lastX = e.clientX;
    drag.lastT = e.timeStamp;
    drag.dx = dx;
    setPanelX(Math.max(0, dx));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (!drag.captured) {
      dragRef.current = null;
      return;
    }
    endDrag(drag.dx > SWIPE_CLOSE_PX || drag.speed > SWIPE_CLOSE_SPEED);
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.captured) endDrag(false);
    else dragRef.current = null;
  };

  const nudgeClass = nudging ? ' b70-panel--nudge' : '';
  const itemsWord = count === 1 ? 'item' : 'items';

  return (
    <>
      <div ref={rootRef} className={`b70-cart${open ? ' b70-cart--open' : ''}`} data-testid="side-cart" aria-hidden={!open}>
        {open && <StockCheckOnOpen />}
        <div className="b70-scrim" onClick={closeSideCart} data-testid="side-cart-scrim" />
        <aside
          className={`b70-panel${nudgeClass}`}
          role="dialog"
          aria-modal="true"
          aria-label="Cart"
          ref={panelRef}
          tabIndex={-1}
          data-testid="side-cart-panel"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) setNudging(false);
          }}
        >
          <div className="b70-panel__hd">
            {mode === 'added' ? (
              <div className="b70-panel__t" data-testid="side-cart-title">
                <i className="b70-ok">
                  <TickIcon />
                </i>
                Added to cart
              </div>
            ) : (
              <div className="b70-panel__t" data-testid="side-cart-title">
                Your cart{' '}
                <span className="b70-cnt">
                  {count} {itemsWord}
                </span>
              </div>
            )}
            <button type="button" className="b70-x" onClick={closeSideCart} aria-label="Close" data-testid="side-cart-close">
              <XIcon />
            </button>
          </div>

          <div className="b70-list" data-testid="side-cart-list">
            {lines.length === 0 ? (
              <p className="b70-empty">Your cart is empty.</p>
            ) : (
              <>
              {lines.map((item) => {
                const key = lineKey(item.product.id, item.variantId);
                const isHighlighted = mode === 'added' && key === highlightKey;
                const image = item.variantImage ?? cardImage(item.product);
                const name = item.product.name;
                return (
                  <div
                    key={key}
                    className={`b70-li${isHighlighted ? ' b70-li--new' : ''}`}
                    data-testid="side-cart-line"
                    data-highlighted={isHighlighted}
                  >
                    <div className="b70-li__img">
                      {image ? (
                        <img src={image} alt="" width={64} height={64} loading="lazy" decoding="async" />
                      ) : (
                        <PlaceholderIcon />
                      )}
                    </div>
                    <div>
                      <div className="b70-li__n">{name}</div>
                      {item.variantLabel && <div className="b70-li__v">{item.variantLabel}</div>}
                      <div className="b70-li__r">
                        <span className="b70-li__p" data-testid="side-cart-line-total">
                          {formatTaka(item.unitPrice * item.quantity)}
                        </span>
                        <span className="b70-mini">
                          <button
                            type="button"
                            onClick={() => decrease(item)}
                            aria-label={`One less ${name}`}
                            data-testid="side-cart-minus"
                          >
                            −
                          </button>
                          <span aria-live="polite" data-testid="side-cart-qty">
                            {item.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => increase(item)}
                            aria-label={`One more ${name}`}
                            data-testid="side-cart-plus"
                          >
                            +
                          </button>
                          {popup && popup.key === key && (
                            <LimitPopup
                              reason={popup.reason}
                              productName={name}
                              optionLabel={item.variantLabel}
                              onClose={() => setPopup(null)}
                            />
                          )}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="b70-rm"
                        onClick={() => {
                          setPopup(null);
                          removeItem(item.product.id, item.variantId);
                        }}
                        data-testid="side-cart-remove"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
              <SideCartRoutine
                lines={lines}
                anchorKey={mode === 'added' ? highlightKey : null}
                openCount={openCount}
                onLeave={(path) => {
                  afterCloseRef.current = () => navigate(path);
                  closeSideCart();
                }}
              />
              </>
            )}
          </div>

          {lines.length > 0 && (
            <>
              <div className="b70-tot">
                <span>
                  Total ({count} {itemsWord})
                </span>
                <b data-testid="side-cart-total">{formatTaka(subtotal)}</b>
              </div>
              <div className="b70-btns">
                <ActionLink to="/cart" className="b70-vc" onOpen={() => navigate('/cart')} data-testid="side-cart-view">
                  View cart
                </ActionLink>
                <ActionLink to="/checkout/delivery" className="b70-co" onOpen={onCheckout} data-testid="side-cart-checkout">
                  Checkout
                </ActionLink>
              </div>
            </>
          )}
          <button type="button" className="b70-ks" onClick={closeSideCart} data-testid="side-cart-keep">
            <ShopIcon />
            Keep shopping
          </button>
        </aside>
      </div>
      {loginSheet}
    </>
  );
}
