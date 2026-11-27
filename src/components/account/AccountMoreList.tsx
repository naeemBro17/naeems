import { Link } from 'react-router-dom';
import { useTheme } from '../../contexts/ThemeContext';

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

const POLICIES: { to: string; label: string }[] = [
  { to: '/about', label: 'About us' },
  { to: '/delivery', label: 'Delivery info' },
  { to: '/return-policy', label: 'Return policy' },
  { to: '/terms', label: 'Terms and conditions' },
  { to: '/privacy', label: 'Privacy policy' },
];

/**
 * Batch 71: what the old hamburger menu held, now at the bottom of the
 * Account page: Dark mode, then "About and policies". The Admin panel and
 * Wholesale account rows stay the staff / wholesaler Account view's own
 * "Open admin panel" / "Open wholesaler account" row (role from the
 * session, AuthContext), so a customer never sees them.
 */
export function AccountMoreList() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <div className="b71-acct-list" data-testid="account-more">
      <div className="b71-card">
        <div className="b71-row">
          <span>Dark mode</span>
          <button
            type="button"
            className={`toggle${isDark ? ' toggle--on' : ''}`}
            onClick={toggleTheme}
            role="switch"
            aria-checked={isDark}
            aria-label="Dark mode"
            data-testid="account-dark-mode"
          >
            <span className="toggle__thumb" />
          </button>
        </div>
      </div>

      <h2>About and policies</h2>
      <div className="b71-card">
        {POLICIES.map((p) => (
          <Link key={p.to} to={p.to} className="b71-row">
            <span>{p.label}</span>
            <Chevron />
          </Link>
        ))}
      </div>
    </div>
  );
}
