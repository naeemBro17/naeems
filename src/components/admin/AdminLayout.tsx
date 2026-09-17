import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ThemeToggle } from '../shared/ThemeToggle';

export type AdminTab =
  | 'products'
  | 'categories'
  | 'import-export'
  | 'wholesalers'
  | 'reviews'
  | 'bento'
  | 'promo-codes'
  | 'settings';

interface AdminLayoutProps {
  activeTab: AdminTab;
  onTabChange: (tab: AdminTab) => void;
  /** Number of pending wholesaler requests, shown as a badge on that tab. */
  pendingWholesalers: number;
  children: ReactNode;
}

const TABS: { id: AdminTab; label: string; iconPath: ReactNode }[] = [
  {
    id: 'products',
    label: 'Products',
    iconPath: (
      <>
        <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
        <path d="M3 8l9 5 9-5" />
        <path d="M12 13v8" />
      </>
    ),
  },
  {
    id: 'categories',
    label: 'Categories',
    iconPath: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
  },
  {
    id: 'import-export',
    label: 'Import/Export',
    iconPath: (
      <>
        <path d="M12 3v12" />
        <path d="M8 7l4-4 4 4" />
        <path d="M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4" />
      </>
    ),
  },
  {
    id: 'wholesalers',
    label: 'Wholesalers',
    iconPath: (
      <>
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 00-3-3.87" />
        <path d="M16 3.13a4 4 0 010 7.75" />
      </>
    ),
  },
  {
    id: 'reviews',
    label: 'Reviews',
    iconPath: (
      <>
        <path d="M12 3.5l2.6 5.27 5.82.85-4.21 4.1.99 5.78L12 16.77l-5.2 2.73.99-5.78-4.21-4.1 5.82-.85L12 3.5z" />
      </>
    ),
  },
  {
    id: 'bento',
    label: 'Bento Tiles',
    iconPath: (
      <>
        <rect x="3" y="3" width="8" height="18" rx="1.5" />
        <rect x="13" y="3" width="8" height="8" rx="1.5" />
        <rect x="13" y="13" width="8" height="8" rx="1.5" />
      </>
    ),
  },
  {
    id: 'promo-codes',
    label: 'Promo Codes',
    iconPath: (
      <>
        <path d="M20.59 13.41L11 3.83A2 2 0 009.59 3H4a1 1 0 00-1 1v5.59a2 2 0 00.59 1.41l9.58 9.58a2 2 0 002.83 0l4.59-4.59a2 2 0 000-2.83z" />
        <circle cx="7.5" cy="7.5" r="1.5" />
      </>
    ),
  },
  {
    id: 'settings',
    label: 'Settings',
    iconPath: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </>
    ),
  },
];

export function AdminLayout({
  activeTab,
  onTabChange,
  pendingWholesalers,
  children,
}: AdminLayoutProps) {
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <h1 className="admin-header__title">Naeem's — Admin</h1>
        <div className="admin-header__actions">
          <ThemeToggle />
          <Link to="/" className="admin-header__view-link" aria-label="Open the public price list">
            View Site
          </Link>
        </div>
      </header>

      <div className="admin-body">
        <nav className="admin-nav" aria-label="Admin sections">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`admin-nav__item${activeTab === tab.id ? ' admin-nav__item--active' : ''}`}
              onClick={() => onTabChange(tab.id)}
              aria-current={activeTab === tab.id ? 'page' : undefined}
            >
              <svg
                className="admin-nav__icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {tab.iconPath}
              </svg>
              <span className="admin-nav__label">
                {tab.label}
                {tab.id === 'wholesalers' && pendingWholesalers > 0 && (
                  <span className="admin-nav__badge" aria-label={`${pendingWholesalers} pending`}>
                    {pendingWholesalers}
                  </span>
                )}
              </span>
            </button>
          ))}
        </nav>

        <main className="admin-content">{children}</main>
      </div>
    </div>
  );
}
