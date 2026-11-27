import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActionLink } from '../shared/ActionLink';
import { useTabNavigate } from '../../hooks/useAppNavigate';
import { navAfterScroll, pillKeyframes, PILL_EASING, PILL_MS, setNavShown, type NavTab } from '../../lib/bottomNav';
import { prefersReducedMotion } from '../../lib/viewTransition';

export type { NavTab } from '../../lib/bottomNav';

interface BottomNavProps {
  activeTab: NavTab;
  /** Tapping the tab you are already on (Home or Shop): back to the top. */
  onTop: () => void;
  onAccount: () => void;
}

/** Scrolls this soon after the bar appears are the page restoring its spot. */
const SETTLE_MS = 300;
/** Fix 72.1: the bar hides only for a scroll this soon after the shopper's
 *  own touch, wheel or key. A scroll nobody made (a Back putting the page
 *  back while it is still loading, the browser keeping the content in place
 *  as photos above load) only moves the starting point. */
const INPUT_MS = 1200;
const INPUT_EVENTS = ['touchstart', 'touchmove', 'wheel', 'keydown'] as const;

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M11.3 2.7a1.1 1.1 0 0 1 1.4 0l8.2 7a1.1 1.1 0 0 1-.7 1.9H19V20a1.5 1.5 0 0 1-1.5 1.5H14.5v-5.2a1 1 0 0 0-1-1h-3a1 1 0 0 0-1 1v5.2H6.5A1.5 1.5 0 0 1 5 20v-8.4H3.8a1.1 1.1 0 0 1-.7-1.9z" />
    </svg>
  );
}

/** The storefront from Batch 69.1 (Keep shopping). */
function ShopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 9.5 5 4.5h14l1.5 5" />
      <path d="M3.5 9.5a2.8 2.8 0 0 0 5.67 0 2.8 2.8 0 0 0 5.66 0 2.8 2.8 0 0 0 5.67 0" />
      <path d="M5 12.5v7h14v-7" />
      <path d="M10 19.5v-4h4v4" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4.35-4.35" />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
    </svg>
  );
}

/**
 * Batch 71: the floating glass tab bar (Home, Shop, Search, Account). The
 * active tab carries its label over one glass pill that slides between tabs
 * (Fix 71.1); the others are icons only. It slides away on a scroll down of 24 px and comes back on a
 * scroll up of 12 px or at the top (transform and opacity only; instant
 * with reduced motion, see batch71.css).
 */
export function BottomNav({ activeTab, onTop, onAccount }: BottomNavProps) {
  const navigate = useTabNavigate();
  const [visible, setVisible] = useState(true);
  const stateRef = useRef({ visible: true, anchor: 0 });
  const navRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  /** Where the pill and each tab were last time (for the slide and FLIP). */
  const lastRef = useRef<{ left: number; width: number; tabs: Map<string, number> } | null>(null);

  const placePill = useCallback((animate: boolean) => {
    const nav = navRef.current;
    const pill = pillRef.current;
    if (!nav || !pill) return;
    const active = nav.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!active) return;
    const left = active.offsetLeft;
    const width = active.offsetWidth;
    const links = Array.from(nav.querySelectorAll<HTMLElement>('a[data-tab]'));
    const tabs = new Map(links.map((link) => [link.dataset.tab ?? '', link.offsetLeft]));
    pill.style.width = `${width}px`;
    pill.style.transform = `translate3d(${left}px, 0, 0)`;
    const last = lastRef.current;
    lastRef.current = { left, width, tabs };
    if (!animate || !last || prefersReducedMotion()) return;
    if (last.left === left && last.width === width) return;
    pill.animate(pillKeyframes({ left: last.left, width: last.width }, { left, width }), {
      duration: PILL_MS,
      easing: PILL_EASING,
    });
    for (const link of links) {
      const before = last.tabs.get(link.dataset.tab ?? '');
      const dx = before === undefined ? 0 : before - link.offsetLeft;
      if (dx === 0) continue;
      link.animate([{ transform: `translate3d(${dx}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }], {
        duration: PILL_MS,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
    }
  }, []);

  // The tab changed: the pill slides there (the bar stays mounted across Home,
  // Shop and Search, see App.tsx GlobalBottomNav).
  useLayoutEffect(() => {
    placePill(true);
  }, [activeTab, placePill]);

  // Fonts loading or a resize: put the pill back under its tab, no slide.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => placePill(false));
    observer.observe(nav);
    return () => observer.disconnect();
  }, [placePill]);

  useEffect(() => {
    let frame = 0;
    stateRef.current = { visible: true, anchor: window.scrollY };
    setVisible(true);
    setNavShown(true);
    // The first scroll after the bar appears is the page putting back its
    // remembered spot (a Back), not the shopper: it only sets the start.
    const mountedAt = performance.now();
    let inputAt = -Infinity;
    const onInput = () => {
      inputAt = performance.now();
    };
    const check = () => {
      frame = 0;
      if (performance.now() - mountedAt < SETTLE_MS) {
        stateRef.current = { visible: true, anchor: window.scrollY };
        return;
      }
      const next = navAfterScroll(stateRef.current, window.scrollY);
      if (!next.visible && performance.now() - inputAt > INPUT_MS) {
        stateRef.current = { visible: stateRef.current.visible, anchor: window.scrollY };
        return;
      }
      if (next.visible !== stateRef.current.visible) {
        setVisible(next.visible);
        setNavShown(next.visible);
      }
      stateRef.current = next;
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(check);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput);
      window.cancelAnimationFrame(frame);
      setNavShown(true);
    };
  }, [activeTab]);

  const tabs: { id: NavTab; label: string; to: string; icon: JSX.Element; onOpen: () => void }[] = [
    { id: 'home', label: 'Home', to: '/', icon: <HomeIcon />, onOpen: () => (activeTab === 'home' ? onTop() : navigate('/')) },
    { id: 'shop', label: 'Shop', to: '/shop', icon: <ShopIcon />, onOpen: () => (activeTab === 'shop' && window.location.pathname === '/shop' ? onTop() : navigate('/shop')) },
    { id: 'search', label: 'Search', to: '/search', icon: <SearchIcon />, onOpen: () => (activeTab === 'search' ? undefined : navigate('/search')) },
    { id: 'account', label: 'Account', to: '/account', icon: <AccountIcon />, onOpen: onAccount },
  ];

  return (
    <nav className={`b71-nav${visible ? '' : ' b71-nav--away'}`} aria-label="Main" data-testid="bottom-nav" ref={navRef}>
      <span ref={pillRef} className="b71-nav__pill" aria-hidden="true" data-testid="bottom-nav-pill" />
      {tabs.map((tab) => {
        const active = tab.id === activeTab;
        return (
          <ActionLink
            key={tab.id}
            to={tab.to}
            onOpen={tab.onOpen}
            aria-current={active ? 'page' : undefined}
            aria-label={active ? undefined : tab.label}
            data-tab={tab.id}
          >
            {tab.icon}
            {active && <span>{tab.label}</span>}
          </ActionLink>
        );
      })}
    </nav>
  );
}
