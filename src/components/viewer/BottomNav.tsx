import { useEffect, useRef, useState } from 'react';
import { ActionLink } from '../shared/ActionLink';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { navAfterScroll, setNavShown, type NavTab } from '../../lib/bottomNav';

export type { NavTab } from '../../lib/bottomNav';

interface BottomNavProps {
  activeTab: NavTab;
  /** Tapping the tab you are already on (Home or Shop): back to the top. */
  onTop: () => void;
  onAccount: () => void;
}

/** Scrolls this soon after the bar appears are the page restoring its spot. */
const SETTLE_MS = 300;

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
 * active tab is a filled near-black pill with its label; the others are
 * icons only. It slides away on a scroll down of 24 px and comes back on a
 * scroll up of 12 px or at the top (transform and opacity only; instant
 * with reduced motion, see batch71.css).
 */
export function BottomNav({ activeTab, onTop, onAccount }: BottomNavProps) {
  const navigate = useAppNavigate();
  const [visible, setVisible] = useState(true);
  const stateRef = useRef({ visible: true, anchor: 0 });

  useEffect(() => {
    let frame = 0;
    stateRef.current = { visible: true, anchor: window.scrollY };
    setVisible(true);
    setNavShown(true);
    // The first scroll after the bar appears is the page putting back its
    // remembered spot (a Back), not the shopper: it only sets the start.
    const mountedAt = performance.now();
    const check = () => {
      frame = 0;
      if (performance.now() - mountedAt < SETTLE_MS) {
        stateRef.current = { visible: true, anchor: window.scrollY };
        return;
      }
      const next = navAfterScroll(stateRef.current, window.scrollY);
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
    return () => {
      window.removeEventListener('scroll', onScroll);
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
    <nav className={`b71-nav${visible ? '' : ' b71-nav--away'}`} aria-label="Main" data-testid="bottom-nav">
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
