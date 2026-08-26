export type NavTab = 'home' | 'search' | 'account';

interface BottomNavProps {
  activeTab: NavTab;
  /** Scrolls the page back to the top. */
  onHome: () => void;
  /** Scrolls to the top and focuses the search input. */
  onSearch: () => void;
  /** Opens the "coming soon" account sheet. */
  onAccount: () => void;
}

function HomeIcon() {
  return (
    <svg
      className="bottom-nav__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 10.5L12 3l9 7.5" />
      <path d="M5.5 9.5V20a1 1 0 001 1h11a1 1 0 001-1V9.5" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      className="bottom-nav__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4.35-4.35" />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg
      className="bottom-nav__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1" />
    </svg>
  );
}

/** Fixed frosted-glass tab bar. Home and Search act on the page, not the router. */
export function BottomNav({ activeTab, onHome, onSearch, onAccount }: BottomNavProps) {
  const tabs = [
    { id: 'home' as const, label: 'Home', icon: <HomeIcon />, onClick: onHome },
    { id: 'search' as const, label: 'Search', icon: <SearchIcon />, onClick: onSearch },
    {
      id: 'account' as const,
      label: 'Account',
      icon: <AccountIcon />,
      onClick: onAccount,
    },
  ];

  return (
    <nav className="bottom-nav" aria-label="Main">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`bottom-nav__tab${
            activeTab === tab.id ? ' bottom-nav__tab--active' : ''
          }`}
          onClick={tab.onClick}
          aria-current={activeTab === tab.id ? 'page' : undefined}
        >
          {tab.icon}
          <span className="bottom-nav__label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
