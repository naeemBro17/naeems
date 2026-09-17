import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { BottomSheet } from '../shared/BottomSheet';

interface HamburgerMenuProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Which sub-screen the sheet is showing. */
type MenuScreen = 'root' | 'settings' | 'about';

const SCREEN_TITLES: Record<MenuScreen, string> = {
  root: 'Menu',
  settings: 'Settings',
  about: "About Naeem's Price Hub",
};

function ChevronRight() {
  return (
    <svg
      className="menu-row__chevron"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function ComingSoon({ onBack }: { onBack: () => void }) {
  return (
    <div className="menu-coming-soon">
      <button type="button" className="menu-back" onClick={onBack}>
        ← Back
      </button>
      <p className="menu-coming-soon__text">Coming Soon</p>
    </div>
  );
}

/**
 * Bottom sheet behind the header's hamburger button. The Dark Mode switch is
 * live and shares state with the header's theme button; Settings and About are
 * placeholders that swap the sheet body for a Coming Soon panel.
 */
export function HamburgerMenu({ isOpen, onClose }: HamburgerMenuProps) {
  const { theme, toggleTheme } = useTheme();
  const { isAdmin, profile } = useAuth();
  const navigate = useNavigate();
  const [screen, setScreen] = useState<MenuScreen>('root');
  const isApprovedWholesaler = profile?.role === 'wholesaler' && profile?.status === 'approved';

  const goTo = (path: string) => {
    onClose();
    navigate(path);
  };

  // Always reopen on the root screen, never on a stale Coming Soon panel.
  useEffect(() => {
    if (!isOpen) setScreen('root');
  }, [isOpen]);

  const isDark = theme === 'dark';

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={SCREEN_TITLES[screen]}>
      {screen === 'root' ? (
        <div className="menu-list">
          <div className="menu-row">
            <span className="menu-row__label">Dark Mode</span>
            <button
              type="button"
              className={`toggle${isDark ? ' toggle--on' : ''}`}
              onClick={toggleTheme}
              role="switch"
              aria-checked={isDark}
              aria-label="Dark Mode"
            >
              <span className="toggle__thumb" />
            </button>
          </div>

          <button
            type="button"
            className="menu-row menu-row--button"
            onClick={() => setScreen('settings')}
          >
            <span className="menu-row__label">Settings</span>
            <ChevronRight />
          </button>

          <button
            type="button"
            className="menu-row menu-row--button"
            onClick={() => setScreen('about')}
          >
            <span className="menu-row__label">About Naeem&apos;s Price Hub</span>
            <ChevronRight />
          </button>

          {/* Only an authenticated admin/wholesaler ever sees these — the
              role check comes straight from AuthContext's session profile,
              never from CSS or client-side guessing. */}
          {isAdmin && (
            <button
              type="button"
              className="menu-row menu-row--button"
              onClick={() => goTo('/admin')}
            >
              <span className="menu-row__label">Admin Panel</span>
              <ChevronRight />
            </button>
          )}

          {isApprovedWholesaler && (
            <button
              type="button"
              className="menu-row menu-row--button"
              onClick={() => goTo('/wholesaler-access')}
            >
              <span className="menu-row__label">Wholesale Account</span>
              <ChevronRight />
            </button>
          )}
        </div>
      ) : (
        <ComingSoon onBack={() => setScreen('root')} />
      )}
    </BottomSheet>
  );
}
