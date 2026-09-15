import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type DragReorderMode = 'swap' | 'move';

interface Point {
  x: number;
  y: number;
}

/** Page-coordinate rectangle captured when a drag begins. */
interface PageRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface DragReorderOptions<T> {
  items: T[];
  /**
   * Called on release over a valid target with the proposed new order. The
   * visual drag state is held until this resolves (so a pessimistic save can
   * finish before anything snaps), and snaps back if it rejects.
   */
  onReorder: (next: T[], from: number, to: number) => Promise<void> | void;
  /** 'swap' exchanges two items; 'move' lifts one item and inserts it at the target. */
  mode: DragReorderMode;
  /** No listeners are attached while false. */
  enabled: boolean;
  /** Hold time before a drag begins. 0 starts on first touch (for a handle). */
  longPressMs?: number;
  /** Stable identity per item, used to notice when the reordered items arrive. */
  keyOf?: (item: T) => string;
  /** Touches that start inside a match are ignored (e.g. a button on the tile). */
  ignoreSelector?: string;
}

export interface DragReorderState {
  /** Index being dragged, or null. Stays set while a reorder is pending. */
  dragIndex: number | null;
  /** Index the finger is over (never the dragged index), or null. */
  hoverIndex: number | null;
  /** True from activation until release — the item is following the finger. */
  isDragging: boolean;
  /** Translation to apply to the dragged item. */
  delta: Point;
  /** Vertical shift for a non-dragged item in 'move' mode (the gap opening). */
  shiftFor: (index: number) => number;
  /** Ref callback for the element the drag is started from. */
  registerHandle: (index: number) => (el: HTMLElement | null) => void;
  /** Ref callback for the element that moves / acts as the drop target. */
  registerItem: (index: number) => (el: HTMLElement | null) => void;
}

/** Finger movement that cancels a pending long press (it's a scroll/swipe). */
const LONG_PRESS_SLOP_PX = 8;
/** How long a synthesized click is swallowed after a drag ends. */
const CLICK_SUPPRESS_MS = 400;

function pointOf(e: TouchEvent | MouseEvent): Point | null {
  if ('touches' in e) {
    const t = e.touches[0] ?? e.changedTouches[0];
    return t ? { x: t.pageX, y: t.pageY } : null;
  }
  return { x: e.pageX, y: e.pageY };
}

function measure(el: HTMLElement): PageRect {
  const r = el.getBoundingClientRect();
  return {
    left: r.left + window.scrollX,
    top: r.top + window.scrollY,
    right: r.right + window.scrollX,
    bottom: r.bottom + window.scrollY,
    width: r.width,
    height: r.height,
  };
}

/**
 * Touch-first drag reordering with no library. Listeners are native and
 * non-passive so the drag can preventDefault touchmove and keep the page
 * from scrolling underneath; mouse events are wired to the same flow so the
 * feature also works at a desk.
 *
 * Positions are measured once at activation and the hover target is resolved
 * against those page-coordinate rects, not against elementFromPoint — the
 * dragged item is translated under the finger and would otherwise hit-test
 * itself.
 */
export function useDragReorder<T>({
  items,
  onReorder,
  mode,
  enabled,
  longPressMs = 0,
  keyOf = (item) => String(item),
  ignoreSelector,
}: DragReorderOptions<T>): DragReorderState {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [delta, setDelta] = useState<Point>({ x: 0, y: 0 });

  const handles = useRef(new Map<number, HTMLElement>());
  const itemEls = useRef(new Map<number, HTMLElement>());
  const rects = useRef<PageRect[]>([]);

  // Mutable drag session state, kept out of React state for the move loop.
  const session = useRef<{
    index: number;
    start: Point;
    active: boolean;
    timer: number | null;
    hover: number | null;
    pointer: 'touch' | 'mouse';
  } | null>(null);

  // The order we asked for; once `items` arrives in that order, clear the
  // held visual state before paint so nothing double-offsets.
  const pendingKeys = useRef<string[] | null>(null);

  // Callers usually pass inline functions; keeping them in refs means the
  // listener effect doesn't tear down and re-attach on every render.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;

  const reset = useCallback(() => {
    session.current = null;
    pendingKeys.current = null;
    setIsDragging(false);
    setDragIndex(null);
    setHoverIndex(null);
    setDelta({ x: 0, y: 0 });
  }, []);

  useLayoutEffect(() => {
    if (!pendingKeys.current) return;
    const current = items.map(keyOfRef.current);
    const matches =
      current.length === pendingKeys.current.length &&
      current.every((k, i) => k === pendingKeys.current?.[i]);
    if (matches) reset();
  }, [items, reset]);

  const registerHandle = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      if (el) handles.current.set(index, el);
      else handles.current.delete(index);
    },
    []
  );

  const registerItem = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      if (el) itemEls.current.set(index, el);
      else itemEls.current.delete(index);
    },
    []
  );

  const shiftFor = useCallback(
    (index: number): number => {
      if (mode !== 'move' || dragIndex === null || hoverIndex === null) return 0;
      const height = rects.current[dragIndex]?.height ?? 0;
      if (dragIndex < hoverIndex && index > dragIndex && index <= hoverIndex) return -height;
      if (hoverIndex < dragIndex && index >= hoverIndex && index < dragIndex) return height;
      return 0;
    },
    [mode, dragIndex, hoverIndex]
  );

  useEffect(() => {
    if (!enabled) return;
    const count = itemsRef.current.length;

    const suppressNextClick = () => {
      const swallow = (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
      };
      document.addEventListener('click', swallow, true);
      window.setTimeout(() => document.removeEventListener('click', swallow, true), CLICK_SUPPRESS_MS);
    };

    const resolveHover = (point: Point, from: number): number | null => {
      const all = rects.current;
      if (mode === 'swap') {
        const hit = all.findIndex(
          (r, i) =>
            i !== from &&
            point.x >= r.left && point.x <= r.right &&
            point.y >= r.top && point.y <= r.bottom
        );
        return hit === -1 ? null : hit;
      }
      // 'move': resolve on the vertical axis only, clamped to the list ends.
      const inside = all.findIndex((r) => point.y >= r.top && point.y <= r.bottom);
      let target: number;
      if (inside !== -1) target = inside;
      else if (point.y < all[0].top) target = 0;
      else if (point.y > all[all.length - 1].bottom) target = all.length - 1;
      else {
        let best = 0;
        let bestDist = Number.POSITIVE_INFINITY;
        all.forEach((r, i) => {
          const d = Math.abs((r.top + r.bottom) / 2 - point.y);
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        });
        target = best;
      }
      return target === from ? null : target;
    };

    const activate = () => {
      const s = session.current;
      if (!s || s.active) return;
      s.timer = null;
      s.active = true;
      rects.current = Array.from({ length: count }, (_, i) => {
        const el = itemEls.current.get(i);
        return el ? measure(el) : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      });
      try {
        navigator.vibrate?.(15);
      } catch {
        // Vibration unsupported — non-blocking.
      }
      setDragIndex(s.index);
      setHoverIndex(null);
      setDelta({ x: 0, y: 0 });
      setIsDragging(true);
    };

    const begin = (index: number, point: Point, pointer: 'touch' | 'mouse') => {
      if (session.current) return;
      session.current = { index, start: point, active: false, timer: null, hover: null, pointer };
      if (longPressMs > 0) {
        session.current.timer = window.setTimeout(activate, longPressMs);
      } else {
        activate();
      }
    };

    const move = (e: TouchEvent | MouseEvent) => {
      const s = session.current;
      if (!s) return;
      const point = pointOf(e);
      if (!point) return;
      if (!s.active) {
        // Still waiting on the long press: real movement means a scroll.
        const dx = point.x - s.start.x;
        const dy = point.y - s.start.y;
        if (Math.hypot(dx, dy) > LONG_PRESS_SLOP_PX && s.timer !== null) {
          window.clearTimeout(s.timer);
          session.current = null;
        }
        return;
      }
      if (e.cancelable) e.preventDefault();
      const hover = resolveHover(point, s.index);
      s.hover = hover;
      setHoverIndex(hover);
      setDelta({ x: point.x - s.start.x, y: point.y - s.start.y });
    };

    const end = () => {
      const s = session.current;
      if (!s) return;
      if (!s.active) {
        if (s.timer !== null) window.clearTimeout(s.timer);
        session.current = null;
        return;
      }
      suppressNextClick();
      setIsDragging(false);
      const from = s.index;
      const to = s.hover;
      if (to === null || to === from) {
        reset();
        return;
      }

      // Snap the dragged item onto its destination while the save runs.
      const a = rects.current[from];
      const b = rects.current[to];
      if (mode === 'move') {
        const newTop = to > from ? b.bottom - a.height : b.top;
        setDelta({ x: 0, y: newTop - a.top });
      } else {
        setDelta({ x: b.left - a.left, y: b.top - a.top });
      }

      const current = itemsRef.current;
      const next = [...current];
      if (mode === 'swap') {
        [next[from], next[to]] = [next[to], next[from]];
      } else {
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
      }
      pendingKeys.current = next.map(keyOfRef.current);
      session.current = null;

      Promise.resolve()
        .then(() => onReorderRef.current(next, from, to))
        .then(
          () => reset(),
          () => reset()
        );
    };

    const onTouchStart = (index: number) => (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      if (ignoreSelector && (e.target as Element).closest?.(ignoreSelector)) return;
      const point = pointOf(e);
      if (point) begin(index, point, 'touch');
    };
    const onMouseDown = (index: number) => (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (ignoreSelector && (e.target as Element).closest?.(ignoreSelector)) return;
      const point = pointOf(e);
      if (point) begin(index, point, 'mouse');
    };
    const onContextMenu = (e: Event) => {
      // A long press must not open the browser's context menu on the tile.
      if (session.current) e.preventDefault();
    };
    const onMouseMove = (e: MouseEvent) => {
      if (session.current?.pointer === 'mouse') move(e);
    };
    const onMouseUp = () => {
      if (session.current?.pointer === 'mouse') end();
    };

    const cleanups: (() => void)[] = [];
    for (let i = 0; i < count; i += 1) {
      const el = handles.current.get(i);
      if (!el) continue;
      const ts = onTouchStart(i);
      const md = onMouseDown(i);
      el.addEventListener('touchstart', ts, { passive: true });
      el.addEventListener('touchmove', move, { passive: false });
      el.addEventListener('touchend', end, { passive: true });
      el.addEventListener('touchcancel', end, { passive: true });
      el.addEventListener('mousedown', md);
      el.addEventListener('contextmenu', onContextMenu);
      cleanups.push(() => {
        el.removeEventListener('touchstart', ts);
        el.removeEventListener('touchmove', move);
        el.removeEventListener('touchend', end);
        el.removeEventListener('touchcancel', end);
        el.removeEventListener('mousedown', md);
        el.removeEventListener('contextmenu', onContextMenu);
      });
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      cleanups.forEach((fn) => fn());
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (session.current?.timer !== null && session.current?.timer !== undefined) {
        window.clearTimeout(session.current.timer);
      }
      session.current = null;
    };
  }, [enabled, items.length, mode, longPressMs, ignoreSelector, reset]);

  return {
    dragIndex,
    hoverIndex,
    isDragging,
    delta,
    shiftFor,
    registerHandle,
    registerItem,
  };
}
